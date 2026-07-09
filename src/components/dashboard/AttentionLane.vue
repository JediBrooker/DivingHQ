<script setup>
// P4 (2/2): the Dashboard needs-attention lane, presentational only.
// The chip + popover markup got lifted out of DashboardView verbatim
// so the ranked lane is a reusable surface. No fetch, no business
// logic here: the parent passes the already-ranked chips (most urgent
// first), the open popover id, and the flashing set, and gets a
// chip-click back. The count -> named-items -> deep-link popover drill
// is unchanged, only the host moved. Motion stays one-shot/static (the
// P1 reduced-motion guard lives in app.css + the parents per-file guard).
defineProps({
  chips: { type: Array, default: () => [] },
  openId: { type: [String, null], default: null },
  flashing: { type: Object, default: () => new Set() }, // Set<chipId>
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['chip-click'])
</script>

<template>
  <div class="pulse-strip">
    <!-- Skeleton placeholder while the initial pulse fetches. Three ghost
         chips so the strip doesn't look empty before the real data lands. -->
    <template v-if="loading">
      <span v-for="n in 3" :key="`sk-${n}`" class="pulse-skeleton" aria-hidden="true"></span>
    </template>
    <template v-else>
      <!-- Chip is a role=button div (NOT a <button>) since it nests
           <RouterLink> popover items and an anchor inside a button is
           invalid HTML. Keyboard handlers preserve button-like Enter/Space. -->
      <div
        v-for="chip in chips"
        :key="chip.id"
        role="button"
        tabindex="0"
        :class="[
          'pulse-chip',
          `pulse-${chip.kind}`,
          flashing.has(chip.id) ? 'pulse-flash' : '',
          openId === chip.id ? 'is-open' : '',
        ]"
        :aria-label="`${chip.popoverTitle} — click to view in ${chip.targetTab.replace('_', ' ')} tab`"
        @click="emit('chip-click', chip)"
        @keydown.enter.prevent="emit('chip-click', chip)"
        @keydown.space.prevent="emit('chip-click', chip)"
      >
        <span v-if="chip.glyph" class="pulse-glyph" aria-hidden="true">{{ chip.glyph }}</span>
        <template v-if="chip.layout === 'count-after'">
          <span class="pulse-text">{{ chip.label }}</span>
          <span class="pulse-num">{{ chip.number }}</span>
        </template>
        <template v-else>
          <span class="pulse-num">{{ chip.number }}</span>
          <span class="pulse-text">{{ chip.label }}</span>
        </template>
        <!-- Hover/focus popover, hides entirely when items.length === 0. -->
        <div v-if="chip.items.length" class="pulse-popover" role="menu">
          <div class="pulse-popover-head">{{ chip.popoverTitle }}</div>
          <RouterLink
            v-for="item in chip.items"
            :key="item.id"
            :to="item.to"
            :class="['pulse-popover-item', item.urgency ? `pulse-popover-${item.urgency}` : '']"
            role="menuitem"
            @click.stop
          >
            <span class="pulse-popover-item-title">{{ item.title }}</span>
            <span v-if="item.meta" class="pulse-popover-item-meta">{{ item.meta }}</span>
            <span v-if="item.urgency === 'urgent'" class="pulse-urgency-pill pulse-urgency-urgent">closing soon</span>
            <span v-else-if="item.urgency === 'overdue'" class="pulse-urgency-pill pulse-urgency-overdue">overdue</span>
            <span v-else-if="item.urgency === 'live'" class="pulse-urgency-pill pulse-urgency-live">live</span>
          </RouterLink>
        </div>
      </div>

      <span v-if="!chips.length" class="pulse-quiet">All quiet — nothing pending.</span>
    </template>
  </div>
</template>

<style scoped>
/* P1: reduced-motion guard (tracked per-file by the P0 scanner) */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
.pulse-strip {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 0.45rem 1.1rem;
  width: calc(100% - 4rem);
  max-width: calc(1400px - 4rem);
  margin: 1.25rem auto 0;
  padding: 0.75rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--text-3);
}
.pulse-chip {
  position: relative;
  display: inline-flex; align-items: center; gap: 0.4rem;
  background: transparent; border: 0;
  padding: 0.2rem 0.4rem;
  margin: -0.2rem -0.4rem;
  border-radius: 4px;
  font: inherit;
  color: inherit;
  letter-spacing: inherit;
  cursor: pointer;
  transition: background 0.12s, transform 0.12s;
}
.pulse-chip:hover  { background: rgba(255, 255, 255, 0.04); }
.pulse-chip:focus  { outline: none; }
.pulse-chip:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
.pulse-text { font-style: normal; }
.pulse-num {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 800;
  letter-spacing: 0;
  padding: 0.05rem 0.5rem;
  border-radius: 3px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  transition: transform 0.18s, box-shadow 0.18s;
}
.pulse-glyph {
  display: inline-flex; align-items: center;
  font-size: 14px; line-height: 1;
  margin-inline-end: 0.05rem;
}
.pulse-live     .pulse-num { color: var(--red);   border-color: rgba(239,68,68,0.4);   background: rgba(239,68,68,0.08); }
.pulse-upcoming .pulse-num { color: var(--cyan);  border-color: rgba(6,182,212,0.4);   background: rgba(6,182,212,0.08); }
.pulse-pending  .pulse-num { color: #a78bfa;      border-color: rgba(167,139,250,0.4); background: rgba(167,139,250,0.08); }
.pulse-diver    .pulse-num { color: var(--green); border-color: rgba(16,185,129,0.4);  background: rgba(16,185,129,0.08); }
.pulse-judge    .pulse-num { color: var(--amber); border-color: rgba(245,158,11,0.4);  background: rgba(245,158,11,0.08); }
.pulse-coach    .pulse-num { color: #f472b6;      border-color: rgba(244,114,182,0.4); background: rgba(244,114,182,0.08); }

/* Flash effect, one-shot ~1.4s when a count changes (the parent only adds
   the class on a real numeric delta, never at rest). */
@keyframes pulseFlash {
  0%   { transform: scale(1);    box-shadow: 0 0 0 0 currentColor; }
  20%  { transform: scale(1.18); box-shadow: 0 0 0 6px rgba(6, 182, 212, 0.15); }
  100% { transform: scale(1);    box-shadow: 0 0 0 0 transparent; }
}
.pulse-chip.pulse-flash .pulse-num { animation: pulseFlash 1.4s ease-out; }
.pulse-chip.pulse-live.pulse-flash { animation: pulseFlash 1.4s ease-out; }

.pulse-quiet {
  font-family: var(--font-mono); font-size: 12px; font-weight: 500;
  letter-spacing: 0.04em; text-transform: none; color: var(--text-3);
  font-style: italic;
}
.pulse-popover {
  position: absolute;
  top: 100%;
  inset-inline-start: 0;
  margin-top: 0.4rem;
  min-width: 280px;
  max-width: min(420px, 90vw);
  z-index: 100;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
  padding: 0.45rem 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  letter-spacing: 0;
  text-transform: none;
}
.pulse-popover::before {
  content: '';
  position: absolute;
  top: -0.5rem;
  inset-inline-start: 0; inset-inline-end: 0;
  height: 0.5rem;
}
.pulse-chip:hover .pulse-popover,
.pulse-chip:focus-within .pulse-popover,
.pulse-chip.is-open .pulse-popover {
  opacity: 1;
  pointer-events: auto;
}
@keyframes pulse-sheet-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}
@keyframes pulse-sheet-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.pulse-popover-head {
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  padding: 0.45rem 0.95rem 0.55rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.35rem;
}
.pulse-popover-item {
  display: flex; flex-direction: column;
  gap: 0.15rem;
  padding: 0.5rem 0.95rem;
  text-decoration: none;
  text-align: start;
  transition: background 0.12s;
}
.pulse-popover-item:hover { background: var(--bg-3); }
.pulse-popover-item-title {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700;
  font-style: italic;
  letter-spacing: 0.02em;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pulse-popover-item-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pulse-popover-urgent  { border-inline-start: 3px solid var(--amber); }
.pulse-popover-overdue { border-inline-start: 3px solid var(--red); }
.pulse-popover-live    { border-inline-start: 3px solid var(--red); }
.pulse-urgency-pill {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  margin-top: 0.25rem;
  align-self: flex-start;
}
.pulse-urgency-urgent  { color: var(--amber); background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35); }
.pulse-urgency-overdue { color: var(--red);   background: rgba(239,68,68,0.12);  border: 1px solid rgba(239,68,68,0.35); }
.pulse-urgency-live    { color: var(--red);   background: rgba(239,68,68,0.12);  border: 1px solid rgba(239,68,68,0.4); }
.pulse-skeleton {
  display: inline-block;
  width: 110px;
  height: 22px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-2), var(--bg-3), var(--bg-2));
  background-size: 200% 100%;
  opacity: 0.55;
}
.pulse-skeleton:nth-child(2) { width: 140px; }
.pulse-skeleton:nth-child(3) { width: 90px; }

/* Tablet: tighter strip. */
@media (max-width: 900px) {
  .pulse-strip {
    width: calc(100% - 2.5rem);
    max-width: calc(1400px - 2.5rem);
    padding: 0.6rem 0.85rem;
    gap: 0.4rem 0.85rem;
    min-width: 0;
  }
}

/* Phone: chips scroll horizontally, popover floats up as a bottom sheet. */
@media (max-width: 600px) {
  .pulse-strip {
    margin: 0.85rem auto 0;
    width: calc(100% - 2rem);
    padding: 0.55rem 0.7rem;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    min-width: 0;
  }
  .pulse-strip::-webkit-scrollbar { display: none; }
  .pulse-chip { flex-shrink: 0; }
  .pulse-num { font-size: 13px; padding: 0.1rem 0.45rem; }
  .pulse-chip.is-open .pulse-popover {
    position: fixed;
    top: auto;
    inset-inline-start: 0;
    inset-inline-end: 0;
    bottom: 0;
    transform: none;
    margin-top: 0;
    min-width: 0;
    max-width: none;
    width: 100%;
    max-height: 70vh;
    max-height: 70dvh;
    overflow-y: auto;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: 0;
    box-shadow: 0 -16px 36px rgba(0, 0, 0, 0.55);
    z-index: 200;
    padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom, 0px));
    animation: pulse-sheet-up 0.2s ease-out;
  }
  .pulse-chip.is-open::before {
    content: '';
    position: fixed;
    inset: 0;
    background: rgba(3, 7, 18, 0.55);
    -webkit-backdrop-filter: blur(4px);
    backdrop-filter: blur(4px);
    z-index: 150;
    animation: pulse-sheet-fade 0.2s ease-out;
  }
  .pulse-chip.is-open .pulse-popover-head {
    text-align: center;
    padding: 0.85rem 1rem 0.7rem;
    position: relative;
  }
  .pulse-chip.is-open .pulse-popover-head::before {
    content: '';
    position: absolute;
    top: 0.45rem;
    inset-inline-start: 50%;
    transform: translateX(-50%);
    width: 40px;
    height: 4px;
    background: var(--border-2, var(--border));
    border-radius: 999px;
  }
  .pulse-chip.is-open .pulse-popover-item {
    padding: 0.85rem 1rem;
    min-height: 48px;
  }
}
</style>
