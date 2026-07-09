<script setup>
// One Live pool's control card. Rendered once per Live event in the
// multi-pool grid, so each card is fully self-contained: it owns its own
// shot clock, auto-advance countdown, and meet-hold (all keyed to this
// card's :event), driven reactively off its :pool. Two pools never share
// a timer or a hold, a background pool runs its own 60s clock and
// auto-advances itself without the operator ever focusing it.
//
// Side-effecting MEET actions (advance the cursor, finalise) stay in the
// parent via the `advance` emit: the parent owns the confirm + socket
// emit + finalise PUT. The card cancels its own in-flight auto-advance on
// a manual click so the operator wins the race. Class names mirror the
// old inline markup so the control-v2 e2e selectors keep resolving.
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { deriveStatus } from '@/composables/useLivePools'
import { useShotClock } from '@/composables/useShotClock'
import { useAutoAdvance, AUTO_ADVANCE_KEY } from '@/composables/useAutoAdvance'
import { useMeetHold } from '@/composables/useMeetHold'
import { useHttpOutbox } from '@/composables/useHttpOutbox'

const props = defineProps({
  event: { type: Object, required: true },
  pool: { type: Object, required: true },
  focused: { type: Boolean, default: false },
  totalJudges: { type: Number, default: 0 },
  socket: { type: Object, required: true },
  // #7: the last set_active_diver for this pool wasn't confirmed by the
  // server (likely rate-limited), so judges may be sitting on a stale diver.
  unconfirmed: { type: Boolean, default: false },
  // Lease: another operator/window is also driving this event (or null)
  conflict: { type: String, default: null },
})
const emit = defineEmits(['focus', 'advance', 'retry-active'])
const { t } = useI18n()

// ---- Per-pool controllers (own lifecycle, auto-clean on card unmount) --
const {
  shotClock, shotClockExpired, shotClockClass, startShotClock, stopShotClock, resetShotClock,
} = useShotClock()
const signaling = computed(() => (props.pool?.judgeTiles || []).some((t) => t.signaled))
const { autoAdvanceSeconds, autoAdvanceCountdown, startAutoAdvance, cancelAutoAdvance } = useAutoAdvance({
  isSignaling: () => signaling.value,
  // Per-event key so each pool keeps its own cadence, no cross-clobber.
  storageKey: `${AUTO_ADVANCE_KEY}:${props.event.id}`,
})
const { queueSocketAction: qsa } = useHttpOutbox()
const { isHeld, holdReason, resumeMeet, confirmHold } = useMeetHold({
  socket: props.socket,
  event: () => props.event,
  onHold: () => resetShotClock(),
  queueSocketAction: qsa,
})

// ---- Derived display state (per pool) ---------------------------------
const info = computed(() => props.pool?.activeInfo || null)
const scoresIn = computed(() => Object.keys(props.pool?.scoresThisRound || {}).length)
const tiles = computed(() => props.pool?.judgeTiles || [])

const liveStatus = computed(() =>
  deriveStatus({
    hasActive: !!props.pool?.currentActive,
    scoresInCount: scoresIn.value,
    clockExpired: shotClockExpired.value,
  }),
)

const isLast = computed(
  () => !!props.pool && props.pool.currentIndex >= (props.pool.roster?.length || 0) - 1,
)
const nextBtnComplete = computed(() => !!props.pool?.advanceArmed && isLast.value)
const nextBtnDisabled = computed(() => !props.pool?.advanceArmed || isHeld.value)
const nextBtnText = computed(() =>
  nextBtnComplete.value
    ? `✓ ${t('control.finalise')} & ${t('control.view_results')}`
    : `${t('control.next_diver')} →`,
)
const nextBtnTitle = computed(() => {
  if (isHeld.value) return 'Meet held — resume to continue'
  if (!nextBtnDisabled.value) {
    return nextBtnComplete.value
      ? 'All rounds complete — finalise the event'
      : 'Advance to the next diver'
  }
  if (!props.pool?.currentActive) return 'Pick an active diver from the queue first'
  const need = props.totalJudges || 5
  const remaining = Math.max(0, need - scoresIn.value)
  return remaining === 0 ? 'Loading…' : `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}`
})

const blockers = computed(() => {
  const p = props.pool
  if (!p || !p.currentActive) return []
  const out = []
  const total = props.totalJudges || 0
  if (total > 0 && scoresIn.value > 0 && scoresIn.value < total) {
    const remaining = total - scoresIn.value
    out.push({ kind: 'partial', label: `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}` })
  }
  const sig = (p.judgeTiles || []).filter((tile) => tile.signaled).map((tile) => tile.judgeIndex)
  if (sig.length) out.push({ kind: 'signal', label: `Judge ${sig.join(', ')} signaling the referee` })
  return out
})

// ---- Reactive controller wiring ---------------------------------------
// Restart the shot clock whenever THIS pool's active dive changes.
const activeKey = computed(() => {
  const a = props.pool?.currentActive
  return a ? `${a.competitor_id}:${a.round_number}` : null
})
function armClockForActive() {
  if (activeKey.value && props.event.status === 'Live' && !isHeld.value) startShotClock()
  else resetShotClock()
}
watch(activeKey, armClockForActive)

// A completed panel stops the clock and arms THIS pool's auto-advance
// (false->true edge only; never auto-fires finalise).
watch(
  () => props.pool?.advanceArmed,
  (armed, was) => {
    if (armed && !was) {
      stopShotClock()
      if (!nextBtnComplete.value && !isHeld.value) startAutoAdvance(fireAdvance)
    }
  },
)

// Re-arm when a referee signal clears; kill the countdown when it raises.
watch(signaling, (now, prev) => {
  if (now) cancelAutoAdvance()
  else if (prev && !nextBtnDisabled.value && !nextBtnComplete.value) startAutoAdvance(fireAdvance)
})

// Hold pauses the clock; resume restarts it for the live dive.
watch(isHeld, (held) => {
  if (held) { resetShotClock(); cancelAutoAdvance() } else armClockForActive()
})

onMounted(armClockForActive)

function fireAdvance() {
  emit('advance')
}
function onPrimary() {
  // A manual advance cancels any in-flight countdown so the click wins.
  cancelAutoAdvance()
  emit('advance')
}

// Referee calls for THIS pool's active diver (ControlView.vue:2330-2345).
// A referee action means the dive needs review, so it kills the in-flight
// auto-advance so the operator isn't racing the timer.
function refAction(type) {
  const a = props.pool?.currentActive
  if (!a) return
  cancelAutoAdvance()
  const payload = { event_id: a.event_id, competitor_id: a.competitor_id, round_number: a.round_number }
  if (type === 'failed') qsa('referee_failed_dive', payload)
  else if (type === 'cap') qsa('referee_cap_scores', { ...payload, cap_value: 2.0 })
  else if (type === 'redive') qsa('referee_redive', payload)
}
function onCardClick() {
  if (!props.focused) emit('focus', props.event.id)
}
const autoNextMenuOpen = ref(false)
const autoNextOptions = [
  { v: 0, label: 'Manual' },
  { v: 5, label: '5 seconds' },
  { v: 10, label: '10 seconds' },
  { v: 15, label: '15 seconds' },
  { v: 20, label: '20 seconds' },
  { v: 25, label: '25 seconds' },
  { v: 30, label: '30 seconds' },
]
function pickAutoNext(v) {
  autoAdvanceSeconds.value = v
  autoNextMenuOpen.value = false
}
function toggleHold() {
  if (isHeld.value) resumeMeet()
  else confirmHold()
}
</script>

<template>
  <article
    class="cv2-pool"
    :class="{ 'is-focused': focused, 'is-held': isHeld }"
    :data-event-id="event.id"
    @click="onCardClick"
  >
    <header class="cv2-pool-head">
      <span class="cv2-pool-title">
        <span v-if="focused" class="cv2-pool-focusdot" aria-hidden="true"></span>
        {{ event.name }}
      </span>
      <span v-if="event.height" class="cv2-pool-meta">{{ event.height }}</span>
      <button
        type="button"
        class="cv2-pool-hold"
        :class="{ 'is-held': isHeld }"
        :aria-pressed="isHeld"
        v-tip="isHeld ? 'Resume this event' : 'Hold this event (pause the clock + judges)'"
        @click.stop="toggleHold"
      >{{ isHeld ? '▶ Resume' : '⏸ Hold' }}</button>
    </header>

    <div v-if="isHeld" class="cv2-pool-heldbar" role="status">
      ⏸ Held<template v-if="holdReason"> — {{ holdReason }}</template>
    </div>
    <div v-if="conflict" class="cv2-pool-conflict" role="status">
      ⚠ Also being controlled by {{ conflict }} — changes may conflict.
    </div>
    <div v-if="unconfirmed" class="cv2-pool-unconfirmed" role="alert">
      <span>⚠ Diver not confirmed to the judges</span>
      <button type="button" class="cv2-pool-retry" @click.stop="emit('retry-active')">Retry</button>
    </div>

    <div v-if="info" class="cv2-live">
      <div class="cv2-live-head">
        <span class="cv2-live-status" :class="`cv2-status-${liveStatus}`">{{ liveStatus.toUpperCase() }}</span>
        <span class="cv2-live-round">Round {{ info.round_number }} / {{ event.total_rounds }}</span>
        <span class="cv2-shotclock" :class="shotClockClass" aria-label="Shot clock">{{ shotClock }}s</span>
      </div>
      <p class="cv2-live-diver">
        {{ info.name }}
        <span v-if="info.country" class="cv2-live-country">{{ info.country }}</span>
      </p>
      <p v-if="info.code || info.desc" class="cv2-live-dive">
        <span v-if="info.code">{{ info.code }}</span>
        <span v-if="info.dd"> · {{ info.dd }}</span>
        <span v-if="info.desc"> · {{ info.desc }}</span>
      </p>
      <div class="cv2-tiles" aria-label="Judge scores">
        <div
          v-for="tile in tiles"
          :key="tile.judgeIndex"
          class="cv2-tile"
          :class="{ scored: tile.scored, signaled: tile.signaled }"
        >{{ tile.scored ? tile.score : '—' }}</div>
      </div>
      <div v-if="blockers.length" class="cv2-blockers" role="status" aria-label="Blockers">
        <span
          v-for="b in blockers"
          :key="b.kind"
          class="cv2-blocker"
          :class="`cv2-blocker-${b.kind}`"
        >{{ b.label }}</span>
      </div>
      <div v-if="pool.currentActive && !isHeld" class="cv2-ref" aria-label="Referee actions">
        <button type="button" class="cv2-ref-btn cv2-ref-failed" v-tip="'Referee: failed dive (scores → 0)'" @click.stop="refAction('failed')">Failed</button>
        <button type="button" class="cv2-ref-btn" v-tip="'Referee: cap each judge score at 2.0'" @click.stop="refAction('cap')">Cap 2.0</button>
        <button type="button" class="cv2-ref-btn" v-tip="'Referee: re-dive (clear scores, dive again)'" @click.stop="refAction('redive')">Re-dive</button>
      </div>
      <div class="cv2-primary-slot">
        <div class="cv2-split">
          <button
            type="button"
            class="cv2-primary"
            :class="{ 'is-finalise': nextBtnComplete, 'is-counting': autoAdvanceCountdown > 0 }"
            :disabled="nextBtnDisabled"
            v-tip="nextBtnTitle"
            @click.stop="onPrimary"
          >
            {{ nextBtnText }}
            <span v-if="autoAdvanceCountdown > 0" class="cv2-autopill">{{ autoAdvanceCountdown }}s</span>
          </button>
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
              @click.stop="pickAutoNext(opt.v)"
            >
              <span>{{ opt.label }}</span>
              <span v-if="autoAdvanceSeconds === opt.v" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <p v-else class="cv2-pool-loading">Loading the active diver…</p>
  </article>
</template>

<style scoped>
.cv2-pool {
  display: flex; flex-direction: column;
  border: 1px solid var(--border-2); border-radius: var(--radius-lg);
  background: var(--bg-2); padding: 1rem 1.25rem; min-width: 0;
}
.cv2-pool.is-focused { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan); }
.cv2-pool.is-held { border-color: var(--amber); }
.cv2-pool:not(.is-focused) { cursor: pointer; }
.cv2-pool:not(.is-focused):hover { border-color: var(--border); }
.cv2-pool-head {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.85rem;
}
.cv2-pool-title {
  display: flex; align-items: center; gap: 0.4rem;
  font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--fg);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cv2-pool-focusdot { width: 8px; height: 8px; border-radius: 50%; background: var(--cyan); flex: none; }
.cv2-pool-meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-inline-start: auto; }
.cv2-pool-hold {
  flex: none; padding: 0.25rem 0.55rem; border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-3); cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.cv2-pool-hold:hover { color: var(--amber); border-color: var(--amber); }
.cv2-pool-hold.is-held { color: var(--bg); background: var(--amber); border-color: var(--amber); }
.cv2-pool-heldbar {
  margin-bottom: 0.75rem; padding: 0.4rem 0.7rem; border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.14); color: var(--amber);
  font-family: var(--font-mono); font-size: 12px;
}
.cv2-pool-conflict {
  margin-bottom: 0.75rem; padding: 0.4rem 0.7rem; border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.12); color: var(--amber);
  font-family: var(--font-mono); font-size: 12px;
}
.cv2-pool-unconfirmed {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  margin-bottom: 0.75rem; padding: 0.4rem 0.5rem 0.4rem 0.7rem; border-radius: var(--radius-sm);
  background: rgba(239, 68, 68, 0.14); color: var(--red);
  font-family: var(--font-mono); font-size: 12px;
}
.cv2-pool-retry {
  flex: none; padding: 0.25rem 0.7rem; border: 1px solid var(--red); border-radius: var(--radius-sm);
  background: transparent; color: var(--red); cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.cv2-pool-retry:hover { background: var(--red); color: var(--bg); }
.cv2-pool-loading { margin: 0; font-family: var(--font-mono); font-size: 13px; color: var(--text-3); }

.cv2-live-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
.cv2-live-status {
  font-family: var(--font-display); font-size: 11px; font-weight: 800; letter-spacing: 0.18em;
  padding: 0.2rem 0.6rem; border-radius: 999px; background: var(--bg-3); color: var(--text-2);
}
.cv2-status-diving { color: var(--cyan); background: rgba(6, 182, 212, 0.12); }
.cv2-status-judging { color: var(--amber); background: rgba(245, 158, 11, 0.12); }
.cv2-live-round { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-shotclock {
  margin-inline-start: auto;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700;
  padding: 0.15rem 0.6rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); color: var(--text-2);
}
.cv2-shotclock.shot-clock-amber { color: var(--amber); border-color: var(--amber); }
.cv2-shotclock.shot-clock-warn { color: var(--red); border-color: var(--red); }
.cv2-shotclock.shot-clock-expired { color: var(--red); background: rgba(239, 68, 68, 0.12); border-color: var(--red); }
.cv2-live-diver { margin: 0 0 0.4rem; font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--fg); }
.cv2-live-country { font-family: var(--font-mono); font-size: 13px; font-weight: 400; color: var(--text-3); margin-inline-start: 0.5rem; }
.cv2-live-dive { margin: 0 0 1rem; font-family: var(--font-mono); font-size: 13px; color: var(--text-2); }

.cv2-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(44px, 1fr)); gap: 6px; margin-bottom: 0.75rem; }
.cv2-tile {
  display: flex; align-items: center; justify-content: center;
  height: 40px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-2); background: var(--bg-3);
  font-family: var(--font-mono); font-size: 15px; font-weight: 700; color: var(--text-3);
}
.cv2-tile.scored { color: var(--fg); border-color: var(--cyan); background: rgba(6, 182, 212, 0.08); }
.cv2-tile.signaled { border-color: var(--amber); background: rgba(245, 158, 11, 0.12); }

.cv2-blockers { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }
.cv2-blocker {
  font-family: var(--font-mono); font-size: 12px;
  padding: 0.2rem 0.55rem; border-radius: var(--radius-sm);
  background: var(--bg-3); color: var(--text-2);
}
.cv2-blocker-signal { color: var(--amber); background: rgba(245, 158, 11, 0.12); }

.cv2-ref { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.6rem; }
.cv2-ref-btn {
  flex: 1; min-width: 70px; padding: 0.4rem 0.5rem;
  border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-2); cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
}
.cv2-ref-btn:hover { color: var(--fg); border-color: var(--text-3); }
.cv2-ref-failed:hover { color: var(--red); border-color: var(--red); }

.cv2-primary-slot { margin-top: auto; padding-top: 1rem; }
.cv2-split { display: flex; gap: 2px; position: relative; }
.cv2-primary {
  flex: 1; padding: 0.85rem 1.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  border-radius: var(--radius); border: 1px solid var(--cyan);
  background: var(--cyan); color: var(--bg); cursor: pointer; transition: filter 0.12s;
}
.cv2-primary:hover:not(:disabled) { filter: brightness(1.08); }
.cv2-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.cv2-primary.is-finalise { background: var(--green); border-color: var(--green); }
.cv2-primary.is-counting { background: var(--amber); border-color: var(--amber); }
.cv2-autopill {
  margin-inline-start: 0.5rem; font-family: var(--font-mono); font-size: 12px;
  padding: 0.05rem 0.45rem; border-radius: 999px; background: rgba(0,0,0,0.18);
}
.cv2-split-aside {
  width: 38px; flex: none; border: 1px solid var(--cyan); border-inline-start: 0;
  border-radius: var(--radius); background: var(--cyan); color: var(--bg);
  font-size: 14px; cursor: pointer;
}
.cv2-split-aside.is-finalise { background: var(--green); border-color: var(--green); }
.cv2-autonext-menu {
  position: absolute; bottom: calc(100% + 6px); inset-inline-end: 0; z-index: 20;
  min-width: 220px; padding: 0.4rem; border: 1px solid var(--border-2);
  border-radius: var(--radius); background: var(--bg-2); box-shadow: 0 8px 24px rgba(0,0,0,0.25);
}
.cv2-autonext-head { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.25rem 0.5rem 0.4rem; }
.cv2-autonext-item {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  padding: 0.5rem; border: 0; border-radius: var(--radius-sm); background: transparent;
  color: var(--text-1, var(--fg)); font-size: 13px; cursor: pointer;
}
.cv2-autonext-item:hover, .cv2-autonext-item.is-active { background: var(--bg-3); }
</style>
