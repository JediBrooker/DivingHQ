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
import { useLivePools, initJudgeTiles } from '@/composables/useLivePools'
import { idbInvalidate } from '@/lib/idbCache'

const route = useRoute()
const auth = useAuthStore()

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
  routeScore(data, numberOfJudgesFor)
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
  pool.judgeTiles = initJudgeTiles(ev.number_of_judges)
  try {
    const roster = await auth.apiFetch(`/api/events/${ev.id}/roster`)
    pool.currentActive = Array.isArray(roster) && roster.length ? roster[0] : null
    // Tell the server who is up in THIS pool (event-scoped), so judge
    // scores for it are accepted + broadcast back as score_received --
    // for every Live pool, not just the focused one.
    if (pool.currentActive) {
      socket.emit('set_active_diver', { ...pool.currentActive, status: 'ready' })
    }
  } catch {
    pool.currentActive = null
  }
}

async function selectEvent(id) {
  selectedEventId.value = String(id)
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
          <div v-if="livePool && livePool.currentActive" class="cv2-live">
            <p class="cv2-live-diver">{{ livePool.currentActive.full_name }}</p>
            <div class="cv2-tiles" aria-label="Judge scores">
              <div
                v-for="t in livePool.judgeTiles"
                :key="t.judgeIndex"
                class="cv2-tile"
                :class="{ scored: t.scored, signaled: t.signaled }"
              >{{ t.scored ? t.score : '—' }}</div>
            </div>
            <p class="cv2-mode-note">Live — active diver + judge tiles route per-pool. Full screen (queue, shot clock, primary action): P6.</p>
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
.cv2-live-diver { margin: 0 0 1rem; font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--fg); }
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
