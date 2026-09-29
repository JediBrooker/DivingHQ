<script setup>
// ControlViewV2, the Stage-Rail Control Room (and the only Control Room now;
// the legacy all-in-one ControlView got removed at cutover).
//
// Top event bar (switch + actions) plus a CENTER mode-switch (Setup / Live
// / Review, plus a Recovery cross-cut). Live mode is the three-column
// board (History, concurrent pool cards, Standings) with per-pool
// controllers + meet-day tools; the mode gets chosen by the shared
// useControlStage derivation. Same /control URL, ?event= deep-link, role
// gate + AppShell as before.
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent, provide } from 'vue'
import { useRoute, onBeforeRouteLeave, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useClubScope, CONTROL_ROOM_ROLES } from '@/composables/useClubScope'
import { useControlStage, liveEventsInOrder } from '@/composables/useControlStage'
import ControlTopBar from '@/components/control/ControlTopBar.vue'
import SetupStage from '@/components/control/SetupStage.vue'
import ReviewStage from '@/components/control/ReviewStage.vue'
import LivePoolCard from '@/components/control/LivePoolCard.vue'
import ScoreCorrectionModal from '@/components/control/ScoreCorrectionModal.vue'
// The Tools drawer (broadcast chooser, overlay picker, sponsors, reserves,
// audit) only mounts on a click and needs the network to do anything, so
// it's split into its own chunk rather than riding along on every live
// board load. It's about half of this view's JS and CSS.
// A Control Room tab stays open for hours though, and after a deploy the
// old chunk hashes are gone (the SPA fallback answers them with HTML), so
// a drawer first opened mid-meet wouldn't show up at all. That's why
// onMounted warms loadDrawer once the board is up: from then on import()
// answers out of the module map and a deploy or a wifi drop can't break it.
// Score correction, check-in and the draw stay static, they queue through
// the outbox and have to keep working through a network blip.
const loadDrawer = () => import('@/components/control/DrawerPanel.vue')
const DrawerPanel = defineAsyncComponent(loadDrawer)
// Only opens after finalising an event that overran its schedule slot, so
// it rides in its own chunk too.
const ReflowModal = defineAsyncComponent(() => import('@/components/ReflowModal.vue'))
import EmptyState from '@/components/EmptyState.vue'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import {
  useLivePools, selectDiver, rosterIndexForActive, competingQueue, rebaseQueue, nextQueueIndex,
  applyRedive, applyRefereeCall, historyNewestFirst,
} from '@/composables/useLivePools'
import { annotateJudgeRows } from '@/composables/useScoreTrim'
import { synchroJudgeGroups } from '@/composables/useScoreCategories'
import { controlKeyIntent, hotkeyBlocked, spaceOwnerOf } from '@/composables/useControlKeymap'
import { diveDescription } from '@/composables/useDiveLabel'
import { invalidateEventScores } from '@/lib/idbCache'
import { activeDiverPayload } from '@/lib/activeDiver'
import { useMeetHold, MEET_HOLD_STORE } from '@/composables/useMeetHold'
import { useHttpOutbox, waitForOutboxEntry } from '@/composables/useHttpOutbox'
import { useOutbox } from '@/composables/useOutbox'
import { confirmAction } from '@/composables/useConfirm'
import { showUndo } from '@/composables/useUndo'
import { showError, showSuccess, showInfo, showWarning } from '@/composables/useNotify'

const route = useRoute()
const auth = useAuthStore()
// Referees run any event in the org here, so only a club / region admin
// with none of the Control Room's roles gets narrowed to their own meets.
const { narrowEvents } = useClubScope(CONTROL_ROOM_ROLES)
const { queueAction, queueSocketAction } = useHttpOutbox()

// Socket + the concurrent-pool live-state engine are hoisted ABOVE the
// mode switch: one subscription for the shell's whole lifetime routes every
// score_received / judge_signal to the matching pool by event_id, so a
// non-focused Live pool still updates its own tiles (useLivePools). The
// frozen trim/sync math itself is untouched, only where the result lands
// is per-pool now. Shot clock + auto-advance live PER-POOL inside each
// LivePoolCard (driven off its own pool state), so the shell just routes
// scores and refreshes side-panel data when a dive completes.
const socket = useSocket()
const { pools, poolFor, routeScore, routeSignal } = useLivePools()

useSocketEvent(socket, 'score_received', (data) => {
  if (data?.event_id) invalidateEventScores(data.event_id)
  const res = routeScore(data, numberOfJudgesFor)
  // A completed dive changes that pool's history + standings, so refresh
  // its side-panel data (whichever pool, focused or not). Each card
  // watches its own pool to stop its clock and arm its own auto-advance.
  // The queue gets re-read too, so a withdrawal or a reserve promoted from
  // the Manager lands before Next walks on.
  if (res.allScoresIn) {
    loadPoolPanels(data.event_id)
    refreshPoolRoster(data.event_id)
  }
})
useSocketEvent(socket, 'judge_signal', (data) => {
  routeSignal(data)
})
// Anything that changes scores after the fact (a correction from any
// operator, the HTTP amend, a referee Failed or Cap, a resolved conflict)
// ends in score_corrected for the event's room. That's the moment the
// server's numbers are new, so that's when History and Standings re-read.
// The correction dialog used to trigger the re-read itself, right after
// queueing its PUT, which usually beat the PUT to the server.
useSocketEvent(socket, 'score_corrected', (data) => {
  if (data?.event_id) {
    invalidateEventScores(data.event_id)
    loadPoolPanels(data.event_id)
  }
})

// A re-dive (from any operator) starts the dive over: the server marks
// its scores 'redive' until the judges score again. Reset that pool's
// tiles and disarm Next so it can't be advanced past the dive on the old
// scores; the card sees rediveSeq move and restarts its clock.
useSocketEvent(socket, 'referee_action_redive', (data) => {
  const pool = data?.event_id != null ? pools[data.event_id] : null
  if (pool) applyRedive(pool, data, numberOfJudgesFor(data.event_id))
})

// A Failed or Cap call on the live dive (from any operator). The server
// has rewritten the scores and score_corrected re-reads History and
// Standings, but the pool's tiles kept the awards from before the call
// until the next diver. applyRefereeCall holds them to it: 0 for a failed
// dive, nothing above the declared maximum for a cap.
useSocketEvent(socket, 'referee_action_failed', (data) => {
  const pool = data?.event_id != null ? pools[data.event_id] : null
  if (pool) applyRefereeCall(pool, data, 'failed')
})
useSocketEvent(socket, 'referee_action_cap', (data) => {
  const pool = data?.event_id != null ? pools[data.event_id] : null
  if (pool) applyRefereeCall(pool, data, 'cap')
})

// A coach withdrew a diver from an event that's live here (routes/coach.js
// emits roster_changed). The pool used to keep the roster it loaded at
// setup, so the operator could call a diver who had already gone. Re-read
// the queue without moving the stage (refreshPoolRoster, see rebaseQueue)
// and say who left. The payload is ids only, so the name comes from the
// fresh roster, which still lists withdrawn rows.
useSocketEvent(socket, 'roster_changed', async (data) => {
  if (!data?.event_id || !pools[data.event_id]) return
  const roster = await refreshPoolRoster(data.event_id)
  if (!roster || data.change !== 'withdrawn') return
  const row = roster.find((r) => String(r.competitor_id) === String(data.competitor_id))
  const ev = events.value.find((e) => String(e.id) === String(data.event_id))
  showWarning(`${row?.full_name || 'A diver'} was withdrawn by their coach${ev ? ` from "${ev.name}"` : ''}.`)
})

// Authoritative active-diver restore. The server answers get_active_diver
// with a state_update carrying the diver it currently has live per event.
// It also replays one on (re)connect, but only for events in the user's
// own org they hold a control role in, so a delegate (a host club admin,
// say) leans on get_active_diver alone. We record it and snap the matching pool
// to that diver, without emitting, so reopening the Control Room
// mid-meet never yanks the judges' panel back to roster[0]. Only a
// genuinely fresh event (no server diver) announces, over in setupLivePool.
const pendingActive = {} // event_id -> latest server state_update payload
const pendingSeed = new Set() // events optimistically seeded, awaiting the server's verdict
const seedTimers = new Set() // fallback timers, cleared on unmount
const SEED_GRACE_MS = 1500

// Set when the view goes away. Everything here that resumes after an
// await checks it: leaving while /api/events (or a roster) was still
// loading used to let the dead instance wire pools anyway, and with its
// socket listeners already gone its seed timer announced diver 1 to the
// judges of any event nobody had started.
let unmounted = false

// Lease conflict state: event_id -> true when another socket (operator or
// window) is also controlling this event (server claim_event_control).
const conflicts = reactive({})

useSocketEvent(socket, 'state_update', (data) => {
  if (!data?.event_id) return
  pendingActive[data.event_id] = data
  seedPoolFromServer(data.event_id)
})

// Lease: the server warns when a second socket drives the same event.
useSocketEvent(socket, 'event_control_conflict', (d) => {
  if (d?.event_id) conflicts[d.event_id] = d.sameUser ? 'another window' : 'another operator'
})
useSocketEvent(socket, 'event_control_contested', (d) => {
  if (d?.event_id) conflicts[d.event_id] = d.sameUser ? 'another window' : 'another operator'
})
useSocketEvent(socket, 'event_control_granted', (d) => {
  if (d?.event_id) delete conflicts[d.event_id]
})

// Queue set_active_diver through the outbox. It persists to IDB and
// drains via socket ack when online; offline entries replay on
// reconnect. That replaced the old token-bucket + drop-detection flow
// (and its "unconfirmed / Retry" banner on the pool card), since the
// outbox's own pending/synced/failed states cover retries now.
// The roster row alone isn't enough: judges and the scoreboard render
// diverName / diveCode / eventName, see src/lib/activeDiver.js.
function emitActiveDiver(ev) {
  const p = pools[ev.id]
  const a = p && p.currentActive
  if (!a) return
  queueSocketAction('set_active_diver', activeDiverPayload(a, ev))
}

// Snap an optimistically-seeded pool to the server's authoritative active
// diver (no emit), but only while it's still awaiting the server's
// verdict (pendingSeed), so a routine state echo during live operation
// can never wipe out the operator's in-progress pool. Clearing pendingSeed
// marks the event as server-resolved, so the roster[0] announce fallback
// won't fire for it anymore. A payload we can't map to a roster row (-1)
// still resolves: we leave the optimistic roster[0] in place but never
// announce over the server's diver.
function seedPoolFromServer(eventId) {
  if (!pendingSeed.has(eventId)) return
  const pool = pools[eventId]
  const active = pendingActive[eventId]
  if (!pool || !active) return
  if (!Array.isArray(pool.roster) || !pool.roster.length) return
  const idx = rosterIndexForActive(pool.roster, active)
  if (idx >= 0 && idx !== pool.currentIndex) {
    selectDiver(pool, idx, numberOfJudgesFor(eventId), diveDescription)
  }
  pendingSeed.delete(eventId)
}

const events = ref([])
const selectedEventId = ref('')
const loading = ref(true)
const loadError = ref('')
const stageTitleEl = ref(null)

const currentEvent = computed(
  () => events.value.find((e) => String(e.id) === String(selectedEventId.value)) || null,
)
const { workflowMode } = useControlStage(currentEvent)

// Safe recovery: meet hold/resume on the FOCUSED event, driving the
// recovery center mode + the focused hold banner. Hold state lives in one
// per-event store shared with every LivePoolCard (provide/inject), so the
// banner, the cards and the 'h' hotkey all agree about which event is
// held, and the banner follows focus from pool to pool. The focused
// pool's clock gets paused by its own card's hold instance, so onHold
// here is a no-op.
const holdStore = reactive({}) // event_id -> { reason }
provide(MEET_HOLD_STORE, holdStore)
const { isHeld, holdReason, holdPromptOpen, holdReasonInput, openHoldPrompt, confirmHold, resumeMeet } =
  useMeetHold({ socket, event: () => currentEvent.value, onHold: () => {}, queueSocketAction, store: holdStore })

// Recovery is the one explicit cross-cutting mode (offer, not seize).
// Off by default so the center always shows the stage mode.
const recoveryOpen = ref(false)
const drawerOpen = ref(false)

// Operator broadcast (/control?broadcast=1, "Operator broadcast (this
// screen)" in the Broadcast chooser): the operator's own screen doubles
// as the projector. The top bar, History and every control go; the pool
// cards and Standings stay, and the hotkeys still drive the meet, since
// the operator is still running it from this keyboard. App.vue drops the
// app shell for it too. Nothing read the flag after the old Control Room
// went, so picking it just closed the chooser.
const kiosk = computed(() => route.query.broadcast === '1')
const kioskExit = computed(() => ({
  path: '/control',
  query: route.query.event ? { event: route.query.event } : {},
}))
watch(kiosk, (on) => { if (on) drawerOpen.value = false })
const centerMode = computed(() => (recoveryOpen.value ? 'recovery' : workflowMode.value))

// Every currently-Live event, paired with its pool -> the multi-pool grid
// in the center renders one LivePoolCard per entry. With one Live event
// it's the classic single 3-column board; with two or three, the cards sit
// side by side so the operator can see every pool at a glance.
// Canonical order (oldest Live first) so grid card N, top-bar chip N, and
// the "N" focus hotkey all point at the same pool. See useControlStage.
const livePools = computed(() =>
  liveEventsInOrder(events.value).map((e) => ({ event: e, pool: poolFor(e.id) })),
)

// History + standings for the FOCUSED pool feed the side columns. Kept in
// the view (not the pure useLivePools engine) since they're fetched per
// pool on setup and refreshed when that pool completes a dive.
const histories = reactive({}) // event_id -> completed-dive cards, newest first
const standingsByEvent = reactive({}) // event_id -> standings rows, total desc
const focusedHistory = computed(() => histories[selectedEventId.value] || [])
const focusedStandings = computed(() => standingsByEvent[selectedEventId.value] || [])

// Collapsible side columns. One Live event -> both open (the full
// 3-column board). Two or more -> auto-collapse to edge drawers so the
// pool cards get the width, though the operator can still peek either
// panel for the focused pool. Manual toggles hold until the Live-event
// count changes.
const historyOpen = ref(true)
const standingsOpen = ref(true)
watch(
  () => livePools.value.length,
  (n) => {
    const multi = n > 1
    historyOpen.value = !multi
    standingsOpen.value = !multi
  },
)

// The two fetches don't depend on each other, so they go out together and
// a refresh after each dive costs the slower one, not both back to back.
// Each still only overwrites its own panel on success.
async function loadPoolPanels(eventId) {
  if (!eventId) return
  await Promise.all([
    auth.apiFetch(`/api/events/${eventId}/history`).then((h) => {
      // /history comes back round ASC, name ASC; put the latest dive on
      // top by the pool's own queue order (see historyNewestFirst).
      histories[eventId] = historyNewestFirst(Array.isArray(h) ? h : [], pools[eventId]?.roster)
    }).catch(() => { /* leave prior history in place */ }),
    auth.apiFetch(`/api/scoreboard/${eventId}`).then((sb) => {
      standingsByEvent[eventId] = Array.isArray(sb?.standings) ? sb.standings : []
    }).catch(() => { /* leave prior standings in place */ }),
  ])
}

// Re-read one pool's queue and keep the live diver where they are (see
// rebaseQueue). A failed fetch leaves the old queue in place. Resolves to
// the full roster it read (withdrawn and reserve rows included), or null.
async function refreshPoolRoster(eventId) {
  const pool = pools[eventId]
  if (!pool) return null
  try {
    const roster = await auth.apiFetch(`/api/events/${eventId}/roster`)
    if (!Array.isArray(roster)) return null
    rebaseQueue(pool, roster)
    return roster
  } catch {
    return null // keep the queue we have
  }
}

function fmtTotal(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

// Per-judge score chips for a History row. /history carries judge_scores +
// judge_numbers as parallel arrays (ordered by judge_number), so zip them
// into the {judge_number, score} shape annotateJudgeRows wants and let it
// apply the WA trim (kept/dropped) using the focused event's panel size + type.
// Returns [{ judge_number, score, dropped, category }] in judge order.
function historyJudgeRows(row) {
  const scores = row?.judge_scores || []
  const nums = row?.judge_numbers || []
  if (!scores.length) return []
  const judges = scores.map((s, i) => ({ judge_number: Number(nums[i] ?? i + 1), score: Number(s) }))
  return annotateJudgeRows(judges, numberOfJudgesFor(selectedEventId.value) || judges.length, currentEvent.value?.event_type)
}

// Synchro: split a History row's annotated chips into Exec A / Exec B /
// Sync clusters using the canonical panel-role mapping (synchroJudgeGroups,
// the same rule the server scoring uses). Returns null for non-synchro or
// unrecognised panel sizes -> the template falls back to a flat strip.
const SYNCHRO_LABELS = { a: 'Exec A', b: 'Exec B', sync: 'Sync' }
function historySynchroGroups(row) {
  const groups = synchroJudgeGroups(numberOfJudgesFor(selectedEventId.value))
  if (!groups) return null
  const rows = historyJudgeRows(row)
  if (!rows.length) return null
  const byJn = new Map(rows.map((r) => [r.judge_number, r]))
  return ['a', 'b', 'sync'].map((role) => ({
    role,
    label: SYNCHRO_LABELS[role],
    scores: groups[role].map((jn) => byJn.get(jn)).filter(Boolean),
  }))
}

// Score correction (#9): clicking a completed dive in the focused pool's
// History column opens the manager-amend modal. /history rows carry
// judge_scores + score_ids, but the modal wants `scores`, so map across.
//
// Only the meet managers of whoever hosts the meet may change a score
// (the club, the region or the federation, never another level), and
// /api/events says so per event as can_change_scores. Everyone else gets
// a read-only History; the server refuses the PUT regardless.
const canChangeScores = computed(() => currentEvent.value?.can_change_scores === true)
function amendable(row) {
  return canChangeScores.value && !!row?.score_ids?.length
}
const correctOpen = ref(false)
const correctTarget = ref(null)
function openCorrection(row) {
  if (!amendable(row)) return
  correctTarget.value = {
    name: row.diverName,
    round: row.round_number,
    dive_code: row.dive_code,
    position: row.position,
    dd: row.dd,
    scores: (row.judge_scores || []).map((s) => parseFloat(s)),
    judge_numbers: row.judge_numbers || [],
    score_ids: row.score_ids,
    competitor_id: row.competitor_id,
    event_id: row.event_id,
  }
  correctOpen.value = true
}
function closeCorrection() {
  correctOpen.value = false
  correctTarget.value = null
}
// The dialog hands back its outbox key. score_corrected normally does the
// refresh, but it goes to the room and a socket mid-reconnect can miss
// it, so re-read once more when the PUT itself has landed.
async function onCorrectionSaved(key, eventId) {
  if ((await waitForOutboxEntry(key, { timeoutMs: 15000 })) === 'synced') loadPoolPanels(eventId)
}

// Announce (#9): push the focused pool's standings to the spectator
// scoreboard ("say it on screen") via announce_score. The server's gate
// reads event_id; this used to send eventId, so every announce was
// refused while the toast said it had gone out. The toast now waits for
// the server's yes.
// The standings go through JSON on the way into the outbox: they're a
// reactive array, and IndexedDB can't clone a Proxy, so the push itself
// threw before anything was queued.
async function announceFocused() {
  const ev = currentEvent.value
  if (!ev || !focusedStandings.value.length) return
  let key
  try {
    key = await queueSocketAction('announce_score', {
      event_id: ev.id,
      standings: JSON.parse(JSON.stringify(focusedStandings.value)),
    })
  } catch (err) {
    showError(`Couldn't announce "${ev.name}" standings: ${err.message}`)
    return
  }
  const status = await waitForOutboxEntry(key)
  if (status === 'synced') showSuccess(`Announced "${ev.name}" standings on the scoreboard.`)
  else if (status === 'failed') showError(`Couldn't announce "${ev.name}" standings.`)
  else showInfo(`"${ev.name}" standings are queued and will go out when the connection's back.`)
}

// The old single-pool nextDiver funnel, generalized to ANY pool so each
// card's primary button advances its OWN event: partial-score
// confirm, then advance that pool's cursor or finalise. Per-pool shot
// clock + auto-advance live in each card, which re-arms its clock when its
// active diver changes here.
//
// The card's own button is disabled while the event is held or the panel
// is short, but Space, the arrow key and the card's Skip all land here,
// so the same gates live here too: nothing moves during a hold, and
// moving past a dive that's short of a full panel (none at all included,
// a no-show) always asks first.
async function advancePool(ev) {
  if (!ev) return
  const p = pools[ev.id]
  if (!p) return
  if (holdStore[String(ev.id)]) {
    showInfo(`"${ev.name}" is on hold. Resume it before moving on.`)
    return
  }
  const totalJudges = numberOfJudgesFor(ev.id) || 0
  const scoresIn = Object.keys(p.scoresThisRound || {}).length
  // The pool's roster is the competing queue already (competingQueue),
  // but nextQueueIndex steps over a withdrawn or reserve row regardless,
  // the same test the card's isLast uses.
  const nextIndex = nextQueueIndex(p.roster, p.currentIndex)
  const isLast = nextIndex < 0
  const isComplete = !!p.advanceArmed && isLast
  const short = !p.advanceArmed && !!p.currentActive
  if (short) {
    const name = p.currentActive.full_name || 'this diver'
    const ok = scoresIn > 0
      ? await confirmAction({
        title: 'Skip ahead with partial scores?',
        body: `Only ${scoresIn} of ${totalJudges || '?'} judges have submitted for this dive in "${ev.name}".`,
        consequences: [
          'The dive will close with whatever scores arrived',
          'Missing judges can still amend via score correction afterwards',
        ],
        confirmLabel: 'Move on',
        confirmKind: 'warn',
      })
      : await confirmAction({
        title: `Skip ${name}?`,
        body: `No judge scores have reached this screen for this dive in "${ev.name}".`,
        consequences: [
          'No score is recorded for this dive',
          'Use it for a no-show or a diver who can\'t dive',
        ],
        confirmLabel: 'Skip diver',
        confirmKind: 'warn',
      })
    if (!ok) return
    // Skipping the last dive in the queue is finishing the event.
    if (isLast) {
      await finalisePool(ev)
      return
    }
  }
  if (isComplete) {
    await finalisePool(ev)
  } else if (selectDiver(p, nextIndex, totalJudges, diveDescription)) {
    // The pool's currentActive changed -> its card re-arms the shot clock.
    // Goes out through the outbox, see emitActiveDiver.
    emitActiveDiver(ev)
  }
}

// Pool cards by event id, so a hotkey can go through the focused card's
// own handlers (see LivePoolCard's defineExpose).
const poolCards = {}
function setPoolCard(eventId, el) {
  if (el) poolCards[eventId] = el
  else delete poolCards[eventId]
}

// Referee call for the FOCUSED pool's active diver, the keyboard path.
// It goes through the card, which cancels its auto-next countdown before
// queueing the call; the view can't reach that timer, and queueing it
// from here let the countdown run on and advance mid-review. Acts only on
// currentEvent so a hotkey never touches a background pool.
function refActionFocused(type) {
  const ev = currentEvent.value
  const a = ev && pools[ev.id]?.currentActive
  if (!a) return
  const card = poolCards[ev.id]
  if (card) {
    card.refAction(type)
    return
  }
  // No card on screen (Recovery mode), so no countdown to cancel either.
  const payload = { event_id: a.event_id, competitor_id: a.competitor_id, round_number: a.round_number }
  if (type === 'failed') queueSocketAction('referee_failed_dive', payload)
  else if (type === 'cap') queueSocketAction('referee_cap_scores', { ...payload, cap_value: 2.0 })
  else if (type === 'redive') queueSocketAction('referee_redive', payload)
}

// Hold / resume the focused pool through its card too (same store as the
// banner, and the card's own hold watcher stops its clock and countdown).
// Recovery mode has no card on screen, so fall back to the view's own.
function toggleHoldFocused() {
  const ev = currentEvent.value
  if (!ev) return
  const card = poolCards[ev.id]
  if (card) card.toggleHold()
  else if (isHeld.value) resumeMeet()
  else confirmHold()
}

// The control the mouse last pressed (see hotkeyBlocked). A button that
// only has focus because it was clicked doesn't get Space, the advance
// does. Tab forgets it, so tabbing back onto that button presses it.
let clickedControl = null
function onPointerDown(e) {
  clickedControl = spaceOwnerOf(e.target)
}

// Per-pool keyboard control. One window listener: controlKeyIntent
// maps the key, hotkeyBlocked keeps it out of inputs, dialogs and the
// buttons Space already presses, and every action resolves through the
// FOCUSED pool (number keys only switch focus).
function onKeydown(e) {
  if (e.key === 'Tab') clickedControl = null
  if (hotkeyBlocked(e, {
    modalOpen: !!document.querySelector('[aria-modal="true"]'),
    clickedControl,
  })) return
  const intent = controlKeyIntent(e, livePools.value.length)
  if (!intent) return
  if (intent.action === 'focus') {
    const lp = livePools.value[intent.arg - 1]
    if (lp) { e.preventDefault(); selectEvent(lp.event.id) }
    return
  }
  if (!currentEvent.value) return
  e.preventDefault()
  if (intent.action === 'advance') advancePool(currentEvent.value)
  else if (intent.action === 'announce') announceFocused()
  else if (intent.action === 'hold') toggleHoldFocused()
  else if (intent.action === 'ref') refActionFocused(intent.arg)
}

// Schedule re-flow after an event that ran long (docs/session-scheduler.md
// §6). The status PUT comes back with a `reflow` proposal when the event's
// block overran by 5+ minutes and later blocks in its session haven't
// started; the operator picks which of them shift. The old Control Room
// opened this and the Stage-Rail rewrite dropped it, so a late-running
// event never offered to move the rest of the session.
const reflowOpen = ref(false)
const reflowProposal = ref(null)
const reflowEventName = ref('')
function closeReflow() {
  reflowOpen.value = false
  reflowProposal.value = null
  reflowEventName.value = ''
}
function onReflowSaved(payload) {
  const n = (payload && payload.count) || 0
  if (n > 0) showSuccess(`Shifted ${n} later block${n === 1 ? '' : 's'} in the schedule.`)
  closeReflow()
}

// Finalise one pool: consequences confirm, PUT Completed, then an undo
// toast, and the re-flow prompt when the event overran its slot.
async function finalisePool(ev) {
  if (!ev) return
  const p = pools[ev.id]
  // pool.roster is already just the divers who compete, so reserves and
  // scratched divers don't pad the email count.
  const diverIds = new Set()
  for (const r of p?.roster || []) {
    diverIds.add(r.competitor_id || r.diver_id || r.dive_list_id)
  }
  const n = diverIds.size
  if (
    !(await confirmAction({
      title: 'Finalise event?',
      body: `"${ev.name}" will flip to Completed and the recap publishes.`,
      consequences: [
        'Public scoreboard switches to recap mode (podium + full standings)',
        'Event lands in the public Results Archive',
        n
          ? `"Results posted" emails go out to ${n} competitor${n === 1 ? '' : 's'} (if email is configured)`
          : '"Results posted" emails go out to every competitor (if email is configured)',
        'Reversible by an org admin via Meet Manager → set status back to Live',
      ],
      confirmLabel: 'Finalise & publish',
      confirmKind: 'primary',
    }))
  ) {
    return
  }
  const evId = ev.id
  const evName = ev.name
  try {
    const res = await auth.apiFetch(`/api/events/${evId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Completed' }),
    })
    const target = events.value.find((e) => String(e.id) === String(evId))
    if (target) target.status = 'Completed' // -> workflowMode flips to review
    if (Array.isArray(res?.reflow?.candidates) && res.reflow.candidates.length) {
      reflowProposal.value = res.reflow
      reflowEventName.value = evName
      reflowOpen.value = true
    }
    // The card unmounts from the live grid (status no longer Live) and its
    // own onUnmounted stops its shot clock; nothing to reset here.
    showUndo({
      message: `Finalised "${evName}" — results published.`,
      timeoutMs: 12000,
      onUndo: async () => {
        await queueAction({
          method: 'PUT',
          url: `/api/events/${evId}/status`,
          body: { status: 'Live' },
          actionType: 'event_status_flip',
        })
        const back = events.value.find((e) => String(e.id) === String(evId))
        if (back) back.status = 'Live'
      },
    })
  } catch (err) {
    showError('Failed to finalise: ' + err.message)
  }
}

function numberOfJudgesFor(eventId) {
  const ev = events.value.find((e) => String(e.id) === String(eventId))
  return parseInt(ev?.number_of_judges) || 0
}

// Stand up a per-event live pool: join its room, load the roster, and put
// an active diver on the stage. Per-pool, so two Live pools stay
// independent.
//
// Active-diver seeding restores the meet's REAL state instead of resetting
// it. The old version blindly emitted set_active_diver for roster[0] on
// mount for EVERY Live event, so merely opening the Control Room yanked
// every judge's panel (even another operator's) back to diver 1, round 1.
// Now we:
//   1. optimistically select roster[0] LOCALLY (no emit) so the stage
//      isn't blank and a non-focused pool's scores route the instant they
//      arrive (applyScore matches on the client's currentActive);
//   2. ask the server who is actually live (get_active_diver). If it has a
//      diver, the state_update echo snaps us to it via seedPoolFromServer,
//      still no emit, so the judges are never reset;
//   3. only when the server has NO diver (a freshly-Live event nobody has
//      started yet) do we announce roster[0], the one load path that emits.
// Join an event's room and claim its lease. Also asks whether it's held:
// the server only replays a hold to a socket that asks, so without this a
// second operator (or a reload) mid-hold saw no banner, a running clock
// and an enabled Next.
function joinPoolRooms(eventId) {
  socket.emit('subscribe_event', { event_id: eventId })
  // Claim the control lease so a second operator/window driving this same
  // event gets warned (advisory; never blocks).
  socket.emit('claim_event_control', { event_id: eventId })
  socket.emit('get_meet_hold', { event_id: eventId })
}

// The server keeps no room membership across a reconnect, and it drops
// this socket's leases when it disconnects. score_received and
// judge_signal only go to event:<id>, so after a wifi blip or a deploy
// every pool went deaf until someone reloaded. Rejoin each wired Live
// pool. get_active_diver just refreshes what the server has on record;
// pendingSeed isn't touched, so a routine reconnect never snaps the
// operator's cursor or announces over it.
useSocketEvent(socket, 'connect', () => {
  for (const ev of events.value) {
    if (ev.status !== 'Live' || !wiredPools.has(ev.id)) continue
    // A resume that happened while we were away never reached us. Forget
    // the hold and let get_meet_hold put it back if it's still on.
    delete holdStore[String(ev.id)]
    joinPoolRooms(ev.id)
    socket.emit('get_active_diver', { event_id: ev.id })
  }
})

async function setupLivePool(ev) {
  if (unmounted) return
  joinPoolRooms(ev.id)
  const pool = poolFor(ev.id)
  try {
    const roster = await auth.apiFetch(`/api/events/${ev.id}/roster`)
    // Gone while the roster was loading: don't seed (or later announce)
    // anything from a dead instance.
    if (unmounted) return
    // Only the rows that dive: withdrawn and reserve rows come back too.
    pool.roster = competingQueue(roster)
    // History + standings for the side columns (fire-and-forget; refreshed
    // again whenever this pool completes a dive).
    loadPoolPanels(ev.id)
    if (!pool.roster.length) return
    selectDiver(pool, 0, ev.number_of_judges, diveDescription)
    pendingSeed.add(ev.id)
    // Pull the authoritative active diver. The echo (or a connect replay
    // that landed before the roster finished loading) snaps us to it.
    socket.emit('get_active_diver', { event_id: ev.id })
    seedPoolFromServer(ev.id)
    // Fallback: the server never answered within the grace window -> this
    // event is freshly Live with nobody up, so announce roster[0]. Guarded
    // on pendingSeed (cleared once the server resolves it) plus a live
    // socket check, so we never clobber an existing diver or announce
    // blind while disconnected.
    const tid = setTimeout(() => {
      seedTimers.delete(tid)
      if (!unmounted && pendingSeed.has(ev.id) && socket.isConnected.value && pool.currentActive) {
        pendingSeed.delete(ev.id)
        emitActiveDiver(ev)
      }
    }, SEED_GRACE_MS)
    seedTimers.add(tid)
  } catch {
    pool.roster = []
  }
}

async function selectEvent(id) {
  selectedEventId.value = String(id)
  // Roving focus: move into the (visually-hidden) stage heading so the
  // switch lands the operator on the focused board, not back in the bar.
  await nextTick()
  stageTitleEl.value?.focus()
}

async function loadEvents() {
  loading.value = true
  try {
    // Club admins without an org role only run their own club's meets,
    // so don't list (or stand up live pools for) the neighbours'.
    events.value = await narrowEvents(await auth.apiFetch('/api/events'))
    loadError.value = ''
    return true
  } catch (err) {
    loadError.value = err?.message || 'Failed to load events'
    return false
  } finally {
    loading.value = false
  }
}

// Events whose live pool is already wired, so a retry doesn't subscribe
// or announce twice. An event that leaves Live stays in here: if it comes
// back (Undo on a finalise) its pool, rooms and cursor are all still good,
// and wiring it again would announce diver 1 over the top.
const wiredPools = new Set()

// Stand up a live pool for EVERY Live event (not just the focused
// one) so non-focused pools keep receiving + routing their scores.
function wireLivePools() {
  for (const ev of events.value) {
    if (ev.status === 'Live' && !wiredPools.has(ev.id)) {
      wiredPools.add(ev.id)
      setupLivePool(ev)
    }
  }
}

function bringUpPools() {
  // Honour /control?event=<id>, the Control Room's deep link.
  const q = route.query.event
  if (q != null && events.value.some((e) => String(e.id) === String(q))) {
    selectedEventId.value = String(q)
  }
  wireLivePools()
}

// An event can go Live after load: Start Event on the Setup stage flips
// the row in place, and another operator can start one too (see
// event_status_changed below). Either way it needs a pool wired, or its
// card sits on "Loading the active diver" and no diver ever reaches the
// judges.
watch(
  () => liveEventsInOrder(events.value).map((e) => e.id).join(),
  () => { if (!loading.value && !loadError.value) wireLivePools() },
)

// Statuses changed somewhere else (another operator, the Manager, an
// Undo in another tab). The server tells every socket; patch our row so
// the board follows. An event we don't have yet (created after this page
// loaded) that's just gone Live gets fetched quietly, without the
// full-page "Loading…" a loadEvents() would flash mid-meet.
useSocketEvent(socket, 'event_status_changed', (d) => {
  if (!d?.event_id || !d.to) return
  const ev = events.value.find((e) => String(e.id) === String(d.event_id))
  if (ev) {
    ev.status = d.to
    return
  }
  if (d.to === 'Live' && (auth.user?.is_system_admin || String(d.org_id) === String(auth.user?.org_id))) {
    mergeNewEvents()
  }
})

async function mergeNewEvents() {
  try {
    const fresh = await narrowEvents(await auth.apiFetch('/api/events'))
    if (!Array.isArray(fresh)) return
    const known = new Set(events.value.map((e) => String(e.id)))
    const added = fresh.filter((e) => !known.has(String(e.id)))
    if (added.length) events.value = [...events.value, ...added]
  } catch { /* the next status change or a reload will catch it */ }
}

// Venue wifi dies, the operator refreshes, /api/events can't be reached and
// they are left staring at an error message in the middle of a meet, with
// no way back other than noticing the wifi came back and hitting reload
// again. Retry the moment the socket reconnects.
watch(socket.isConnected, async (connected) => {
  if (connected && loadError.value) {
    if (await loadEvents() && !unmounted) bringUpPools()
  }
})

onMounted(async () => {
  // Both before the await on purpose. Queued outbox actions from a
  // previous visit still need the leave-page prompt while /api/events is
  // loading, and a listener added after it would outlive a view that was
  // left mid-load (onUnmounted would have run first).
  window.addEventListener('beforeunload', onBeforeUnload)
  // Per-pool operator hotkeys (focused pool only).
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onPointerDown, true)
  if (await loadEvents() && !unmounted) bringUpPools()
  if (unmounted) return
  // Fetch the drawer chunk while the board sits idle so it's already here
  // when someone hits Tools later on. Older Safari has no
  // requestIdleCallback, the timeout covers it.
  ;(window.requestIdleCallback || ((f) => setTimeout(f, 2000)))(() => loadDrawer().catch(() => {}))
})

// Clear any in-flight seed-fallback timers so a pool can't get announced
// after the view is gone. Heads up: useSocketEvent already auto-cleans the
// socket listeners on unmount, this is just for our own timers.
onUnmounted(() => {
  unmounted = true
  seedTimers.forEach(clearTimeout)
  seedTimers.clear()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('beforeunload', onBeforeUnload)
})

const { isOffline, pendingCount: outboxPending } = useOutbox()

onBeforeRouteLeave(() => {
  if (!isOffline.value && outboxPending.value === 0) return true
  const msg = isOffline.value
    ? 'You are offline — leaving the Control Room will lose the current meet state. Stay on this page?'
    : `${outboxPending.value} action(s) are still syncing. Leave anyway?`
  return window.confirm(msg) // eslint-disable-line no-alert
})

function onBeforeUnload(e) {
  if (!isOffline.value && outboxPending.value === 0) return
  e.preventDefault()
}
</script>

<template>
  <div class="cv2" :class="{ 'cv2-kiosk': kiosk }">
    <RouterLink
      v-if="kiosk"
      :to="kioskExit"
      class="cv2-kiosk-exit"
      aria-label="Exit broadcast mode"
      v-tip="'Exit broadcast mode'"
    >✕</RouterLink>
    <ControlTopBar
      v-if="!kiosk"
      :events="events"
      :selected-id="selectedEventId"
      :history-open="historyOpen"
      :standings-open="standingsOpen"
      :recovery-open="recoveryOpen"
      @select="selectEvent"
      @toggle-history="historyOpen = !historyOpen"
      @toggle-standings="standingsOpen = !standingsOpen"
      @toggle-recovery="recoveryOpen = !recoveryOpen"
      @open-tools="drawerOpen = true"
    />

    <section class="cv2-center" aria-label="Current stage">
      <div v-if="isHeld" class="cv2-hold-banner" role="status">
        <span>⏸ Meet held<template v-if="holdReason"> — {{ holdReason }}</template></span>
        <button v-if="!kiosk" type="button" @click="resumeMeet">Resume</button>
      </div>
      <p v-if="loadError" class="cv2-msg cv2-error">{{ loadError }}</p>
      <p v-else-if="loading" class="cv2-msg">Loading…</p>
      <div v-else-if="!currentEvent" class="cv2-empty">
        <EmptyState
          icon="🏁"
          :title="events.length ? 'No event selected' : 'No meets yet'"
          :body="events.length
            ? 'Pick an event from the bar above to run setup, go live, or review results.'
            : 'Create an event to start running it from the Control Room.'"
          :action-label="events.length ? null : 'Create an event'"
          :action-to="events.length ? null : '/manager?new=1'"
        />
      </div>

      <div v-else class="cv2-stage" :data-mode="centerMode">
        <!-- The focused event's NAME now lives only in the top bar. This
             visually-hidden heading is the roving-focus target on switch,
             and it gives screen readers the stage context. -->
        <h1 ref="stageTitleEl" tabindex="-1" class="cv2-sr-title">{{ currentEvent.name }} — {{ currentEvent.status }}</h1>

        <!-- Center mode-switch: exactly one mode per stage. The bodies
             here are placeholders, P6-P8 rebuild the real panels. -->
        <section v-if="centerMode === 'setup'" class="cv2-mode" aria-label="Setup">
          <SetupStage :event="currentEvent" />
        </section>
        <section v-else-if="centerMode === 'meet'" class="cv2-live-layout" aria-label="Live">
          <!-- HISTORY (left). One Live event -> a full column; two or more
               -> a collapsed edge drawer the operator can peek per focused pool. -->
          <aside v-if="historyOpen && !kiosk" class="cv2-side cv2-side-history" aria-label="History">
            <div class="cv2-side-head">
              <span class="cv2-side-title">History</span>
              <button type="button" class="cv2-side-collapse" aria-label="Collapse history" @click="historyOpen = false">‹</button>
            </div>
            <div class="cv2-side-body">
              <p v-if="!focusedHistory.length" class="cv2-side-empty">No completed dives yet.</p>
              <p v-else-if="!canChangeScores" class="cv2-side-note">
                Read-only. Scores on this event can only be changed by the meet managers of the club, region or federation hosting it.
              </p>
              <component
                :is="amendable(h) ? 'button' : 'div'"
                v-for="(h, i) in focusedHistory"
                :key="`${h.competitor_id}-${h.round_number}-${i}`"
                :type="amendable(h) ? 'button' : null"
                class="cv2-hcard"
                :class="{ 'is-clickable': amendable(h) }"
                v-tip="amendable(h) ? 'Amend a judge score on this dive' : null"
                @click="openCorrection(h)"
              >
                <span class="cv2-hcard-round">R{{ h.round_number }}</span>
                <div class="cv2-hcard-main">
                  <span class="cv2-hcard-name">{{ h.diverName }}</span>
                  <span class="cv2-hcard-dive">{{ h.dive_code }}{{ h.position }}</span>
                </div>
                <span class="cv2-hcard-total">{{ fmtTotal(h.total_points) }}</span>
                <!-- Per-judge scores. Synchro events group into Exec A /
                     Exec B / Sync, everything else just shows a flat strip.
                     Kept/dropped trim + categories reuse the global j-* CSS. -->
                <div
                  v-if="currentEvent.event_type === 'synchro_pair' && historySynchroGroups(h)"
                  class="cv2-hcard-judges judge-groups"
                >
                  <div
                    v-for="g in historySynchroGroups(h)"
                    :key="g.role"
                    class="judge-group"
                    :class="`judge-group-${g.role}`"
                  >
                    <span class="judge-group-label">{{ g.label }}</span>
                    <span
                      v-for="(j, ji) in g.scores"
                      :key="ji"
                      class="j-score"
                      :class="[`j-${j.category}`, { 'j-dropped': j.dropped }]"
                    >{{ Number(j.score).toFixed(1) }}</span>
                  </div>
                </div>
                <div v-else-if="historyJudgeRows(h).length" class="cv2-hcard-judges">
                  <span
                    v-for="(j, ji) in historyJudgeRows(h)"
                    :key="ji"
                    class="j-score"
                    :class="[`j-${j.category}`, { 'j-dropped': j.dropped }]"
                  >{{ Number(j.score).toFixed(1) }}</span>
                </div>
              </component>
            </div>
          </aside>
          <button
            v-else-if="!kiosk"
            type="button"
            class="cv2-side-tab"
            aria-label="Open history drawer"
            @click="historyOpen = true"
          ><span class="cv2-side-tab-label">History</span> ›</button>

          <!-- CENTER: one LivePoolCard per Live event. Single Live event
               -> the classic full board; two or three -> side-by-side. -->
          <div class="cv2-pools" :data-count="Math.min(livePools.length, 3)">
            <LivePoolCard
              v-for="lp in livePools"
              :key="lp.event.id"
              :ref="(el) => setPoolCard(lp.event.id, el)"
              :event="lp.event"
              :pool="lp.pool"
              :focused="String(lp.event.id) === String(selectedEventId)"
              :total-judges="numberOfJudgesFor(lp.event.id)"
              :socket="socket"
              :conflict="conflicts[lp.event.id] || null"
              @focus="selectEvent"
              @advance="advancePool(lp.event)"
              @skip="advancePool(lp.event)"
            />
          </div>

          <!-- STANDINGS (right). Same collapse behaviour as History. -->
          <aside v-if="standingsOpen || kiosk" class="cv2-side cv2-side-standings" aria-label="Standings">
            <div class="cv2-side-head">
              <button v-if="!kiosk" type="button" class="cv2-side-collapse" aria-label="Collapse standings" @click="standingsOpen = false">›</button>
              <span class="cv2-side-title">Standings</span>
              <button
                v-if="!kiosk"
                type="button"
                class="cv2-announce"
                :disabled="!focusedStandings.length"
                v-tip="'Announce these standings on the spectator scoreboard'"
                @click="announceFocused"
              >Announce</button>
            </div>
            <div class="cv2-side-body">
              <p v-if="!focusedStandings.length" class="cv2-side-empty">No scores yet.</p>
              <div
                v-for="(s, i) in focusedStandings.slice(0, 12)"
                :key="`${s.competitor_id || s.public_id || i}`"
                class="cv2-srow"
              >
                <!-- the server's RANK(): tied totals share the place -->
                <span class="cv2-srow-rank">{{ s.rank ?? i + 1 }}</span>
                <span class="cv2-srow-name">{{ s.full_name }}</span>
                <span class="cv2-srow-total">{{ fmtTotal(s.total) }}</span>
              </div>
            </div>
          </aside>
          <button
            v-else
            type="button"
            class="cv2-side-tab"
            aria-label="Open standings drawer"
            @click="standingsOpen = true"
          >‹ <span class="cv2-side-tab-label">Standings</span></button>
        </section>
        <section v-else-if="centerMode === 'review'" class="cv2-mode" aria-label="Review">
          <ReviewStage :event="currentEvent" />
        </section>
        <section v-else class="cv2-mode" aria-label="Recovery">
          <p class="cv2-mode-note">Recovery — pause the meet to deal with an issue, then resume. (Score correction + offline/conflict trays: later slice.)</p>
          <div class="cv2-recovery-actions">
            <button v-if="!isHeld" type="button" class="cv2-recovery-btn" @click="openHoldPrompt">⏸ Hold meet</button>
            <button v-else type="button" class="cv2-recovery-btn is-resume" @click="resumeMeet">▶ Resume meet</button>
            <button type="button" class="cv2-recovery-back" @click="recoveryOpen = false">← Back to stage</button>
          </div>
          <div v-if="holdPromptOpen" class="cv2-hold-prompt">
            <label class="cv2-hold-label">Reason (optional)
              <input v-model="holdReasonInput" type="text" class="cv2-hold-input" placeholder="e.g. pool maintenance" />
            </label>
            <div class="cv2-hold-prompt-actions">
              <button type="button" @click="holdPromptOpen = false">Cancel</button>
              <button type="button" class="cv2-hold-confirm" @click="confirmHold">Hold meet</button>
            </div>
          </div>
        </section>
      </div>
    </section>

    <!-- Secondary surfaces (broadcast / reserves / audit / sponsor) live
         in a closed-by-default drawer. v-if-gated so a resting Live canvas
         never mounts this markup, the #9 subtraction. -->
    <DrawerPanel
      v-if="drawerOpen"
      :event="currentEvent"
      @close="drawerOpen = false"
      @roster-changed="(id) => refreshPoolRoster(id)"
    />

    <ReflowModal
      v-if="reflowOpen"
      :open="reflowOpen"
      :proposal="reflowProposal"
      :event-name="reflowEventName"
      @close="closeReflow"
      @saved="onReflowSaved"
    />

    <!-- Score correction (#9): amend a judge score on a completed dive in
         the focused pool's History. Mounted per-open so its draft fields
         reset from the clicked card. -->
    <ScoreCorrectionModal
      v-if="correctOpen && correctTarget"
      :card="correctTarget"
      :event="currentEvent"
      @close="closeCorrection"
      @saved="(key) => onCorrectionSaved(key, selectedEventId)"
    />
  </div>
</template>

<style scoped>
.cv2 { display: flex; flex-direction: column; min-height: 100%; }
.cv2-center { padding: 1.5rem 2rem; min-width: 0; flex: 1; }
/* The event name lives in the top bar now; this heading is the
   visually-hidden roving-focus target on event switch. */
.cv2-sr-title {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.cv2-mode {
  padding: 1.5rem; border: 1px dashed var(--border-2);
  border-radius: var(--radius-lg); color: var(--text-2);
}
.cv2-mode-note { margin: 0 0 0.4rem; font-family: var(--font-mono); font-size: 13px; }
/* Live mode: History | pool grid | Standings. The center holds one
   LivePoolCard per Live event (its own scoped styles). */
.cv2-live-layout { display: flex; gap: 1rem; align-items: stretch; min-height: 62vh; }
.cv2-pools { flex: 1; min-width: 0; display: grid; gap: 1rem; align-content: start; }
.cv2-pools[data-count="1"] { grid-template-columns: minmax(0, 1fr); }
.cv2-pools[data-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cv2-pools[data-count="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.cv2-side {
  flex: 0 0 clamp(220px, 24%, 300px);
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--border-2); border-radius: var(--radius-lg); background: var(--bg-2);
}
.cv2-side-head {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-2);
}
.cv2-side-title { font-family: var(--font-display); font-size: 13px; font-weight: 700; letter-spacing: 0.04em; color: var(--text-2); flex: 1; }
.cv2-side-collapse { border: 0; background: transparent; color: var(--text-3); font-size: 18px; line-height: 1; cursor: pointer; padding: 0 0.25rem; }
.cv2-side-collapse:hover { color: var(--fg); }
.cv2-announce {
  flex: none; padding: 0.25rem 0.6rem; border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-2); cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.cv2-announce:hover:not(:disabled) { color: var(--cyan); border-color: var(--cyan); }
.cv2-announce:disabled { opacity: 0.45; cursor: not-allowed; }
.cv2-side-body { padding: 0.6rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; }
.cv2-side-empty { margin: 0.5rem; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-side-note { margin: 0.25rem 0.5rem 0.4rem; font-size: 12px; line-height: 1.4; color: var(--text-3); }

.cv2-hcard {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem 0.5rem; padding: 0.45rem 0.55rem;
  border: 1px solid var(--border-2); border-radius: var(--radius-sm); background: var(--bg-3);
  width: 100%; text-align: start; font: inherit; color: var(--text-2);
}
.cv2-hcard.is-clickable { cursor: pointer; }
.cv2-hcard.is-clickable:hover { border-color: var(--cyan); }
/* Judge-score chip strip wraps onto its own line under the name/total row. */
.cv2-hcard-judges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; flex-basis: 100%; }
.cv2-hcard-round { font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--text-3); flex: none; width: 28px; }
.cv2-hcard-main { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.cv2-hcard-name { font-size: 13px; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv2-hcard-dive { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.cv2-hcard-total { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--cyan); flex: none; }

.cv2-srow { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.55rem; border-radius: var(--radius-sm); }
.cv2-srow:nth-child(odd) { background: var(--bg-3); }
.cv2-srow-rank { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-3); width: 18px; flex: none; text-align: center; }
.cv2-srow-name { font-size: 13px; color: var(--fg); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv2-srow-total { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--fg); flex: none; }

.cv2-side-tab {
  flex: 0 0 auto; align-self: stretch; width: 2.5rem;
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  border: 1px dashed var(--border-2); border-radius: var(--radius-lg); background: var(--bg-2);
  color: var(--text-3); cursor: pointer; font-family: var(--font-display); font-weight: 700; font-size: 12px;
}
.cv2-side-tab:hover { color: var(--fg); border-color: var(--cyan); }
.cv2-side-tab-label { writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 0.08em; }

.cv2-msg { padding: 3rem; text-align: center; color: var(--text-3); font-family: var(--font-mono); }
.cv2-error { color: var(--red); }
@media (max-width: 860px) {
  /* The top bar already wraps; just tighten the center and stack the live
     board so nothing overflows sideways. */
  .cv2-center { padding: 1rem; }
  /* Stack the live board on narrow screens: side columns and pools go
     full-width, one above the other, so nothing overflows sideways. */
  .cv2-live-layout { flex-direction: column; min-height: 0; }
  .cv2-side { flex-basis: auto; }
  .cv2-pools[data-count] { grid-template-columns: 1fr; }
}

.cv2-recovery-actions { display: flex; gap: 0.6rem; margin-top: 1rem; flex-wrap: wrap; }
.cv2-recovery-btn {
  padding: 0.65rem 1.2rem; font-family: var(--font-display); font-weight: 700; font-size: 13px;
  border-radius: var(--radius); border: 1px solid var(--amber); background: var(--amber); color: var(--bg); cursor: pointer;
}
.cv2-recovery-btn.is-resume { border-color: var(--green); background: var(--green); }
.cv2-recovery-back { padding: 0.65rem 1.2rem; background: transparent; border: 1px solid var(--border-2); color: var(--text-2); border-radius: var(--radius); cursor: pointer; font: inherit; }
.cv2-hold-prompt { margin-top: 1rem; padding: 1rem; border: 1px solid var(--border-2); border-radius: var(--radius); background: var(--bg-3); max-width: 420px; }
.cv2-hold-label { display: block; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-hold-input { display: block; width: 100%; margin-top: 0.4rem; padding: 0.5rem; background: var(--bg); border: 1px solid var(--border-2); border-radius: var(--radius-sm); color: var(--fg); font: inherit; }
.cv2-hold-prompt-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.75rem; }
.cv2-hold-prompt-actions button { padding: 0.4rem 0.9rem; border-radius: var(--radius-sm); border: 1px solid var(--border-2); background: transparent; color: var(--text-2); cursor: pointer; font: inherit; }
.cv2-hold-confirm { background: var(--amber) !important; border-color: var(--amber) !important; color: var(--bg) !important; }
.cv2-hold-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  margin-bottom: 1rem; padding: 0.6rem 1rem; border-radius: var(--radius-sm);
  background: var(--amber); color: var(--bg); font-family: var(--font-display); font-weight: 700; font-size: 13px;
}
.cv2-hold-banner button { padding: 0.3rem 0.8rem; border-radius: var(--radius-sm); border: 1px solid var(--bg); background: transparent; color: var(--bg); cursor: pointer; font: inherit; font-weight: 700; }

/* Operator broadcast (kiosk). Controls hidden rather than unmounted, so
   the cards keep their clocks and hotkeys keep working; type sized for a
   projector across the room. */
.cv2-kiosk .cv2-center { padding: 2rem 2.5rem; }
.cv2-kiosk :deep(.cv2-ref),
.cv2-kiosk :deep(.cv2-primary-slot),
.cv2-kiosk :deep(.cv2-pool-hold),
.cv2-kiosk :deep(.cv2-blockers),
.cv2-kiosk :deep(.cv2-pool-conflict) { display: none; }
.cv2-kiosk :deep(.cv2-live-diver) { font-size: clamp(32px, 4.5vw, 72px); }
.cv2-kiosk :deep(.cv2-live-dive) { font-size: clamp(16px, 1.6vw, 26px); }
.cv2-kiosk :deep(.cv2-tile) { height: clamp(48px, 6vw, 96px); font-size: clamp(18px, 2.2vw, 34px); }
.cv2-kiosk .cv2-srow-name,
.cv2-kiosk .cv2-srow-total { font-size: 16px; }
.cv2-kiosk-exit {
  position: fixed; top: 1rem; inset-inline-end: 1rem; z-index: 90;
  width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-2); border-radius: 50%;
  background: var(--bg-2); color: var(--text-3); text-decoration: none;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700; opacity: 0.5;
}
.cv2-kiosk-exit:hover { opacity: 1; color: var(--cyan); border-color: var(--cyan); }
</style>
