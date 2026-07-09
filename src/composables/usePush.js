// Service-worker registration + Web Push subscribe flow + a
// single shared inbox stream the SPA can listen to for in-app
// notifications.
//
// One module-level shared state:
//   - The notifications ref is shared so multiple component
//     mounts (banner + nav badge + inbox view) all see the same
//     list without each opening its own socket.
//   - The browser exposes one ServiceWorkerRegistration; we cache
//     its push subscription rather than chase the browser API.
//
// Public API:
//   const { ready, notifications, subscribe, unsubscribe,
//           ack, recent } = usePush()
//   ready          - true once SW is registered + push status
//                    settled (or push isn't available)
//   notifications  - reactive array, newest-first, capped at 50.
//                    Pushed to by the socket listener AND the
//                    SW postMessage on notification-click.
//   subscribe()    - request permission + register with the
//                    server. Idempotent.
//   unsubscribe()  - revoke browser sub + tell the server.
//   ack(id)        - mark notification 'acknowledged' on the
//                    server + remove from the local list.
//   recent()       - pull /api/notifications/me, merge into list.

import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Module-level shared state, survives across component mounts
const notifications = ref([])
const ready = ref(false)
let initialised = false
let socket = null         // socket.io-client passed in by the caller

// Named so bindPushSocket can move it between sockets without
// orphaning a closure on the old one.
const onNotification = (n) => pushIntoList(n)

// Bind (or rebind) the socket the shared notification stream
// listens on. The pooled socket object is different per auth
// token, so a set-once guard would keep listening on the
// PREVIOUS user's socket after sign-out → sign-in.
// NotificationCenter calls this whenever the auth identity
// changes; pass null to detach (sign-out).
export function bindPushSocket(sock) {
  const next = sock || null
  if (next === socket) return
  if (socket) socket.off('notification', onNotification)
  socket = next
  if (socket) socket.on('notification', onNotification)
}

// Most browsers refuse to subscribe to push from an http:// origin.
// Skip the whole flow when serviceWorker / PushManager are missing.
function pushApiAvailable() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && (location.protocol === 'https:' || location.hostname === 'localhost')
}

// Convert a base64url VAPID public key (what the server hands out)
// into the Uint8Array PushManager.subscribe wants.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i)
  return out
}

function pushIntoList(n) {
  if (!n?.id) return
  // Dedup by id so a SW message + socket emit for the same row
  // doesn't double-render. Newest first.
  const existing = notifications.value.findIndex(x => x.id === n.id)
  if (existing >= 0) {
    notifications.value.splice(existing, 1)
  }
  notifications.value.unshift(n)
  if (notifications.value.length > 50) notifications.value.length = 50
}

export function usePush({ socket: sock } = {}) {
  const auth = useAuthStore()
  if (sock) bindPushSocket(sock)

  // Service worker postMessage, fired when the user taps a
  // system notification while the SPA tab is open.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !initialised) {
    initialised = true
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const m = ev.data
      if (m?.type === 'notification-click' && m.id) {
        // Mark read locally; the SW already POSTed the ack.
        notifications.value = notifications.value.filter(n => n.id !== m.id)
      }
    })
  }

  // Subscribe to push. Safe to call multiple times, duplicates
  // just collapse on the endpoint UNIQUE.
  async function subscribe() {
    if (!pushApiAvailable() || !auth.isLoggedIn) {
      ready.value = true
      return { ok: false, reason: 'unavailable' }
    }
    try {
      const reg = await navigator.serviceWorker.register('/sw.js')
      // Pull VAPID public key. If empty → server didn't configure
      // push, fall through to socket-only delivery.
      const r = await fetch('/api/push/vapid-public-key')
      const { key, enabled } = await r.json()
      if (!enabled || !key) {
        ready.value = true
        return { ok: false, reason: 'server-disabled' }
      }
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        ready.value = true
        return { ok: false, reason: 'permission-denied' }
      }
      // PushManager.subscribe is idempotent against the same
      // applicationServerKey, returns the existing sub if there is one.
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
      await auth.apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify(sub.toJSON()),
      })
      ready.value = true
      return { ok: true }
    } catch (err) {
      console.warn('[usePush] subscribe failed', err.message)
      ready.value = true
      return { ok: false, reason: err.message }
    }
  }

  async function unsubscribe() {
    if (!pushApiAvailable()) return
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js')
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await auth.apiFetch('/api/push/subscribe', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
        await sub.unsubscribe().catch(() => {})
      }
    } catch (err) {
      console.warn('[usePush] unsubscribe failed', err.message)
    }
  }

  async function ack(id) {
    if (!id) return
    notifications.value = notifications.value.filter(n => n.id !== id)
    if (socket) socket.emit('notification:ack', { id })
    // belt and braces, also fire the HTTP ack in case the socket is
    // disconnected (idempotent server-side anyway)
    try {
      await auth.apiFetch(`/api/notifications/${id}/acknowledge`, { method: 'POST' })
    } catch { /* silent */ }
  }

  async function recent() {
    if (!auth.isLoggedIn) return
    try {
      const rows = await auth.apiFetch('/api/notifications/me?limit=20')
      // filter out anything already acknowledged, those don't
      // belong in the live banner
      const fresh = (rows || []).filter(r => r.status !== 'acknowledged')
      // Merge into notifications, preserving order.
      for (const r of [...fresh].reverse()) pushIntoList(r)
    } catch { /* silent */ }
  }

  // Auto-subscribe on login, once. The watcher fires when the user
  // identity appears (after a fresh login or the boot-time /me probe)
  // and is wrapped to avoid a duplicate subscribe on hot module reload.
  watch(() => auth.user?.id, (id, prev) => {
    if (id && !prev) {
      subscribe().catch(() => {})
      recent().catch(() => {})
    }
  }, { immediate: true })

  return { ready, notifications, subscribe, unsubscribe, ack, recent }
}
