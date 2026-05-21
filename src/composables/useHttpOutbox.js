// HTTP-outbox composable.
//
// Bridge between src/lib/outbox.js (which is protocol-agnostic)
// and the meet-time HTTP write endpoints in routes/control-room.js
// + routes/score-correction.js + routes/events/index.js. The
// composable provides a single `queueAction({ method, url, body,
// actionType })` helper that:
//
//   1. Pushes the action onto the outbox (IDB-persisted).
//   2. Schedules a drain attempt — drain() calls fetch() with the
//      right method/body + auth + X-Idempotency-Key.
//   3. Returns the idempotency_key so the caller can show
//      optimistic UI tied to it (PendingBadge etc.).
//
// The send function honours the same retry/backoff semantics as
// the socket send (JudgeView). 409 → conflict (outbox marks as
// 'conflict' for the review tray); 4xx → fail (no retry); 5xx /
// network error → retry up to MAX_ATTEMPTS.
//
// Feature flag posture: when VITE_OFFLINE_OUTBOX_ENABLED is off,
// queueAction falls through to a direct fetch (legacy behaviour).
// Callers don't need a separate "is the feature on" check at
// every call site.

import { createOutbox, createIdbBackend } from '@/lib/outbox'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from './useSocket'

const OUTBOX_ENABLED = import.meta.env.VITE_OFFLINE_OUTBOX_ENABLED === '1'

// Per-user fingerprint helper. Same scheme as idbCache (first 24
// chars of the JWT payload segment). Kept inline so the composable
// doesn't depend on yet another helper module.
function fingerprintFromToken(token) {
  if (!token) return 'anon'
  const parts = String(token).split('.')
  if (parts.length < 2) return 'anon'
  return parts[1].slice(0, 24)
}

// Singleton across all useHttpOutbox callers. Multiple components
// asking for queueAction share the same outbox instance + drain
// lock; the IDB-side keyspace is already user-fingerprint-scoped.
let outbox = null
let drainScheduled = false

function ensureOutbox(auth) {
  if (outbox) return outbox
  outbox = createOutbox({
    backend: createIdbBackend(),
    userFingerprint: fingerprintFromToken(auth.token),
  })
  return outbox
}

// fetch() wrapper used as the outbox's send callback for HTTP
// entries. Walks the payload's method/url/body, injects auth +
// idempotency key, translates 409 into a conflict error the
// outbox state machine recognises.
async function httpSend(auth, entry) {
  const { method, url, body } = entry.payload
  const headers = {
    'Content-Type': 'application/json',
    'X-Idempotency-Key': entry.idempotency_key,
  }
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body == null ? undefined : JSON.stringify({
        ...body,
        // actor_local_time travels in the body for HTTP routes.
        // The deadline-with-review gate + audit clock both read it.
        actor_local_time: entry.actor_local_time,
      }),
    })
  } catch (err) {
    // Network failure — let the outbox retry.
    throw new Error(`network: ${err.message}`)
  }

  let data = null
  try { data = await res.json() } catch { /* non-JSON response */ }

  if (res.ok) {
    return { ok: true, response: data }
  }

  // 409 maps to the outbox's conflict state. The server-side
  // payload carries enough context for the review tray to render
  // the conflicting values.
  if (res.status === 409) {
    const err = new Error((data && data.error) || 'conflict')
    err.kind = 'conflict'
    err.conflict = data || { status: 409 }
    throw err
  }

  // 4xx (excluding 409) are permanent — the outbox should give up
  // after maxAttempts. We throw with a clear message; the outbox
  // increments attempts and either retries (5xx) or fails.
  // For 422 (payload-hash mismatch from idempotency layer) we
  // also throw — that's a client bug we can't recover from.
  const errBody = data && data.error ? data.error : `HTTP ${res.status}`
  const err = new Error(errBody)
  err.status = res.status
  throw err
}

// Schedule a drain on the next tick. Coalesces multiple
// queueAction calls in a single sync block into one drain pass.
function scheduleDrain(auth) {
  if (drainScheduled || !outbox) return
  drainScheduled = true
  Promise.resolve().then(async () => {
    drainScheduled = false
    try {
      await outbox.drain({ send: (e) => httpSend(auth, e) })
    } catch (err) {
      // drain() catches per-entry errors; this catch covers a
      // top-level lock or backend failure.
      // eslint-disable-next-line no-console
      console.error('[useHttpOutbox] drain failed:', err.message)
    }
  })
}

export function useHttpOutbox() {
  const auth = useAuthStore()
  const socket = useSocket()

  // Wire socket-connect to drain. Reusing the socket's connection
  // signal as the "online again" trigger is cheaper than a
  // separate window.online listener and avoids the false-positive
  // case where the browser thinks it's online but the server is
  // unreachable.
  if (OUTBOX_ENABLED) {
    socket.on('connect', () => scheduleDrain(auth))
  }

  /**
   * Queue an HTTP write through the outbox.
   *
   * @param {Object} opts
   * @param {'POST'|'PUT'|'PATCH'|'DELETE'} opts.method
   * @param {string} opts.url
   * @param {Object} [opts.body]
   * @param {string} opts.actionType  Stable label for the outbox
   *                                  entry. Used by drain + the
   *                                  review tray, not the server.
   * @returns {Promise<string|null>}  idempotency_key (when outbox
   *                                  is enabled) or null (legacy
   *                                  direct path).
   */
  async function queueAction({ method, url, body, actionType }) {
    if (!OUTBOX_ENABLED) {
      // Legacy direct path: just fetch and let the caller handle
      // success/failure. Matches the pre-outbox behaviour exactly.
      const headers = { 'Content-Type': 'application/json' }
      if (auth.token) headers.Authorization = `Bearer ${auth.token}`
      const res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: body == null ? undefined : JSON.stringify(body),
      })
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      return null
    }

    const ob = ensureOutbox(auth)
    const key = await ob.push(actionType, { method, url, body })
    scheduleDrain(auth)
    return key
  }

  return { queueAction, outbox: OUTBOX_ENABLED ? ensureOutbox(auth) : null }
}

// Test-only escape hatch.
export function _resetHttpOutboxForTests() {
  outbox = null
  drainScheduled = false
}
