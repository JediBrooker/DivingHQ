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
    throw new Error(`network: ${err.message}`)
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

function socketSend(entry) {
  const s = _socket
  if (!s || !s.connected) {
    throw new Error('socket disconnected')
  }
  const eventName = entry.action_type.slice('socket:'.length)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000)
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
  if (entry.action_type.startsWith('socket:')) {
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
      await outbox.drain({ send: (e) => unifiedSend(auth, e) })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[outbox] drain failed:', err.message)
    }
  })
}

// --- Public composable -------------------------------------------

export function useHttpOutbox() {
  const auth = useAuthStore()
  const socket = useSocket()
  _socket = socket

  if (!drainHookSockets.has(socket)) {
    drainHookSockets.add(socket)
    socket.on('connect', () => scheduleDrain(auth))
  }

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
}
