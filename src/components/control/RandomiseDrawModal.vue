<script setup>
/* RandomiseDrawModal — the WA Article 4.1.6 random dive-order
 * draw ceremony, extracted from ControlView.vue. Three phases:
 * 'preview' (current order + "Start the draw"), 'shuffling'
 * (5-second animated reel; the server-side randomise runs in
 * parallel but the result is held until the floor elapses), and
 * 'done' (confirm or re-shuffle).
 *
 * Mount contract: the parent mounts this with v-if when the
 * operator opens the draw, so every open starts at 'preview'
 * with a clean reel — same reset the old openRandomiseDraw()
 * performed. The open guard (queue lock check + toast) stays in
 * ControlView because it owns canReorderQueue.
 *
 * State boundary: stage + reel are OWNED here; the roster comes
 * in as a prop and is never mutated. A successful draw emits
 * `randomised` with the fresh roster — the parent assigns it,
 * resets the active-diver pointer, and stamps the workflow.
 */
import { ref, computed, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { showError } from '@/composables/useNotify'

const props = defineProps({
  event:  { type: Object, default: null },
  roster: { type: Array,  default: () => [] },
})
const emit = defineEmits(['close', 'randomised'])

const auth = useAuthStore()
const { queueAction } = useHttpOutbox()

const randomiseStage       = ref('preview')   // 'preview' | 'shuffling' | 'done'
const randomiseShufflePreview = ref([])       // overlay rows during 'shuffling'
let randomiseShuffleTimer  = null

const ANIM_MS = 5000   // user spec: 5 seconds
const TICK_MS = 140    // 140ms per permutation → ~36 ticks across the run

// Rows the modal should render — preview reads from roster,
// shuffling reads from the cycling overlay, done reads from
// roster again (now the post-randomise one).
//
// Start order is per-diver, not per-(diver, round) — every
// round dives in the SAME order. So we dedupe props.roster
// by competitor_id (the roster endpoint returns one row per
// diver-round combination, and display_order is identical
// across rounds for the same diver). Reserves are also
// excluded — they're not in the start order until promoted.
const randomiseDisplayRows = computed(() => {
  if (randomiseStage.value === 'shuffling') {
    return randomiseShufflePreview.value
  }
  const seen = new Set()
  const unique = []
  for (const r of props.roster) {
    if (r.is_reserve || r.withdrawn_at) continue
    if (seen.has(r.competitor_id)) continue
    seen.add(r.competitor_id)
    unique.push({ ...r })
  }
  // Sort by display_order so the rendered list reads 1..N.
  unique.sort((a, b) =>
    (a.display_order ?? Infinity) - (b.display_order ?? Infinity),
  )
  return unique
})

function close() {
  if (randomiseShuffleTimer) {
    clearInterval(randomiseShuffleTimer)
    randomiseShuffleTimer = null
  }
  emit('close')
}
// Mount-scope safety net — the parent unmounts this component via
// close(), which already cleared the timer; this guards any
// future unmount path so the shuffle interval can never leak.
onUnmounted(() => {
  if (randomiseShuffleTimer) clearInterval(randomiseShuffleTimer)
})

// Called from the modal's "Start the draw" button (and from
// "Re-shuffle"). Runs the 5-sec animation + parallel server
// randomise, then settles the final order.
async function runRandomiseDraw() {
  const ev = props.event
  if (!ev) return

  // Start order is per-diver, applied identically across every
  // round (Article 4.1.6). Snapshot ONE row per unique diver
  // (excluding reserves + withdrawn) — that's the list the
  // animation cycles. Server-side, the randomize endpoint
  // assigns the same display_order to every round-row of a
  // given diver, so there's no need for the animation to think
  // in (diver, round) tuples.
  const seen = new Set()
  const baseRoster = []
  for (const r of props.roster) {
    if (r.is_reserve || r.withdrawn_at) continue
    if (seen.has(r.competitor_id)) continue
    seen.add(r.competitor_id)
    baseRoster.push({ ...r })
  }

  function shuffleTick() {
    // Fisher-Yates the diver list, then re-stamp display_order
    // so the rendered position pills also cycle (1, 2, 3…).
    const arr = baseRoster.map(r => ({ ...r }))
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    arr.forEach((row, idx) => {
      row.display_order = idx + 1
      row.round_order = idx + 1
    })
    randomiseShufflePreview.value = arr
  }

  randomiseStage.value = 'shuffling'
  shuffleTick()
  randomiseShuffleTimer = setInterval(shuffleTick, TICK_MS)

  try {
    const [, fresh] = await Promise.all([
      queueAction({
        method: 'POST',
        url: `/api/events/${ev.id}/dive-lists/randomize`,
        actionType: 'dive_list_randomize',
      }),
      // Hold the ceremony for the full ANIM_MS even if the
      // server returns faster — the audience needs the full
      // animation to read the moment as a "draw".
      new Promise((resolve) => setTimeout(resolve, ANIM_MS)).then(() =>
        auth.apiFetch(`/api/events/${ev.id}/roster`),
      ),
    ])
    // Parent applies the fresh roster + workflow stamps (listener
    // runs synchronously on emit, so ordering matches the old
    // inline code: roster first, then stage flips to 'done').
    emit('randomised', fresh)
    randomiseStage.value = 'done'
  } catch (err) {
    showError('Randomise failed: ' + err.message)
    randomiseStage.value = 'preview'
  } finally {
    if (randomiseShuffleTimer) {
      clearInterval(randomiseShuffleTimer)
      randomiseShuffleTimer = null
    }
    randomiseShufflePreview.value = []
  }
}

</script>

<template>
  <div class="lb-backdrop"
       @click.self="randomiseStage !== 'shuffling' && close()"></div>
  <div
       :class="['lb-modal', 'randomise-modal', `phase-${randomiseStage}`]"
       @click.stop>
    <div class="randomise-head">
      <div class="randomise-icon">🎲</div>
      <div>
        <div class="randomise-title">
          <template v-if="randomiseStage === 'preview'">Random Dive-Order Draw</template>
          <template v-else-if="randomiseStage === 'shuffling'">Drawing dive order…</template>
          <template v-else>Final dive order</template>
        </div>
        <div class="randomise-sub">
          <template v-if="event">
            {{ event.name }} ·
            <em>WA Article 4.1.6 (random draw at the Technical/Team Leaders' Meeting)</em>
          </template>
        </div>
      </div>
    </div>

    <p class="randomise-body-text">
      <template v-if="randomiseStage === 'preview'">
        The current dive order is shown below. Click <strong>Start the draw</strong>
        when the room is ready — the draw will animate for 5 seconds before
        the new order is revealed.
      </template>
      <template v-else-if="randomiseStage === 'shuffling'">
        Watch the draw. The reel cycles through random permutations until the
        official order is locked in.
      </template>
      <template v-else>
        Below is the dive order for <strong>{{ event?.name }}</strong>.
        Confirm to lock it in, or re-shuffle if the room agrees.
      </template>
    </p>

    <!-- Single list of divers — start order is per-diver, the
         same across every round (Article 4.1.6). -->
    <div class="randomise-list">
      <div v-for="item in randomiseDisplayRows"
           :key="item.competitor_id"
           :class="['randomise-row', randomiseStage === 'shuffling' ? 'is-shuffling' : '']">
        <span class="randomise-row-pos">{{ item.display_order ?? '?' }}</span>
        <span class="randomise-row-name">
          {{ item.full_name }}<span v-if="item.country_code" class="randomise-row-country">{{ item.country_code }}</span>
        </span>
        <span v-if="item.club_code" class="randomise-row-club">{{ item.club_code }}</span>
      </div>
    </div>

    <div class="randomise-actions">
      <template v-if="randomiseStage === 'preview'">
        <button type="button" class="btn btn-ghost" @click="close">Cancel</button>
        <button type="button" class="btn btn-primary-lg randomise-go" @click="runRandomiseDraw">
          🎲  Start the draw
        </button>
      </template>
      <template v-else-if="randomiseStage === 'shuffling'">
        <div class="randomise-progress">Drawing…</div>
      </template>
      <template v-else>
        <button type="button" class="btn btn-ghost" @click="runRandomiseDraw">Re-shuffle</button>
        <button type="button" class="btn btn-primary-lg" @click="close">
          ✓  Confirm dive order
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Randomise-draw styles MOVED from ControlView.css (exclusive to
   this modal). The .lb-* modal frame at the bottom is COPIED —
   the pattern is shared by the modals that remain in
   ControlView. */
/* =========================================================
   Random dive-order draw modal (WA Article 4.1.6 ceremony).
   Wide + projector-friendly so divers / referees / spectators
   in the meeting room can read it from the back.
   ========================================================= */
.randomise-modal {
  max-width: 760px;
  /* `dvh` so the modal shrinks with the iOS Safari toolbar
     rather than being clipped behind it. vh fallback for
     browsers older than ~Q4-2022. */
  max-height: 92vh;
  max-height: 92dvh;
  display: flex; flex-direction: column;
}
.randomise-head {
  display: flex; align-items: center; gap: 1rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--border);
}
.randomise-icon {
  font-size: 42px; line-height: 1; flex-shrink: 0;
  filter: drop-shadow(0 0 8px rgba(0, 224, 255, 0.4));
}
.randomise-modal.phase-shuffling .randomise-icon {
  animation: rd-icon-spin 0.9s linear infinite;
}
@keyframes rd-icon-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.randomise-title {
  font-family: var(--font-sans);
  font-size: 20px; font-weight: 600;
  font-style: normal;
  color: var(--accent);
  letter-spacing: 0.02em;
}
.randomise-modal.phase-shuffling .randomise-title {
  animation: rd-title-pulse 1.4s ease-in-out infinite alternate;
}
@keyframes rd-title-pulse {
  from { text-shadow: 0 0 0 rgba(0, 224, 255, 0); }
  to   { text-shadow: 0 0 14px rgba(0, 224, 255, 0.6); }
}
.randomise-sub {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); margin-top: 0.2rem;
}
.randomise-sub em { font-style: italic; opacity: 0.85; }
.randomise-body-text {
  margin: 1rem 0;
  font-size: 14px; line-height: 1.55; color: var(--text-2);
}

/* List of divers — large, readable from across the room.
   While shuffling, the .is-shuffling rows pulse subtly. */
.randomise-list {
  flex: 1; min-height: 0;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 0.4rem;
  padding: 0.25rem;
}
.randomise-row {
  display: grid; grid-template-columns: 56px 1fr auto;
  align-items: center; gap: 0.85rem;
  padding: 0.7rem 0.85rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 18px; font-weight: 600;
  color: var(--text);
  transition: background 0.15s, border-color 0.15s;
}
.randomise-row.is-shuffling {
  border-color: var(--cyan);
  background: rgba(0, 224, 255, 0.06);
  animation: rd-row-flicker 0.18s ease-out;
}
@keyframes rd-row-flicker {
  0%   { transform: translateY(-2px); opacity: 0.65; }
  100% { transform: translateY(0);    opacity: 1;    }
}
.randomise-row-pos {
  font-family: var(--font-display); font-size: 28px;
  font-weight: 800; color: var(--cyan);
  text-align: center;
  background: rgba(0, 224, 255, 0.10);
  border-radius: var(--radius-sm);
  padding: 0.15rem 0;
}
.randomise-row-name {
  display: flex; align-items: center; gap: 0.5rem;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.randomise-row-country {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  color: var(--text-3);
  background: rgba(255,255,255,0.04);
  padding: 0.12rem 0.45rem; border-radius: 4px;
  letter-spacing: 0.04em;
}
.randomise-row-club {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  background: rgba(255,255,255,0.04);
  padding: 0.12rem 0.5rem; border-radius: 4px;
}

.randomise-actions {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 0.75rem; padding-top: 1rem;
  border-top: 1px solid var(--border);
  margin-top: 0.5rem;
}
.randomise-actions .btn-primary-lg {
  width: auto; min-width: 220px;
  font-size: 16px;
}
.randomise-go {
  background: var(--cyan); color: var(--bg);
}
.randomise-progress {
  width: 100%; text-align: center;
  font-family: var(--font-display); font-size: 16px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--cyan);
  animation: rd-title-pulse 1.0s ease-in-out infinite alternate;
}

/* Modal frame — copied from ControlView.css (see AGENTS.md
   "Modal CSS pattern"). */
.lb-backdrop { position: fixed; inset: 0; background: rgba(3,7,18,0.95); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); z-index: 300; }
.lb-modal {
  position: fixed; top: 50%; inset-inline-start: 50%; transform: translate(-50%, -50%);
  z-index: 301;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 28px;
  width: calc(100% - 3rem); max-width: 560px;
  max-height: 90vh;
  max-height: 90dvh;
  overflow-y: auto; animation: fadeUp 0.3s ease;
  overflow-x: clip;
  box-shadow: 0 30px 60px rgba(0,0,0,0.55);
}
@media (max-width: 720px) {
  .lb-modal {
    max-height: calc(100vh - 1.5rem);   /* fallback */
    max-height: calc(100dvh - 1.5rem);  /* preferred */
    border-radius: var(--radius-lg);
  }
}
</style>
