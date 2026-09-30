// Action-outbox composable.
//
// Unified bridge between src/lib/outbox.js (protocol-agnostic) and
// both HTTP write endpoints and socket-based Control Room operations.
// Every meet-time write, whether HTTP or socket, goes through the
// same IDB-backed outbox so actions survive offline gaps.
//
// Two transport modes, dispatched by action_type prefix:
//   • 'socket:<event>'  → socket.emit with ack callback
//   • anything else     → fetch (HTTP)
//
// Both share the same outbox singleton, drain lock, and
// socket-connect → drain trigger.

import { useAuthStore } from '@/stores/auth'
import { useSocket } from './useSocket'
import { getOutbox } from './useOutbox'

let drainScheduled = false
let retryTimer = null

// Sockets that already carry the connect→drain hook.
const drainHookSockets = new WeakSet()

// --- HTTP send ---------------------------------------------------

async function httpSend(auth, entry) {
  const { method, url, body } = entry.payload
  const headers = {
    'Content-Type': 'application/json',
    'X-Idempotency-Key': entry.idempotency_key,
  }

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body == null ? undefined : JSON.stringify({
        ...body,
        actor_local_time: entry.actor_local_time,
      }),
    })
  } catch (err) {
    // fetch() only rejects when the request never got an answer, so
    // this didn't cost an attempt (see drain()).
    const offline = new Error(`network: ${err.message}`)
    offline.offline = true
    throw offline
  }

  let data = null
  try { data = await res.json() } catch { /* non-JSON response */ }

  if (res.ok) return { ok: true, response: data }

  if (res.status === 409) {
    const err = new Error((data && data.error) || 'conflict')
    err.kind = 'conflict'
    err.conflict = data || { status: 409 }
    throw err
  }

  const errBody = data && data.error ? data.error : `HTTP ${res.status}`
  const err = new Error(errBody)
  err.status = res.status
  throw err
}

// --- Socket send -------------------------------------------------

let _socket = null

// JudgeView predates the 'socket:' prefix and pushes plain 'submit_score'
// entries, and they drain through here like everything else (it had its
// own copy of socketSend once). Routing one to httpSend would fire
// fetch(undefined) and burn the entry's retries until it was marked
// failed, so the legacy name counts as a socket action.
const LEGACY_SOCKET_ACTIONS = new Set(['submit_score'])

function isSocketAction(actionType) {
  return actionType.startsWith('socket:') || LEGACY_SOCKET_ACTIONS.has(actionType)
}

function socketSend(entry) {
  const s = _socket
  if (!s || !s.connected) {
    const offline = new Error('socket disconnected')
    offline.offline = true
    throw offline
  }
  const eventName = entry.action_type.startsWith('socket:')
    ? entry.action_type.slice('socket:'.length)
    : entry.action_type
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // No ack in 10s. It may still have landed, so the drain holds the
      // queue behind it rather than letting later actions go first.
      const err = new Error('timeout')
      err.ambiguous = true
      reject(err)
    }, 10000)
    s.emit(eventName, {
      ...entry.payload,
      idempotency_key: entry.idempotency_key,
      actor_local_time: entry.actor_local_time,
    }, (response) => {
      clearTimeout(timer)
      if (response?.ok) {
        resolve({ ok: true, response })
      } else if (response?.conflict) {
        const err = new Error(response.error || 'conflict')
        err.kind = 'conflict'
        err.conflict = response.conflict
        reject(err)
      } else {
        reject(new Error(response?.error || 'rejected'))
      }
    })
  })
}

// --- Unified send ------------------------------------------------

function unifiedSend(auth, entry) {
  if (isSocketAction(entry.action_type)) {
    return socketSend(entry)
  }
  return httpSend(auth, entry)
}

// --- Drain scheduling --------------------------------------------

function scheduleDrain(auth) {
  const outbox = getOutbox()
  if (drainScheduled || !outbox) return
  drainScheduled = true
  Promise.resolve().then(async () => {
    drainScheduled = false
    try {
      const result = await outbox.drain({ send: (e) => unifiedSend(auth, e) })
      // The outbox says when a retry is due (backoff after a failure, or
      // an entry another tab left inflight going stale). Without this a
      // retry only happened on the next reconnect or the next tap.
      if (result?.retryInMs != null) {
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          retryTimer = null
          scheduleDrain(auth)
        }, result.retryInMs)
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[outbox] drain failed:', err.message)
    }
  })
}

// Send whatever's queued now, for a screen that pushes onto the outbox
// itself instead of through queueAction (the judge keypad). Same sender,
// same lock and the same retry timer as every other drain.
export function drainOutboxNow() {
  scheduleDrain(useAuthStore())
}

// Manual retry for entries that ran out of attempts (the offline
// banner's Retry button). Requeues them and drains straight away.
export async function retryFailedActions() {
  const outbox = getOutbox()
  if (!outbox) return 0
  // Nothing past the retention window gets resent: the server has
  // forgotten its idempotency key by then, so a replay could land twice.
  await outbox.gc().catch(() => {})
  const n = await outbox.retryFailed()
  if (n) scheduleDrain(useAuthStore())
  return n
}

// Attach the connect -> drain hook to the socket, once, and kick a drain
// straight away if we're already online.
//
// The immediate drain is the important half. The socket connects during
// app boot, long before any of this runs, so waiting for the *next*
// 'connect' stranded whatever a previous session left in the queue: the
// entry sat pending until the operator happened to reconnect or make
// another write.
//
// Exported so App.vue can arm it for the whole session (see
// useOutboxSync). Until then the hook only existed while the Control
// Room was on screen, and a judge or operator who refreshed mid-meet
// could sit reconnected on some other route with unsent scores in IDB.
export function armOutboxDrain(auth, socket) {
  _socket = socket
  if (drainHookSockets.has(socket)) return
  drainHookSockets.add(socket)
  socket.on('connect', () => scheduleDrain(auth))
  if (socket.connected) scheduleDrain(auth)
}

// Wait for one queued entry to settle. Resolves 'synced' once the server
// took it, 'failed' once the outbox gave up on it (or parked it as a
// conflict), and 'pending' if it's still queued when the time runs out,
// which is the offline case, or a server that keeps saying no while the
// retries tick over. Never rejects.
//
// For the few actions whose success toast only means something once the
// server has said yes. An announce the server refused used to toast
// "Announced" all the same.
export function waitForOutboxEntry(key, { timeoutMs = 8000 } = {}) {
  const ob = getOutbox()
  if (!ob || !key) return Promise.resolve('pending')
  return new Promise((resolve) => {
    let done = false
    let off = () => {}
    const finish = (status) => {
      if (done) return
      done = true
      clearTimeout(timer)
      off()
      resolve(status)
    }
    async function check() {
      try {
        const e = await ob.getEntry(key)
        if (!e) return
        if (e.status === 'synced') finish('synced')
        else if (e.status === 'failed' || e.status === 'conflict' || e.status === 'cancelled') finish('failed')
      } catch { /* look again on the next change */ }
    }
    const timer = setTimeout(() => finish('pending'), timeoutMs)
    off = ob.on('change', check)
    check()
  })
}

// Signed out: stop sending through the old user's socket. Entries stay
// in IndexedDB under their fingerprint for when that person is back.
export function disarmOutboxDrain() {
  _socket = null
  clearTimeout(retryTimer)
  retryTimer = null
}

// --- Public composable -------------------------------------------

export function useHttpOutbox() {
  const auth = useAuthStore()
  const socket = useSocket()
  armOutboxDrain(auth, socket)

  async function queueAction({ method, url, body, actionType }) {
    const ob = getOutbox()
    const key = await ob.push(actionType, { method, url, body })
    scheduleDrain(auth)
    return key
  }

  async function queueSocketAction(eventName, payload) {
    const ob = getOutbox()
    const key = await ob.push(`socket:${eventName}`, payload)
    scheduleDrain(auth)
    return key
  }

  return { queueAction, queueSocketAction, outbox: getOutbox() }
}

export function _resetHttpOutboxForTests() {
  drainScheduled = false
  clearTimeout(retryTimer)
  retryTimer = null
}
