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
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useControlStage } from '@/composables/useControlStage'
import StageRail from '@/components/control/StageRail.vue'
import StatusPill from '@/components/StatusPill.vue'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { useI18n } from 'vue-i18n'
import { useLivePools, selectDiver, deriveStatus } from '@/composables/useLivePools'
import { diveDescription } from '@/composables/useDiveLabel'
import { idbInvalidate } from '@/lib/idbCache'
import { useShotClock } from '@/composables/useShotClock'
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
const { workflowMode, orderWorkflowState } = useControlStage(currentEvent)

// Recovery is the one explicit cross-cutting mode (offer-not-seize);
// P7 fills it. Off by default so the center always shows the stage mode.
const recoveryOpen = ref(false)
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
      <p v-if="loadError" class="cv2-msg cv2-error">{{ loadError }}</p>
      <p v-else-if="loading" class="cv2-msg">Loading…</p>
      <p v-else-if="!currentEvent" class="cv2-msg">Pick a stage from the rail to begin.</p>

      <div v-else class="cv2-stage" :data-mode="centerMode">
        <header class="cv2-stage-head">
          <StatusPill :status="currentEvent.status" size="md" />
          <h1 ref="stageTitleEl" tabindex="-1" class="cv2-stage-title">{{ currentEvent.name }}</h1>
        </header>

        <!-- Center mode-switch: EXACTLY ONE mode per stage. The bodies
             are placeholders; P6-P8 rebuild the real panels here. -->
        <section v-if="centerMode === 'setup'" class="cv2-mode" aria-label="Setup">
          <p class="cv2-mode-note">Setup — pre-meet workflow. (Built in P7.)</p>
          <p class="cv2-mode-state">Next step: {{ orderWorkflowState || '—' }}</p>
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
            <div class="cv2-primary-slot">
              <button
                type="button"
                class="cv2-primary"
                :class="{ 'is-finalise': nextBtnComplete }"
                :disabled="nextBtnDisabled"
                v-tip="nextBtnTitle"
                @click="advancePrimary"
              >{{ nextBtnText }}</button>
            </div>
            <p class="cv2-mode-note">Live current-state + next action (P6.2). Next: blockers strip (P6.3).</p>
          </div>
          <p v-else class="cv2-mode-note">Live — loading the active diver… (Full live screen: P6.)</p>
        </section>
        <section v-else-if="centerMode === 'review'" class="cv2-mode" aria-label="Review">
          <p class="cv2-mode-note">Review — standings, judge ranking, recap. (Built in P8.)</p>
        </section>
        <section v-else class="cv2-mode" aria-label="Recovery">
          <p class="cv2-mode-note">Recovery — hold, correction, withdraw, offline/conflict. (Built in P7.)</p>
        </section>
      </div>
    </section>

    <!-- Drawer stub — broadcast handoff / reserves / audit / sponsor;
         lazy-mounted in P8. Closed by default. -->
    <aside class="cv2-drawer" aria-label="Secondary actions" hidden></aside>
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
.cv2-tiles { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
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
  .cv2 { grid-template-columns: 1fr; }
}
</style>
