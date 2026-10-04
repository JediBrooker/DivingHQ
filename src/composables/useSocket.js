import { nativeSocketOptions } from '@/lib/native-platform'
import { createNativeSocketRecovery } from '@/lib/native-socket.mjs'
import { ref, getCurrentInstance, onUnmounted } from 'vue'
import { io } from 'socket.io-client'
import { useAuthStore } from '@/stores/auth'

// Singleton socket pool keyed by `(spectator, userId)` so every
// view + global component sharing the same auth share one
// transport. Without this, every `useSocket()` call creates a
// fresh `io(...)` connection: a tab on /dashboard with the
// global NotificationCenter mounted ends up with two-or-three
// concurrent sockets joining the same event rooms, doubling
// server connections and forcing every broadcast to get sent
// twice to the same client. Refcounted so the last consumer
// disconnecting actually closes the transport.
//
// Auth rides the httpOnly session cookie on the handshake, since
// browser JS can't read the JWT to pass it via `auth.token` any
// more, so authenticated sockets send no token and the server
// reads the cookie instead. The pool keys on the user id (not the
// token) so a mid-session identity change still swaps the socket.
// An explicit `spectator` lease sends `auth.token: 'spectator'` to
// opt OUT of cookie auth (a signed-in user viewing a public board).
//
// Public surface stays exactly the same: returns a socket-like
// object with `.isConnected` (a Vue ref) plus the original
// socket.io methods (.on, .off, .emit, .connected, etc.).
let nativePaused = false
const pool = new Map() // key -> { socket, isConnected, refs }

function poolKey({ spectator, userId }) {
  return spectator ? 'spectator' : `auth:${userId || 'none'}`
}

function acquire({ spectator, userId }) {
  const key = poolKey({ spectator, userId })
  let entry = pool.get(key)
  if (!entry) {
    const native = nativeSocketOptions({ spectator, userId })
    const socket = native ? io(native.url, { ...native.options, autoConnect: !nativePaused }) : io({ auth: spectator ? { token: 'spectator' } : {} })
    // Initialise from the socket's real state, since io() connects
    // asynchronously, so a hardcoded `true` would report
    // "connected" before the first connect event ever fires.
    const isConnected = ref(socket.connected)
    const recovery = native ? createNativeSocketRecovery({
      socket,
      isCurrent: () => pool.get(key)?.socket === socket,
      isPaused: () => nativePaused,
      onSessionExpired: () => {
        if (userId) window.dispatchEvent(new CustomEvent('dhq:native-session-expired', { detail: userId }))
      },
    }) : null
    socket.on('connect',       () => { isConnected.value = true })
    socket.on('disconnect',    () => { isConnected.value = false })
    socket.on('connect_error', () => { isConnected.value = false })
    socket.isConnected = isConnected
    entry = { socket, isConnected, refs: 0, recovery }
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
    entry.recovery?.dispose()
    try { entry.socket.disconnect() } catch { /* ignore */ }
    pool.delete(key)
  }
}

// Manual lease on a pooled socket, for consumers whose socket
// lifetime is tied to something other than a component unmount:
// NotificationCenter swaps sockets whenever the auth identity
// changes mid-session (login/logout navigate without a reload).
// Returns the pooled socket plus an idempotent release().
export function acquireSocket({ spectator = false, userId = null } = {}) {
  const key = poolKey({ spectator, userId })
  const entry = acquire({ spectator, userId })
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
  const userId = auth.user?.id
  const key = poolKey({ spectator, userId })
  const entry = acquire({ spectator, userId })

  // Only refcount-decrement on unmount when called from a component
  // setup context. Calling `useSocket` from a non-component module
  // (e.g. a top-level imported helper) doesn't have a lifecycle to
  // hook, and we definitely don't want to disconnect there.
  if (getCurrentInstance()) {
    onUnmounted(() => release(key))
  }

  return entry.socket
}

// Native suspension drops leases on the wire, while retaining the pool and
// listeners. Reconnect drives each view's existing restore/rejoin handlers.
export function pauseNativeSockets() {
  nativePaused = true
  for (const { socket, recovery } of pool.values()) { recovery?.cancel(); socket.disconnect() }
}
export function resumeNativeSockets() {
  nativePaused = false
  for (const { socket } of pool.values()) socket.connect()
}
