<script setup>
/* MeetEventGrid: one row per discipline, progression stages laid
 * out as aligned ordinal columns.
 *
 * Presentational only, it takes already-grouped `rows` (see
 * src/composables/useProgressionGroups.js) plus the group's
 * `maxCols` and renders an aligned grid. First column is the
 * discipline (name + tags), the rest are the stages in
 * progression order. A straight final just fills column 1 and
 * leaves the rest as faint placeholders so every row's columns
 * still line up.
 *
 * Each stage cell is a button, click emits `select(eventId)`.
 * Same component drives the live Scoreboard (cells carry a
 * LIVE/FINAL badge plus Watch/Recap affordance) and the
 * DiveRecorder archive (no badge, just a "Results" affordance).
 * The affordance's derived per cell from its status, so we don't
 * need a mode flag for it.
 */
const props = defineProps({
  rows:    { type: Array,  required: true },
  maxCols: { type: Number, default: 1 },
})
const emit = defineEmits(['select'])

// Pad a row's stages out to maxCols with nulls, so the trailing
// empty columns still render as alignment placeholders.
function cells(row) {
  const out = row.stages.slice()
  while (out.length < props.maxCols) out.push(null)
  return out
}
function cta(cell) {
  if (cell.status === 'live')     return 'Watch'
  if (cell.status === 'upcoming') return 'Preview'
  if (cell.status === 'final')    return 'Recap'
  return 'Results'
}
function cellClass(cell) {
  if (cell.status === 'live')     return 'ev-cell-live'
  if (cell.status === 'upcoming') return 'ev-cell-upcoming'
  return ''
}
</script>

<template>
  <div class="ev-grid">
    <div v-for="row in rows" :key="row.key" class="ev-row" :style="{ '--cols': maxCols }">
      <div class="ev-disc">
        <span class="ev-disc-name">{{ row.discipline }}</span>
        <span v-if="row.tags.length" class="ev-disc-tags">
          <span v-for="(t, i) in row.tags" :key="i" :class="['ev-tag', { 'ev-tag-cyan': t.cyan }]">{{ t.text }}</span>
        </span>
      </div>
      <template v-for="(cell, i) in cells(row)" :key="i">
        <button
          v-if="cell"
          :class="['ev-cell', cellClass(cell)]"
          @click="emit('select', cell.id)"
        >
          <span class="ev-cell-top">
            <span class="ev-cell-stage">{{ cell.label }}</span>
            <span v-if="cell.status === 'live'" class="ev-cell-badge live">● LIVE</span>
            <span v-else-if="cell.status === 'upcoming'" class="ev-cell-badge upcoming">SOON</span>
            <span v-else-if="cell.status === 'final'" class="ev-cell-badge final">FINAL</span>
          </span>
          <span class="ev-cell-bot">
            <span v-if="cell.count" class="ev-cell-count">{{ cell.count }} {{ cell.count === 1 ? 'diver' : 'divers' }}</span>
            <span v-else class="ev-cell-count ev-cell-count-dim">—</span>
            <span class="ev-cell-cta">{{ cta(cell) }} →</span>
          </span>
        </button>
        <div v-else class="ev-cell ev-cell-empty" aria-hidden="true"></div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* P1: reduced-motion guard, tracked per-file by the P0 scanner.
   Just reinforces the global guard in app.css. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
.ev-grid { display: flex; flex-direction: column; gap: 0.45rem; }

/* Each row is its own grid sharing an identical column template
   (label + N equal stage columns) so columns line up across
   every row, no need for one shared grid container. */
.ev-row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) repeat(var(--cols), minmax(0, 1fr));
  gap: 0.5rem;
  align-items: stretch;
}

.ev-disc {
  display: flex; flex-direction: column; gap: 0.3rem; justify-content: center;
  padding: 0.45rem 0.25rem; min-width: 0;
}
.ev-disc-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 800;
  font-style: italic; color: var(--text); line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ev-disc-tags { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.ev-tag {
  font-family: var(--font-mono); font-size: 9.5px;
  color: var(--text-3); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0.05rem 0.35rem;
}
.ev-tag-cyan { color: var(--cyan); border-color: rgba(6,182,212,0.3); background: var(--cyan-dim); }

.ev-cell {
  text-align: start; cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.6rem;
  display: flex; flex-direction: column; justify-content: space-between; gap: 0.3rem;
  transition: border-color 0.12s, background 0.12s, transform 0.1s;
  min-width: 0; min-height: 54px;
}
.ev-cell:hover { border-color: var(--cyan); background: rgba(6,182,212,0.06); transform: translateY(-1px); }
.ev-cell-live { border-color: rgba(239,68,68,0.4); }
.ev-cell-live:hover { border-color: var(--red); background: rgba(239,68,68,0.06); }
.ev-cell-upcoming { border-color: rgba(245,158,11,0.4); }
.ev-cell-upcoming:hover { border-color: var(--amber); background: rgba(245,158,11,0.06); }

.ev-cell-empty {
  background: transparent; border: 1px dashed var(--border);
  opacity: 0.3; cursor: default; min-height: 54px;
}
.ev-cell-empty:hover { transform: none; }

.ev-cell-top { display: flex; align-items: center; justify-content: space-between; gap: 0.4rem; }
.ev-cell-stage {
  font-family: var(--font-display); font-size: 12px; font-weight: 800;
  letter-spacing: 0.03em; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ev-cell-badge {
  font-family: var(--font-display); font-size: 8.5px; font-weight: 900;
  letter-spacing: 0.1em; padding: 0.1rem 0.35rem; border-radius: 3px; flex-shrink: 0;
}
.ev-cell-badge.live { background: var(--red); color: #fff; animation: ev-pulse 2s infinite; }
.ev-cell-badge.upcoming { background: var(--amber); color: #fff; }
.ev-cell-badge.final { background: var(--surface); color: var(--text-3); border: 1px solid var(--border); }

.ev-cell-bot {
  display: flex; align-items: baseline; justify-content: space-between; gap: 0.4rem;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
}
.ev-cell-count-dim { opacity: 0.5; }
.ev-cell-cta {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); white-space: nowrap;
}
.ev-cell-live .ev-cell-cta { color: var(--red); }
.ev-cell-upcoming .ev-cell-cta { color: var(--amber); }

/* Local keyframe (scoped) so this component stays self-contained
   in both host views, doesn't matter which global stylesheet loaded. */
@keyframes ev-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.65; } }

@media (max-width: 720px) {
  /* Phones: collapse the bracket, discipline gets its own line,
     stage cells stack full-width beneath it. Placeholders get
     dropped here so empty stages don't waste vertical space. */
  .ev-row { grid-template-columns: 1fr; gap: 0.35rem; }
  .ev-disc { padding: 0.15rem 0.25rem 0; }
  .ev-cell-empty { display: none; }
}
</style>
