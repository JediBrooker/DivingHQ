<script setup>
// ControlViewV2 — the Stage-Rail Control Room (the only Control Room; the
// legacy all-in-one ControlView was removed at cutover).
//
// A top event bar (switch + actions) + a CENTER mode-switch (Setup / Live
// / Review, plus a Recovery cross-cut). Live mode is the three-column
// board (History · concurrent pool cards · Standings) with per-pool
// controllers + meet-day tools; the mode is chosen by the shared
// useControlStage derivation. Same /control URL, ?event= deep-link, role
// gate + AppShell as before.
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useControlStage } from '@/composables/useControlStage'
import ControlTopBar from '@/components/control/ControlTopBar.vue'
import SetupStage from '@/components/control/SetupStage.vue'
import ReviewStage from '@/components/control/ReviewStage.vue'
import LivePoolCard from '@/components/control/LivePoolCard.vue'
import ScoreCorrectionModal from '@/components/control/ScoreCorrectionModal.vue'
import DrawerPanel from '@/components/control/DrawerPanel.vue'
import EmptyState from '@/components/EmptyState.vue'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { useLivePools, selectDiver, rosterIndexForActive } from '@/composables/useLivePools'
import { diveDescription } from '@/composables/useDiveLabel'
import { idbInvalidate } from '@/lib/idbCache'
import { makeTokenBucket } from '@/lib/token-bucket'
import { useMeetHold } from '@/composables/useMeetHold'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { confirmAction } from '@/composables/useConfirm'
import { showUndo } from '@/composables/useUndo'
import { showError, showSuccess } from '@/composables/useNotify'

const route = useRoute()
const auth = useAuthStore()
const { queueAction } = useHttpOutbox()

// Socket + the concurrent-pool live-state engine are hoisted ABOVE the
// mode switch: ONE subscription for the shell's lifetime routes every
// score_received / judge_signal to the matching pool by event_id, so a
// non-focused Live pool still updates its own tiles (useLivePools). The
// frozen trim/sync math is untouched -- only WHERE the result lands is
// per-pool. The shot clock + auto-advance now live PER-POOL inside each
// LivePoolCard (driven off its pool state), so the shell just routes
// scores and refreshes side-panel data on completion.
const socket = useSocket()
const { pools, poolFor, routeScore, routeSignal } = useLivePools()

useSocketEvent(socket, 'score_received', (data) => {
  if (data?.event_id) idbInvalidate(`/api/scoreboard/${data.event_id}`).catch(() => {})
  const res = routeScore(data, numberOfJudgesFor)
  // A completed dive changes that pool's history + standings -> refresh
  // its side-panel data (for whichever pool, focused or not). Each card
  // watches its own pool to stop its clock + arm its own auto-advance.
  if (res.allScoresIn) loadPoolPanels(data.event_id)
})
useSocketEvent(socket, 'judge_signal', (data) => {
  routeSignal(data)
})

// AUTHORITATIVE active-diver restore. The server replays state_update on
// (re)connect and in reply to get_active_diver, carrying the diver it
// currently has live per event. We record it and snap the matching pool
// to that diver -- WITHOUT emitting -- so reopening the Control Room
// mid-meet never yanks the judges' panel back to roster[0]. Only a
// genuinely fresh event (no server diver) announces, in setupLivePool.
const pendingActive = {} // event_id -> latest server state_update payload
const pendingSeed = new Set() // events optimistically seeded, awaiting the server's verdict
const seedTimers = new Set() // fallback timers, cleared on unmount
const SEED_GRACE_MS = 1500

// #7 RATE-LIMIT + DROP-DETECTION. set_active_diver is capped server-side
// at 60/min/user and over-budget emits are dropped SILENTLY -- so a diver
// change can fail to reach the judges. The token bucket staggers bursts
// under the budget; drop-detection waits for the server's state_update
// echo and flags the pool (a Retry on its card) if the change never
// confirms. unconfirmed is reactive so the card can surface the warning.
const activeDiverBucket = makeTokenBucket({ capacity: 40, refillPerMin: 40 })
const pendingConfirm = {} // event_id -> { competitor_id, round_number }
const unconfirmed = reactive({}) // event_id -> true when a set_active_diver wasn't echoed
const confirmTimers = new Set()
const CONFIRM_TIMEOUT_MS = 4000

// LEASE conflict state: event_id -> true when another socket (operator or
// window) is also controlling this event (server claim_event_control).
const conflicts = reactive({})

useSocketEvent(socket, 'state_update', (data) => {
  if (!data?.event_id) return
  pendingActive[data.event_id] = data
  // Drop-detection: a state_update matching our pending diver confirms the
  // set_active_diver landed -> clear the warning.
  const pc = pendingConfirm[data.event_id]
  if (pc && String(pc.competitor_id) === String(data.competitor_id) && Number(pc.round_number) === Number(data.round_number)) {
    delete pendingConfirm[data.event_id]
    delete unconfirmed[data.event_id]
  }
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

// Emit set_active_diver for a pool THROUGH the token bucket, then watch
// for the server's echo; if it doesn't arrive within the window, flag the
// pool as unconfirmed so the operator can retry (judges may be on a stale
// diver). The lone funnel for every set_active_diver the shell sends.
function emitActiveDiver(ev) {
  const p = pools[ev.id]
  const a = p && p.currentActive
  if (!a) return
  pendingConfirm[ev.id] = { competitor_id: a.competitor_id, round_number: a.round_number }
  delete unconfirmed[ev.id] // re-attempt clears any stale warning
  const payload = { ...a, status: 'ready' }
  activeDiverBucket(() => {
    socket.emit('set_active_diver', payload)
    const tid = setTimeout(() => {
      confirmTimers.delete(tid)
      const pc = pendingConfirm[ev.id]
      if (pc && String(pc.competitor_id) === String(a.competitor_id) && Number(pc.round_number) === Number(a.round_number)) {
        unconfirmed[ev.id] = true
      }
    }, CONFIRM_TIMEOUT_MS)
    confirmTimers.add(tid)
  })
}

// Snap an optimistically-seeded pool to the server's authoritative active
// diver (no emit), but ONLY while it is still awaiting the server's
// verdict (pendingSeed) -- so a routine state echo during live operation
// can never wipe the operator's in-progress pool. Clearing pendingSeed
// marks the event server-resolved, so the roster[0] announce fallback
// won't fire for it. A payload we can't map to a roster row (-1) still
// resolves: we leave the optimistic roster[0] in place but never announce
// over the server's diver.
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

// SAFE RECOVERY: meet hold/resume on the FOCUSED event, driving the
// recovery center mode + the focused hold banner. Per-pool hold (from any
// card) lives inside LivePoolCard; this focused instance mirrors the same
// server meet_held/meet_resumed broadcasts so the two stay in sync. The
// focused pool's clock is paused by its own card's hold instance, so
// onHold here is a no-op.
const { isHeld, holdReason, holdPromptOpen, holdReasonInput, openHoldPrompt, confirmHold, resumeMeet } =
  useMeetHold({ socket, event: () => currentEvent.value, onHold: () => {} })

// Recovery is the one explicit cross-cutting mode (offer-not-seize).
// Off by default so the center always shows the stage mode.
const recoveryOpen = ref(false)
const drawerOpen = ref(false)
const centerMode = computed(() => (recoveryOpen.value ? 'recovery' : workflowMode.value))

// Every currently-Live event, paired with its pool -> the multi-pool grid
// in the center renders one LivePoolCard per entry. With one Live event
// it's the classic single 3-column board; with two or three the cards sit
// side by side so the operator sees every pool at a glance.
const livePools = computed(() =>
  events.value
    .filter((e) => e.status === 'Live')
    .map((e) => ({ event: e, pool: poolFor(e.id) })),
)

// History + standings for the FOCUSED pool feed the side columns. Kept in
// the view (not the pure useLivePools engine): fetched per pool on setup
// and refreshed when that pool completes a dive.
const histories = reactive({}) // event_id -> completed-dive cards, newest first
const standingsByEvent = reactive({}) // event_id -> standings rows, total desc
const focusedHistory = computed(() => histories[selectedEventId.value] || [])
const focusedStandings = computed(() => standingsByEvent[selectedEventId.value] || [])

// Collapsible side columns. One Live event -> both open (the full
// 3-column board). Two or more -> auto-collapse to edge drawers so the
// pool cards get the width; the operator can still peek either panel for
// the focused pool. Manual toggles hold until the Live-event count
// changes.
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

async function loadPoolPanels(eventId) {
  if (!eventId) return
  try {
    const h = await auth.apiFetch(`/api/events/${eventId}/history`)
    // /history is round ASC, name ASC; reverse so the latest dive is on top.
    histories[eventId] = Array.isArray(h) ? h.slice().reverse() : []
  } catch { /* leave prior history in place */ }
  try {
    const sb = await auth.apiFetch(`/api/scoreboard/${eventId}`)
    standingsByEvent[eventId] = Array.isArray(sb?.standings) ? sb.standings : []
  } catch { /* leave prior standings in place */ }
}

function fmtTotal(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

// SCORE CORRECTION (#9): clicking a completed dive in the focused pool's
// History column opens the manager-amend modal. /history rows carry
// judge_scores + score_ids; the modal wants `scores`, so map across.
const correctOpen = ref(false)
const correctTarget = ref(null)
function openCorrection(row) {
  if (!row?.score_ids?.length) return
  correctTarget.value = {
    name: row.diverName,
    round: row.round_number,
    dive_code: row.dive_code,
    position: row.position,
    dd: row.dd,
    scores: (row.judge_scores || []).map((s) => parseFloat(s)),
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

// ANNOUNCE (#9): push the focused pool's standings to the spectator
// scoreboard ("say it on screen"), reproducing the V1 announce_score emit.
function announceFocused() {
  const ev = currentEvent.value
  if (!ev || !focusedStandings.value.length) return
  socket.emit('announce_score', { standings: focusedStandings.value, eventId: ev.id })
  showSuccess(`Announced "${ev.name}" standings on the scoreboard.`)
}

// The nextDiver funnel (ControlView.vue:2347-2378), generalized to ANY
// pool so each card's primary advances its OWN event: partial-scores
// confirm, then advance that pool's cursor OR finalise. The per-pool shot
// clock + auto-advance live in each card, which re-arms its clock when its
// active diver changes here.
async function advancePool(ev) {
  if (!ev) return
  const p = pools[ev.id]
  if (!p) return
  const totalJudges = numberOfJudgesFor(ev.id) || 0
  const scoresIn = Object.keys(p.scoresThisRound || {}).length
  const isLast = p.currentIndex >= (p.roster?.length || 0) - 1
  const isComplete = !!p.advanceArmed && isLast
  const partial = totalJudges > 0 && scoresIn > 0 && scoresIn < totalJudges
  if (!isComplete && partial) {
    if (
      !(await confirmAction({
        title: 'Skip ahead with partial scores?',
        body: `Only ${scoresIn} of ${totalJudges} judges have submitted for this dive in "${ev.name}".`,
        consequences: [
          'The dive will close with whatever scores arrived',
          'Missing judges can still amend via score correction afterwards',
        ],
        confirmLabel: 'Move on',
        confirmKind: 'warn',
      }))
    ) {
      return
    }
  }
  if (isComplete) {
    await finalisePool(ev)
  } else if (selectDiver(p, p.currentIndex + 1, totalJudges, diveDescription)) {
    // The pool's currentActive changed -> its card re-arms the shot clock.
    // Routed through the bucket + drop-detection (#7).
    emitActiveDiver(ev)
  }
}

// Re-announce the focused/named pool's current active diver (the card's
// "Retry" after a dropped set_active_diver).
function retryActiveDiver(ev) {
  if (ev) emitActiveDiver(ev)
}

// finaliseEvent (ControlView.vue:2470-2545), per pool: same
// consequences/confirm/PUT/undo. (The reflow modal is drawer plumbing,
// deferred to P8; an event with no long-run candidates -- the common
// case -- never opens it.)
async function finalisePool(ev) {
  if (!ev) return
  const p = pools[ev.id]
  const diverIds = new Set()
  for (const r of p?.roster || []) {
    if (r.withdrawn_at) continue
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
          ? `"Results posted" emails go out to ${n} competitor${n === 1 ? '' : 's'} (if SMTP is configured)`
          : '"Results posted" emails go out to every competitor (if SMTP is configured)',
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
    await auth.apiFetch(`/api/events/${evId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Completed' }),
    })
    const target = events.value.find((e) => String(e.id) === String(evId))
    if (target) target.status = 'Completed' // -> workflowMode flips to review
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
// Active-diver seeding restores the meet's REAL state rather than resetting
// it. The old version blindly emitted set_active_diver for roster[0] on
// mount for EVERY Live event -- so merely opening the Control Room yanked
// every judge's panel (even another operator's) back to diver 1, round 1.
// Now we:
//   1. optimistically select roster[0] LOCALLY (no emit) so the stage
//      isn't blank and a non-focused pool's scores route the instant they
//      arrive (applyScore matches on the client's currentActive);
//   2. ask the server who is actually live (get_active_diver). If it has a
//      diver, the state_update echo snaps us to it via seedPoolFromServer
//      -- still no emit, so the judges are never reset;
//   3. only when the server has NO diver (a freshly-Live event nobody has
//      started) announce roster[0] -- the lone load path that emits.
async function setupLivePool(ev) {
  socket.emit('subscribe_event', { event_id: ev.id })
  // Claim the control lease so a second operator/window driving this same
  // event gets warned (advisory; never blocks).
  socket.emit('claim_event_control', { event_id: ev.id })
  const pool = poolFor(ev.id)
  try {
    const roster = await auth.apiFetch(`/api/events/${ev.id}/roster`)
    pool.roster = Array.isArray(roster) ? roster : []
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
    // on pendingSeed (cleared once the server resolves it) + a live socket
    // so we never clobber an existing diver or announce blind while
    // disconnected.
    const tid = setTimeout(() => {
      seedTimers.delete(tid)
      if (pendingSeed.has(ev.id) && socket.isConnected.value && pool.currentActive) {
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

onMounted(async () => {
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch (err) {
    loadError.value = err?.message || 'Failed to load events'
  } finally {
    loading.value = false
  }
  // Honour /control?event=<id> (same deep-link contract as V1).
  const q = route.query.event
  if (q != null && events.value.some((e) => String(e.id) === String(q))) {
    selectedEventId.value = String(q)
  }
  // Stand up a live pool for EVERY Live event (not just the focused
  // one) so non-focused pools keep receiving + routing their scores.
  for (const ev of events.value) {
    if (ev.status === 'Live') setupLivePool(ev)
  }
})

// Clear any in-flight seed-fallback timers so a pool can't be announced
// after the view is gone. (useSocketEvent already auto-cleans the socket
// listeners on unmount.)
onUnmounted(() => {
  seedTimers.forEach(clearTimeout)
  seedTimers.clear()
  confirmTimers.forEach(clearTimeout)
  confirmTimers.clear()
})
</script>

<template>
  <div class="cv2">
    <ControlTopBar
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
        <button type="button" @click="resumeMeet">Resume</button>
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
             visually-hidden heading is the roving-focus target on switch
             and gives screen readers the stage context. -->
        <h1 ref="stageTitleEl" tabindex="-1" class="cv2-sr-title">{{ currentEvent.name }} — {{ currentEvent.status }}</h1>

        <!-- Center mode-switch: EXACTLY ONE mode per stage. The bodies
             are placeholders; P6-P8 rebuild the real panels here. -->
        <section v-if="centerMode === 'setup'" class="cv2-mode" aria-label="Setup">
          <SetupStage :event="currentEvent" />
        </section>
        <section v-else-if="centerMode === 'meet'" class="cv2-live-layout" aria-label="Live">
          <!-- HISTORY (left). One Live event -> a full column; two or more
               -> a collapsed edge drawer the operator peeks per focused pool. -->
          <aside v-if="historyOpen" class="cv2-side cv2-side-history" aria-label="History">
            <div class="cv2-side-head">
              <span class="cv2-side-title">History</span>
              <button type="button" class="cv2-side-collapse" aria-label="Collapse history" @click="historyOpen = false">‹</button>
            </div>
            <div class="cv2-side-body">
              <p v-if="!focusedHistory.length" class="cv2-side-empty">No completed dives yet.</p>
              <component
                :is="h.score_ids && h.score_ids.length ? 'button' : 'div'"
                v-for="(h, i) in focusedHistory"
                :key="`${h.competitor_id}-${h.round_number}-${i}`"
                type="button"
                class="cv2-hcard"
                :class="{ 'is-clickable': h.score_ids && h.score_ids.length }"
                v-tip="h.score_ids && h.score_ids.length ? 'Amend a judge score on this dive' : null"
                @click="openCorrection(h)"
              >
                <span class="cv2-hcard-round">R{{ h.round_number }}</span>
                <div class="cv2-hcard-main">
                  <span class="cv2-hcard-name">{{ h.diverName }}</span>
                  <span class="cv2-hcard-dive">{{ h.dive_code }}{{ h.position }}</span>
                </div>
                <span class="cv2-hcard-total">{{ fmtTotal(h.total_points) }}</span>
              </component>
            </div>
          </aside>
          <button
            v-else
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
              :event="lp.event"
              :pool="lp.pool"
              :focused="String(lp.event.id) === String(selectedEventId)"
              :total-judges="numberOfJudgesFor(lp.event.id)"
              :socket="socket"
              :unconfirmed="!!unconfirmed[lp.event.id]"
              :conflict="conflicts[lp.event.id] || null"
              @focus="selectEvent"
              @advance="advancePool(lp.event)"
              @retry-active="retryActiveDiver(lp.event)"
            />
          </div>

          <!-- STANDINGS (right). Same collapse behaviour as History. -->
          <aside v-if="standingsOpen" class="cv2-side cv2-side-standings" aria-label="Standings">
            <div class="cv2-side-head">
              <button type="button" class="cv2-side-collapse" aria-label="Collapse standings" @click="standingsOpen = false">›</button>
              <span class="cv2-side-title">Standings</span>
              <button
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
                <span class="cv2-srow-rank">{{ i + 1 }}</span>
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
         never mounts this markup (the #9 subtraction). -->
    <DrawerPanel v-if="drawerOpen" :event="currentEvent" @close="drawerOpen = false" />

    <!-- Score correction (#9): amend a judge score on a completed dive in
         the focused pool's History. Mounted per-open so its draft fields
         reset from the clicked card. -->
    <ScoreCorrectionModal
      v-if="correctOpen && correctTarget"
      :card="correctTarget"
      :event="currentEvent"
      @close="closeCorrection"
      @saved="loadPoolPanels(selectedEventId)"
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
.cv2-mode-state { margin: 0; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
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

.cv2-hcard {
  display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.55rem;
  border: 1px solid var(--border-2); border-radius: var(--radius-sm); background: var(--bg-3);
  width: 100%; text-align: start; font: inherit; color: var(--text-2);
}
.cv2-hcard.is-clickable { cursor: pointer; }
.cv2-hcard.is-clickable:hover { border-color: var(--cyan); }
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
</style>
