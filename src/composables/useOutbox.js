// Vue composable wrapping src/lib/outbox.js with reactive refs.
//
// Pure-JS outbox doesn't know about Vue, so this file translates its
// EventEmitter-style change events into Vue refs so components can
// `const { pendingCount, isOffline } = useOutbox()` and let the
// template re-render on every state change.
//
// Singleton model: the first call to useOutbox() creates the outbox
// and wires the socket listener, every subsequent call just returns
// the same refs. Multiple components watching pendingCount don't fan
// out to multiple IDB scans, one 'change' event triggers one refresh
// and every consumer sees the same value.
//
import { ref, computed, watch, effectScope } from 'vue'
import { createOutbox, createIdbBackend, STATUSES } from '@/lib/outbox'
import { fingerprintFromUser } from '@/lib/userFingerprint'
import { useSocket } from './useSocket'
import { useAuthStore } from '@/stores/auth'

// ---- Singleton state ------------------------------------------
// Created on the first getOutbox() call. Kept module-scope so
// multiple component mounts share one instance.

let instance = null
let refreshTimer = null
let offlineScope = null   // detached effectScope owning the socket watch

const counts = ref({ pending: 0, inflight: 0, synced: 0, conflict: 0, failed: 0 })
const offlineSince = ref(null)        // Date | null, set on disconnect, cleared on reconnect
const lastSyncedAt = ref(null)        // Date | null, most recent successful drain

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

export function getOutbox() {
  if (!instance) {
    const auth = useAuthStore()
    instance = createOutbox({
      backend: createIdbBackend(),
      userFingerprint: fingerprintFromUser(auth.user),
    })

    // Refresh counts on every outbox state change. push/drain/
    // resolveConflict all emit 'change'.
    instance.on('change', refresh)

    // Initial scan, the outbox might have leftover entries from a
    // prior session that didn't drain before the tab closed.
    refresh()

    // Periodic refresh as a safety net in case a 'change' event
    // is dropped (e.g., the page was hidden and Visibility-paused).
    // 30s is cheap and bounded, list() is O(n) over a small queue anyway.
    refreshTimer = setInterval(refresh, 30000)
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
  }
  return instance
}

// ---- Public composable ----------------------------------------

export function useOutbox() {
  const outbox = getOutbox()

  if (!offlineScope) {
    const socket = useSocket()
    // Track offline duration via the existing socket singleton.
    // We watch isConnected rather than subscribing to connect/
    // disconnect events directly so we don't race with the
    // composable's own listeners. The watcher lives in a DETACHED
    // effect scope: it's created during the first consumer's setup,
    // and a component-scoped watcher would die when that component
    // unmounts while the singleton state lives on, silently killing
    // offline tracking for every later consumer. Learned that one
    // the hard way.
    offlineScope = effectScope(true)
    offlineScope.run(() => {
      watch(socket.isConnected, (connected, was) => {
        if (!connected && was !== false) {
          offlineSince.value = new Date()
        } else if (connected) {
          offlineSince.value = null
        }
      }, { immediate: true })
    })
  }

  return {
    outbox,
    counts,
    offlineSince,
    lastSyncedAt,
    isOffline: computed(() => offlineSince.value !== null),
    pendingCount: computed(() => counts.value.pending),
    failedCount: computed(() => counts.value.failed),
    conflictCount: computed(() => counts.value.conflict),
    // "hasActivity": a single boolean components use to decide
    // whether to render the offline banner / sync chips at all.
    // True when offline OR when there are pending / failed /
    // conflict entries even though we're online (the drain might
    // still be in flight, or hit a transient retry).
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
// surface, consumers should import it explicitly. Lets tests reset
// the singleton between cases.
export function _resetOutboxForTests() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (offlineScope) {
    offlineScope.stop()
    offlineScope = null
  }
  instance = null
  counts.value = { pending: 0, inflight: 0, synced: 0, conflict: 0, failed: 0 }
  offlineSince.value = null
  lastSyncedAt.value = null
}
