<script setup>
/* Diver meet-day view — phone-deck experience for athletes
 * mid-competition. Three blocks composed from data the rest of
 * the system already has:
 *
 *   1. Your next dive — code, position, DD, height. Pulled from
 *      competitor_dive_lists with directory join, the first
 *      round whose judges aren't all in yet.
 *
 *   2. Current standing — rank, total, gap to leader, with
 *      movement vs the previous render.
 *
 *   3. What you need — average judge score required from each
 *      remaining dive to reach gold / silver / bronze. Same
 *      math as the Control Room's catch-up indicator and the
 *      audience scoreboard's projection panel; ceiling-rounded
 *      to the next 0.5 because judges score in halves.
 *
 * Real-time: subscribe to the event-room socket. score_received
 * and state_update both trigger a bundle refetch (cheap; the
 * server endpoint composes from cached pieces).
 */

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { ordinal as fmtOrdinal } from '@/lib/format'
import StatusPill from '@/components/StatusPill.vue'

const { t } = useI18n()

const route   = useRoute()
const router  = useRouter()
const auth    = useAuthStore()
const socket  = useSocket()

const eventId = computed(() => route.params.eventId)

const data    = ref(null)
const loading = ref(true)
const error   = ref('')
// Track previous rank across refetches so we can render
// movement arrows. Cleared on event change.
const prevRank = ref(null)

async function load() {
  if (!eventId.value) return
  if (!data.value) loading.value = true
  error.value = ''
  try {
    const fresh = await auth.apiFetch(`/api/events/${eventId.value}/me-meet-day`)
    if (data.value && fresh.standing.rank !== data.value.standing.rank) {
      prevRank.value = data.value.standing.rank
    }
    data.value = fresh
  } catch (err) {
    error.value = err.message || 'Failed to load meet day data'
  } finally {
    loading.value = false
  }
}

// Debounced refetch — multiple socket events in quick succession
// (5 judge submissions in 200ms) collapse to one round-trip.
let refetchTimer = null
function scheduleRefetch() {
  clearTimeout(refetchTimer)
  refetchTimer = setTimeout(() => { load() }, 250)
}

function onScoreReceived(payload) {
  if (payload?.event_id && payload.event_id !== eventId.value) return
  scheduleRefetch()
}
function onStateUpdate(payload) {
  if (payload?.event_id && payload.event_id !== eventId.value) return
  scheduleRefetch()
}
function onScoreCorrected(payload) {
  if (payload?.event_id && payload.event_id !== eventId.value) return
  scheduleRefetch()
}

function joinRoom() {
  if (!eventId.value) return
  socket.emit('subscribe_event', { event_id: eventId.value })
}

onMounted(() => {
  load()
  if (socket.connected) joinRoom()
  socket.on('connect',          joinRoom)
  socket.on('score_received',   onScoreReceived)
  socket.on('state_update',     onStateUpdate)
  socket.on('score_corrected',  onScoreCorrected)
})

onBeforeUnmount(() => {
  clearTimeout(refetchTimer)
  socket.off('connect',         joinRoom)
  socket.off('score_received',  onScoreReceived)
  socket.off('state_update',    onStateUpdate)
  socket.off('score_corrected', onScoreCorrected)
})

watch(() => route.params.eventId, () => {
  data.value = null
  prevRank.value = null
  load()
})

// ---- Derived display state ----------------------------------

const movement = computed(() => {
  if (!data.value || prevRank.value == null) return null
  const cur = data.value.standing.rank
  if (cur == null) return null
  if (cur < prevRank.value) return 'up'
  if (cur > prevRank.value) return 'down'
  return null
})

// Shared ordinal from @/lib/format, with this view's em-dash
// placeholder for a not-yet-known rank (format.js returns '').
function ordinal(n) {
  return n == null ? '—' : fmtOrdinal(n)
}

function formatTarget(t, label) {
  if (!t) return null
  if (t.achieved) {
    return { label, body: 'Already achieved', tone: 'achieved' }
  }
  if (t.possible === false) {
    return { label, body: 'Out of reach — gap too large', tone: 'impossible' }
  }
  if (t.needs_avg == null) {
    return { label, body: `Need ${t.gap.toFixed(1)} more pts (no remaining dives)`, tone: 'impossible' }
  }
  return {
    label,
    body: `Need avg ${t.needs_avg.toFixed(1)} from each judge on every remaining dive (${t.gap.toFixed(1)} pts behind)`,
    tone: 'reachable',
  }
}

const targetRows = computed(() => {
  if (!data.value) return []
  return [
    formatTarget(data.value.targets.gold,   'Gold'),
    formatTarget(data.value.targets.silver, 'Silver'),
    formatTarget(data.value.targets.bronze, 'Bronze'),
  ].filter(Boolean)
})

const queueLabel = computed(() => {
  if (!data.value || !data.value.next_dive) return null
  const q = data.value.queue
  if (q.divers_until_me == null) {
    return data.value.event.status === 'Upcoming'
      ? 'Pre-meet — entries still locking'
      : null
  }
  if (q.divers_until_me === 0) return "YOU'RE UP"
  if (q.divers_until_me === 1) return "1 diver until you're up"
  return `${q.divers_until_me} divers until you're up`
})

const eventNotLive = computed(() => {
  return data.value && data.value.event.status !== 'Live'
})
</script>

<template>
  <div class="meet-day">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('meet_day.page_label') }}</div>
        <h1 class="page-title">{{ data?.event?.name || 'Loading…' }}</h1>
        <div class="page-sub" v-if="data">
          <StatusPill :status="data.event.status" size="sm" />
          <span v-if="data.event.height"> · {{ data.event.height }}</span>
          <span v-if="data.event.total_rounds"> · {{ data.event.total_rounds }} rounds</span>
        </div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
    </div>

    <div v-if="loading" class="md-loading">Loading your meet day…</div>
    <div v-else-if="error" class="md-error">{{ error }}</div>

    <template v-else-if="data">
      <!-- Pre-event hint when nothing's happening yet -->
      <div v-if="eventNotLive && data.event.status === 'Upcoming'" class="md-hint">
        {{ $t('meet_day.waiting') }}
      </div>
      <div v-else-if="eventNotLive && data.event.status === 'Completed'" class="md-hint">
        This event is over — no more dives. Tap the link below to view the recap.
      </div>

      <!-- BLOCK 1: Your next dive ----------------------------- -->
      <section class="md-card md-next-dive">
        <header class="md-card-head">
          <span class="md-card-label">{{ $t('meet_day.next_dive') }}</span>
          <span v-if="data.next_dive" class="md-round-pip">
            R{{ data.next_dive.round_number }}/{{ data.event.total_rounds }}
          </span>
        </header>
        <div v-if="data.next_dive" class="md-next-body">
          <div class="md-dive-code">
            {{ data.next_dive.dive_code }}{{ data.next_dive.position || '' }}
          </div>
          <div v-if="data.next_dive.description" class="md-dive-desc">
            {{ data.next_dive.description }}
          </div>
          <div class="md-dive-meta">
            <span v-if="data.next_dive.dive_height">{{ data.next_dive.dive_height }}</span>
            <span v-if="data.next_dive.dd != null"> · DD {{ data.next_dive.dd.toFixed(1) }}</span>
            <span v-if="data.completed_dives != null">
               · {{ data.completed_dives }} done / {{ data.total_dives }} total
            </span>
          </div>
          <div
            v-if="queueLabel"
            :class="['md-queue', data.queue.divers_until_me === 0 ? 'md-queue-up' : '']"
          >
            {{ queueLabel }}
          </div>
        </div>
        <div v-else class="md-next-empty">
          {{ data.event.status === 'Completed'
              ? 'All your dives complete — meet finished.'
              : "You've completed every dive on your list." }}
        </div>
      </section>

      <!-- BLOCK 2: Current standing ---------------------------- -->
      <section class="md-card md-standing">
        <header class="md-card-head">
          <span class="md-card-label">Current standing</span>
          <span class="md-round-pip">{{ data.standing.total_competitors }} divers</span>
        </header>
        <div class="md-standing-body">
          <div class="md-rank-block">
            <div class="md-rank">
              {{ ordinal(data.standing.rank) }}
              <span v-if="movement === 'up'"   class="md-mv mv-up"   v-tip="'Up vs last'">↑</span>
              <span v-if="movement === 'down'" class="md-mv mv-down" v-tip="'Down vs last'">↓</span>
            </div>
            <div class="md-rank-sub">place</div>
          </div>
          <div class="md-total-block">
            <div class="md-total">{{ data.standing.total.toFixed(1) }}</div>
            <div class="md-total-sub">points</div>
          </div>
          <div v-if="data.standing.rank > 1" class="md-gap-block">
            <div class="md-gap">{{ data.standing.behind_leader.toFixed(1) }}</div>
            <div class="md-gap-sub">behind leader</div>
          </div>
          <div v-else class="md-gap-block md-gap-leader">
            <div class="md-gap-icon">🥇</div>
            <div class="md-gap-sub">in the lead</div>
          </div>
        </div>
      </section>

      <!-- BLOCK 3: What you need ------------------------------- -->
      <section v-if="targetRows.length" class="md-card md-targets">
        <header class="md-card-head">
          <span class="md-card-label">What you need</span>
        </header>
        <ul class="md-target-list">
          <li v-for="t in targetRows" :key="t.label" :class="['md-target-row', `tone-${t.tone}`]">
            <span class="md-target-label">{{ t.label }}</span>
            <span class="md-target-body">{{ t.body }}</span>
          </li>
        </ul>
        <p class="md-targets-foot">
          Average shown is per-judge across every remaining dive — judges only score in halves, so the figure is rounded UP to the next 0.5.
        </p>
      </section>

      <!-- Footer link out -->
      <div class="md-footer">
        <RouterLink :to="`/scoreboard/${data.event.id}`" class="btn btn-ghost btn-sm">
          Open full scoreboard →
        </RouterLink>
      </div>
    </template>
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
.meet-day {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  display: flex; flex-direction: column;
  gap: 1.25rem;
}

.md-loading, .md-error, .md-hint {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
  padding: 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.md-error { color: var(--red); }
.md-hint  { color: var(--text-2); }

.md-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  display: flex; flex-direction: column;
  gap: 0.75rem;
}
.md-card-head {
  display: flex; justify-content: space-between; align-items: center;
}
.md-card-label {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--text-3);
}
.md-round-pip {
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
  color: var(--cyan);
  background: rgba(6,182,212,0.1);
  border: 1px solid rgba(6,182,212,0.3);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
}

/* Next-dive block ============================================ */
.md-next-dive .md-dive-code {
  font-family: var(--font-display);
  font-size: clamp(36px, 9vw, 56px);
  font-weight: 900; font-style: italic;
  color: var(--text);
  line-height: 1;
  letter-spacing: 0.02em;
}
.md-next-dive .md-dive-desc {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-2);
  margin-top: 0.25rem;
}
.md-next-dive .md-dive-meta {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}
.md-next-dive .md-queue {
  margin-top: 0.5rem;
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-2);
  background: var(--bg-3);
  border-radius: var(--radius);
  padding: 0.55rem 0.75rem;
}
.md-next-dive .md-queue-up {
  color: var(--bg);
  background: var(--cyan);
  animation: queue-pulse 1.6s ease-in-out infinite;
}
@keyframes queue-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(6,182,212,0); }
  50%      { box-shadow: 0 0 0 8px rgba(6,182,212,0.18); }
}
.md-next-empty {
  font-family: var(--font-mono); font-size: 13px;
  color: var(--text-3); padding: 0.75rem 0;
}

/* Standing block ============================================= */
.md-standing-body {
  display: flex; align-items: flex-end; gap: 1rem;
  flex-wrap: wrap;
}
.md-rank-block, .md-total-block, .md-gap-block {
  display: flex; flex-direction: column; gap: 0.15rem;
  min-width: 0;
}
.md-rank-block { flex: 1 1 80px; }
.md-total-block { flex: 1 1 80px; }
.md-gap-block { flex: 1 1 120px; }

.md-rank {
  font-family: var(--font-display);
  font-size: clamp(40px, 10vw, 56px);
  font-weight: 900; font-style: italic;
  color: var(--cyan);
  line-height: 1;
}
.md-mv { font-size: 0.5em; margin-inline-start: 0.15em; }
.mv-up   { color: var(--green); }
.mv-down { color: var(--amber); }
.md-rank-sub, .md-total-sub, .md-gap-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.md-total {
  font-family: var(--font-display);
  font-size: clamp(28px, 7vw, 40px);
  font-weight: 800; font-style: italic;
  color: var(--text); line-height: 1;
}
.md-gap {
  font-family: var(--font-display);
  font-size: clamp(22px, 5vw, 28px);
  font-weight: 700; font-style: italic;
  color: var(--amber); line-height: 1;
}
.md-gap-leader .md-gap-icon { font-size: 32px; line-height: 1; }

/* Targets block ============================================== */
.md-target-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column;
  gap: 0.5rem;
}
.md-target-row {
  display: flex; flex-direction: column; gap: 0.25rem;
  padding: 0.65rem 0.85rem;
  border-radius: var(--radius);
  background: var(--bg-3);
  border-inline-start: 3px solid var(--border);
}
.md-target-row.tone-achieved   { border-inline-start-color: var(--green); }
.md-target-row.tone-reachable  { border-inline-start-color: var(--cyan); }
.md-target-row.tone-impossible { border-inline-start-color: var(--text-3); opacity: 0.7; }

.md-target-label {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-2);
}
.md-target-row.tone-achieved   .md-target-label { color: var(--green); }
.md-target-row.tone-reachable  .md-target-label { color: var(--cyan);  }
.md-target-row.tone-impossible .md-target-label { color: var(--text-3); }

.md-target-body {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
}

.md-targets-foot {
  margin: 0.4rem 0 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}

.md-footer {
  text-align: center;
  padding: 0.5rem 0;
}

/* Phone-deck ergonomics. The 56px+ score-card font and
   2x stacking padding are deliberate — divers glance at this
   between drying off and walking up to the platform. */
@media (max-width: 480px) {
  .meet-day { padding: 0.85rem 0.65rem 4rem; gap: 0.85rem; }
  .md-card  { padding: 0.95rem; }
  .md-standing-body { gap: 0.85rem; }
}
</style>
