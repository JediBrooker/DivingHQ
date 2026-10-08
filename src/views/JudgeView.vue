<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink, onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { diveDescription } from '@/composables/useDiveLabel'
import { normaliseActiveDiver } from '@/lib/activeDiver'
import { synchroRoleForJudge } from '@/composables/useScoreCategories'
import { heldAward } from '@/composables/useScoreTrim'
import { showInfo, showWarning } from '@/composables/useNotify'
import OfflineBanner from '@/components/OfflineBanner.vue'
import SyncStatusBadge from '@/components/SyncStatusBadge.vue'
import BigScoreDisplay from '@/components/BigScoreDisplay.vue'
import { useOutbox } from '@/composables/useOutbox'
import { isNativeApp } from '@/lib/native-platform'
import { setPoolsideAwake, poolsideHaptic } from '@/lib/poolside'
import { drainOutboxNow } from '@/composables/useHttpOutbox'

const { t } = useI18n()

// Pool deck ergonomics: judging usually happens on a phone left
// face-up on a table for an entire round. Two helpers here:
//
//   1. Screen wake lock so the OS doesn't dim the display
//      mid-dive. Native builds use the OS idle timer; browsers use
//      Screen Wake Lock when available.
//   2. Haptic feedback on score submit + signal so the judge
//      gets a confirmation pulse without having to glance back
//      at the screen. Native builds use Capacitor Haptics; browsers
//      use vibration where available.
//
// Wake lock releases on unmount and reacquires on visibility
// change (the OS drops it when the tab backgrounds, so we
// reacquire on focus to avoid the re-tap dance).
const wakeLock = ref(null)
async function acquireWakeLock() {
  if (isNativeApp()) {
    await setPoolsideAwake(Boolean(eventIdFromUrl.value && !finished.value && document.visibilityState === 'visible')).catch(() => {})
    return
  }
  if (!('wakeLock' in navigator)) return
  try {
    wakeLock.value = await navigator.wakeLock.request('screen')
    wakeLock.value.addEventListener('release', () => { wakeLock.value = null })
  } catch { /* permission denied or unsupported */ }
}
function onVisibilityChange() {
  if (document.visibilityState !== 'visible') {
    if (isNativeApp()) setPoolsideAwake(false).catch(() => {})
    return
  }
  if (!wakeLock.value) acquireWakeLock()
  // A phone that slept through the start, or the finish: go and look
  // (adoptOwnLiveEvent and checkStillLive further down, each a no-op
  // when it doesn't apply).
  adoptOwnLiveEvent()
  checkStillLive()
}
function buzz(pattern) { poolsideHaptic(pattern).catch(() => {}) }

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const socket = useSocket()

// Event id from /judge?event=<id>. Required so the socket can
// subscribe to the right room. Without it, state_update and
// meet_held broadcasts (which the server emits to
// io.to('event:<id>')) never reach this client.
const eventIdFromUrl = computed(() => route.query.event || null)

const user = auth.user

const currentScore = ref(0)
const isHalf = ref(false)
const activeDiver = ref(null)
// Set once the event this screen is judging stops taking scores: its id
// and name, the status it went to (null when all we know is that a score
// came back refused), and the score of this judge's it turned away, if
// there was one, with when that went up (lostAt). While it's set the
// keypad is shut and the header says why. The next diver clears it (see
// endJudgingEvent and clearFinished).
const finished = ref(null)
watch([eventIdFromUrl, finished], () => { if (isNativeApp()) acquireWakeLock() })
const judgeLabel = ref(user?.full_name || 'Judge')
// Connection state lives on the singleton socket itself
// (`socket.isConnected`, a ref), so a parallel `connStatus` ref
// would just duplicate that state. Also, since useSocket is now
// a real singleton, two listeners on `connect`/`disconnect` (the
// composable's + this view's) would race each other.
const submitted = ref(false)
const judgeNumber = ref(null)
// Manual-fallback "big number" mode (P5). When the operator is in
// fallback mode (typing scores from across the room), the judge
// taps "Show big" to fill the screen with their submitted score.
// Tapping anywhere on the big-mode panel returns to normal view.
// Stays hidden until at least one score's been submitted since
// theres nothing to show before that.
const bigDisplayOpen = ref(false)
const lastSubmittedScore = ref(null)
function showBigScore() {
  if (lastSubmittedScore.value == null) return
  bigDisplayOpen.value = true
}
function closeBigScore() {
  bigDisplayOpen.value = false
}

// Outbox singleton lives in src/composables/useOutbox.js. The
// composable returns reactive counts plus the underlying outbox
// instance, so push()/drain() callers go through getOutbox() and
// UI components (OfflineBanner, SyncStatusBadge) stay declarative.
const outboxState = useOutbox()
const outboxInstance = outboxState.outbox
const pendingCount = outboxState.pendingCount
const refreshPendingCount = outboxState.refresh

function getOutbox() { return outboxInstance }

// Per-entry view of the outbox queue. Drives the sync-chip strip
// in the template so a judge sees each individual queued score,
// not just a count. Refreshed on every outbox 'change' emission
// (same trigger as pendingCount) so the list stays in step.
// Filters to non-terminal states so a long-finished synced entry
// doesn't clutter the strip.
const queuedEntries = ref([])
async function refreshQueuedEntries() {
  if (!outboxInstance) {
    queuedEntries.value = []
    return
  }
  const all = await outboxInstance.list({})
  queuedEntries.value = all.filter((e) =>
    e.status === 'pending'
    || e.status === 'inflight'
    || e.status === 'failed'
    || e.status === 'conflict'
  )
  noticeRefusals(all)
}
// The outbox is a module singleton that outlives this view, so the
// listener has to come off again on unmount. Without that every visit to
// the judge screen left one more listener behind, each doing a full IDB
// list() on every outbox change for the rest of the session.
const offQueuedEntries = outboxInstance?.on('change', refreshQueuedEntries)
if (outboxInstance) refreshQueuedEntries()

// Panel of every judge's score for the current dive, keyed by
// judge_number and populated as score_received broadcasts arrive.
// Lets THIS judge see the full panel (e.g. their own 8.5 next
// to J1's 8.0, J3's 7.5, and so on) once everyone has submitted.
const panelScores = ref({})
// Referee-signal flag, true when this judge has flagged the
// referee on the current dive (e.g. didn't see it, wants a
// review). Toggleable, and resets on every state_update.
const signaled = ref(false)
// Per-judge signal state from the rest of the panel, populated
// off the judge_signal broadcasts. Lets THIS judge see when
// another panel member has flagged the referee, so they can
// pause or coordinate before locking their own score in.
const panelSignals = ref({})

const displayValue = computed(() => {
  const val = currentScore.value + (isHalf.value ? 0.5 : 0)
  return val % 1 === 0 ? val.toString() : val.toFixed(1)
})

const scoreIsZero = computed(() => (currentScore.value + (isHalf.value ? 0.5 : 0)) === 0)

// Total judges on the panel for the current event, drives the
// number of slots the panel display renders.
const panelSize = computed(() =>
  parseInt(activeDiver.value?.number_of_judges) || 0,
)
// keypad / submit go inert once a score is in, unless the
// judge has flagged the referee. The flag re-opens the
// keypad so the judge can correct the score, and submitting
// the new score auto-clears the signal.
const keypadLocked = computed(() => !!finished.value || (submitted.value && !signaled.value))
const finishedTitle = computed(() =>
  finished.value?.status === 'Upcoming' ? t('judge.event_not_live') : t('judge.event_finished'))
// List of OTHER judges (excludes this judge's own number) who
// currently have an active signal. Drives the "Judge X flagged
// the referee" banner above the dive panel.
const signalingOthers = computed(() => {
  const me = judgeNumber.value
  return Object.entries(panelSignals.value)
    .filter(([num, sig]) => sig && Number(num) !== me)
    .map(([num]) => Number(num))
    .sort((a, b) => a - b)
})
const panelInCount = computed(() => Object.keys(panelScores.value).length)

// On the smallest phones the header scrolls inside itself (see the phone
// styles at the bottom). A judge who scrolled it down to the panel
// shouldn't meet the next diver half way down it.
const headerEl = ref(null)
watch(
  () => activeDiver.value && `${activeDiver.value.competitor_id}:${activeDiver.value.round_number}`,
  () => { if (headerEl.value) headerEl.value.scrollTop = 0 },
)

// Synchro role, derived from this judge's position in the panel.
// Lets the judge see whether they should be scoring Diver A's
// execution, Diver B's execution, or the synchronisation. The seat map
// is the shared synchroRoleForJudge (the same one scoring uses), so the
// 7-judge panel the Manager allows gets a role too; this used to know
// only 9 and 11.
const SYNCHRO_ROLE_LABELS = {
  a: { label: 'EXEC A', tone: 'a' },
  b: { label: 'EXEC B', tone: 'b' },
  sync: { label: 'SYNCHRONISATION', tone: 'sync' },
}
const synchroRole = computed(() => {
  if (activeDiver.value?.event_type !== 'synchro_pair') return null
  const n = Number(judgeNumber.value)
  const total = Number(activeDiver.value?.number_of_judges)
  if (!n || !total) return null
  return SYNCHRO_ROLE_LABELS[synchroRoleForJudge(n, total)] || null
})

function joinEventRoom() {
  // Use the URL's event id first (set when the judge clicked
  // through from the dashboard), fall back to whatever
  // activeDiver carries (set after the first state_update).
  const evId = eventIdFromUrl.value || activeDiver.value?.event_id
  if (!evId) return
  // subscribe_event joins the room; get_active_diver also joins
  // AND replays the current active state if any. Calling both
  // covers late joiners who load the page after a meet has
  // already started.
  socket.emit('subscribe_event',  { event_id: evId })
  socket.emit('get_active_diver', { event_id: evId })
  socket.emit('get_meet_hold',    { event_id: evId })
}

// Opened without ?event= (the side-nav Judge Terminal link, the guide
// card). The connect replay only covers events this judge sits on, and
// it shows their diver once without joining the room, so the next diver
// never arrived and the keypad sat on the old one (or on "waiting") all
// meet. Take the judge's own Live panel instead: the newest one, since
// my-events comes back newest first. No Live panel just leaves it
// waiting, same as before.
//
// Waiting isn't the end of it though. Judges open this before Start
// Event, and with no event there's no room to hear the first diver in,
// so the look has to happen again once the panel goes live: on the
// status change and the "panel is live" notice (both come to this
// socket), on a reconnect or the phone waking up, and on a slow poll for
// a judge none of those reach. Only ever while the URL names no event.
// A call that lands mid-lookup runs once more afterwards, since that
// lookup may have read the list just before the event flipped.
let adopting = false
let adoptAgain = false
async function adoptOwnLiveEvent() {
  if (eventIdFromUrl.value) return
  if (adopting) { adoptAgain = true; return }
  adopting = true
  try {
    const mine = await auth.apiFetch('/api/judge/my-events')
    const live = Array.isArray(mine) ? mine.find((e) => e.status === 'Live') : null
    if (live && !eventIdFromUrl.value) {
      // Picking the finished event back up means it's Live again (an
      // undone finalise the broadcast didn't bring), so the notice goes.
      reopenFinished(live.id)
      router.replace({ query: { ...route.query, event: live.id } })
    }
  } catch { /* stays on the waiting screen */ } finally {
    adopting = false
    if (adoptAgain) {
      adoptAgain = false
      adoptOwnLiveEvent()
    }
  }
}
const ADOPT_POLL_MS = 10_000
let adoptPoll = null

// The event on screen has stopped taking scores: finalised, put back to
// Upcoming, or a score for it just came back refused. Nothing more can go
// in, so the diver goes, the keypad shuts and the header says the event
// is over. It used to sit on the last diver with Submit lit, and a score
// sent then came back refused and looked like a phone fault. After that
// it waits for the judge's next Live panel the way a phone opened before
// the start does: ?event= comes off and adoptOwnLiveEvent takes over. The
// notice stays until the next diver lands, so a judge whose next panel is
// already running still gets to read it.
function endJudgingEvent(eventId, { status = null, eventName = null, unrecorded = null } = {}) {
  const id = String(eventId)
  const prev = finished.value
  // When the "wasn't recorded" line went up, see clearFinished.
  const lostAt = unrecorded != null ? Date.now() : null
  if (prev?.eventId === id) {
    // Already on screen; a refused score arriving after the broadcast
    // just adds its line.
    finished.value = {
      ...prev,
      status: status ?? prev.status,
      eventName: prev.eventName || eventName,
      unrecorded: unrecorded ?? prev.unrecorded,
      lostAt: lostAt ?? prev.lostAt,
    }
  } else {
    // Some other event's notice gives way to this one, and passes on a
    // score it was showing if it hasn't been up long enough to be read.
    clearFinished()
    const onScreen = String(activeDiver.value?.event_id) === id ? activeDiver.value : null
    finished.value = { eventId: id, status, eventName: eventName || onScreen?.eventName || null, unrecorded, lostAt }
    if (!finished.value.eventName) fillFinishedName(id)
    diveSeq++
    activeDiver.value = null
    resetScore()
    panelScores.value = {}
    panelSignals.value = {}
    signaled.value = false
    judgeNumber.value = null
    judgeLabel.value = user?.full_name || 'Judge'
    isHeld.value = false
    holdReason.value = ''
    bigDisplayOpen.value = false
  }
  // Both ways round, the notice already up included. If the URL still
  // names this event it has to come off, or the page sits on it for good:
  // adoptOwnLiveEvent and the poll only look while the URL names nothing.
  // An event that's only some other one's (the judge has moved on) stays.
  if (String(eventIdFromUrl.value) === id) {
    const query = { ...route.query }
    delete query.event
    router.replace({ query }).then(() => adoptOwnLiveEvent())
  } else {
    adoptOwnLiveEvent()
  }
}

// Takes the finished notice down: the next diver has landed, the event is
// Live again, or another event's finish is taking its place. A score it
// was showing as not recorded still wasn't, though. If that line has only
// been up a moment nobody has read it, which is what happens to a judge
// coming back to the screen after a refusal while their next panel is
// already running: the notice goes up and the replayed diver takes it
// straight down. So then the line moves to a toast instead of vanishing.
const LOST_SCORE_READ_MS = 5000
function clearFinished() {
  const f = finished.value
  if (!f) return
  finished.value = null
  if (f.unrecorded != null && Date.now() - f.lostAt < LOST_SCORE_READ_MS) warnUnrecorded(f.unrecorded)
}

function warnUnrecorded(score) {
  showWarning(t('judge.score_not_recorded', { score: Number(score).toFixed(1) }))
}

// The finished event is Live again (an undone finalise), so it isn't
// finished. Left up, the notice kept the keypad shut on a Live event until
// a diver came, and a second finalise then found it "already on screen".
function reopenFinished(eventId) {
  if (finished.value?.eventId === String(eventId)) clearFinished()
}

// Only needed when neither the diver nor the caller had the name (a
// refused score for an event this screen never showed a diver for).
async function fillFinishedName(id) {
  try {
    const mine = await auth.apiFetch('/api/judge/my-events')
    const ev = Array.isArray(mine) ? mine.find((e) => String(e.id) === id) : null
    if (ev && finished.value?.eventId === id && !finished.value.eventName) {
      finished.value = { ...finished.value, eventName: ev.name }
    }
  } catch { /* the notice reads fine without it */ }
}

// The status broadcast is fire and forget, so this also asks whenever the
// phone may have missed it: opening a link to the event, a reconnect, the
// phone waking up. Only Completed counts here. A link to an Upcoming event
// is a judge getting ready for the start.
async function checkStillLive() {
  const id = eventIdFromUrl.value || activeDiver.value?.event_id
  if (!id || finished.value?.eventId === String(id)) return
  try {
    const mine = await auth.apiFetch('/api/judge/my-events')
    const ev = Array.isArray(mine) ? mine.find((e) => String(e.id) === String(id)) : null
    const now = eventIdFromUrl.value || activeDiver.value?.event_id
    if (ev?.status === 'Completed' && String(now) === String(id)) {
      endJudgingEvent(id, { status: 'Completed', eventName: ev.name })
    }
  } catch { /* a score sent now would still come back refused, and say so */ }
}

// Scores the server turned down for good because their event isn't Live
// any more. The outbox closes those on the first answer (FINAL_REFUSALS
// in useHttpOutbox) rather than retrying them into a failed chip, and this
// is where the judge hears about it. That answer can come back while this
// screen isn't open: the drain runs on every route, so a judge who scored
// offline and then went to the dashboard gets it there. So it's every
// refusal the outbox still has as untold (it keeps them 72h), whenever it
// came back, and each is marked acknowledged once it's been said. The set
// only covers the gap while that write is still going.
const refusalsSeen = new Set()
function noticeRefusals(entries) {
  for (const e of entries) {
    if (e.status !== 'rejected' || e.action_type !== 'submit_score') continue
    if (e.last_error !== 'event_not_live' || e.acknowledged_at) continue
    if (refusalsSeen.has(e.idempotency_key)) continue
    refusalsSeen.add(e.idempotency_key)
    onScoreRefused(e.payload)
    outboxInstance?.acknowledge(e.idempotency_key).catch(() => {})
  }
}

// On the event on screen, or the one that just finished, this is the
// finish the broadcast didn't bring: the notice goes up with the score it
// turned away. For an event the judge has already moved on from, a toast.
function onScoreRefused(payload) {
  const id = String(payload?.event_id)
  const score = Number(payload?.score)
  const current = eventIdFromUrl.value || activeDiver.value?.event_id
  if (!current || String(current) === id || finished.value?.eventId === id) {
    endJudgingEvent(id, { unrecorded: score })
  } else {
    warnUnrecorded(score)
  }
}

useSocketEvent(socket, 'event_status_changed', (d) => {
  if (d?.to === 'Live') {
    // An undone finalise with no diver announced: nothing else would
    // take the notice down, since the server dropped its diver at
    // Completed and there's none to replay.
    reopenFinished(d.event_id)
    adoptOwnLiveEvent()
    return
  }
  // Off Live (finalised, or back to Upcoming), or straight to Completed
  // without ever starting. Either way this screen can't score it.
  if (d?.from !== 'Live' && d?.to !== 'Completed') return
  const current = eventIdFromUrl.value || activeDiver.value?.event_id
  if (current && String(current) === String(d.event_id)) {
    endJudgingEvent(current, { status: d.to })
  }
})
useSocketEvent(socket, 'notification', (n) => {
  if (n?.category === 'event_live' && n.data?.role === 'judge') adoptOwnLiveEvent()
})
// The URL picking up an event (the adopt above, or a link while this
// view is open) has to join that room. On a later reconnect the
// connect handler below does it. A diver that came in for some other
// event while the URL named none (the pooled socket can still sit in a
// scoreboard's room) goes, so the keypad can't score the wrong dive.
watch(eventIdFromUrl, (id) => {
  if (!id) return
  if (activeDiver.value && activeDiver.value.event_id !== id) activeDiver.value = null
  if (socket.connected) joinEventRoom()
  checkStillLive()
})

// Heads up: all socket listeners go through useSocketEvent. The
// pooled socket outlives this view, so bare socket.on registrations
// would stack a duplicate panel/keypad handler every time the
// judge navigates back here. No outbox drain in this one, the
// app-wide hook already drains on every connect.
useSocketEvent(socket, 'connect', () => {
  joinEventRoom()
  adoptOwnLiveEvent()
  checkStillLive()
})

const { isOffline, unsyncedCount } = outboxState

// unsyncedCount, not pendingCount: a score mid-send (waiting on its ack)
// is lost just the same if the judge reloads now.
function onJudgeBeforeUnload(e) {
  if (!isOffline.value && unsyncedCount.value === 0) return
  e.preventDefault()
}

onBeforeRouteLeave(() => {
  if (!isOffline.value && unsyncedCount.value === 0) return true
  const msg = isOffline.value
    ? 'You are offline — leaving the Judge Terminal will lose queued scores. Stay on this page?'
    : `${unsyncedCount.value} score(s) are still syncing. Leave anyway?`
  return window.confirm(msg) // eslint-disable-line no-alert
})

onMounted(() => {
  if (socket.connected) joinEventRoom()
  adoptOwnLiveEvent()
  checkStillLive()
  adoptPoll = setInterval(() => {
    if (!eventIdFromUrl.value && document.visibilityState === 'visible') adoptOwnLiveEvent()
  }, ADOPT_POLL_MS)
  acquireWakeLock()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onVisibilityChange)
  window.addEventListener('beforeunload', onJudgeBeforeUnload)
})

onBeforeUnmount(() => {
  clearInterval(adoptPoll)
  offQueuedEntries?.()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('focus', onVisibilityChange)
  if (isNativeApp()) setPoolsideAwake(false).catch(() => {})
  window.removeEventListener('beforeunload', onJudgeBeforeUnload)
  try { wakeLock.value?.release?.() } catch { /* ignore */ }
  wakeLock.value = null
})
// Hold-state propagation. A held meet should disable scoring,
// since judges shouldn't accidentally submit during a video review.
const isHeld = ref(false)
const holdReason = ref('')

// Which event this screen is judging: the ?event= id when there is one,
// else whatever the active diver belongs to. Every broadcast below is
// checked against it. The pooled socket can still sit in another
// event's room (a scoreboard opened earlier in this tab), and the
// connect replay covers every event this judge is on; taking the last
// one in put some other event's diver on a waiting judge's screen, with
// Submit enabled.
function isMyEvent(eventId) {
  const mine = eventIdFromUrl.value || activeDiver.value?.event_id
  return !mine || String(eventId) === String(mine)
}

useSocketEvent(socket, 'meet_held', (data) => {
  if (!isMyEvent(data?.event_id)) return
  isHeld.value = true
  holdReason.value = data.reason || ''
})
useSocketEvent(socket, 'meet_resumed', (data) => {
  if (!isMyEvent(data?.event_id)) return
  isHeld.value = false
  holdReason.value = ''
})

// One dive: this diver, this round, this event.
function diveKey(d) {
  return d ? `${d.event_id}|${d.competitor_id}|${d.round_number}` : ''
}

// Bumped by anything that changes what this judge has done on the dive
// on screen (a submit, a new diver, a re-dive), so a restore that went
// out before it can't land on top of it.
let diveSeq = 0
// Judge numbers whose score_received landed while a restore was out.
// Those are newer than whatever the restore read, so they're kept.
let arrivedDuringRestore = null
// The last Failed or Cap call heard for a dive, and a count of them, so a
// restore that read the scores before the call can still hold its tiles
// to it (see applyRefereeCallToPanel).
let lastRefereeCall = null
let refereeCallSeq = 0

// A score this judge queued for the dive that the server's answer can't
// have included: waiting in the outbox, mid-send, failed and waiting on a
// Retry, or sent only after the restore asked (`since`). Right after a
// submit the keypad stays shut for all of those, so it does here too. A
// conflict is left out; the server's value (the operator's manual entry)
// is the one that stands there.
async function queuedScoreFor(dive, since) {
  if (!outboxInstance) return null
  try {
    const entries = await outboxInstance.list({ action_type: 'submit_score' })
    const mine = entries.filter((e) =>
      (['pending', 'inflight', 'failed'].includes(e.status)
        || (e.status === 'synced' && Date.parse(e.synced_at) >= since))
      && String(e.payload?.judge_id) === String(user?.id)
      && diveKey(e.payload) === diveKey(dive))
    const last = mine[mine.length - 1]
    return last ? Number(last.payload.score) : null
  } catch { return null }
}

// Show a score as sent, the way the page looks right after Submit:
// the number up, the keypad shut, Submit reading "Score submitted".
function showSubmitted(score) {
  const whole = Math.floor(score)
  currentScore.value = whole
  isHalf.value = score - whole === 0.5
  submitted.value = true
  lastSubmittedScore.value = score
}

// What the server already has for the dive on screen. A reload forgets
// everything, and a reconnect replays the diver, so a judge who had
// scored came back to an open keypad and an empty tile, with nothing to
// say their score was in (one tap would have sent a second, different
// one over it). This puts the panel's tiles back and, when this judge's
// score is in or still queued, shows it and shuts the keypad. When
// there's neither but the keypad is shut, the dive was re-dived while
// this phone wasn't listening, so it opens again. A judge who has
// flagged the referee is correcting their score, so their keypad is
// left alone.
async function restoreDiveScores(dive) {
  if (!dive?.event_id || !dive.competitor_id || !dive.round_number) return
  const seq = diveSeq
  const callSeq = refereeCallSeq
  const since = Date.now()
  const arrived = new Set()
  arrivedDuringRestore = arrived
  let body
  try {
    const q = new URLSearchParams({ competitor_id: dive.competitor_id, round_number: String(dive.round_number) })
    body = await auth.apiFetch(`/api/events/${dive.event_id}/dive-scores?${q}`)
  } catch {
    return
  } finally {
    if (arrivedDuringRestore === arrived) arrivedDuringRestore = null
  }
  const stale = () => seq !== diveSeq || diveKey(activeDiver.value) !== diveKey(dive)
  if (stale() || !Array.isArray(body?.scores)) return
  const tiles = {}
  for (const s of body.scores) tiles[s.judge_number] = Number(s.score)
  for (const n of arrived) {
    if (panelScores.value[n] != null) tiles[n] = panelScores.value[n]
  }
  if (callSeq !== refereeCallSeq && lastRefereeCall?.key === diveKey(dive)) {
    const { call, cap } = lastRefereeCall
    for (const n of Object.keys(tiles)) tiles[n] = heldAward(tiles[n], call, cap)
  }
  panelScores.value = tiles

  const queued = await queuedScoreFor(dive, since)
  if (stale() || signaled.value) return
  const score = queued ?? tiles[body.judge_number]
  if (score != null) showSubmitted(score)
  else if (submitted.value) resetScore()
}

useSocketEvent(socket, 'state_update', async (data) => {
  if (!data || !isMyEvent(data.event_id)) return
  // A diver for the event that just finished (a late or replayed
  // set_active_diver) mustn't reopen the keypad on it. Coming back through
  // the Live adopt, an undone finalise say, puts it back in the URL first.
  if (finished.value?.eventId === String(data.event_id) && eventIdFromUrl.value !== finished.value.eventId) return
  clearFinished()
  // The same dive again is a replay (the reconnect, get_active_diver on
  // a rejoin), not a new diver. Wiping the keypad on it reopened it for
  // a judge who had already scored, so only a different dive resets.
  const sameDive = diveKey(activeDiver.value) === diveKey(data)
  const keepNumber = String(activeDiver.value?.event_id) === String(data.event_id)
    ? activeDiver.value?.judge_number : undefined
  // Replayed payloads from before the Control Room sent diverName /
  // diveCode still need to render, so fill them from the raw row.
  activeDiver.value = { ...normaliseActiveDiver(data), ...(keepNumber ? { judge_number: keepNumber } : {}) }
  if (!sameDive) {
    diveSeq++
    resetScore()
    // New diver / round: previous panel + referee signal are both
    // irrelevant now. The signal would otherwise carry over to the
    // next diver and confuse the referee.
    panelScores.value = {}
    panelSignals.value = {}
    signaled.value = false
  }
  restoreDiveScores(activeDiver.value)

  if (data.event_id) {
    try {
      // auth.apiFetch rather than a raw fetch: same headers, plus
      // the store's expired-session (401 → /login) handling.
      const { judge_number } = await auth.apiFetch(`/api/events/${data.event_id}/my-judge-number`)
      // Another state_update may have landed while this was in flight;
      // only stamp the number onto the diver it was fetched for.
      if (String(activeDiver.value?.event_id) !== String(data.event_id)) return
      judgeNumber.value = judge_number
      activeDiver.value = { ...activeDiver.value, judge_number }
      judgeLabel.value = `${user?.full_name} — J${judge_number}`
    } catch { /* show name only */ }
  }
})

// The referee ordered a re-dive of the dive on screen. The server marks
// its scores 'redive' until each judge scores again, so open the keypad
// back up and clear the panel. The keypad used to stay locked, and a
// judge only got it back by stumbling on the Signal Referee trick.
useSocketEvent(socket, 'referee_action_redive', (data) => {
  const a = activeDiver.value
  if (!a || !data) return
  if (String(data.event_id) !== String(a.event_id)) return
  if (String(data.competitor_id) !== String(a.competitor_id)) return
  if (Number(data.round_number) !== Number(a.round_number)) return
  diveSeq++
  resetScore()
  panelScores.value = {}
  panelSignals.value = {}
  signaled.value = false
})

// A Failed or Cap call on the dive on screen. The server has rewritten
// every judge's stored award, but the panel tiles kept the old ones, so a
// judge couldn't see the call had landed. Hold them to it (heldAward: 0
// for a failed dive, nothing above the declared maximum for a cap).
function applyRefereeCallToPanel(data, call) {
  const a = activeDiver.value
  if (!a || !data) return
  if (String(data.event_id) !== String(a.event_id)) return
  if (String(data.competitor_id) !== String(a.competitor_id)) return
  if (Number(data.round_number) !== Number(a.round_number)) return
  lastRefereeCall = { key: diveKey(a), call, cap: data.cap_value }
  refereeCallSeq++
  const held = {}
  for (const [n, v] of Object.entries(panelScores.value)) held[n] = heldAward(v, call, data.cap_value)
  panelScores.value = held
}
useSocketEvent(socket, 'referee_action_failed', (data) => applyRefereeCallToPanel(data, 'failed'))
useSocketEvent(socket, 'referee_action_cap', (data) => applyRefereeCallToPanel(data, 'cap'))

// judge_signal broadcasts from other panel members. Mirror the
// state into panelSignals so the panel tile turns red and a
// banner surfaces telling THIS judge that someone else needs
// the referee. Resets to false when a judge clears their flag
// (or auto-clears when they submit a fresh score, server-side).
useSocketEvent(socket, 'judge_signal', (data) => {
  if (!activeDiver.value) return
  if (data.event_id      !== activeDiver.value.event_id)      return
  if (data.competitor_id !== activeDiver.value.competitor_id) return
  if (Number(data.round_number) !== Number(activeDiver.value.round_number)) return
  if (data.judge_number == null) return
  panelSignals.value = {
    ...panelSignals.value,
    [data.judge_number]: !!data.signaled,
  }
})

// Every judge tile fills as score_received broadcasts arrive.
// The judge sees the panel build up in real time: their own
// score lights up first when they hit Submit, then the rest
// trickle in as the other panel members lock theirs in.
useSocketEvent(socket, 'score_received', (data) => {
  if (!activeDiver.value) return
  if (data.event_id      !== activeDiver.value.event_id)      return
  if (data.competitor_id !== activeDiver.value.competitor_id) return
  if (Number(data.round_number) !== Number(activeDiver.value.round_number)) return
  if (data.judge_number == null) return
  arrivedDuringRestore?.add(data.judge_number)
  panelScores.value = {
    ...panelScores.value,
    [data.judge_number]: Number(data.score),
  }
})

function pressNumber(n) {
  currentScore.value = n
  if (n === 10) {
    isHalf.value = false
  }
}

function toggleHalf() {
  if (currentScore.value === 10) return
  isHalf.value = !isHalf.value
}

function resetScore() {
  currentScore.value = 0
  isHalf.value = false
  submitted.value = false
}

async function submitScore() {
  if (!activeDiver.value) {
    showInfo('Waiting for an active diver — please wait for the control room to set the current diver.')
    return
  }
  const finalScore = currentScore.value + (isHalf.value ? 0.5 : 0)
  const payload = {
    event_id: activeDiver.value.event_id,
    competitor_id: activeDiver.value.competitor_id,
    round_number: activeDiver.value.round_number,
    dive_id: activeDiver.value.dive_id || null,
    judge_id: user?.id,
    judge_number: activeDiver.value.judge_number || null,
    score: finalScore,
  }

  // Two short pulses confirms the score landed without the
  // judge needing to look back at the locked submit button.
  // Fires the same in both outbox and legacy paths because the
  // judge's intent is captured the moment they tap.
  buzz([20, 60, 30])
  diveSeq++
  submitted.value = true
  // Stash for the big-display fallback (P5). Visible behind a
  // "Show big" button below the keypad; the judge taps it when
  // the operator is in manual-entry mode.
  lastSubmittedScore.value = finalScore

  // If the judge had flagged the referee before submitting, the
  // submission IS the rectification, so auto-clear the signal
  // and let the Control Room's auto-advance resume.
  // Signal-clear is transient and idempotent; we still send it
  // direct (not via outbox) since an offline signal-clear means
  // nothing to a server that never saw the signal.
  const clearSignal = signaled.value
  if (clearSignal) signaled.value = false

  try {
    await getOutbox().push('submit_score', payload, { actorLocalTime: new Date() })
    refreshPendingCount()
    if (clearSignal && socket.connected) {
      socket.emit('judge_signal', {
        event_id:      activeDiver.value.event_id,
        competitor_id: activeDiver.value.competitor_id,
        round_number:  activeDiver.value.round_number,
        judge_id:      user?.id,
        judge_number:  activeDiver.value.judge_number || null,
        signaled:      false,
      })
    }
    // Out through the app-wide sender in useHttpOutbox, the one App.vue
    // arms for the whole session. This screen used to carry its own copy
    // and the two drifted: that one spent an attempt on a send that never
    // left a phone with no signal, let the next score overtake one whose
    // ack timed out, and never came back for a retry it was owed. Offline
    // is fine here, the send is put back for free and the reconnect
    // drains it.
    drainOutboxNow()
  } catch (err) {
    submitted.value = false
    showInfo(`Could not queue score: ${err.message}`)
  }
}

// Toggle the "I need the referee's attention" signal. Emits a
// judge_signal event the server re-broadcasts to the event
// room; the Control Room's panel display picks it up and rings
// the matching judge tile in red. Tapping again clears the
// signal (e.g. judge resolved their query without referee
// involvement).
function toggleRefereeSignal() {
  if (!activeDiver.value) return
  signaled.value = !signaled.value
  // Long buzz when raising a signal (deliberate gesture); short
  // when clearing. Helps a judge confirm the toggle direction
  // without staring at the button.
  buzz(signaled.value ? 90 : 30)
  socket.emit('judge_signal', {
    event_id:      activeDiver.value.event_id,
    competitor_id: activeDiver.value.competitor_id,
    round_number:  activeDiver.value.round_number,
    judge_id:      user?.id,
    judge_number:  activeDiver.value.judge_number || null,
    signaled:      signaled.value,
  })
}

const submitLabel = computed(() => {
  if (pendingCount.value > 0) {
    return pendingCount.value === 1
      ? '⏳ 1 pending — will send when reconnected'
      : `⏳ ${pendingCount.value} pending — will send when reconnected`
  }
  // Signaled trumps submitted: the judge has flagged a need to
  // correct, so prompt them to enter + submit a fresh score.
  if (signaled.value && submitted.value) return 'Submit Corrected Score'
  if (submitted.value) {
    const val = currentScore.value + (isHalf.value ? 0.5 : 0)
    return `✓ ${t('judge.score_submitted')} — ${val % 1 === 0 ? val : val.toFixed(1)}`
  }
  return t('judge.submit_score')
})
</script>

<template>
  <div class="judge-layout">
    <OfflineBanner />
    <!-- Per-entry sync-status strip. Each queued submit gets a
         chip showing its score plus current sync state (pending,
         inflight, failed, conflict). Synced entries drop off the
         strip automatically since refreshQueuedEntries filters
         them out. Empty list → renders nothing. -->
    <div v-if="queuedEntries.length > 0" class="queued-strip">
      <span class="queued-strip-label">{{ $t('judge.queued_label') }}</span>
      <span v-for="entry in queuedEntries"
            :key="entry.idempotency_key"
            class="queued-chip">
        <SyncStatusBadge :status="entry.status" />
        <span class="queued-chip-score">
          {{ Number(entry.payload?.score).toFixed(1) }}
        </span>
      </span>
    </div>
    <!-- Meet-hold banner: Control Room paused the meet. Score
         input is disabled below until the hold lifts. -->
    <div v-if="isHeld" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>
    <!-- Header -->
    <div ref="headerEl" :class="['judge-header', finished ? 'is-finished' : '']">
      <!-- One slim row for who's judging and the two ways out. They used
           to stack down the right-hand side, and on a phone that wrapped
           under the diver's name and took ~100px from the keypad. The
           name can shorten, the J-number never does. -->
      <div class="judge-topbar">
        <div class="judge-id">
          <span class="status-dot" :class="{ connected: socket.isConnected.value }"></span>
          <span class="judge-id-name">{{ user?.full_name || 'Judge' }}</span>
          <span v-if="judgeNumber" class="judge-id-num">— J{{ judgeNumber }}</span>
        </div>
        <div class="judge-links">
          <RouterLink to="/judge-profile" class="btn-back-judge"
                      v-tip="'See how your scoring tracks against the panel-kept mean'">Analysis</RouterLink>
          <RouterLink to="/dashboard" class="btn-back-judge">← Dashboard</RouterLink>
        </div>
      </div>
      <div class="event-name">{{ (finished ? finished.eventName : activeDiver?.eventName) || '—' }}</div>
      <!-- The event stopped taking scores (see endJudgingEvent). Says so,
           says what happened to a score it refused, and what's next. -->
      <div v-if="finished" class="judge-finished" role="status" data-testid="judge-finished">
        <div class="diver-name">{{ finishedTitle }}</div>
        <p v-if="finished.unrecorded != null" class="judge-finished-lost">
          {{ $t('judge.score_not_recorded', { score: finished.unrecorded.toFixed(1) }) }}
        </p>
        <p class="judge-finished-next">
          {{ eventIdFromUrl ? $t('judge.waiting') : $t('judge.waiting_next_panel') }}
        </p>
      </div>
      <div v-else class="diver-name">
        <template v-if="activeDiver?.partner_name">
          {{ activeDiver.diverName }}<span v-if="activeDiver?.country_code" class="diver-country">{{ activeDiver.country_code }}</span>
          <span class="diver-amp">&amp;</span>
          {{ activeDiver.partner_name }}<span v-if="activeDiver?.partner_country" class="diver-country">{{ activeDiver.partner_country }}</span>
        </template>
        <template v-else>
          {{ activeDiver?.diverName || $t('judge.waiting') }}<span v-if="activeDiver?.country_code" class="diver-country">{{ activeDiver.country_code }}</span>
        </template>
      </div>
      <div v-if="activeDiver?.team_name" class="judge-team-line">
        Team: <strong>{{ activeDiver.team_name }}</strong>
      </div>
      <div v-if="synchroRole" :class="['synchro-role', `role-${synchroRole.tone}`]">
        You are scoring: <strong>{{ synchroRole.label }}</strong>
      </div>
      <div v-if="!finished" class="dive-info-row">
        <span class="dive-pill code">{{ activeDiver?.diveCode || '—' }}</span>
        <span class="dive-pill dd">{{ activeDiver?.dd ? `DD ${activeDiver.dd}` : 'DD —' }}</span>
        <span class="dive-desc">{{ activeDiver ? (diveDescription(activeDiver) || '—') : '—' }}</span>
      </div>

      <!-- Live panel: every judge's tile fills as their
           score_received broadcast lands. Highlights this
           judge's own tile so they can read the spread including
           their own contribution at a glance. -->
      <div v-if="activeDiver && panelSize" class="judge-panel">
        <div class="judge-panel-label">
          <span class="judge-panel-count">DIVE PANEL · {{ panelInCount }} / {{ panelSize }}</span>
          <!-- Another panel member tapped Signal Referee, so this judge
               knows to pause or coordinate before locking their score in.
               It shares the label's row on purpose: as a strip of its own
               it added a line, which pushed Signal Referee off a small
               phone and moved the keypad down mid-entry. The flagging
               judge's tile pulses red as well. -->
          <span v-if="signalingOthers.length" class="judge-panel-alert" role="status">
            <span class="signal-dot" aria-hidden="true"></span>
            <span class="judge-panel-alert-text">
              <template v-if="signalingOthers.length === 1">
                Judge {{ signalingOthers[0] }} flagged the referee
              </template>
              <template v-else>
                Judges {{ signalingOthers.join(', ') }} flagged the referee
              </template>
            </span>
          </span>
        </div>
        <div class="judge-panel-tiles">
          <div v-for="n in panelSize" :key="n"
               :class="[
                 'judge-panel-tile',
                 n === judgeNumber ? 'mine' : '',
                 panelScores[n] != null ? 'in' : '',
                 panelSignals[n] ? 'signaled' : '',
               ]">
            <div class="judge-panel-tile-label">J{{ n }}</div>
            <div class="judge-panel-tile-score">
              {{ panelScores[n] != null ? panelScores[n].toFixed(1) : '—' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Score display -->
    <div class="score-zone">
      <div :class="['score-number', scoreIsZero ? 'zero' : '']">{{ displayValue }}</div>
      <div class="score-hint">Current Score Entry</div>
    </div>

    <!-- Keypad: number buttons overwrite the current entry, so
         a judge who fat-fingers a 7 instead of 8 just taps 8 to
         fix it. The Clear button used to live in this grid but
         it was redundant given that behaviour, and too easy to
         hit by accident.

         keypadLocked = submitted AND not signaled. Once the
         judge has tapped Signal Referee the keypad re-opens
         even after submission, since the signal is the operator's
         way of saying "I need to fix this," and a fresh score
         submission rectifies it. -->
    <div class="keypad">
      <!-- 1-9 -->
      <button v-for="n in 9" :key="n" class="key" :disabled="keypadLocked" @click="pressNumber(n)">{{ n }}</button>
      <!-- ½ -->
      <button :class="['key', 'key-half', isHalf ? 'active' : '']" :disabled="keypadLocked" @click="toggleHalf">½</button>
      <!-- 0 -->
      <button class="key key-zero" :disabled="keypadLocked" @click="pressNumber(0)">0</button>
      <!-- 10 -->
      <button class="key key-ten" :disabled="keypadLocked" @click="pressNumber(10)">10</button>
    </div>

    <!-- Signal referee: judges tap this to flag the referee
         (e.g. they didn't see the dive, want a re-dive review,
         scoreboard mismatch). Toggles a bright-red highlight on
         this judge's tile in the Control Room judge grid until
         the next diver lands, or the judge taps again to clear. -->
    <div class="signal-footer">
      <button
        :class="['signal-btn', signaled ? 'signal-btn-on' : '']"
        :disabled="!activeDiver || isHeld"
        @click="toggleRefereeSignal"
        v-tip="signaled ? 'Tap to clear the signal' : 'Flag the referee — e.g. did not see the dive, request a review'"
      >
        <span class="signal-dot"></span>
        {{ signaled ? '✓ Signal sent — tap to cancel' : `${$t('judge.signal_referee')}` }}
      </button>
    </div>

    <!-- Submit + Clear -->
    <div class="submit-footer">
      <div class="submit-row">
        <button class="clear-btn" type="button" :disabled="keypadLocked" @click="resetScore">Clear</button>
        <button
          :class="['submit-btn', (submitted && !signaled) || finished ? 'locked' : '', isHeld ? 'held' : '']"
          :disabled="(submitted && !signaled) || isHeld || !!finished"
          @click="submitScore"
        >{{ finished ? finishedTitle : isHeld ? 'Meet on hold — wait for resume' : submitLabel }}</button>
      </div>
    </div>
    <!-- Manual-fallback "Show big" button (P5). Only renders after
         at least one score has been submitted, and only when the
         outbox shows pending work OR the socket is offline, i.e.
         the scenario where the operator might need to read it off
         the screen. Tap fills the viewport with the score as a
         giant number; tap again to return. -->
    <div v-if="lastSubmittedScore != null && (!socket.isConnected.value || pendingCount > 0)"
         class="big-mode-footer">
      <button class="big-mode-btn"
              type="button"
              @click="showBigScore"
              v-tip="$t('judge.show_big_tip')">
        {{ $t('judge.show_big') }}
      </button>
    </div>
  </div>

  <!-- Big-mode overlay: full-screen, z-index 1000, fixed. -->
  <BigScoreDisplay
    v-if="bigDisplayOpen && lastSubmittedScore != null"
    :score="lastSubmittedScore"
    :judge-number="judgeNumber"
    :judge-name="judgeLabel"
    @close="closeBigScore"
  />
</template>

<style scoped>
/* P1: reduced-motion guard (tracked per-file by the P0 scanner;
   reinforces the global guard in app.css). */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
/* Meet-hold banner, surfaced when the Control Room pauses
   the meet. Same shape on Scoreboard + Control. */
.hold-banner {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 1rem;
  background: var(--amber); color: var(--bg);
  flex-shrink: 0;
}
.hold-pulse {
  font-family: var(--font-display); font-size: 12px; font-weight: 900;
  letter-spacing: 0.2em;
}
.hold-reason {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  opacity: 0.85;
}

/* The event stopped taking scores. Sits where the diver's name was, the
   title in the same type so it reads from arm's length on the table. */
.judge-finished-lost,
.judge-finished-next {
  margin: 0.4rem 0 0;
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.35;
  color: var(--text-2);
}
.judge-finished-lost {
  padding: 0.4rem 0.6rem;
  background: var(--warn-bg);
  border: 1px solid var(--warn-solid);
  border-radius: var(--radius-sm);
  color: var(--warn-fg);
  font-weight: 600;
}

/* Queued-entries strip. Sits below the OfflineBanner; shows each
   queued submit_score with a SyncStatusBadge + the score value.
   Visually quieter than the banner, informational rather than
   alerting. Hides itself when there's nothing in non-terminal
   states. */
.queued-strip {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  background: rgba(245, 158, 11, 0.06);
  border-bottom: 1px solid rgba(245, 158, 11, 0.15);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.queued-strip-label {
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--text-3);
  margin-right: 0.2rem;
}
.queued-chip {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.05rem 0.35rem 0.05rem 0.1rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}
.queued-chip-score {
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 500; font-style: normal;
  color: var(--fg);
  letter-spacing: 0;
}


.judge-layout {
  /* Fills the viewport, and on a phone the whole pad (header, diver,
     keypad, submit/clear, signal) fits one screen. position:fixed
     escapes any global body styling the public auth views inject. The
     keypad flexes to take the leftover space, but only down to its
     floor (see .keypad). Past that, on a phone, the header scrolls
     inside itself (see the phone styles), and only past the header's
     own floor does this scroll. Squashing the keys instead is how an
     iPhone 13 ended up with 18px keys. */
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  touch-action: manipulation;
  user-select: none;
  /* Installed on an iPhone the pad runs up under the status bar and,
     in landscape, the notch. Same brand band as the app shell's topbar
     so the white status text stays readable. */
  border-top: env(safe-area-inset-top, 0px) solid var(--status-band);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  /* The keypad's floor: four rows of 56px keys plus the gaps and padding
     (48px keys on a phone, see the phone styles). */
  --keypad-floor: calc(4 * 56px + 3 * 0.5rem + 1rem);
}

.btn-back-judge {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-3);
  text-decoration: none;
  transition: color 0.15s;
  /* Small type, but a full-height target in the top row. */
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 0 0.5rem;
  white-space: nowrap;
}
.btn-back-judge:hover { color: var(--text); }
.judge-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: -0.25rem -0.5rem 0.25rem 0;
}
.judge-links { display: flex; align-items: center; flex-shrink: 0; }

.judge-header {
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  padding: 0.875rem 1.25rem;
  flex-shrink: 0;
}
.event-name {
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.25rem;
}
.diver-name {
  font-family: var(--font-sans);
  font-size: 26px;
  font-weight: 600;
  font-style: normal;
  letter-spacing: -0.01em;
  color: var(--fg);
  line-height: 1.1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.diver-country {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  font-style: normal;
  letter-spacing: 0.05em;
  color: var(--text-3);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.15rem 0.4rem;
  vertical-align: middle;
}
.diver-amp { color: var(--cyan); margin: 0 0.4em; font-weight: 400; }
.synchro-role {
  display: inline-block;
  margin-top: 0.6rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.35rem 0.75rem; border-radius: 4px;
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text-2);
}
.synchro-role strong { color: var(--text); }
.synchro-role.role-a    { color: var(--role-admin-fg); border-color: rgba(139,92,246,0.45); background: rgba(139,92,246,0.10); }
.synchro-role.role-b    { color: #fbbf24; border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.10); }
.synchro-role.role-sync { color: #34d399; border-color: rgba(16,185,129,0.45); background: rgba(16,185,129,0.10); }
.judge-team-line {
  display: inline-block; margin-top: 0.5rem; margin-inline-end: 0.5rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.3rem 0.7rem; border-radius: 4px;
  border: 1px solid rgba(139,92,246,0.45); background: rgba(139,92,246,0.10); color: var(--role-admin-fg);
}
.judge-team-line strong { color: var(--text); }
.judge-id {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.judge-id-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.judge-id-num { flex-shrink: 0; white-space: nowrap; }
/* One line whatever the dive. A long description (5355B is "Reverse 2½
   Somersaults 2½ Twists Pike") used to wrap onto a line of its own and
   push Signal Referee off a small phone, so it shortens instead. The
   code and DD never do, and the code is what names the dive anyway. */
.dive-info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.625rem;
  min-width: 0;
}
.dive-pill {
  flex-shrink: 0;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.2rem 0.625rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-2);
}
.dive-pill.code { color: var(--text); font-weight: 500; font-size: 13px; }
.dive-pill.dd { color: var(--cyan); border-color: rgba(6,182,212,0.3); background: var(--cyan-dim); }
.dive-desc {
  flex: 1 1 0;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px; color: var(--text-3); font-family: var(--font-mono);
}

/* Live panel display: every judge's tile fills as their score
   lands. The current judge's own tile gets a cyan ring so they
   can see their contribution at a glance amongst the panel. */
.judge-panel {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
/* The label row holds the flag notice too, so it has a fixed line
   height: the notice coming and going mustn't move anything below it. */
.judge-panel-label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
  line-height: 14px;
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.4rem;
}
.judge-panel-count { flex-shrink: 0; white-space: nowrap; }
.judge-panel-tiles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.judge-panel-tile {
  /* Fixed width so the panel's overall footprint stays the
     same whether the tile reads "—" (empty) or "10.0" (max).
     Without this the cells resize dynamically between dives,
     shifting the surrounding layout left and right as scores
     come in. 52px fits "10.0" at the chosen mono font with
     room for padding; flex-shrink: 0 stops grid/flex parents
     from squeezing them. */
  width: 52px;
  flex-shrink: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.4rem;
  text-align: center;
  transition: all 0.15s;
}
.judge-panel-tile.in {
  background: var(--green-dim);
  border-color: var(--green);
}
.judge-panel-tile.mine {
  border-color: var(--cyan);
  box-shadow: 0 0 0 1px var(--cyan);
}
.judge-panel-tile.mine.in {
  background: var(--cyan-dim);
}
.judge-panel-tile-label {
  font-family: var(--font-display); font-size: 8px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3);
}
.judge-panel-tile.in .judge-panel-tile-label { color: var(--green); }
.judge-panel-tile.mine .judge-panel-tile-label { color: var(--cyan); }
.judge-panel-tile-score {
  font-family: var(--font-mono); font-size: 14px; font-weight: 700;
  color: var(--text-3); margin-top: 0.1rem;
}
.judge-panel-tile.in .judge-panel-tile-score { color: var(--text); }
/* Another panel member tapped Signal Referee: bright-red ring
   draws this judge's eye so they pause before locking in
   their own score. Wins over .scored / .mine when both apply
   so a signaling judge stands out regardless of state. */
.judge-panel-tile.signaled {
  border-color: var(--red);
  box-shadow: 0 0 0 2px var(--red), 0 0 14px rgba(239,68,68,0.4);
  animation: judgePanelSignalPulse 1.4s ease-in-out infinite;
}
@keyframes judgePanelSignalPulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--red), 0 0 14px rgba(239,68,68,0.4); }
  50%      { box-shadow: 0 0 0 2px var(--red), 0 0 4px  rgba(239,68,68,0.15); }
}
.judge-panel-tile.signaled .judge-panel-tile-label,
.judge-panel-tile.signaled .judge-panel-tile-score { color: var(--red); }

/* Which other judge(s) flagged the referee, at the end of the panel's
   label row. Red and bold so it reads at a glance; on a narrow phone it
   shortens before the count does. */
.judge-panel-alert {
  display: inline-flex; align-items: center; gap: 0.35rem;
  min-width: 0;
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 700;
  letter-spacing: 0; text-transform: none;
  color: var(--red);
}
.judge-panel-alert .signal-dot { flex-shrink: 0; width: 7px; height: 7px; }
.judge-panel-alert-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.score-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1rem;
  flex-shrink: 0;
  background: var(--bg);
}
.score-number {
  font-family: var(--font-display);
  font-size: 110px;
  font-weight: 900;
  line-height: 1;
  color: var(--text);
  transition: color 0.1s;
  letter-spacing: -0.02em;
}
.score-number.zero { color: var(--text-3); }
.score-hint {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-top: 0.25rem;
}

.keypad {
  /* Compact keypad, buttons are still tap-friendly on touch
     screens but no longer dominate the page on a desktop. Caps
     at a sensible width and height so the layout stays balanced
     against the dive header above. */
  /* Starts at its floor and grows into whatever room is left. The rows
     used to be minmax(0, ...) with min-height 0, so a tall header
     squashed them to nothing. Starting at the floor rather than at its
     full height means it never takes room from the header either: the
     header only gives way (see the phone styles) once the keypad is
     down to the floor. */
  flex: 1 1 var(--keypad-floor);
  min-height: var(--keypad-floor);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* Cap key height so they don't balloon on tall screens, and
     centre them in the leftover space (footers stay pinned to
     the bottom). */
  grid-template-rows: repeat(4, minmax(56px, 84px));
  align-content: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  max-width: 460px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.key {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-sans);
  font-size: 26px;
  font-weight: 600;
  color: var(--fg);
  cursor: pointer;
  transition: all 0.08s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.key:active { background: var(--accent); color: var(--fg-on-accent); border-color: var(--accent); transform: scale(0.94); }
.key-half { font-size: 14px; color: var(--accent); border-color: var(--accent-soft-2); }
.key-half.active { background: var(--accent); color: var(--fg-on-accent); border-color: var(--accent); }
/* Disabled key state, engaged once the judge has submitted.
   Greyed-out and non-interactive so an accidental tap doesn't
   look like it landed but actually no-ops. */
.key:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.key:disabled:active { transform: none; background: var(--surface); color: var(--text); border-color: var(--border); }

/* Signal Referee button sits between the keypad and the submit
   footer. Outline style so it doesn't compete with the cyan
   submit button visually; goes solid red once tapped so the
   judge sees "I sent the flag" at a glance. */
.signal-footer {
  padding: 0 0.75rem;
  flex-shrink: 0;
  max-width: 360px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
/* The signal-flag and submit-score buttons live in the bottom
   bar. On notch iPhones the home-indicator overlays the bottom
   ~20px, so without an env(safe-area-inset-bottom) gutter the
   button edges land inside the system swipe-gesture zone and
   mis-register as "swipe up" instead of a tap. Tested with a
   wet thumb at the deck, since that's the real condition poolside, tbh.
   Where there's no inset it still gets a little gap, it used to sit
   flush on the bottom edge. */
.signal-footer { padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px)); }
.signal-btn {
  width: 100%;
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  background: var(--danger-bg);
  color: var(--danger-fg);
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  padding: 0.75rem;
  border: 1px solid var(--red-100);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
}
.signal-btn:hover:not(:disabled) {
  background: rgba(239,68,68,0.18);
  border-color: var(--red);
}
.signal-btn:active:not(:disabled) { transform: scale(0.98); }
.signal-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.signal-btn.signal-btn-on {
  background: var(--red);
  color: white;
  border-color: var(--red);
  box-shadow: 0 0 0 2px rgba(239,68,68,0.35), 0 0 20px rgba(239,68,68,0.4);
  animation: signalBtnPulse 1.4s ease-in-out infinite;
}
@keyframes signalBtnPulse {
  0%, 100% { box-shadow: 0 0 0 2px rgba(239,68,68,0.35), 0 0 20px rgba(239,68,68,0.4); }
  50%      { box-shadow: 0 0 0 2px rgba(239,68,68,0.15), 0 0 8px  rgba(239,68,68,0.15); }
}
.signal-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--red);
  box-shadow: 0 0 6px var(--red);
}
.signal-btn-on .signal-dot { background: white; box-shadow: 0 0 8px white; }

.submit-footer {
  /* See note on .signal-footer above. Bottom padding adds the
     iOS safe-area inset on top of the design's 0.875rem so the
     submit button never crosses the home-indicator gesture zone. */
  padding: 0.625rem 0.75rem calc(0.875rem + env(safe-area-inset-bottom, 0px));
  flex-shrink: 0;
  max-width: 360px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

/* Manual-fallback "Show big" button (P5). Sits below the submit
   button when the judge is offline or has queued scores; a single
   tap fills the viewport with the score as a giant number so the
   operator can read it from across the room. */
.big-mode-footer {
  padding: 0 0.75rem 0.5rem;
  max-width: 360px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}
.big-mode-btn {
  width: 100%;
  background: transparent;
  color: var(--text-2);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 0.55rem 0.5rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.big-mode-btn:hover {
  color: var(--cyan);
  border-color: rgba(6, 182, 212, 0.55);
}

.submit-btn {
  width: 100%;
  background: var(--accent);
  color: var(--fg-on-accent);
  font-family: var(--font-sans);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  padding: 0.9rem;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
}
.submit-btn:hover:not(:disabled) { background: var(--accent-hover); }
.submit-btn:active:not(:disabled) { transform: scale(0.98); }
.submit-btn:disabled,
.submit-btn.locked { background: var(--surface); color: var(--text-3); border: 1px solid var(--border); cursor: not-allowed; }

/* Bottom buttons: keypad (top, flex) → Submit+Clear → Signal Referee
   pinned to the very bottom, ordered via flex `order`. */
.submit-footer { order: 1; }
.big-mode-footer { order: 2; }
.signal-footer { order: 3; }
.submit-row { display: flex; gap: 0.5rem; align-items: stretch; }
.submit-row .submit-btn { flex: 1; width: auto; }
.clear-btn {
  flex: 0 0 auto;
  background: var(--surface); color: var(--fg-2);
  font-family: var(--font-sans); font-size: 13px; font-weight: 600;
  padding: 0 1.2rem;
  border: 1px solid var(--border-2); border-radius: var(--radius);
  cursor: pointer; transition: background var(--dur) var(--ease);
}
.clear-btn:hover:not(:disabled) { background: var(--surface-hover); }
.clear-btn:active { transform: scale(0.98); }
.clear-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* =========================================================
   Phone-deck ergonomics. Judges work poolside on phones held
   one-handed. The keys stay at least 48px tall (over Apple's 44pt
   and WCAG 2.5.5's 44px) so a wet thumb doesn't mash two at once,
   and the header, score and footers tighten so that the whole pad
   fits an iPhone 13 or 13 mini in Safari, or an iPhone SE added to
   the home screen, without scrolling. A long dive description, a
   synchro pair in a team event or another judge flagging the referee
   doesn't change that: none of them adds a line any more. The budget
   on a 629px screen is roughly: header 187 (220 for the synchro pair),
   score 80, keypad 222 at its floor, submit 63, signal 56. Whatever's
   left grows the keys.

   Shorter than that (an SE in Safari is 548px, the first SE 568px)
   the header gives way rather than the keys: it scrolls inside itself
   down to its own floor, the judge's row, the event, the diver and the
   dive, so the keypad, Submit and Signal Referee all stay whole on the
   screen. The rehearsal had Submit half off the bottom of an SE and
   Signal Referee below it, which a judge had to scroll the whole pad
   to reach.
   ========================================================= */
@media (max-width: 600px) {
  .judge-layout { --keypad-floor: calc(4 * 48px + 3 * 0.4rem + 0.7rem); }
  .judge-header {
    padding: 0.5rem 0.85rem;
    flex: 0 1 auto;
    min-height: 7.6rem;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* When it does scroll, a soft shadow on the edge with more behind it
       says so. The covers ride with the content and the shadows don't,
       so a shadow only shows where the covers have scrolled away. */
    background:
      linear-gradient(var(--bg-2) 30%, transparent) top / 100% 24px no-repeat local,
      linear-gradient(transparent, var(--bg-2) 70%) bottom / 100% 24px no-repeat local,
      radial-gradient(farthest-side at 50% 0, rgba(15, 23, 42, 0.22), transparent) top / 100% 8px no-repeat scroll,
      radial-gradient(farthest-side at 50% 100%, rgba(15, 23, 42, 0.22), transparent) bottom / 100% 8px no-repeat scroll,
      var(--bg-2);
  }
  /* The finished notice is the whole point of the screen then, and the
     keypad is shut, so that header keeps its height and the pad scrolls. */
  .judge-header.is-finished { flex-shrink: 0; }
  .judge-topbar { margin-bottom: 0.15rem; }
  .diver-name { font-size: 20px; }
  .dive-info-row { margin-top: 0.4rem; }
  /* Tighter tracking so a team event's two tags share one line. */
  .synchro-role, .judge-team-line { margin-top: 0.35rem; padding: 0.2rem 0.5rem; letter-spacing: 0.06em; }
  .judge-panel { margin-top: 0.45rem; padding-top: 0.45rem; }
  .judge-panel-label { margin-bottom: 0.3rem; letter-spacing: 0.2em; }
  /* Share the row rather than a fixed 52px each, so a 7-judge panel
     stays on one line on a phone. Still a fixed size for a given
     panel, so nothing moves as the scores come in. */
  .judge-panel-tile { flex: 1 1 0; width: auto; min-width: 40px; max-width: 56px; padding: 0.25rem 0.2rem; }
  .score-zone { padding: 0.35rem 1rem; }
  .score-number { font-size: 64px; }
  .score-hint { margin-top: 0.1rem; }
  .keypad {
    grid-template-rows: repeat(4, minmax(48px, 76px));
    max-width: none;
    padding: 0.35rem 0.6rem;
    gap: 0.4rem;
  }
  .key { font-size: 22px; }
  .key-half { font-size: 18px; }
  .submit-footer { padding: 0.4rem 0.6rem; max-width: none; }
  .submit-btn { padding: 0.8rem; font-size: 17px; min-height: 50px; }
  .signal-footer { max-width: none; padding-inline: 0.6rem; }
  .signal-btn { padding: 0.8rem 0.75rem; font-size: 14px; min-height: 48px; }
  .big-mode-footer { max-width: none; padding-inline: 0.6rem; }
}

/* Short phones (an iPhone SE or 13 in Safari, a phone in landscape):
   a smaller score number buys the keys their room. */
@media (max-height: 700px) {
  .score-zone { padding-block: 0.25rem; }
  .score-number { font-size: 54px; }
}

/* The shortest (an SE in Safari, the first SE): the score number
   shrinks again and loses its caption, and the header tightens, so it
   has to give way as little as it can. What it hides first is the
   panel's tiles, under the label row (and the flag notice in it). */
@media (max-width: 600px) and (max-height: 600px) {
  .score-zone { padding-block: 0.15rem; }
  .score-number { font-size: 46px; }
  .score-hint { display: none; }
  .submit-footer { padding-block: 0.3rem; }
  .event-name { margin-bottom: 0.1rem; }
  .dive-info-row { margin-top: 0.25rem; }
  .judge-panel { margin-top: 0.3rem; padding-top: 0.3rem; }
  .judge-panel-label { margin-bottom: 0.2rem; }
}
</style>
