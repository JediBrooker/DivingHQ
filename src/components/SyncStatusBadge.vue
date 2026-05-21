<script setup>
/* Small chip showing the sync state of a queued action.
 *
 * Used inline next to anything that lives in the outbox: a score
 * row, a coach's pending dive-list edit, a referee-action item in
 * the audit log. Variants map to the outbox state machine:
 *
 *   pending   — ⏳ amber, "queued, waiting for network"
 *   inflight  — 🔄 cyan,  "send in progress"
 *   synced    — ✓ subtle, "server accepted" (only shown for the
 *                first few seconds after success; usually fades
 *                out of the UI)
 *   failed    — ⚠ red,   "max retries exhausted, needs manual help"
 *   conflict  — 🔀 magenta, "server rejected, needs operator review"
 *
 * Density-first: 11px monospace, fits next to a 32px score chip.
 * Visual language matches the rest of the app's chip + tag idiom
 * (see src/components/JudgeRankingTable.vue's status pills).
 */
import { computed } from 'vue'

const props = defineProps({
  status: {
    type: String,
    required: true,
    validator: (v) => ['pending', 'inflight', 'synced', 'failed', 'conflict'].includes(v),
  },
  /** Optional count; rendered as "⏳ 3" when > 1. */
  count: { type: Number, default: 0 },
  /** When true, show the long-form label ("queued, will send"). When false (default), icon only. */
  showLabel: { type: Boolean, default: false },
})

const icon = computed(() => ({
  pending:  '⏳',
  inflight: '🔄',
  synced:   '✓',
  failed:   '⚠',
  conflict: '🔀',
}[props.status]))

const tone = computed(() => props.status)
</script>

<template>
  <span :class="['sync-badge', `sync-badge--${tone}`]"
        :title="$t(`sync_badge.${status}_full`)"
        :aria-label="$t(`sync_badge.${status}_full`)">
    <span class="sync-badge-icon" aria-hidden="true">{{ icon }}</span>
    <span v-if="count > 1" class="sync-badge-count">{{ count }}</span>
    <span v-if="showLabel" class="sync-badge-label">{{ $t(`sync_badge.${status}`) }}</span>
  </span>
</template>

<style scoped>
.sync-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.35rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}
.sync-badge-icon { font-size: 11px; }
.sync-badge-count {
  font-weight: 700;
  letter-spacing: 0.02em;
}
.sync-badge-label {
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
}

/* Tonal variants. We lean on the cyan / amber / red palette
   already in use across the app (see ScoreboardView's status
   chips and ControlView's queue indicators). */
.sync-badge--pending {
  border-color: rgba(245, 158, 11, 0.45);
  color: #f59e0b;
}
.sync-badge--inflight {
  border-color: rgba(6, 182, 212, 0.55);
  color: var(--cyan);
  animation: sync-spin 1.2s linear infinite;
}
.sync-badge--synced {
  border-color: rgba(34, 197, 94, 0.4);
  color: #22c55e;
  opacity: 0.7;
}
.sync-badge--failed {
  border-color: rgba(239, 68, 68, 0.5);
  color: #ef4444;
}
.sync-badge--conflict {
  border-color: rgba(217, 70, 239, 0.5);
  color: #d946ef;
}

/* Inflight gets a subtle spin on the icon glyph only; we can't
   rotate the whole badge because that'd rotate the count too. */
@keyframes sync-spin {
  /* Use a gentle pulse instead of a literal rotate to keep the
     emoji readable. The chip subtly breathes between full
     opacity and 70% — enough to draw the eye without being
     distracting. */
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.7; }
}

@media (prefers-reduced-motion: reduce) {
  .sync-badge--inflight { animation: none; }
}
</style>
