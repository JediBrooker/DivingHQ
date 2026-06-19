<script setup>
// ControlViewV2 — the flag-gated Stage-Rail Control Room shell (P5).
//
// Parallel to the UNTOUCHED ControlView.vue (the instant rollback). This
// phase stands up the FRAME only: a meet/event RAIL + a CENTER
// mode-switch (Setup / Live / Review, plus a Recovery cross-cut) + a
// drawer stub. Exactly one mode renders per stage, chosen by the shared
// useControlStage derivation. The mode bodies are placeholders here;
// P6 (Live) / P7 (Setup + Recovery) / P8 (Review + drawer) rebuild the
// real panels into them. Live score handling + the concurrent-pool
// per-event live-state map is the next P5 slice.
//
// Resolved only when VITE_CONTROL_V2_ENABLED === '1' (router resolver);
// same /control URL, same ?event= deep-link, same role gate + AppShell.
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useControlStage } from '@/composables/useControlStage'
import StageRail from '@/components/control/StageRail.vue'
import StatusPill from '@/components/StatusPill.vue'
import SetupStage from '@/components/control/SetupStage.vue'
import ReviewStage from '@/components/control/ReviewStage.vue'
import DrawerPanel from '@/components/control/DrawerPanel.vue'
import EmptyState from '@/components/EmptyState.vue'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { useI18n } from 'vue-i18n'
import { useLivePools, selectDiver, deriveStatus } from '@/composables/useLivePools'
import { diveDescription } from '@/composables/useDiveLabel'
import { idbInvalidate } from '@/lib/idbCache'
import { useShotClock } from '@/composables/useShotClock'
import { useMeetHold } from '@/composables/useMeetHold'
import { useAutoAdvance } from '@/composables/useAutoAdvance'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { confirmAction } from '@/composables/useConfirm'
import { showUndo } from '@/composables/useUndo'
import { showError } from '@/composables/useNotify'

const route = useRoute()
const auth = useAuthStore()
const { t } = useI18n()
const { queueAction } = useHttpOutbox()

// ONE shot clock bound to the FOCUSED pool (WA 8.5.5 60s window; frozen
// composable, reused as-is). Only the centered diver is on the clock; a
// non-focused Live pool can sit at READY/JUDGING without its own clock.
// Per-pool multi-clocks are a later slice.
const { shotClock, shotClockExpired, shotClockClass, startShotClock, stopShotClock, resetShotClock } =
  useShotClock()

// Socket + the concurrent-pool live-state engine are hoisted ABOVE the
// mode switch: ONE subscription for the shell's lifetime routes every
// score_received / judge_signal to the matching pool by event_id, so a
// non-focused Live pool still updates its own tiles (useLivePools). The
// frozen trim/sync math is untouched -- only WHERE the result lands is
// per-pool. useSocketEvent auto-cleans on unmount so no dead instance
// can keep advancing a meet.
const socket = useSocket()
const { pools, poolFor, routeScore, routeSignal } = useLivePools()

useSocketEvent(socket, 'score_received', (data) => {
  if (data?.event_id) idbInvalidate(`/api/scoreboard/${data.event_id}`).catch(() => {})
  const res = routeScore(data, numberOfJudgesFor)
  // Focused-pool shot clock stops when ITS dive completes; a non-focused
  // pool's completion arms its own advance and never touches the clock.
  if (res.allScoresIn && currentEvent.value && String(data.event_id) === String(currentEvent.value.id)) {
    stopShotClock()
    // Focused pool's panel just completed -> arm the auto-advance
    // countdown (frozen V1 contract). Finalise is never auto-fired.
    if (!nextBtnComplete.value) startAutoAdvance(advancePrimary)
  }
})
useSocketEvent(socket, 'judge_signal', (data) => {
  routeSignal(data)
})

const events = ref([])
const selectedEventId = ref('')
const loading = ref(true)
const loadError = ref('')
const stageTitleEl = ref(null)

const currentEvent = computed(
  () => events.value.find((e) => String(e.id) === String(selectedEventId.value)) || null,
)
const { workflowMode } = useControlStage(currentEvent)

// SAFE RECOVERY: meet hold/resume on the focused event (useMeetHold,
// reused as-is; one instance keyed to currentEvent, meet-wide). Holding
// pauses the focused diver's shot clock. Instantiated AFTER socket +
// currentEvent exist so neither is referenced in a temporal dead zone.
const { isHeld, holdReason, holdPromptOpen, holdReasonInput, openHoldPrompt, confirmHold, resumeMeet } =
  useMeetHold({ socket, event: () => currentEvent.value, onHold: () => resetShotClock() })

// Recovery is the one explicit cross-cutting mode (offer-not-seize);
// P7 fills it. Off by default so the center always shows the stage mode.
const recoveryOpen = ref(false)
const drawerOpen = ref(false)
const centerMode = computed(() => (recoveryOpen.value ? 'recovery' : workflowMode.value))

// The focused pool's live state (active diver + judge tiles), or null.
const livePool = computed(() => (currentEvent.value ? pools[currentEvent.value.id] : null))

// CURRENT STATE: the READY/JUDGING/DIVING pill, re-derived per focused
// pool off its own scores. clockExpired (the DIVING transition) wires in
// with the focused-pool shot clock in P6.2.
const liveStatus = computed(() => {
  const p = livePool.value
  if (!p) return 'ready'
  return deriveStatus({
    hasActive: !!p.currentActive,
    scoresInCount: Object.keys(p.scoresThisRound || {}).length,
    clockExpired: shotClockExpired.value,
  })
})

// BLOCKERS (live): "what's stopping me", surfaced on-canvas instead of
// hidden in the primary's tooltip -- partial scores + a judge signaling
// the referee, derived from the focused pool's tiles (no new fetch).
const liveBlockers = computed(() => {
  const p = livePool.value
  const ev = currentEvent.value
  if (!p || !p.currentActive || !ev) return []
  const out = []
  const total = numberOfJudgesFor(ev.id) || 0
  const scoresIn = Object.keys(p.scoresThisRound || {}).length
  if (total > 0 && scoresIn > 0 && scoresIn < total) {
    const remaining = total - scoresIn
    out.push({ kind: 'partial', label: `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}` })
  }
  const signaling = (p.judgeTiles || []).filter((t) => t.signaled).map((t) => t.judgeIndex)
  if (signaling.length) {
    out.push({ kind: 'signal', label: `Judge ${signaling.join(', ')} signaling the referee` })
  }
  return out
})

// AUTO-ADVANCE (P6.4): once the focused pool's panel completes, a
// countdown moves the meet to the next diver without a click. A judge
// flagging the referee blocks/cancels it (frozen V1 contract); finalise
// is never auto-fired. Manual (0s) is the safe default. Per-pool clocks
// are a later slice -- this drives the FOCUSED pool only.
const liveSignaling = computed(() =>
  (livePool.value?.judgeTiles || []).some((t) => t.signaled),
)
const autoNextOptions = [
  { v: 0, label: 'Manual' },
  { v: 5, label: '5 seconds' },
  { v: 10, label: '10 seconds' },
  { v: 15, label: '15 seconds' },
  { v: 20, label: '20 seconds' },
  { v: 25, label: '25 seconds' },
  { v: 30, label: '30 seconds' },
]
const autoNextMenuOpen = ref(false)
const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance, cancelAutoAdvance } =
  useAutoAdvance({ isSignaling: () => liveSignaling.value })

// Re-arm when a referee signal clears (panel already complete, not at
// finalise); kill the in-flight countdown the moment a signal raises.
watch(liveSignaling, (now, prev) => {
  if (prev && !now && !nextBtnDisabled.value && !nextBtnComplete.value) {
    startAutoAdvance(advancePrimary)
  }
  if (now) cancelAutoAdvance()
})

// NEXT ACTION: one bottom-pinned primary scoped to the focused pool,
// reproducing updateNextButton (ControlView.vue:2311-2328) + nextBtn*
// per pool. disabled until that pool's last score lands (advanceArmed);
// on the last dive it morphs to Finalise.
const isLastInPool = computed(() => {
  const p = livePool.value
  return !!p && p.currentIndex >= p.roster.length - 1
})
const nextBtnComplete = computed(() => !!livePool.value?.advanceArmed && isLastInPool.value)
const nextBtnDisabled = computed(() => !livePool.value?.advanceArmed)
const nextBtnText = computed(() =>
  nextBtnComplete.value
    ? `✓ ${t('control.finalise')} & ${t('control.view_results')}`
    : `${t('control.next_diver')} →`,
)
const nextBtnTitle = computed(() => {
  if (!nextBtnDisabled.value) {
    return nextBtnComplete.value
      ? 'All rounds complete — finalise the event'
      : 'Advance to the next diver'
  }
  const p = livePool.value
  if (!p?.currentActive) return 'Pick an active diver from the queue first'
  const need = numberOfJudgesFor(currentEvent.value?.id) || 5
  const have = Object.keys(p.scoresThisRound || {}).length
  const remaining = Math.max(0, need - have)
  return remaining === 0 ? 'Loading…' : `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}`
})

function syncShotClock() {
  const p = livePool.value
  if (p && p.currentActive && currentEvent.value?.status === 'Live') startShotClock()
  else resetShotClock()
}

// The nextDiver funnel (ControlView.vue:2347-2378), per focused pool:
// partial-scores confirm, then advance the pool's cursor OR finalise.
async function advancePrimary() {
  // A manual advance cancels any in-flight countdown so the operator's
  // click wins the race with the timer.
  cancelAutoAdvance()
  const p = livePool.value
  const ev = currentEvent.value
  if (!p || !ev) return
  const totalJudges = numberOfJudgesFor(ev.id) || 0
  const scoresIn = Object.keys(p.scoresThisRound || {}).length
  const partial = totalJudges > 0 && scoresIn > 0 && scoresIn < totalJudges
  if (!nextBtnComplete.value && partial) {
    if (
      !(await confirmAction({
        title: 'Skip ahead with partial scores?',
        body: `Only ${scoresIn} of ${totalJudges} judges have submitted for this dive.`,
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
  if (nextBtnComplete.value) {
    await finaliseFocusedPool()
  } else if (selectDiver(p, p.currentIndex + 1, totalJudges, diveDescription)) {
    socket.emit('set_active_diver', { ...p.currentActive, status: 'ready' })
    startShotClock()
  }
}

// finaliseEvent (ControlView.vue:2470-2545), reproduced for the focused
// pool: same consequences/confirm/PUT/undo. (The reflow modal is drawer
// plumbing, deferred to P8; an event with no long-run candidates -- the
// common case -- never opens it.)
async function finaliseFocusedPool() {
  const ev = currentEvent.value
  const p = livePool.value
  if (!ev) return
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
    resetShotClock()
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

// Stand up a per-event live pool: subscribe to its room, seed the judge
// tiles, set the active diver from the roster. Per-pool, so two Live
// pools stay independent. Minimal active diver here (first dive in the
// order); the full setActive / auto-advance derivation is P6.
async function setupLivePool(ev) {
  socket.emit('subscribe_event', { event_id: ev.id })
  const pool = poolFor(ev.id)
  try {
    const roster = await auth.apiFetch(`/api/events/${ev.id}/roster`)
    pool.roster = Array.isArray(roster) ? roster : []
    // Active diver on load = the first dive in the server-ordered queue.
    // (The Completed-review + empty-roster branches are P6.2/P8.)
    if (pool.roster.length && selectDiver(pool, 0, ev.number_of_judges, diveDescription)) {
      // Tell the server who is up in THIS pool (event-scoped) so judge
      // scores for it are accepted + broadcast -- for every Live pool.
      socket.emit('set_active_diver', { ...pool.currentActive, status: 'ready' })
    }
  } catch {
    pool.roster = []
  }
}

async function selectEvent(id) {
  selectedEventId.value = String(id)
  syncShotClock()
  // Roving focus rail -> center heading (a11y: the selection moves focus
  // into the focused stage, not back to the top of the rail).
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
  syncShotClock()
})
</script>

<template>
  <div class="cv2">
    <StageRail
      :events="events"
      :selected-id="selectedEventId"
      :loading="loading"
      @select="selectEvent"
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
          :title="events.length ? 'No stage selected' : 'No meets yet'"
          :body="events.length
            ? 'Pick a meet stage from the rail to run setup, go live, or review results.'
            : 'Create an event to start running it from the Control Room.'"
          :action-label="events.length ? null : 'Create an event'"
          :action-to="events.length ? null : '/manager?new=1'"
        />
      </div>

      <div v-else class="cv2-stage" :data-mode="centerMode">
        <header class="cv2-stage-head">
          <StatusPill :status="currentEvent.status" size="md" />
          <h1 ref="stageTitleEl" tabindex="-1" class="cv2-stage-title">{{ currentEvent.name }}</h1>
          <button
            type="button"
            class="cv2-recovery-toggle"
            :class="{ 'is-active': recoveryOpen }"
            :aria-pressed="recoveryOpen"
            @click="recoveryOpen = !recoveryOpen"
          >⛑ Recovery</button>
          <button
            type="button"
            class="cv2-tools-toggle"
            :class="{ 'is-active': drawerOpen }"
            :aria-pressed="drawerOpen"
            @click="drawerOpen = true"
          >🧰 Tools</button>
        </header>

        <!-- Center mode-switch: EXACTLY ONE mode per stage. The bodies
             are placeholders; P6-P8 rebuild the real panels here. -->
        <section v-if="centerMode === 'setup'" class="cv2-mode" aria-label="Setup">
          <SetupStage :event="currentEvent" />
        </section>
        <section v-else-if="centerMode === 'meet'" class="cv2-mode" aria-label="Live">
          <div v-if="livePool && livePool.activeInfo" class="cv2-live">
            <div class="cv2-live-head">
              <span class="cv2-live-status" :class="`cv2-status-${liveStatus}`">{{ liveStatus.toUpperCase() }}</span>
              <span class="cv2-live-round">Round {{ livePool.activeInfo.round_number }} / {{ currentEvent.total_rounds }}</span>
              <span class="cv2-shotclock" :class="shotClockClass" aria-label="Shot clock">{{ shotClock }}s</span>
            </div>
            <p class="cv2-live-diver">
              {{ livePool.activeInfo.name }}
              <span v-if="livePool.activeInfo.country" class="cv2-live-country">{{ livePool.activeInfo.country }}</span>
            </p>
            <p v-if="livePool.activeInfo.code || livePool.activeInfo.desc" class="cv2-live-dive">
              <span v-if="livePool.activeInfo.code">{{ livePool.activeInfo.code }}</span>
              <span v-if="livePool.activeInfo.dd"> · {{ livePool.activeInfo.dd }}</span>
              <span v-if="livePool.activeInfo.desc"> · {{ livePool.activeInfo.desc }}</span>
            </p>
            <div class="cv2-tiles" aria-label="Judge scores">
              <div
                v-for="t in livePool.judgeTiles"
                :key="t.judgeIndex"
                class="cv2-tile"
                :class="{ scored: t.scored, signaled: t.signaled }"
              >{{ t.scored ? t.score : '—' }}</div>
            </div>
            <div v-if="liveBlockers.length" class="cv2-blockers" role="status" aria-label="Blockers">
              <span
                v-for="b in liveBlockers"
                :key="b.kind"
                class="cv2-blocker"
                :class="`cv2-blocker-${b.kind}`"
              >{{ b.label }}</span>
            </div>
            <div class="cv2-primary-slot">
              <div class="cv2-split">
                <button
                  type="button"
                  class="cv2-primary"
                  :class="{ 'is-finalise': nextBtnComplete, 'is-counting': autoAdvanceCountdown > 0 }"
                  :disabled="nextBtnDisabled"
                  v-tip="nextBtnTitle"
                  @click="advancePrimary"
                >
                  {{ nextBtnText }}
                  <span v-if="autoAdvanceCountdown > 0" class="cv2-autopill">{{ autoAdvanceCountdown }}s</span>
                </button>
                <!-- The picker is NOT gated on nextBtnDisabled: the
                     operator sets Auto-next at any point, even before the
                     first diver or while waiting on scores. -->
                <button
                  type="button"
                  class="cv2-split-aside"
                  :class="{ 'is-finalise': nextBtnComplete }"
                  :aria-expanded="autoNextMenuOpen"
                  v-tip="`Auto-next: ${autoAdvanceSeconds === 0 ? 'Manual' : autoAdvanceSeconds + 's'}`"
                  @click.stop="autoNextMenuOpen = !autoNextMenuOpen"
                >▾</button>
                <div v-if="autoNextMenuOpen" class="cv2-autonext-menu" role="menu">
                  <div class="cv2-autonext-head">Auto-next after the panel completes</div>
                  <button
                    v-for="opt in autoNextOptions"
                    :key="opt.v"
                    type="button"
                    role="menuitemradio"
                    :aria-checked="autoAdvanceSeconds === opt.v"
                    class="cv2-autonext-item"
                    :class="{ 'is-active': autoAdvanceSeconds === opt.v }"
                    @click="autoAdvanceSeconds = opt.v; autoNextMenuOpen = false"
                  >
                    <span>{{ opt.label }}</span>
                    <span v-if="autoAdvanceSeconds === opt.v" aria-hidden="true">✓</span>
                  </button>
                </div>
              </div>
            </div>
            <p class="cv2-mode-note">Live current state, next action + auto-advance (P6.4).</p>
          </div>
          <p v-else class="cv2-mode-note">Live — loading the active diver… (Full live screen: P6.)</p>
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
  </div>
</template>

<style scoped>
.cv2 { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100%; }
.cv2-center { padding: 1.5rem 2rem; min-width: 0; }
.cv2-stage-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
.cv2-stage-title {
  margin: 0; font-family: var(--font-display); font-size: 24px; font-weight: 700;
  color: var(--fg); outline: none;
}
.cv2-mode {
  padding: 1.5rem; border: 1px dashed var(--border-2);
  border-radius: var(--radius-lg); color: var(--text-2);
}
.cv2-mode-note { margin: 0 0 0.4rem; font-family: var(--font-mono); font-size: 13px; }
.cv2-mode-state { margin: 0; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-live-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
.cv2-live-status {
  font-family: var(--font-display); font-size: 11px; font-weight: 800; letter-spacing: 0.18em;
  padding: 0.2rem 0.6rem; border-radius: 999px; background: var(--bg-3); color: var(--text-2);
}
.cv2-status-diving { color: var(--cyan); background: rgba(6, 182, 212, 0.12); }
.cv2-status-judging { color: var(--amber); background: rgba(245, 158, 11, 0.12); }
.cv2-live-round { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-live-diver { margin: 0 0 0.4rem; font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--fg); }
.cv2-live-country { font-family: var(--font-mono); font-size: 13px; font-weight: 400; color: var(--text-3); margin-inline-start: 0.5rem; }
.cv2-live-dive { margin: 0 0 1rem; font-family: var(--font-mono); font-size: 13px; color: var(--text-2); }
.cv2-shotclock {
  margin-inline-start: auto;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700;
  padding: 0.15rem 0.6rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); color: var(--text-2);
}
.cv2-shotclock.shot-clock-amber { color: var(--amber); border-color: var(--amber); }
.cv2-shotclock.shot-clock-warn { color: var(--red); border-color: var(--red); }
.cv2-shotclock.shot-clock-expired { color: var(--red); background: rgba(239, 68, 68, 0.12); border-color: var(--red); }
.cv2-primary-slot {
  position: sticky; bottom: 0; margin-top: 1.5rem; padding-top: 1rem;
  background: linear-gradient(to top, var(--bg) 72%, transparent);
}
.cv2-primary {
  width: 100%; padding: 0.85rem 1.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  border-radius: var(--radius); border: 1px solid var(--cyan);
  background: var(--cyan); color: var(--bg); cursor: pointer;
  transition: filter 0.12s;
}
.cv2-primary:hover:not(:disabled) { filter: brightness(1.08); }
.cv2-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.cv2-primary.is-finalise { background: var(--green); border-color: var(--green); }
.cv2-split { display: flex; gap: 2px; position: relative; }
.cv2-split .cv2-primary { width: auto; flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; }
.cv2-split-aside {
  flex: 0 0 auto; width: 2.75rem; padding: 0.85rem 0;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  border-radius: var(--radius); border: 1px solid var(--cyan);
  background: var(--cyan); color: var(--bg); cursor: pointer; transition: filter 0.12s;
}
.cv2-split-aside:hover { filter: brightness(1.08); }
.cv2-split-aside.is-finalise { background: var(--green); border-color: var(--green); }
.cv2-primary.is-counting { background: var(--amber); border-color: var(--amber); }
.cv2-autopill {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  padding: 0.05rem 0.4rem; border-radius: 999px;
  background: rgba(0, 0, 0, 0.18); color: inherit;
}
.cv2-autonext-menu {
  position: absolute; bottom: calc(100% + 6px); inset-inline-end: 0; z-index: 20;
  min-width: 13rem; padding: 0.4rem;
  background: var(--bg-2); border: 1px solid var(--border-2); border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.cv2-autonext-head {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  padding: 0.3rem 0.5rem 0.4rem;
}
.cv2-autonext-item {
  display: flex; justify-content: space-between; align-items: center; width: 100%;
  padding: 0.45rem 0.5rem; border: none; background: transparent; cursor: pointer;
  font-family: var(--font-mono); font-size: 13px; color: var(--text-2); border-radius: var(--radius-sm);
}
.cv2-autonext-item:hover { background: var(--bg-3); color: var(--fg); }
.cv2-autonext-item.is-active { color: var(--cyan); }
.cv2-tiles { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
.cv2-blockers { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
.cv2-blocker {
  font-family: var(--font-mono); font-size: 12px;
  padding: 0.3rem 0.7rem; border-radius: var(--radius-sm);
  border: 1px solid var(--amber); color: var(--amber); background: rgba(245, 158, 11, 0.08);
}
.cv2-blocker-signal { border-color: var(--red); color: var(--red); background: rgba(239, 68, 68, 0.08); }
.cv2-tile {
  width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  background: var(--bg-3); color: var(--text-3);
  font-family: var(--font-mono); font-size: 16px;
}
.cv2-tile.scored { color: var(--cyan); border-color: var(--cyan); }
.cv2-tile.signaled { box-shadow: 0 0 0 2px var(--red); }
.cv2-msg { padding: 3rem; text-align: center; color: var(--text-3); font-family: var(--font-mono); }
.cv2-error { color: var(--red); }
@media (max-width: 860px) {
  /* Single column: the rail collapses to a horizontal stage strip above
     the center, which then fills the screen. The strip scrolls sideways
     internally so the PAGE never gains a horizontal scrollbar. */
  .cv2 { grid-template-columns: 1fr; }
  .cv2 :deep(.stage-rail) {
    border-inline-end: 0;
    border-bottom: 1px solid var(--border);
    overflow-y: visible;
  }
  .cv2 :deep(.stage-rail-list) {
    display: flex; gap: 0.4rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding: 0.4rem 0.5rem;
  }
  .cv2 :deep(.stage-rail-list)::-webkit-scrollbar { display: none; }
  .cv2 :deep(.stage-rail-list > li) { flex: 0 0 auto; }
  .cv2 :deep(.stage-row) { width: auto; white-space: nowrap; }
  .cv2-center { padding: 1rem; }
  .cv2-stage-head { flex-wrap: wrap; }
}

.cv2-recovery-toggle {
  margin-inline-start: auto;
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  padding: 0.3rem 0.7rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); background: transparent; color: var(--text-2); cursor: pointer;
}
.cv2-recovery-toggle.is-active, .cv2-recovery-toggle:hover { border-color: var(--amber); color: var(--amber); }
.cv2-tools-toggle {
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  padding: 0.3rem 0.7rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); background: transparent; color: var(--text-2); cursor: pointer;
}
.cv2-tools-toggle.is-active, .cv2-tools-toggle:hover { border-color: var(--cyan); color: var(--cyan); }
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
