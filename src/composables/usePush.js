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
//   const { ready, notifications, permission, subscribe,
//           unsubscribe, ack, recent } = usePush()
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
//   showSignoff(requestId, { eventId })
//                  - put a referee sign-off request back in the
//                    banner stack (the only place with Approve/Deny)
//                    for a /control?signoff_request=... deep link.
//                    Resolves false only when the server says the
//                    request is no longer open.
//
// The bound socket also drops a sign-off banner when its request closes
// anywhere (referee_signoff_response, see onSignoffClosed).

import { ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

// Module-level shared state, survives across component mounts
const notifications = ref([])
const ready = ref(false)
// 'granted' | 'denied' | 'default', or 'unsupported' where web push
// can't work at all (no PushManager, plain http). Set on first use and
// after every subscribe() so a button that offers push can hide once
// it's on, or when there's no way to turn it on.
const permission = ref('default')
let initialised = false
let socket = null         // socket.io-client passed in by the caller
// Which signed-in user the login watcher already subscribed for. Every
// usePush() caller gets its own watcher, so without this a later mount
// (CoachView, on each visit) re-ran subscribe() + recent() for the same
// session: another permission prompt call, VAPID fetch and inbox pull.
let autoSubscribedFor = null

// Named so bindPushSocket can move it between sockets without
// orphaning a closure on the old one.
const onNotification = (n) => pushIntoList(n)

// A sign-off request closed somewhere: answered on another device,
// withdrawn by the operator, replaced by a newer request or code, or out
// of time (routes/control-room-signoff.js tells the referee's own room
// every time). Its banner has nothing left to answer, so it goes. It used
// to stay up offering Approve / Deny until the referee tapped it and got
// "Request already expired".
const onSignoffClosed = (d) => {
  const requestId = d?.request_id
  if (!requestId) return
  notifications.value = notifications.value.filter(
    (n) => !(n.category === 'referee_signoff' && n.data?.request_id === requestId),
  )
}

// Bind (or rebind) the socket the shared notification stream
// listens on. The pooled socket object is different per auth
// token, so a set-once guard would keep listening on the
// PREVIOUS user's socket after sign-out → sign-in.
// NotificationCenter calls this whenever the auth identity
// changes; pass null to detach (sign-out).
export function bindPushSocket(sock) {
  const next = sock || null
  if (next === socket) return
  if (socket) {
    socket.off('notification', onNotification)
    socket.off('referee_signoff_response', onSignoffClosed)
  }
  socket = next
  if (socket) {
    socket.on('notification', onNotification)
    socket.on('referee_signoff_response', onSignoffClosed)
  }
}

// Most browsers refuse to subscribe to push from an http:// origin.
// Skip the whole flow when serviceWorker / PushManager are missing.
function pushApiAvailable() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && (location.protocol === 'https:' || location.hostname === 'localhost')
}

function readPermission() {
  if (!pushApiAvailable() || typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission || 'default'
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

// Drop the whole list. Called when the signed-in identity changes: the
// list is module state and sign-out is a router.push with no reload, so
// user A's banners (receipts, role decisions, sign-off Approve/Deny
// cards) used to stay on screen at /login and into the next session.
export function clearNotifications() {
  notifications.value = []
}

// Take specific rows out of the floating stack, e.g. once the Inbox has
// marked them read. Otherwise their banners kept floating over the page.
export function dropNotifications(ids) {
  const gone = new Set(ids)
  if (!gone.size) return
  notifications.value = notifications.value.filter(n => !gone.has(n.id))
}

// Revoke this browser's push subscription, server side and in the
// browser. Needs the session cookie for the DELETE, so sign-out has to
// call it before clearing the session (see useSignOut). Never throws.
export async function unsubscribePush(auth) {
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

// Where one sign-off request stands, from the server: 'pending',
// 'approved', 'declined' or 'expired', or null when it couldn't be asked.
// It's the read the operator's dialog polls while it waits, and referees
// are among the Control Room roles it lets in. A request that isn't on
// that event any more (404) counts as closed.
async function signoffRequestStatus(auth, eventId, requestId) {
  if (!eventId || !requestId) return null
  try {
    const r = await auth.apiFetch(
      `/api/events/${encodeURIComponent(eventId)}/dive-order/sign-off/request/${encodeURIComponent(requestId)}`,
    )
    return typeof r?.status === 'string' ? r.status : null
  } catch (err) {
    return err?.status === 404 ? 'expired' : null
  }
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
  permission.value = readPermission()

  // Service worker postMessage, fired when the user taps a
  // system notification while the SPA tab is open.
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && !initialised) {
    initialised = true
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const m = ev.data
      // Approve/Deny pressed on the OS notification itself. The worker has
      // already answered and acked it, so just drop the banner copy.
      if (m?.type === 'notification-answered') {
        if (m.id) notifications.value = notifications.value.filter(n => n.id !== m.id)
        return
      }
      if (m?.type !== 'notification-click') return
      if (m.id) {
        // Mark read locally; the SW already POSTed the ack. Not for a
        // sign-off though: the SW leaves those unacked until they're
        // answered, and its banner is where the answering happens.
        notifications.value = notifications.value.filter(
          n => n.id !== m.id || n.category === 'referee_signoff',
        )
      }
      // The tap was meant to take them somewhere. The SW only focuses
      // this tab, so the routing is ours to do.
      // The router is loaded here rather than at the top: it imports every
      // view, some of which use this composable, and a static import made
      // usePush drag the whole router in wherever it went (the unit tests
      // that load it without a DOM, for one).
      if (m.action_url) {
        import('@/router').then(({ default: router }) => {
          if (m.action_url !== router.currentRoute.value.fullPath) router.push(m.action_url).catch(() => {})
        }).catch(() => {})
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
      const answer = await Notification.requestPermission()
      permission.value = answer
      if (answer !== 'granted') {
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

  function unsubscribe() {
    return unsubscribePush(auth)
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

  // Resolves true when the request's banner is up, false when the request
  // itself is no longer open (answered, withdrawn, replaced or out of
  // time), null when there's no banner for it but nothing says it's
  // closed, or it couldn't be asked.
  //
  // A missing notification doesn't make the request closed. A handoff-code
  // request never had one (the operator cancelled the push and put a code
  // on their screen), and a referee who followed a link to it was told it
  // was no longer open while that screen was still showing the code. So
  // the request is asked about itself, which needs the event the link
  // names.
  async function showSignoff(requestId, { eventId = null } = {}) {
    if (!requestId || !auth.isLoggedIn) return false
    const match = (n) => n?.category === 'referee_signoff' && n.data?.request_id === requestId
    let n = notifications.value.find(match)
    if (!n) {
      try {
        // Acknowledged rows count too: opening the inbox row may have
        // acked it while the request itself is still waiting.
        const rows = await auth.apiFetch('/api/notifications/me?limit=50')
        n = (rows || []).find(match)
      } catch {
        return null
      }
    }
    if (n) {
      pushIntoList(n)
      return true
    }
    const status = await signoffRequestStatus(auth, eventId, requestId)
    return status && status !== 'pending' ? false : null
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
  // identity appears (after a fresh login or the boot-time /me probe).
  // NotificationCenter lives for the whole app and gets there first, so
  // it sees every sign-out and resets the guard for the next sign-in.
  watch(() => auth.user?.id, (id, prev) => {
    // A different person (or nobody) now: the old list isn't theirs.
    if (prev && id !== prev) clearNotifications()
    if (!id) { autoSubscribedFor = null; return }
    if (prev || id === autoSubscribedFor) return
    autoSubscribedFor = id
    subscribe().catch(() => {})
    recent().catch(() => {})
  }, { immediate: true })

  return { ready, notifications, permission, subscribe, unsubscribe, ack, recent, showSignoff }
}

// Test-only: feed a row into the shared list the way the socket does.
export function _pushNotificationForTests(n) {
  pushIntoList(n)
}
