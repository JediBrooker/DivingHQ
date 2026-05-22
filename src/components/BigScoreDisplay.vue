<script setup>
/* Full-screen big-number score display for manual fallback mode.
 *
 * When the meet goes analog during an extended outage, the
 * operator reads each judge's score off the judge's phone screen.
 * This component fills the screen with the score so it's legible
 * from across the room. Tapping anywhere returns to the normal
 * JudgeView.
 *
 * Visual posture: very high contrast, very large digit, minimal
 * chrome. Designed to be readable from 5–10 metres away under
 * mixed venue lighting. The judge's name + judge number stay
 * visible so the operator knows whose value they're typing.
 *
 * Props:
 *   score        — the value to display (number, e.g. 8.5)
 *   judgeNumber  — slot index on the panel (1, 2, …, N)
 *   judgeName    — full name of the judge
 *
 * Emits:
 *   close        — user tapped to exit big mode
 */
import { onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  score:       { type: Number, required: true },
  judgeNumber: { type: Number, default: null },
  judgeName:   { type: String, default: '' },
})
const emit = defineEmits(['close'])

function fmt(value) {
  return value % 1 === 0 ? value.toString() : value.toFixed(1)
}

// Keep the screen awake while big mode is open — the judge's
// phone shouldn't auto-dim mid-display. We don't re-acquire on
// visibility change here because BigScoreDisplay is short-lived
// (a few seconds while the operator reads); the parent JudgeView
// owns the long-lived wake lock.
let bigWakeLock = null
async function acquireBigWakeLock() {
  if (!('wakeLock' in navigator)) return
  try {
    bigWakeLock = await navigator.wakeLock.request('screen')
  } catch { /* permission denied or unsupported */ }
}

function onKeydown(e) {
  // Escape exits big mode. Operator reads the value, hits escape
  // on the judge's keyboard (if connected), back to normal view.
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  acquireBigWakeLock()
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  try { bigWakeLock?.release?.() } catch { /* ignore */ }
  bigWakeLock = null
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <button class="big-score-display"
          type="button"
          @click="emit('close')"
          :aria-label="`Score ${fmt(score)}. Tap to return.`">
    <div class="big-score-judge">
      <span v-if="judgeNumber" class="big-score-judge-number">J{{ judgeNumber }}</span>
      <span v-if="judgeName" class="big-score-judge-name">{{ judgeName }}</span>
    </div>
    <div class="big-score-digit">{{ fmt(score) }}</div>
    <div class="big-score-hint">{{ $t('judge.tap_to_return') }}</div>
  </button>
</template>

<style scoped>
.big-score-display {
  position: fixed; inset: 0;
  background: var(--bg);
  color: var(--text);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 1rem;
  border: none;
  cursor: pointer;
  font-family: var(--font-display);
  z-index: 1000;
  /* Take full advantage of the viewport — no scrolling. */
  overscroll-behavior: contain;
  /* Reset default button styles so the click target acts like
     a regular div but still gets keyboard focus + screen
     reader semantics. */
  appearance: none;
  padding: 0;
  text-align: center;
}

.big-score-judge {
  display: flex; flex-direction: column; gap: 0.2rem;
  font-size: 14px;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--text-3);
  font-weight: 700;
}
.big-score-judge-number {
  color: var(--cyan);
  font-size: 18px;
  font-style: italic;
}
.big-score-judge-name {
  font-family: var(--font-mono);
  font-size: 13px;
  letter-spacing: 0.05em;
  text-transform: none;
  color: var(--text-2);
}

.big-score-digit {
  /* Fill ~70% of the viewport's smaller axis. clamp() prevents
     a tiny phone screen from getting an absurdly small digit
     while still capping the max for a desktop tester. */
  font-size: clamp(160px, 60vmin, 360px);
  font-weight: 900; font-style: italic;
  line-height: 1;
  color: var(--text);
  /* Subtle glow so the digit stays legible against the dark
     panel. The shadow is purely decorative — readability is
     driven by the raw white-on-black contrast. */
  text-shadow: 0 0 24px rgba(6, 182, 212, 0.18);
}

.big-score-hint {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
}

/* Tap-to-dismiss visual feedback. */
.big-score-display:active {
  background: var(--surface);
}

@media (prefers-reduced-motion: reduce) {
  .big-score-digit { text-shadow: none; }
}
</style>
