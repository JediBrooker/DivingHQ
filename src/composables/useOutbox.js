// Vue composable wrapping src/lib/outbox.js with reactive refs.
//
// Pure-JS outbox doesn't know about Vue; this file translates its
// EventEmitter-style change events into Vue refs so components
// can `const { pendingCount, isOffline } = useOutbox()` and let
// the template re-render on every state change.
//
// Singleton model. The first call to useOutbox() creates the
// outbox + wires the socket listener; every subsequent call
// returns the same refs. Multiple components watching
// pendingCount don't fan out to multiple IDB scans — one
// 'change' event triggers one refresh, every consumer sees the
// same value.
//
// Feature flag posture: when VITE_OFFLINE_OUTBOX_ENABLED is off,
// the composable still returns refs (so the calling code doesn't
// need a separate "is the feature on" check at every use site)
// but all values stay at zero / null / online. Components show
// nothing because there's nothing to show.

import { ref, computed, watch } from 'vue'
import { createOutbox, createIdbBackend, STATUSES } from '@/lib/outbox'
import { useSocket } from './useSocket'
import { useAuthStore } from '@/stores/auth'

const OUTBOX_ENABLED = import.meta.env.VITE_OFFLINE_OUTBOX_ENABLED === '1'

// Per-user fingerprint helper. Same scheme as idbCache (24 chars
// of the JWT payload segment). Kept inline here so the composable
// is self-contained; a shared util across outbox + idbCache is on
// the cleanup list.
function fingerprintFromToken(token) {
  if (!token) return 'anon'
  const parts = String(token).split('.')
  if (parts.length < 2) return 'anon'
  return parts[1].slice(0, 24)
}

// ---- Singleton state ------------------------------------------
// Created on first useOutbox() call. Module-scope so multiple
// component mounts share one instance.

let instance = null
let refreshTimer = null

const counts = ref({ pending: 0, inflight: 0, synced: 0, conflict: 0, failed: 0 })
const offlineSince = ref(null)        // Date | null — set on disconnect, cleared on reconnect
const lastSyncedAt = ref(null)        // Date | null — most recent successful drain

async function refresh() {
  if (!instance) return
  const all = await instance.list({})
  const next = { pending: 0, inflight: 0, synced: 0, conflict: 0, failed: 0 }
  let latest = null
  for (const e of all) {
    next[e.status] = (next[e.status] || 0) + 1
    if (e.status === STATUSES.SYNCED && e.synced_at) {
      const t = Date.parse(e.synced_at)
      if (!latest || t > latest) latest = t
    }
  }
  counts.value = next
  lastSyncedAt.value = latest ? new Date(latest) : null
}

// ---- Public composable ----------------------------------------

export function useOutbox() {
  if (!OUTBOX_ENABLED) {
    // Flag off — return inert refs. No outbox, no IDB, no listeners.
    return {
      enabled: false,
      outbox: null,
      counts,
      offlineSince,
      lastSyncedAt,
      isOffline: computed(() => false),
      pendingCount: computed(() => 0),
      failedCount: computed(() => 0),
      conflictCount: computed(() => 0),
      hasActivity: computed(() => false),
      refresh: async () => {},
    }
  }

  if (!instance) {
    const auth = useAuthStore()
    const socket = useSocket()
    instance = createOutbox({
      backend: createIdbBackend(),
      userFingerprint: fingerprintFromToken(auth.token),
    })

    // Refresh counts on every outbox state change. push/drain/
    // resolveConflict all emit 'change'.
    instance.on('change', refresh)

    // Track offline duration via the existing socket singleton.
    // We watch isConnected rather than subscribing to connect/
    // disconnect events directly so we don't race with the
    // composable's own listeners.
    watch(socket.isConnected, (connected, was) => {
      if (!connected && was !== false) {
        offlineSince.value = new Date()
      } else if (connected) {
        offlineSince.value = null
      }
    }, { immediate: true })

    // Initial scan. The outbox might have entries from a prior
    // session that didn't drain before the tab closed.
    refresh()

    // Periodic refresh as a safety net in case a 'change' event
    // is dropped (e.g., the page was hidden and Visibility-paused).
    // 30s is cheap and bounded — list() is O(n) over a small queue.
    refreshTimer = setInterval(refresh, 30000)
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
  }

  return {
    enabled: true,
    outbox: instance,
    counts,
    offlineSince,
    lastSyncedAt,
    isOffline: computed(() => offlineSince.value !== null),
    pendingCount: computed(() => counts.value.pending),
    failedCount: computed(() => counts.value.failed),
    conflictCount: computed(() => counts.value.conflict),
    // "hasActivity" — a single boolean components use to decide
    // whether to render the offline banner / sync chips at all.
    // True when offline OR when there are pending / failed /
    // conflict entries even though we're online (the drain might
    // be in flight or have hit a transient retry).
    hasActivity: computed(() =>
      offlineSince.value !== null
      || counts.value.pending > 0
      || counts.value.failed > 0
      || counts.value.conflict > 0
    ),
    refresh,
  }
}

// Test-only escape hatch. Not exported from the module's default
// surface; consumers should import it explicitly. Lets tests reset
// the singleton between cases.
export function _resetOutboxForTests() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  instance = null
  counts.value = { pending: 0, inflight: 0, synced: 0, conflict: 0, failed: 0 }
  offlineSince.value = null
  lastSyncedAt.value = null
}
