import { ref, getCurrentInstance, onUnmounted } from 'vue'
import { io } from 'socket.io-client'
import { useAuthStore } from '@/stores/auth'

// Singleton socket pool keyed by `(spectator, token)` so every
// view + global component sharing the same auth share one
// transport. Without this, every `useSocket()` call creates a
// fresh `io(...)` connection — a tab on /dashboard with the
// global NotificationCenter mounted ends up with two-or-three
// concurrent sockets joining the same event rooms, doubling
// server connections and forcing every broadcast to be sent
// twice to the same client. Refcounted so the last consumer
// disconnecting actually closes the transport.
//
// Public surface stays exactly the same: returns a socket-like
// object with `.isConnected` (a Vue ref) plus the original
// socket.io methods (.on, .off, .emit, .connected, etc.).
const pool = new Map() // key -> { socket, isConnected, refs }

function poolKey({ spectator, token }) {
  return spectator ? 'spectator' : `auth:${token || 'spectator'}`
}

function acquire({ spectator, token }) {
  const key = poolKey({ spectator, token })
  let entry = pool.get(key)
  if (!entry) {
    const socket = io({ auth: { token: spectator ? 'spectator' : (token || 'spectator') } })
    // Initialise from the socket's real state — io() connects
    // asynchronously, so a hardcoded `true` would report
    // "connected" before the first connect event ever fires.
    const isConnected = ref(socket.connected)
    socket.on('connect',       () => { isConnected.value = true })
    socket.on('disconnect',    () => { isConnected.value = false })
    socket.on('connect_error', () => { isConnected.value = false })
    socket.isConnected = isConnected
    entry = { socket, isConnected, refs: 0 }
    pool.set(key, entry)
  }
  entry.refs += 1
  return entry
}

function release(key) {
  const entry = pool.get(key)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    try { entry.socket.disconnect() } catch { /* ignore */ }
    pool.delete(key)
  }
}

// Manual lease on a pooled socket, for consumers whose socket
// lifetime is tied to something other than a component unmount —
// NotificationCenter swaps sockets whenever the auth identity
// changes mid-session (login/logout navigate without a reload).
// Returns the pooled socket plus an idempotent release().
export function acquireSocket({ spectator = false, token = null } = {}) {
  const key = poolKey({ spectator, token })
  const entry = acquire({ spectator, token })
  let released = false
  return {
    socket: entry.socket,
    release() {
      if (released) return
      released = true
      release(key)
    },
  }
}

export function useSocket({ spectator = false } = {}) {
  const auth = useAuthStore()
  const token = auth.token
  const key = poolKey({ spectator, token })
  const entry = acquire({ spectator, token })

  // Only refcount-decrement on unmount when called from a component
  // setup context. Calling `useSocket` from a non-component module
  // (e.g. a top-level imported helper) doesn't have a lifecycle to
  // hook, and we definitely don't want to disconnect there.
  if (getCurrentInstance()) {
    onUnmounted(() => release(key))
  }

  return entry.socket
}
