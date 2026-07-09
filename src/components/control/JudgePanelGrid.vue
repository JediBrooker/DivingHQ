<script setup>
/* JudgePanelGrid: the live judge-tile grid extracted from the
 * Control Room's active-diver panel (ControlView.vue). Pure
 * presentation, one tile per panel judge showing their submitted
 * score, with a green "scored" state and a pulsing red "signaled"
 * state when a judge has tapped Signal Referee on their keypad.
 *
 * Two layouts, chosen by the parent:
 *   - synchro events pass `tilesByGroup` (Exec A / Exec B / Sync
 *     columns) so the operator sees who scores what role;
 *   - individual/team events leave it null and the flat `tiles`
 *     grid renders.
 *
 * State boundary: ControlView OWNS the tiles. It builds them in
 * initJudgeTiles(), mutates `.scored` / `.score` on score_received
 * and `.signaled` on judge_signal, and clears them between dives.
 * This component just renders what it's handed, no socket
 * listeners, no emits. v-tip is a globally-registered directive
 * (src/main.js), so it works here with no import.
 */
defineProps({
  // Flat tile list: [{ judgeIndex, judgeId, score, scored, signaled }]
  tiles: { type: Array, default: () => [] },
  // Synchro grouping: [{ role, label, tiles: [...] }] or null for
  // the flat layout. Truthy ⇒ render the grouped columns.
  tilesByGroup: { type: Array, default: null },
  // judge_number → full_name, for the tile name + tooltip.
  judgeNames: { type: Object, default: () => ({}) },
})
</script>

<template>
  <!-- Synchro: split the live judge tiles into the WA panel groups
       (Exec A / Exec B / Sync) so the operator sees who's scoring
       what role at a glance. Each group gets a labelled column; the
       tiles themselves are unchanged so the scoring wiring (signal
       flag, scored class, name tooltip) stays identical with the
       flat layout. -->
  <div v-if="tilesByGroup" class="judge-groups-grid">
    <div v-for="g in tilesByGroup"
         :key="g.role"
         :class="['judge-group-col', `judge-group-${g.role}`]">
      <div class="judge-group-col-label">{{ g.label }}</div>
      <div class="judge-group-col-tiles">
        <div
          v-for="tile in g.tiles"
          :key="tile.judgeIndex"
          :class="[
            'judge-tile',
            tile.scored ? 'scored' : '',
            tile.signaled ? 'signaled' : '',
          ]"
          v-tip="tile.signaled
            ? `${judgeNames[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
            : (judgeNames[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
        >
          <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
          <div class="judge-tile-score">{{ tile.score }}</div>
          <div v-if="judgeNames[tile.judgeIndex]" class="judge-tile-name">
            {{ judgeNames[tile.judgeIndex].split(' ').slice(-1)[0] }}
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="judge-grid">
    <div
      v-for="tile in tiles"
      :key="tile.judgeIndex"
      :class="[
        'judge-tile',
        tile.scored ? 'scored' : '',
        tile.signaled ? 'signaled' : '',
      ]"
      v-tip="tile.signaled
        ? `${judgeNames[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
        : (judgeNames[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
    >
      <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
      <div class="judge-tile-score">{{ tile.score }}</div>
      <!-- Judge name surfaces under the tile so a slow submitter is
           identifiable at a glance. -->
      <div v-if="judgeNames[tile.judgeIndex]" class="judge-tile-name">
        {{ judgeNames[tile.judgeIndex].split(' ').slice(-1)[0] }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* P1: reduced-motion guard (tracked per-file by the P0 scanner;
   reinforces the global guard in app.css). */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
.judge-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }

/* Synchro variant of the judge grid: three labelled columns
   (Exec A / Exec B / Sync) so the operator sees who's scoring
   what role at a glance. Border colour echoes the per-group
   accents the Scoreboard view uses for its score chips, so the
   visual vocabulary stays consistent between the two surfaces. */
.judge-groups-grid {
  display: flex; gap: 0.5rem; margin-bottom: 0.5rem;
  flex-wrap: wrap;
}
.judge-group-col {
  flex: 1 1 auto; min-width: 0;
  padding: 0.35rem 0.5rem 0.45rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.judge-group-col-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.3rem;
}
.judge-group-col-tiles {
  display: flex; flex-wrap: wrap; gap: 0.35rem;
}
/* Exec A / Exec B / Sync keep their violet / amber / green role
   identity (theme-aware role tokens), matching the synchro history
   cards in app.css. */
.judge-group-col.judge-group-a    { border-color: var(--role-admin-fg); }
.judge-group-col.judge-group-b    { border-color: var(--role-manager-fg); }
.judge-group-col.judge-group-sync { border-color: var(--role-diver-fg); }
.judge-group-col.judge-group-a    .judge-group-col-label { color: var(--role-admin-fg); }
.judge-group-col.judge-group-b    .judge-group-col-label { color: var(--role-manager-fg); }
.judge-group-col.judge-group-sync .judge-group-col-label { color: var(--role-diver-fg); }
.judge-tile {
  position: relative;
  width: 64px; height: 52px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  transition: all 0.15s;
}
/* When a score lands, briefly pulse the tile so the operator sees
   incoming submissions even from across the deck. */
.judge-tile.scored {
  background: var(--green-dim); border-color: var(--green);
  animation: tilePulse 0.4s ease-out;
}
@keyframes tilePulse {
  0%   { transform: scale(1); box-shadow: 0 0 0 rgba(16,185,129,0); }
  50%  { transform: scale(1.06); box-shadow: 0 0 18px rgba(16,185,129,0.5); }
  100% { transform: scale(1); box-shadow: 0 0 12px rgba(16,185,129,0.2); }
}
/* Judge has tapped Signal Referee on their keypad. Bright red
   ring around the tile plus a pulsing glow draws the operator's
   eye regardless of what's currently scored / unscored on the
   panel. Wins over .scored when both are set (a judge can
   submit AND signal, e.g. they want a video review of the
   dive they just judged). */
.judge-tile.signaled {
  border-color: var(--red);
  box-shadow: 0 0 0 2px var(--red), 0 0 18px rgba(239,68,68,0.5);
  animation: judgeSignalPulse 1.4s ease-in-out infinite;
}
@keyframes judgeSignalPulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--red), 0 0 18px rgba(239,68,68,0.5); }
  50%      { box-shadow: 0 0 0 2px var(--red), 0 0 6px  rgba(239,68,68,0.2); }
}
.judge-tile.signaled .judge-tile-label,
.judge-tile.signaled .judge-tile-score { color: var(--red); }
.judge-tile-label { font-family: var(--font-display); font-size: 8px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); text-transform: uppercase; }
.judge-tile.scored .judge-tile-label { color: var(--green); }
.judge-tile-score { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--text-3); }
.judge-tile.scored .judge-tile-score { color: var(--text); }

/* Submitter name (last word, truncated) under each tile so a slow
   submitter is identifiable at a glance. */
.judge-tile-name {
  font-family: var(--font-mono); font-size: 9px;
  color: var(--text-3); margin-top: 0.1rem;
  max-width: 60px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.judge-tile.scored .judge-tile-name { color: var(--green); }

/* Shrink tiles a touch on narrow decks so a 7- or 11-judge panel
   still lands on one row. Mirrors the ControlView @720px breakpoint.
   Heads up: the .ctrl-broadcast projection-mode override (110px tiles)
   lives in ControlView.css via :deep(), next to its sibling broadcast
   rules. */
@media (max-width: 720px) {
  .judge-tile { width: 52px; height: 52px; }
}
</style>
