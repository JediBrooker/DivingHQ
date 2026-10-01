<script setup>
// Floating notification banner, shows category-aware in-app
// banners regardless of system push permission. The composable
// (usePush) is the source of truth here; this component just renders
// and lets the user dismiss / act.
//
// Categories with action buttons (referee_signoff is the first,
// judge_call etc. will follow) wire those actions through to the
// component-defined handler map. Everything else just renders as a
// passive "click to open" banner.
import { computed, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePush, bindPushSocket } from '@/composables/usePush'
import { useAuthStore } from '@/stores/auth'
import { acquireSocket } from '@/composables/useSocket'
import { showError, showInfo } from '@/composables/useNotify'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const { notifications, ack, showSignoff } = usePush()

// /control?signoff_request=<id> is where the dashboard's "Waiting for you"
// card, the inbox row and an unanswerable notification tap all send the
// referee. Nothing on that screen reads it, so surface the request here
// as its Approve/Deny banner, wherever in the app the link lands.
// Two sources rather than one getter that builds an array: a fresh array
// counts as a change every time, so any navigation (or a /me refresh)
// would pull an already answered request back up while the query stays.
// A request that's no longer open (answered, withdrawn by the operator,
// replaced, out of time) has no banner left to bring back, so say so
// rather than leave the referee looking for buttons that aren't coming.
// Tapping a notification for one lands here too: the service worker opens
// the app when the server turns its Approve down. Only when the server
// says so, though (showSignoff asks the request itself): a handoff-code
// request has no banner either, and it's still waiting for its code.
const SIGNOFF_GONE = 'That sign-off request is no longer open. It was answered, withdrawn or replaced, or it ran out.'
watch(
  [() => route.query.signoff_request, () => auth.user?.id],
  async ([requestId, userId]) => {
    if (typeof requestId === 'string' && requestId && userId) {
      const eventId = typeof route.query.event === 'string' ? route.query.event : null
      if ((await showSignoff(requestId, { eventId })) === false) showInfo(SIGNOFF_GONE)
    }
  },
  { immediate: true },
)

// One socket per logged-in identity, used for live notification
// reciept + the notification:ack emit. Anonymous sessions get no
// socket (auth gate). Login/logout navigate via router.push with
// NO page reload, so the socket has to follow the auth identity:
// a boot-time acquire would leave a mid-session sign-in with no
// socket, and a sign-out → sign-in with a socket still
// authenticated as the previous user. On every identity change we
// release the old pooled lease, acquire one keyed to the new user
// id, and rebind the shared notification listener.
let releaseSocket = null
watch(() => auth.user?.id, (userId) => {
  if (releaseSocket) {
    releaseSocket()
    releaseSocket = null
  }
  if (userId) {
    // No token passed here, the socket authenticates off the httpOnly
    // session cookie on its handshake. Lease is keyed by user id
    // so a sign-out → sign-in as a different user swaps the socket.
    const lease = acquireSocket({ userId })
    releaseSocket = lease.release
    bindPushSocket(lease.socket)
  } else {
    bindPushSocket(null)
  }
}, { immediate: true })

// Mounted for the app's lifetime in practice, but we release
// defensively just in case a remount tries to double-acquire.
onUnmounted(() => {
  if (releaseSocket) {
    releaseSocket()
    releaseSocket = null
  }
  bindPushSocket(null)
})

// Newest 3 in the floating banner stack, anything older lives
// in the inbox the user can open from the nav (future feature).
// A screen whose buttons live at the bottom (the judge's keypad, route
// meta bannersOnTop) gets them at the top instead, and only the newest,
// so no stack can grow down over Submit. The dry run had "Judging panel
// is live" sitting on a judge's Submit for an hour.
const onTop = computed(() => route.meta?.bannersOnTop === true)
const visible = computed(() => notifications.value.slice(0, onTop.value ? 1 : 3))

// An "is live" banner whose link is the page already open has nothing
// left to do. A judge on /judge?event=X, or one the judge screen just
// moved there by itself, doesn't need a banner saying X is live that
// only takes them to X, so it's acknowledged instead of drawn. Only
// event_live: other notices can point at /dashboard and still need
// reading, and anything with buttons (a sign-off) needs an answer.
function pointsHere(n) {
  const url = n?.action_url
  if (typeof url !== 'string' || !url.startsWith('/')) return false
  let target
  try { target = router.resolve(url) } catch { return false }
  if (target.path !== route.path) return false
  return Object.entries(target.query).every(([k, v]) => String(route.query[k] ?? '') === String(v))
}
watch(
  [() => notifications.value.map((n) => n.id).join(','), () => route.fullPath],
  () => {
    for (const n of notifications.value) {
      if (n.category !== 'event_live' || n.data?.actions?.length) continue
      if (pointsHere(n)) ack(n.id)
    }
  },
  { immediate: true },
)

async function onActionClick(n, action) {
  // Approve / Deny on a referee sign-off banner. The endpoint is
  // category-specific so we dispatch by category.
  if (n.category === 'referee_signoff' && (action === 'approve' || action === 'deny')) {
    try {
      const eventId = n.data?.event_id
      const requestId = n.data?.request_id
      if (!eventId || !requestId) throw new Error('missing event/request')
      await auth.apiFetch(`/api/events/${eventId}/dive-order/sign-off/respond`, {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, decision: action }),
      })
      await ack(n.id)
    } catch (err) {
      // 409 / 404: the request isn't open any more (the socket message
      // that would have taken this banner down didn't reach this device).
      // Nothing was recorded, and the banner has nothing left to answer,
      // so it goes. A late Approve on a request the operator withdrew
      // doesn't count: the Control Room has moved on too.
      if (err?.status === 409 || err?.status === 404) {
        await ack(n.id)
        const was = err.body?.status
        showInfo(was === 'approved' || was === 'declined'
          ? `That sign-off request was already ${was}.`
          : SIGNOFF_GONE)
      } else {
        showError(`Could not record ${action}: ${err.message}`)
      }
    }
    return
  }
  // Generic: ack + open the action URL.
  await ack(n.id)
  if (n.action_url) router.push(n.action_url)
}

async function onBannerClick(n) {
  await ack(n.id)
  if (n.action_url) router.push(n.action_url)
}

async function onDismiss(n, ev) {
  ev.stopPropagation()
  await ack(n.id)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible.length" :class="['notif-stack', { 'notif-stack-top': onTop }]">
      <div v-for="n in visible" :key="n.id"
           :class="['notif-card', `notif-${n.category}`]"
           @click="onBannerClick(n)">
        <button class="notif-dismiss" @click="onDismiss(n, $event)" v-tip="'Dismiss'">✕</button>
        <div class="notif-title">{{ n.title }}</div>
        <div v-if="n.body" class="notif-body">{{ n.body }}</div>
        <div v-if="Array.isArray(n.data?.actions) && n.data.actions.length" class="notif-actions">
          <button v-for="a in n.data.actions" :key="a.action"
                  :class="['notif-action', `notif-action-${a.action}`]"
                  @click.stop="onActionClick(n, a.action)">
            {{ a.title }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.notif-stack {
  /* Anchor against the iOS safe-area on notch iPhones, since the
     referee-signoff banner has Approve/Deny buttons that must not
     overlap the home-indicator gesture zone. max(..) keeps the
     design's 1.5rem inset on devices without safe-area insets, and
     the larger of (inset + 0.75rem, 1.5rem) elsewhere. Same idea on
     the inline-end side for landscape. */
  position: fixed;
  inset-inline-end: max(1.5rem, env(safe-area-inset-right, 0px));
  bottom: max(1.5rem, calc(env(safe-area-inset-bottom, 0px) + 0.75rem));
  display: flex; flex-direction: column; gap: 0.6rem;
  z-index: 9999; max-width: 360px;
  pointer-events: none;
}
/* Top of the screen (route meta bannersOnTop, the judge keypad). Clear of
   the status bar on an installed iPhone, full width on a phone and
   centred on anything wider. Two lines each for title and body keeps the
   card inside the header, well above the keypad. It drops in from above,
   since sliding in from the side starts it past the edge of the screen. */
.notif-stack-top {
  top: max(0.5rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));
  bottom: auto;
  inset-inline-start: max(0.75rem, env(safe-area-inset-left, 0px));
  inset-inline-end: max(0.75rem, env(safe-area-inset-right, 0px));
  max-width: 420px;
  margin-inline: auto;
}
.notif-stack-top .notif-card { animation-name: notif-drop-in; }
.notif-stack-top .notif-title,
.notif-stack-top .notif-body {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.notif-card {
  pointer-events: auto;
  background: var(--surface, #1a1f2e);
  color: var(--text, #f1f5f9);
  border: 1px solid var(--border, #334155);
  border-inline-start: 4px solid var(--cyan, #06b6d4);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  position: relative;
  animation: notif-slide-in 0.25s ease-out;
}
.notif-card:hover { border-inline-start-color: var(--cyan, #06b6d4); }
.notif-referee_signoff { border-inline-start-color: var(--amber, #f59e0b); }
.notif-judge_call      { border-inline-start-color: var(--red, #ef4444); }
.notif-dismiss {
  position: absolute; top: 0.4rem; inset-inline-end: 0.5rem;
  background: transparent; border: none; cursor: pointer;
  font-size: 13px; color: var(--text-3, #64748b);
  /* WCAG 2.5.5: 44×44 minimum. The notif card has Approve and
     Deny buttons just below, so a small ✕ between them risks
     mis-dismissing the alert instead of acting on it. */
  min-width: 44px; min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; line-height: 1;
}
.notif-dismiss:hover { color: var(--text, #f1f5f9); }
.notif-title {
  font-family: var(--font-display, sans-serif);
  font-weight: 800; font-style: italic;
  font-size: 14px; margin-bottom: 0.25rem; padding-inline-end: 1.5rem;
}
.notif-body {
  font-size: 12.5px; color: var(--text-2, #cbd5e1);
  line-height: 1.45;
}
.notif-actions {
  display: flex; gap: 0.4rem; margin-top: 0.7rem;
}
/* WCAG 2.5.5 again: these are the buttons that do the work, and a referee
   answers them on a phone at the poolside. They were about 30px tall next
   to the 44px ✕. */
.notif-action {
  flex: 1; padding: 0.4rem 0.7rem;
  min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--font-display, sans-serif);
  font-weight: 700; font-size: 11.5px;
  letter-spacing: 0.06em; text-transform: uppercase;
  border-radius: 4px; border: 1px solid;
  cursor: pointer; transition: filter 0.15s ease;
}
.notif-action:hover { filter: brightness(1.1); }
.notif-action-approve {
  background: var(--green, #10b981); border-color: var(--green, #10b981);
  color: var(--bg, #0a0e1a);
}
.notif-action-deny {
  background: transparent; border-color: var(--red, #ef4444);
  color: var(--red, #ef4444);
}
@keyframes notif-slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes notif-drop-in {
  from { opacity: 0; transform: translateY(-12px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
