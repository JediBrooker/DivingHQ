<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { diveDescription } from '@/composables/useDiveLabel'
import { showInfo } from '@/composables/useNotify'
import OfflineBanner from '@/components/OfflineBanner.vue'
import SyncStatusBadge from '@/components/SyncStatusBadge.vue'
import BigScoreDisplay from '@/components/BigScoreDisplay.vue'
import { useOutbox } from '@/composables/useOutbox'

// Feature flag (P1 of the offline-resilience work; see
// docs/offline-p1-design.md). Build-time constant via Vite's
// import.meta.env. Default off in production .env; on for CI in
// .github/workflows/ci.yml + canary federations until proven.
//
// When OFF, this view behaves exactly as it did pre-outbox: one
// in-memory pendingScore slot, drained on socket reconnect.
// When ON, every submit routes through src/lib/outbox.js —
// scores survive a tab close + indefinite outage (up to the 72h
// idempotency retention) and replay on reconnect.
const OUTBOX_ENABLED = import.meta.env.VITE_OFFLINE_OUTBOX_ENABLED === '1'

// User fingerprinting lives in src/composables/useOutbox.js; the
// composable handles outbox creation + identity scoping. Nothing
// in JudgeView needs to know how the fingerprint is computed.

const { t } = useI18n()

// Pool deck ergonomics — judging often happens on a phone left
// face-up on a table for an entire round. Two helpers:
//
//   1. Screen wake lock so the OS doesn't dim the display
//      mid-dive. Falls back silently on browsers that don't
//      expose the API (older Safari, in-app webviews).
//   2. Haptic feedback on score submit + signal so the judge
//      gets a confirmation pulse without having to glance back
//      at the screen. `navigator.vibrate` is a no-op on
//      desktop / iOS Safari.
//
// Wake lock is released on unmount + reacquired on visibility
// change (the OS drops it when the tab backgrounds; reacquiring
// on focus avoids the re-tap dance).
const wakeLock = ref(null)
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return
  try {
    wakeLock.value = await navigator.wakeLock.request('screen')
    wakeLock.value.addEventListener('release', () => { wakeLock.value = null })
  } catch { /* permission denied or unsupported */ }
}
function onVisibilityChange() {
  if (document.visibilityState === 'visible' && !wakeLock.value) acquireWakeLock()
}
function buzz(pattern) {
  // Pattern can be a single number (ms) or an array of on/off
  // timings. We default to a short single pulse.
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(pattern || 30) } catch { /* ignore */ }
  }
}

const route = useRoute()
const auth = useAuthStore()
const socket = useSocket()

// Event id from /judge?event=<id>. Required so the socket can
// subscribe to the right room — without it, state_update +
// meet_held broadcasts (which the server emits to
// io.to('event:<id>')) never reach this client.
const eventIdFromUrl = computed(() => route.query.event || null)

const user = auth.user

const currentScore = ref(0)
const isHalf = ref(false)
const activeDiver = ref(null)
const judgeLabel = ref(user?.full_name || 'Judge')
// Connection state lives on the singleton socket itself
// (`socket.isConnected`, a ref), so a parallel `connStatus` ref
// would just duplicate that state — and since useSocket is now
// a real singleton, two listeners on `connect`/`disconnect` (the
// composable's + this view's) would race.
const submitted = ref(false)
const judgeNumber = ref(null)
// Legacy single-slot pending (active when OUTBOX_ENABLED is off).
// In outbox mode this stays null and `pendingCount` drives the UI.
const pendingScore = ref(null)

// Manual-fallback "big number" mode (P5). When the operator is in
// fallback mode (typing scores from across the room), the judge
// taps "Show big" to fill the screen with their submitted score.
// Tapping anywhere on the big-mode panel returns to normal view.
// Stays hidden until at least one score has been submitted; before
// that there's nothing to show.
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
// composable returns reactive counts + the underlying outbox
// instance, so push()/drain() callers go through getOutbox() and
// UI components (OfflineBanner, SyncStatusBadge) stay declarative.
const outboxState = useOutbox()
const outboxInstance = outboxState.outbox
const pendingCount = outboxState.pendingCount
const refreshPendingCount = outboxState.refresh

function getOutbox() { return outboxInstance }

// Per-entry view of the outbox queue. Drives the sync-chip strip
// in the template so a judge sees each individual queued score
// rather than just a count. Refreshed on every outbox 'change'
// emission (same trigger as pendingCount) so the list stays in
// step. Filters to non-terminal states so a long-finished synced
// entry doesn't clutter the strip.
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
}
if (outboxInstance) {
  outboxInstance.on('change', refreshQueuedEntries)
  refreshQueuedEntries()
}

// Per-entry send function for outbox.drain. Uses socket.io's
// ack callback (3rd argument to socket.emit) so the drain protocol
// has reliable per-submit correlation instead of tuple-matching
// the room broadcast (which is racy when multiple judges submit
// for the same diver). Server support: routes/socket.js's
// submit_score handler calls ack() on success/failure paths.
function sendViaSocket(entry) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 10000)
    socket.emit('submit_score', {
      ...entry.payload,
      idempotency_key: entry.idempotency_key,
      actor_local_time: entry.actor_local_time,
    }, (response) => {
      clearTimeout(timer)
      if (response?.ok) {
        resolve({ ok: true, response: response.response })
      } else if (response?.conflict) {
        // Server flagged a conflict (P4 territory — won't fire in
        // P1 because OFFLINE_CONFLICT_RESOLUTION defaults to auto).
        // The outbox marks the entry as 'conflict' and the
        // operator's review tray resolves it.
        const err = new Error(response.error || 'conflict')
        err.kind = 'conflict'
        err.conflict = response.conflict
        reject(err)
      } else {
        // Transient / validation failure. Outbox retries with
        // exponential backoff up to 5 attempts then marks failed.
        reject(new Error(response?.error || 'rejected'))
      }
    })
  })
}

async function drainOutbox() {
  const ob = getOutbox()
  if (!ob) return
  await ob.drain({ send: sendViaSocket })
  refreshPendingCount()
}
// Panel of every judge's score for the current dive — keyed by
// judge_number, populated as score_received broadcasts arrive.
// Lets THIS judge see the full panel (e.g. their own 8.5 next
// to J1's 8.0, J3's 7.5 …) once everyone has submitted.
const panelScores = ref({})
// Referee-signal flag — true when this judge has flagged the
// referee on the current dive (e.g. didn't see, wants a
// review). Toggleable; resets on every state_update.
const signaled = ref(false)
// Per-judge signal state from the rest of the panel — populated
// off the judge_signal broadcasts. Lets THIS judge see when
// another panel member has flagged the referee, so they can
// pause / coordinate before locking their own score in.
const panelSignals = ref({})

const displayValue = computed(() => {
  const val = currentScore.value + (isHalf.value ? 0.5 : 0)
  return val % 1 === 0 ? val.toString() : val.toFixed(1)
})

const scoreIsZero = computed(() => (currentScore.value + (isHalf.value ? 0.5 : 0)) === 0)

// Total judges on the panel for the current event. Drives the
// number of slots the panel display renders.
const panelSize = computed(() =>
  parseInt(activeDiver.value?.number_of_judges) || 0,
)
// keypad / submit are inert once a score is in unless the
// judge has flagged the referee — the flag re-opens the
// keypad so the judge can correct the score, and submitting
// the new score auto-clears the signal.
const keypadLocked = computed(() => submitted.value && !signaled.value)
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

// Synchro role — derived from this judge's position in the panel.
// Lets the judge see whether they should be scoring Diver A's
// execution, Diver B's execution, or the synchronisation.
const synchroRole = computed(() => {
  if (activeDiver.value?.event_type !== 'synchro_pair') return null
  const n = judgeNumber.value
  const total = activeDiver.value?.number_of_judges
  if (!n || !total) return null
  if (total === 9) {
    if (n <= 2) return { label: 'EXEC A', tone: 'a' }
    if (n <= 4) return { label: 'EXEC B', tone: 'b' }
    if (n <= 9) return { label: 'SYNCHRONISATION', tone: 'sync' }
  } else if (total === 11) {
    if (n <= 3) return { label: 'EXEC A', tone: 'a' }
    if (n <= 6) return { label: 'EXEC B', tone: 'b' }
    if (n <= 11) return { label: 'SYNCHRONISATION', tone: 'sync' }
  }
  return null
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

socket.on('connect', () => {
  if (OUTBOX_ENABLED) {
    // Drain any entries queued while offline (this session or a
    // prior session that closed before the drain completed).
    drainOutbox()
  } else if (pendingScore.value) {
    // Legacy single-slot pending.
    socket.emit('submit_score', pendingScore.value)
    pendingScore.value = null
  }
  joinEventRoom()
})

onMounted(() => {
  // The socket may already be connected (composable reuses a
  // singleton across views). Subscribe on mount as well so the
  // room join doesn't depend on a reconnect.
  if (socket.connected) joinEventRoom()
  acquireWakeLock()
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Outbox: useOutbox() already wires the 'change' listener +
  // initial refresh. We just kick a drain in case we connected
  // before this view mounted.
  if (OUTBOX_ENABLED && socket.connected) drainOutbox()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  try { wakeLock.value?.release?.() } catch { /* ignore */ }
  wakeLock.value = null
})
// Hold-state propagation. A held meet should disable scoring —
// judges shouldn't accidentally submit during a video review.
const isHeld = ref(false)
const holdReason = ref('')
socket.on('meet_held', (data) => {
  if (activeDiver.value && data.event_id !== activeDiver.value.event_id) return
  isHeld.value = true
  holdReason.value = data.reason || ''
})
socket.on('meet_resumed', (data) => {
  if (activeDiver.value && data.event_id !== activeDiver.value.event_id) return
  isHeld.value = false
  holdReason.value = ''
})

socket.on('state_update', async (data) => {
  activeDiver.value = data
  resetScore()
  // New diver / round → previous panel + referee signal are
  // both irrelevant. The signal would otherwise carry over to
  // the next diver and confuse the referee.
  panelScores.value = {}
  panelSignals.value = {}
  signaled.value = false

  if (data.event_id) {
    try {
      const res = await fetch(`/api/events/${data.event_id}/my-judge-number`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (res.ok) {
        const { judge_number } = await res.json()
        judgeNumber.value = judge_number
        activeDiver.value = { ...activeDiver.value, judge_number }
        judgeLabel.value = `${user?.full_name} — J${judge_number}`
      }
    } catch { /* show name only */ }
  }
})

// judge_signal broadcasts from other panel members. Mirror the
// state into panelSignals so the panel tile turns red and a
// banner surfaces telling THIS judge that someone else needs
// the referee. Resets to false when a judge clears their flag
// (or auto-clears when they submit a fresh score, server-side).
socket.on('judge_signal', (data) => {
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
// The judge sees the panel build up in real time — their own
// score lights up first when they hit Submit, then the rest
// trickle in as the other panel members lock theirs in.
socket.on('score_received', (data) => {
  if (!activeDiver.value) return
  if (data.event_id      !== activeDiver.value.event_id)      return
  if (data.competitor_id !== activeDiver.value.competitor_id) return
  if (Number(data.round_number) !== Number(activeDiver.value.round_number)) return
  if (data.judge_number == null) return
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
  submitted.value = true
  // Stash for the big-display fallback (P5). Visible behind a
  // "Show big" button below the keypad; the judge taps it when
  // the operator is in manual-entry mode.
  lastSubmittedScore.value = finalScore

  // If the judge had flagged the referee before submitting,
  // the submission IS the rectification — auto-clear the
  // signal so the Control Room's auto-advance can resume.
  // Signal-clear is transient + idempotent; we still send it
  // direct (not via outbox) since an offline signal-clear has
  // no meaning to a server that never saw the signal.
  const clearSignal = signaled.value
  if (clearSignal) signaled.value = false

  if (OUTBOX_ENABLED) {
    // Queue the score for delivery. push() returns immediately
    // (IDB write happens in the background); drain() fires only
    // if we're online.
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
      if (socket.connected) drainOutbox()
    } catch (err) {
      // Push failed (oversized payload, IDB unavailable). Surface
      // to the user; submitted=false so they can retry.
      submitted.value = false
      showInfo(`Could not queue score: ${err.message}`)
    }
  } else if (socket.connected) {
    // Legacy online path.
    socket.emit('submit_score', payload)
    if (clearSignal) {
      socket.emit('judge_signal', {
        event_id:      activeDiver.value.event_id,
        competitor_id: activeDiver.value.competitor_id,
        round_number:  activeDiver.value.round_number,
        judge_id:      user?.id,
        judge_number:  activeDiver.value.judge_number || null,
        signaled:      false,
      })
    }
  } else {
    // Legacy offline path — single-slot in-memory.
    pendingScore.value = payload
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
  // Outbox mode: surface the queue depth so the judge knows their
  // taps are landing even when the socket is bouncing.
  if (OUTBOX_ENABLED && pendingCount.value > 0) {
    return pendingCount.value === 1
      ? '⏳ 1 pending — will send when reconnected'
      : `⏳ ${pendingCount.value} pending — will send when reconnected`
  }
  // Legacy single-slot pending state.
  if (pendingScore.value) return '⏳ Reconnecting — will send automatically'
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
    <!-- Offline / pending-sync banner. Replaces the old
         conn-banner (which only showed when the socket was
         dropped) with a richer signal: also visible when there
         are pending / failed / conflict entries in the outbox
         even while online (drain in flight, etc.). Behind the
         OUTBOX_ENABLED feature flag — falls back to the
         legacy connection banner when the flag is off so
         today's pre-outbox behaviour stays identical. -->
    <OfflineBanner v-if="OUTBOX_ENABLED" />
    <div v-else-if="!socket.isConnected.value" class="conn-banner">
      <span class="conn-dot"></span>
      {{ $t('judge.panel_offline') }}
    </div>
    <!-- Per-entry sync-status strip. Each queued submit gets a
         chip showing its score + current sync state (pending,
         inflight, failed, conflict). Synced entries drop off
         the strip automatically because refreshQueuedEntries
         filters them out. Empty list → renders nothing. -->
    <div v-if="OUTBOX_ENABLED && queuedEntries.length > 0" class="queued-strip">
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
    <!-- Meet-hold banner — Control Room paused the meet. Score
         input is disabled below until the hold lifts. -->
    <div v-if="isHeld" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>
    <!-- Header -->
    <div class="judge-header">
      <div class="header-top">
        <div>
          <div class="event-name">{{ activeDiver?.eventName || '—' }}</div>
          <div class="diver-name">
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
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem">
          <div class="judge-id">
            <span class="status-dot" :class="{ connected: socket.isConnected.value }"></span>
            <span>{{ judgeLabel }}</span>
          </div>
          <RouterLink to="/judge-profile" class="btn-back-judge"
                      v-tip="'See how your scoring tracks against the panel-kept mean'">Analysis</RouterLink>
          <RouterLink to="/dashboard" class="btn-back-judge">← Dashboard</RouterLink>
        </div>
      </div>
      <div class="dive-info-row">
        <span class="dive-pill code">{{ activeDiver?.diveCode || '—' }}</span>
        <span class="dive-pill dd">{{ activeDiver?.dd ? `DD ${activeDiver.dd}` : 'DD —' }}</span>
      </div>
      <div class="dive-desc">{{ activeDiver ? (diveDescription(activeDiver) || '—') : '—' }}</div>

      <!-- Live panel — every judge's tile fills as their
           score_received broadcast lands. Highlights this
           judge's own tile so they read the spread including
           their own contribution at a glance. -->
      <div v-if="activeDiver && panelSize" class="judge-panel">
        <!-- Other-judge signal alert. Surfaces the moment another
             panel member taps "Signal Referee" — this judge
             knows to pause / coordinate before locking their
             score in. Hidden when no other judge has flagged. -->
        <div v-if="signalingOthers.length" class="judge-panel-alert">
          🚩
          <template v-if="signalingOthers.length === 1">
            Judge {{ signalingOthers[0] }} flagged the referee
          </template>
          <template v-else>
            Judges {{ signalingOthers.join(', ') }} flagged the referee
          </template>
        </div>
        <div class="judge-panel-label">
          DIVE PANEL · {{ panelInCount }} / {{ panelSize }}
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

    <!-- Keypad — number buttons overwrite the current entry, so
         a judge who fat-fingers a 7 instead of 8 just taps 8 to
         correct it. The Clear button used to live in this grid
         but it was redundant given that behaviour and easy to
         hit by accident.

         keypadLocked = submitted AND not signaled. Once the
         judge has tapped Signal Referee the keypad re-opens
         even after submission — the signal is the operator's
         way of saying "I need to fix this", and a fresh score
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

    <!-- Signal referee — judges tap this to flag the referee
         (e.g. they didn't see the dive, want a re-dive review,
         scoreboard mismatch). Toggles a bright-red highlight on
         this judge's tile in the Control Room judge grid until
         the next diver lands or the judge taps again to clear. -->
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
          :class="['submit-btn', (submitted && !signaled) ? 'locked' : '', isHeld ? 'held' : '']"
          :disabled="(submitted && !signaled) || isHeld"
          @click="submitScore"
        >{{ isHeld ? 'Meet on hold — wait for resume' : submitLabel }}</button>
      </div>
    </div>
    <!-- Manual-fallback "Show big" button (P5). Only renders after
         at least one score has been submitted, and only when the
         outbox shows pending work OR the socket is offline — i.e.
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

  <!-- Big-mode overlay — full-screen, z-index 1000, fixed. -->
  <BigScoreDisplay
    v-if="bigDisplayOpen && lastSubmittedScore != null"
    :score="lastSubmittedScore"
    :judge-number="judgeNumber"
    :judge-name="judgeLabel"
    @close="closeBigScore"
  />
</template>

<style scoped>
/* Meet-hold banner — surfaced when the Control Room pauses
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

/* Connection banner — sticky at top of viewport so a judge
   can't miss it. Animates in from above on disconnect. */
.conn-banner {
  position: sticky; top: 0; z-index: 50;
  background: var(--amber); color: var(--bg);
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.55rem 1rem;
  display: flex; align-items: center; gap: 0.6rem;
  border-bottom: 1px solid rgba(0,0,0,0.2);
  animation: connSlide 0.18s ease;
}
.conn-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--bg); animation: connPulse 1s infinite;
}
@keyframes connSlide { from { transform: translateY(-100%); } to { transform: translateY(0); } }
@keyframes connPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

/* Queued-entries strip. Sits below the OfflineBanner; shows each
   queued submit_score with a SyncStatusBadge + the score value.
   Visually quieter than the banner — informational, not alerting.
   Hides itself when there's nothing in non-terminal states. */
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
  /* Natural document flow — page scrolls if content exceeds
     the viewport. No 100dvh / overflow:hidden lock; resizing
     the window resizes the page like any other. The keypad +
     submit footer flow naturally below the diver header.
     vh fallback first for browsers older than ~Q4-2022. */
  /* Fill the viewport exactly and never scroll — the whole pad
     (header, diver, keypad, submit/clear, signal) fits one screen.
     position:fixed escapes any global body styling the public auth
     views inject. The keypad flexes to absorb leftover space. */
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  touch-action: manipulation;
  user-select: none;
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
}
.btn-back-judge:hover { color: var(--text); }

.judge-header {
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  padding: 0.875rem 1.25rem;
  flex-shrink: 0;
}
.header-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.625rem;
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
  font-size: clamp(18px, 4vw, 26px);
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
  flex-shrink: 0;
}
.dive-info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.dive-pill {
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
.dive-desc { font-size: 11px; color: var(--text-3); margin-top: 0.35rem; font-family: var(--font-mono); }

/* Live panel display — every judge's tile fills as their score
   lands. The current judge's own tile gets a cyan ring so they
   can see their contribution at a glance amongst the panel. */
.judge-panel {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.judge-panel-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.4rem;
}
.judge-panel-tiles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.judge-panel-tile {
  /* Fixed width so the panel's overall footprint stays the
     same whether the tile reads "—" (empty) or "10.0" (max).
     Without this the cells dynamically resized between dives,
     shifting the surrounding layout left and right as scores
     came in. 52px fits "10.0" at the chosen mono font with
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
/* Another panel member tapped Signal Referee — bright-red ring
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

/* Banner above the panel calling out which other judge(s)
   have flagged. Stays compact so it doesn't push the keypad
   below the fold on phones / small tablets. */
.judge-panel-alert {
  display: flex; align-items: center; gap: 0.4rem;
  margin-bottom: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--red-dim);
  border: 1px solid var(--red);
  border-inline-start-width: 3px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--red);
  animation: judgePanelSignalPulse 1.4s ease-in-out infinite;
}

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
  font-size: clamp(72px, 20vw, 110px);
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
  /* Compact keypad — buttons are still tap-friendly on touch
     screens but no longer dominate the page on a desktop. Caps
     at a sensible width and height so the layout stays balanced
     against the dive header above. */
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  /* Cap key height so they don't balloon on tall screens, and
     centre them in the leftover space (footers stay pinned to
     the bottom). minmax(0,…) lets them shrink to fit short screens. */
  grid-template-rows: repeat(4, minmax(0, 84px));
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
  font-size: clamp(18px, 5vw, 26px);
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
/* Disabled key state — engaged once the judge has submitted.
   Greyed-out + non-interactive so an accidental tap doesn't
   look like it landed but actually no-ops. */
.key:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.key:disabled:active { transform: none; background: var(--surface); color: var(--text); border-color: var(--border); }

/* Signal Referee — sits between the keypad and the submit
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
   bar — on notch iPhones the home-indicator overlays the bottom
   ~20 px. Without an env(safe-area-inset-bottom) gutter the
   button edges land inside the system swipe-gesture zone and
   mis-register as "swipe up" instead of a tap. Tested with a
   wet thumb at the deck because that's the real condition. */
@supports (padding: env(safe-area-inset-bottom)) {
  .signal-footer { padding-bottom: env(safe-area-inset-bottom); }
}
.signal-btn {
  width: 100%;
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  background: var(--danger-bg);
  color: var(--danger-fg);
  font-family: var(--font-sans);
  font-size: clamp(13px, 3vw, 15px);
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
  font-size: clamp(15px, 4vw, 18px);
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
   one-handed; bump the keypad keys, signal, and submit to
   meet the WCAG 2.5.5 44×44 minimum and give them more room
   so a wet thumb doesn't mash two keys at once. The header
   compresses so the keypad stays above the fold on a 5-inch
   screen.
   ========================================================= */
@media (max-width: 600px) {
  .judge-header { padding: 0.6rem 0.85rem; }
  .header-top {
    margin-bottom: 0.4rem;
    /* Wrap so the right-side links (Analysis / Dashboard /
       judge-id) drop below the diver banner on narrow phones
       instead of squeezing the diver name to a 2-char column. */
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .keypad {
    grid-template-rows: repeat(4, minmax(0, 72px));
    align-content: center;
    max-width: none;
    padding: 0.5rem;
    gap: 0.5rem;
  }
  .key-half { font-size: clamp(16px, 4.5vw, 20px); }
  .signal-footer { max-width: none; padding: 0 0.6rem; }
  .signal-btn { padding: 0.95rem 0.75rem; font-size: 14px; }
  .submit-footer { padding: 0.5rem 0.6rem; }
  .submit-btn { padding: 1rem; font-size: 17px; }
  /* Touch-target lift for the small ghost links at the top
     right — at WCAG 2.5.5's 44 px floor a wet thumb still
     lands them reliably. */
  .btn-back-judge {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    padding: 0.3rem 0.5rem;
  }
}

/* Small-phone safety net — even the 320px-wide screens that
   still show up on field tablets and old iPhones. */
@media (max-width: 360px) {
  .keypad { grid-template-rows: repeat(4, minmax(0, 60px)); gap: 0.4rem; }
}
</style>
