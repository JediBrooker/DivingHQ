<script setup>
/* Multi-event broadcast — one display, every Live event side by side.
 *
 * The Control Room "Broadcast" launcher offers this as an alternative
 * to the single-event /scoreboard/:id/broadcast view: when a meet
 * runs two pools concurrently (3 m + 10 m simultaneously, two
 * stages of a Super Final, etc.) and the venue has ONE projector,
 * the operator points the projector at /broadcast/all and gets an
 * auto-sized grid of every Live event.
 *
 * Implementation: each pane is an <iframe> of the existing per-event
 * /scoreboard/:id/broadcast view. Reuses the full scoreboard render
 * + socket plumbing for free, at the cost of N SPA instances on the
 * page. In practice the venue use case is 2-4 events; even Chromium
 * handles 4 iframes of this app comfortably (~120 MB total).
 *
 * The live-events list refreshes every 30s so events that flip
 * Live → Completed drop out and freshly-flipped events drop in
 * automatically. The grid uses CSS auto-fit so 1 event spans the
 * whole screen, 2 events split horizontally, 3-4 events form a
 * 2×2, etc. The operator gets a small floating header with the
 * count and a quick exit (× back to /scoreboard) that fades on
 * pointer-leave so the projector stays clean.
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

// All Live events as returned by the most recent /api/events
// poll. The displayed grid is a `computed` derived from this plus
// the operator's subset filter so that clearing the filter (via
// the "Show all Live events" rescue) re-renders instantly without
// waiting for the next 30s poll.
const liveEvents = ref([])
const loading = ref(true)
const error = ref('')

// Optional ?ids=<id1>,<id2>,…  — when present the operator picked
// a subset from the Control Room's broadcast chooser. We intersect
// this list with the polled Live events so:
//   • events outside the picked set never show (even if Live)
//   • selected events that finish drop out naturally on the next poll
//   • newly-Live events do NOT auto-join the grid (the operator
//     made an explicit choice; respect it)
//
// A null `selectedIds` means "no subset chosen — show every Live event"
// (the legacy /broadcast/all behaviour).
const selectedIds = computed(() => {
  const raw = route.query.ids
  if (raw == null || raw === '') return null
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return ids.length ? new Set(ids) : null
})

// Clear the ?ids= filter and stay on /broadcast/all. Used by the
// "Show all Live events" rescue button when every selected event
// has finished.
function showAllLive() {
  router.replace({ path: '/broadcast/all' })
}

// 30 second refresh — slow enough that we're not hammering the API,
// fast enough that a venue projector picks up newly-Live events
// within half a minute of the operator flipping the status.
const REFRESH_MS = 30_000
let refreshTimer = null

async function loadEvents() {
  try {
    const res = await fetch('/api/events', { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    liveEvents.value = (data || []).filter((e) => e.status === 'Live')
    error.value = ''
  } catch (err) {
    error.value = err.message || 'Failed to load events'
  } finally {
    loading.value = false
  }
}

// The displayed events: every Live event when no ?ids= filter is
// set, else the intersection of (polled Live events) ∩ (picked ids).
// Computed so the rescue button can strip the filter and have the
// grid re-render against the most recent poll instantly.
const events = computed(() => {
  const subset = selectedIds.value
  if (!subset) return liveEvents.value
  return liveEvents.value.filter((e) => subset.has(String(e.id)))
})

// True when the operator picked a subset but every event in that
// subset has since finished (or otherwise dropped out of the Live
// list). Drives the "all selected events have finished" rescue UI.
const subsetExhausted = computed(
  () => selectedIds.value !== null && events.value.length === 0 && !loading.value,
)

onMounted(() => {
  loadEvents()
  refreshTimer = setInterval(loadEvents, REFRESH_MS)
})
onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

// Grid template — auto-fit so the layout responds to event count
// without a manual breakpoint table.
//   1 event  → 1×1 (full screen)
//   2 events → 2×1
//   3 events → 2×2 (3rd spans bottom or one row left blank — CSS
//                   auto-fit handles it naturally)
//   4 events → 2×2
//   5-6      → 3×2
//   7+       → 4×N with vertical scroll on the body
const gridStyle = computed(() => {
  const n = events.value.length
  if (n <= 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
  if (n === 2) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' }
  if (n <= 4) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' }
  if (n <= 6) return { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr' }
  return { gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: 'repeat(auto-fill, minmax(360px, 1fr))' }
})
</script>

<template>
  <div class="mbcast-root">
    <!-- Floating chrome: event count + exit. Hidden until the
         operator moves the pointer near the top of the screen,
         so the projector image stays clean during the meet. -->
    <div class="mbcast-chrome">
      <div class="mbcast-stat">
        {{ events.length }} LIVE EVENT{{ events.length === 1 ? '' : 'S' }}
        <span v-if="selectedIds" class="mbcast-stat-sub">· operator-selected subset</span>
      </div>
      <RouterLink to="/scoreboard" class="mbcast-exit" v-tip.fixed="'Exit broadcast'">✕</RouterLink>
    </div>

    <div v-if="loading && !events.length" class="mbcast-empty">
      Loading live events…
    </div>
    <!-- Operator picked a subset but every event in that subset has
         finished. Offer a one-click rescue back to "all Live events"
         so the projector picks up whatever else is still running. -->
    <div v-else-if="subsetExhausted" class="mbcast-empty">
      All selected events have finished.
      <button type="button" class="mbcast-link" @click="showAllLive">
        Show all Live events
      </button>
    </div>
    <div v-else-if="!events.length" class="mbcast-empty">
      No Live events right now.
      <RouterLink to="/scoreboard" class="mbcast-link">Browse scoreboard</RouterLink>
    </div>

    <div v-else class="mbcast-grid" :style="gridStyle">
      <div v-for="ev in events" :key="ev.id" class="mbcast-cell">
        <!-- Event label strip sits inside the pane so each tile
             carries its own header without leaking the parent's
             chrome into the iframe. Iframe occupies the rest. -->
        <div class="mbcast-label">
          <span class="mbcast-label-name">{{ ev.name }}</span>
          <span v-if="ev.height" class="mbcast-label-meta">{{ ev.height }}</span>
          <span v-if="ev.gender" class="mbcast-label-meta">{{ ev.gender }}</span>
        </div>
        <!-- The single-event broadcast view we already ship. Each
             iframe is its own SPA instance with its own socket;
             they don't interfere. sandbox without allow-same-origin
             would break the JWT session — we deliberately keep
             same-origin so the iframe inherits the spectator's
             (anonymous or authed) context naturally. -->
        <iframe
          :src="`/scoreboard/${ev.id}/broadcast`"
          class="mbcast-frame"
          v-tip="ev.name"
          referrerpolicy="same-origin"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mbcast-root {
  position: fixed;
  /* inset:0 alone doesn't account for the iOS Safari dynamic
     toolbar. Anchor explicitly using safe-area insets so an
     accidental iPhone preview doesn't render the bottom 50-90px
     of the multi-stream behind Safari's UI. height:100dvh +
     inset 0 0 auto 0 + bottom safe-area gives a stream area
     that's actually visible on a phone. On laptops/projectors
     env() values are 0 so this still behaves like inset:0. */
  top: 0; inset-inline-start: 0; inset-inline-end: 0;
  bottom: env(safe-area-inset-bottom, 0px);
  /* vh fallback for browsers older than ~Q4-2022. */
  height: 100vh;
  height: 100dvh;
  background: var(--bg, #0f172a);
  overflow: hidden;
  font-family: var(--font-display, sans-serif);
  color: var(--text-1, #f1f5f9);
}

/* Chrome — visible faintly at rest, fades in on hover near the
   top of the screen so the projector doesn't show operator UI. */
.mbcast-chrome {
  position: absolute;
  top: 0;
  inset-inline-start: 0;
  inset-inline-end: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  background: rgba(15, 23, 42, 0.55);
  -webkit-backdrop-filter: blur(6px);  /* iOS Safari */
  backdrop-filter: blur(6px);
  opacity: 0.25;
  transition: opacity 0.2s;
}
.mbcast-chrome:hover { opacity: 1; }
.mbcast-stat {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.25em;
  color: var(--cyan, #06b6d4);
}
.mbcast-stat-sub {
  margin-inline-start: 0.4rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  color: var(--text-3, #94a3b8);
  text-transform: none;
}
.mbcast-exit {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-3, #94a3b8);
  text-decoration: none;
  padding: 0.2rem 0.6rem;
  border-radius: 50%;
  border: 1px solid transparent;
  transition: all 0.15s;
}
.mbcast-exit:hover {
  color: var(--cyan, #06b6d4);
  border-color: var(--cyan, #06b6d4);
}

.mbcast-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  height: 100%;
  color: var(--text-3, #94a3b8);
  font-size: 18px;
}
.mbcast-link {
  font-size: 13px;
  color: var(--cyan, #06b6d4);
  text-decoration: none;
  border: 1px solid var(--cyan, #06b6d4);
  padding: 0.4rem 1rem;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
}
.mbcast-link:hover {
  background: rgba(6, 182, 212, 0.10);
}

.mbcast-grid {
  display: grid;
  gap: 4px;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.4);
}
.mbcast-cell {
  display: flex;
  flex-direction: column;
  min-height: 360px;
  background: var(--bg-2, #0f172a);
  border: 1px solid rgba(148, 163, 184, 0.18);
  overflow: hidden;
}
.mbcast-label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0.75rem;
  background: rgba(6, 182, 212, 0.10);
  border-bottom: 1px solid rgba(6, 182, 212, 0.30);
  flex-shrink: 0;
}
.mbcast-label-name {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
}
.mbcast-label-meta {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-3, #94a3b8);
  padding: 0.1rem 0.4rem;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 3px;
}
.mbcast-frame {
  flex: 1;
  width: 100%;
  border: 0;
  display: block;
  background: var(--bg, #0f172a);
}
</style>
