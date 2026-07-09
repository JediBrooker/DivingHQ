<script setup>
/* Event status pill: a single source of truth for the
 * Setup / Upcoming / Live / Completed visual vocabulary used by
 * the dashboard pulse strip, attention cards, control room,
 * scoreboard, and event manager. Keeps colours + dot semantics
 * consistent so users dont have to relearn them per surface.
 *
 * Sizes: 'sm' (header chip) | 'md' (default) | 'lg' (hero header).
 * The 'live' variant breathes gently, matching the pulse strip.
 */
import { computed } from 'vue'

const props = defineProps({
  status: { type: String, required: true },
  size:   { type: String, default: 'md' }, // sm | md | lg
  /* Hide the icon dot, e.g. when the surrounding label already
     carries one. */
  iconless: { type: Boolean, default: false },
})

const norm = computed(() => (props.status || '').toLowerCase().trim())
const meta = computed(() => {
  switch (norm.value) {
    case 'live':       return { label: 'Live',      icon: '🔴', cls: 'pill-live' }
    case 'upcoming':   return { label: 'Upcoming',  icon: '📅', cls: 'pill-upcoming' }
    case 'completed':  return { label: 'Completed', icon: '✓',  cls: 'pill-completed' }
    case 'setup':      return { label: 'Setup',     icon: '🛠', cls: 'pill-setup' }
    case 'cancelled':  return { label: 'Cancelled', icon: '✕',  cls: 'pill-cancelled' }
    default:           return { label: props.status || '—', icon: '•', cls: 'pill-other' }
  }
})
</script>

<template>
  <span :class="['status-pill', meta.cls, `pill-size-${size}`]">
    <span v-if="!iconless" class="status-pill-icon" aria-hidden="true">{{ meta.icon }}</span>
    <span class="status-pill-label">{{ meta.label }}</span>
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-flex; align-items: center; gap: 0.4em;
  padding: 0.25em 0.7em;
  border-radius: 999px;
  font-family: var(--font-display, sans-serif);
  font-weight: 700; font-style: italic;
  letter-spacing: 0.08em; text-transform: uppercase;
  border: 1px solid currentColor;
  white-space: nowrap;
}
.pill-size-sm { font-size: 10px; padding: 0.18em 0.55em; }
.pill-size-md { font-size: 11px; }
.pill-size-lg { font-size: 13px; padding: 0.32em 0.85em; }

.status-pill-icon { font-style: normal; font-size: 0.9em; line-height: 1; }
.status-pill-label { line-height: 1; }

.pill-live      { color: var(--red, #ef4444); background: rgba(239,68,68,0.10); animation: pill-breathe 2.4s ease-in-out infinite; }
.pill-upcoming  { color: var(--cyan, #06b6d4); background: rgba(6,182,212,0.08); }
.pill-completed { color: var(--green, #10b981); background: rgba(16,185,129,0.08); }
.pill-setup     { color: #a78bfa; background: rgba(167,139,250,0.08); }
.pill-cancelled { color: var(--text-3, #94a3b8); background: rgba(148,163,184,0.08); }
.pill-other     { color: var(--text-3, #94a3b8); background: rgba(148,163,184,0.06); }

@keyframes pill-breathe {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
  50%      { box-shadow: 0 0 0 4px rgba(239,68,68,0.15); }
}

@media (prefers-reduced-motion: reduce) {
  .pill-live { animation: none; }
}
</style>
