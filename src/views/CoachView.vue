<script setup>
// Coach dashboard. Lists every diver the logged-in coach is
// linked to via coach_diver_links. For divers with a Live or
// Upcoming event, the card shows their NEXT dive (round + code +
// DD), current rank, and LAST completed dive (round + code +
// total) — so a coach with 8 divers across 3 events can see at a
// glance who's where AND what just happened.
//
// Three surfaces:
//
//   1. UP-NEXT STRIP (top) — squad members in the next ~20 min
//      across every Live event with a current active diver,
//      sorted by ETA ascending. The killer "look once, know what
//      to watch" panel. Powered by /api/coach/up-next.
//
//   2. PER-MEET SECTIONS — when the coach has divers across more
//      than one meet (state regionals + local invitational on the
//      same weekend), each meet gets its own LIVE/UPCOMING/IDLE
//      sub-grouping so the eye doesn't have to disambiguate.
//
//   3. LIVE / UPCOMING / IDLE GROUPING — within each meet, cards
//      group by event status (LIVE > UPCOMING > IDLE).
//
// Live refresh: the view subscribes to socket rooms for every
// event in the response and reloads (debounced) on state_update +
// final_score_announced. Coach doesn't have to ↻ Refresh.
//
// Data comes from /api/coach/dashboard + /api/coach/up-next; see
// routes/coach.js.

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { usePush } from '@/composables/usePush'
import { diveDescription } from '@/composables/useDiveLabel'
import { showSuccess, showError } from '@/composables/useNotify'
import OfflineBanner from '@/components/OfflineBanner.vue'

const { t } = useI18n()

const auth = useAuthStore()
const { socket } = useSocket()
const push = usePush({ socket })

// Coach alert preferences — Phase 3 of the coach bundle. The
// server fans out "your diver is up next" pushes when one of
// the coach's linked divers lands within `dives_ahead` of the
// active diver. Defaults: enabled=true, dives_ahead=2 (about
// 60s of warning at a 30s shot clock).
const alertPrefs = ref({ enabled: true, dives_ahead: 2 })
const alertSettingsOpen = ref(false)
const savingPrefs = ref(false)

const rows = ref([])
const upNext = ref({ rows: [], seconds_per_dive: 45, max_eta_minutes: 20 })
const loading = ref(false)
const error = ref('')

// Event ids the view is currently subscribed to. We track this
// so a reload can diff against the new set and join/leave rooms
// idempotently — re-subscribing every reload would be noisy.
const subscribedEvents = ref(new Set())

// Debounced reload. A burst of score_received + final_score_
// announced + state_update events lands inside ~500ms of each
// other when a dive finalizes; one reload covers the lot.
let reloadTimer = null
function scheduleReload() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 250)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [dash, next] = await Promise.all([
      auth.apiFetch('/api/coach/dashboard'),
      auth.apiFetch('/api/coach/up-next'),
    ])
    rows.value = Array.isArray(dash) ? dash : []
    upNext.value = next && Array.isArray(next.rows) ? next : { rows: [], seconds_per_dive: 45, max_eta_minutes: 20 }

    // Sync socket subscriptions to the events we now care about.
    const wantedEventIds = new Set(
      rows.value.filter(r => r.event_id).map(r => r.event_id),
    )
    // Join newly-relevant rooms.
    for (const id of wantedEventIds) {
      if (!subscribedEvents.value.has(id)) {
        socket.emit('subscribe_event', { event_id: id })
        subscribedEvents.value.add(id)
      }
    }
    // Skipping `leave` — Socket.IO has no graceful per-room leave
    // for an event we still hold the connection to; the rooms will
    // be discarded on disconnect. Stale memberships are harmless,
    // just slightly chatty.
  } catch (err) {
    error.value = err.message
    rows.value = []
    upNext.value = { rows: [], seconds_per_dive: 45, max_eta_minutes: 20 }
  } finally {
    loading.value = false
  }
}

// Socket listeners — registered once on mount, torn down on
// unmount. Every listener delegates to scheduleReload() so the
// view stays simple and the server is the single source of truth.
function onStateUpdate()         { scheduleReload() }
function onFinalScoreAnnounced() { scheduleReload() }
function onMeetHeld()            { scheduleReload() }
function onMeetResumed()         { scheduleReload() }

async function loadAlertPrefs() {
  try {
    const prefs = await auth.apiFetch('/api/coach/alert-preferences')
    alertPrefs.value = prefs
  } catch {
    // Silent fallback — the strip still works without prefs.
  }
}

async function saveAlertPrefs() {
  savingPrefs.value = true
  try {
    const saved = await auth.apiFetch('/api/coach/alert-preferences', {
      method: 'POST',
      body: JSON.stringify({
        enabled: alertPrefs.value.enabled,
        dives_ahead: alertPrefs.value.dives_ahead,
      }),
    })
    alertPrefs.value = saved
    showSuccess(t('common.saving'))
  } catch (err) {
    showError(err.message || 'Failed to save preferences')
  } finally {
    savingPrefs.value = false
  }
}

async function enablePushAndPrefs() {
  // Subscribe to Web Push if we're not already, then toggle prefs on.
  try {
    await push.subscribe()
    alertPrefs.value.enabled = true
    await saveAlertPrefs()
  } catch (err) {
    showError(err.message || 'Push permission denied')
  }
}

onMounted(() => {
  socket.on('state_update', onStateUpdate)
  socket.on('final_score_announced', onFinalScoreAnnounced)
  socket.on('meet_held', onMeetHeld)
  socket.on('meet_resumed', onMeetResumed)
  load()
  loadAlertPrefs()
})
onUnmounted(() => {
  clearTimeout(reloadTimer)
  socket.off('state_update', onStateUpdate)
  socket.off('final_score_announced', onFinalScoreAnnounced)
  socket.off('meet_held', onMeetHeld)
  socket.off('meet_resumed', onMeetResumed)
})

// ---------- Display helpers ----------

function fmtRank(n) {
  if (n == null) return ''
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
function placeColor(n) {
  if (n === 1) return 'place-gold'
  if (n === 2) return 'place-silver'
  if (n === 3) return 'place-bronze'
  return ''
}
function fmtEta(seconds) {
  if (seconds == null || seconds < 0) return ''
  if (seconds < 60) return t('coach.dashboard.up_next_now')
  const mins = Math.round(seconds / 60)
  return `~${mins}m`
}
function fmtDivesAway(n) {
  return t(n === 1
    ? 'coach.dashboard.up_next_dives_away_one'
    : 'coach.dashboard.up_next_dives_away_many', { n })
}
function etaTier(seconds) {
  if (seconds == null) return ''
  if (seconds < 60)  return 'eta-now'
  if (seconds < 180) return 'eta-soon'
  if (seconds < 600) return 'eta-watch'
  return 'eta-later'
}

// ---------- Grouping ----------

// First level: group by meet so a coach at a multi-meet weekend
// gets a section per meet. Independent events (no meet_id) bucket
// together as "Standalone events". The display order is "meet
// with the most Live diver cards first" so the section the coach
// is most likely caring about right now floats to the top.
const groupedByMeet = computed(() => {
  const buckets = new Map() // meet_key → { meet_id, meet_name, rows }
  for (const r of rows.value) {
    const key = r.meet_id || '__standalone__'
    if (!buckets.has(key)) {
      buckets.set(key, {
        meet_id: r.meet_id || null,
        meet_name: r.meet_name || 'Standalone events',
        rows: [],
      })
    }
    buckets.get(key).rows.push(r)
  }
  // Within each meet bucket, sort rows into live/upcoming/idle.
  const out = []
  for (const bucket of buckets.values()) {
    const live = [], upcoming = [], idle = []
    for (const r of bucket.rows) {
      if (r.event_status === 'Live')          live.push(r)
      else if (r.event_status === 'Upcoming') upcoming.push(r)
      else                                     idle.push(r)
    }
    out.push({ ...bucket, live, upcoming, idle })
  }
  // Order: most Live cards first; ties broken alphabetically.
  out.sort((a, b) => {
    if (b.live.length !== a.live.length) return b.live.length - a.live.length
    return (a.meet_name || '').localeCompare(b.meet_name || '')
  })
  return out
})

// Do we have multiple meets? Only render the per-meet heading
// when there's more than one — a coach with all their divers in
// one meet shouldn't see a redundant "Acme Regional →" label
// above every section.
const hasMultipleMeets = computed(() => groupedByMeet.value.length > 1)
</script>

<template>
  <div class="coach-wrap">
    <!-- Offline / sync banner. Coaches submitting dive lists on
         behalf of divers (offline-tolerant per the inventory)
         benefit from a visible queue state. -->
    <OfflineBanner />
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('coach.dashboard.label') }}</div>
        <h1 class="page-title">{{ $t('coach.dashboard.title') }}</h1>
        <div class="page-sub">{{ $t('coach.dashboard.subtitle') }}</div>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost btn-sm" @click="alertSettingsOpen = !alertSettingsOpen">
          🔔 {{ alertPrefs.enabled ? $t('coach.dashboard.alerts_on') : $t('coach.dashboard.alerts_off') }}
        </button>
        <button class="btn btn-ghost btn-sm" @click="load" :disabled="loading">
          {{ loading ? $t('common.refreshing') : $t('common.refresh') }}
        </button>
      </div>
    </div>

    <!-- Alert preferences panel — collapsible. Lets the coach
         opt out of "your diver is up next" pushes or change how
         far ahead the alert fires. When push permission hasn't
         been granted yet, surface a one-tap "Enable on this
         device" button that wraps usePush + the prefs POST. -->
    <div v-if="alertSettingsOpen" class="alert-settings-panel">
      <div class="alert-settings-title">{{ $t('coach.dashboard.alerts_title') }}</div>
      <div class="alert-settings-body">
        <label class="alert-toggle">
          <input type="checkbox" v-model="alertPrefs.enabled">
          <span>{{ $t('coach.dashboard.alerts_toggle') }}</span>
        </label>
        <div class="alert-row">
          <label>
            {{ $t('coach.dashboard.alerts_fire_label') }}
            <input type="number"
                   class="input alert-input"
                   v-model.number="alertPrefs.dives_ahead"
                   min="1" max="10">
            {{ alertPrefs.dives_ahead === 1
                ? $t('coach.dashboard.alerts_dives_one')
                : $t('coach.dashboard.alerts_dives_many') }}
          </label>
        </div>
        <p class="alert-hint">{{ $t('coach.dashboard.alerts_hint') }}</p>
        <div class="alert-actions">
          <button v-if="push.permission?.value !== 'granted'"
                  class="btn btn-primary btn-sm"
                  @click="enablePushAndPrefs"
                  :disabled="savingPrefs">
            {{ $t('coach.dashboard.alerts_enable_push') }}
          </button>
          <button class="btn btn-primary btn-sm"
                  @click="saveAlertPrefs"
                  :disabled="savingPrefs">
            {{ savingPrefs ? $t('common.saving') : $t('common.save') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading && !rows.length" class="empty">{{ $t('coach.dashboard.loading') }}</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="!rows.length" class="empty-state-card">
      <div class="empty-state-icon">🤝</div>
      <div class="empty-state-title">{{ $t('coach.dashboard.no_divers_title') }}</div>
      <div class="empty-state-body">{{ $t('coach.dashboard.no_divers_body') }}</div>
    </div>

    <template v-else>
      <!-- UP NEXT STRIP — squad members in the next ~20 min,
           sorted by ETA. The "look once, know what to watch"
           panel. Only renders when at least one squad member is
           in flight; otherwise the coach is between meets and
           this strip is just noise. -->
      <section v-if="upNext.rows.length" class="up-next-section">
        <div class="up-next-head">
          <span class="up-next-label">{{ $t('coach.dashboard.up_next_label') }}</span>
          <span class="up-next-sub">{{ $t('coach.dashboard.up_next_sub', { minutes: upNext.max_eta_minutes }) }}</span>
        </div>
        <div class="up-next-strip">
          <RouterLink v-for="row in upNext.rows"
                      :key="row.diver_id + ':' + row.event_id + ':' + row.round_number"
                      :to="`/scoreboard/${row.event_id}`"
                      :class="['up-next-card', etaTier(row.eta_seconds)]">
            <div class="up-next-eta">
              <span class="up-next-eta-value">{{ fmtEta(row.eta_seconds) }}</span>
              <span class="up-next-eta-detail">{{ fmtDivesAway(row.dives_until) }}</span>
            </div>
            <div class="up-next-diver">
              <span class="up-next-name">{{ row.full_name }}</span>
              <span v-if="row.country_code" class="up-next-ctry">{{ row.country_code }}</span>
            </div>
            <div v-if="row.club_name" class="up-next-club">
              {{ row.club_code || row.club_name }}
            </div>
            <div class="up-next-event">{{ row.event_name }}</div>
            <div v-if="row.dive_code" class="up-next-dive">
              <span class="up-next-round">R{{ row.round_number }}</span>
              <span class="up-next-code">{{ row.dive_code }}{{ row.position }}</span>
              <span v-if="row.dd" class="up-next-dd">DD {{ Number(row.dd).toFixed(1) }}</span>
            </div>
          </RouterLink>
        </div>
      </section>

      <!-- Per-meet sections (when >1 meet) wrap each meet's
           live / upcoming / idle subgroups. Single-meet coaches
           render straight through with no meet heading. -->
      <template v-for="bucket in groupedByMeet" :key="bucket.meet_id || 'standalone'">
        <div v-if="hasMultipleMeets" class="meet-section-head">
          <span class="meet-section-label">🏟 {{ bucket.meet_name }}</span>
          <RouterLink v-if="bucket.meet_id"
                      :to="`/meet/${bucket.meet_id}`"
                      class="meet-section-link">
            Meet page →
          </RouterLink>
        </div>

        <!-- LIVE — biggest cards, brightest accent -->
        <section v-if="bucket.live.length" class="diver-section">
          <div class="section-head">
            <span class="section-label">{{ $t('coach.dashboard.section_live') }}</span>
            <span class="section-count">{{ bucket.live.length }}</span>
          </div>
          <div class="diver-grid">
            <RouterLink v-for="r in bucket.live"
                        :key="r.diver_id + r.event_id"
                        :to="`/profile/${r.diver_id}`"
                        class="diver-card live-card">
              <div class="diver-card-head">
                <span class="diver-card-name">{{ r.full_name }}</span>
                <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
                <span v-if="r.current_rank" :class="['diver-card-rank', placeColor(r.current_rank)]">
                  {{ fmtRank(r.current_rank) }}<span class="dim"> / {{ r.field_size }}</span>
                </span>
              </div>
              <div v-if="r.club_name" class="diver-card-club">
                {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
              </div>
              <div class="diver-card-event">
                <span class="event-name">{{ r.event_name }}</span>
                <span v-if="r.event_type === 'synchro_pair'" class="event-type">SYNCHRO</span>
                <span v-else-if="r.event_type === 'team'" class="event-type">TEAM</span>
              </div>
              <div class="diver-card-next">
                <span class="next-label">Next</span>
                <span class="next-round">R{{ r.round_number }}</span>
                <span class="next-code">{{ r.dive_code }}{{ r.position }}</span>
                <span v-if="r.dd" class="next-dd">DD {{ Number(r.dd).toFixed(1) }}</span>
              </div>
              <div v-if="r.description" class="diver-card-desc">{{ diveDescription(r) }}</div>
              <!-- Last completed dive (only when there IS one) —
                   round, code, and dive total. Surfaces what
                   just landed without forcing the coach to click
                   into the diver's profile. -->
              <div v-if="r.last_dive_round" class="diver-card-last">
                <span class="last-label">Last</span>
                <span class="last-round">R{{ r.last_dive_round }}</span>
                <span class="last-code">{{ r.last_dive_code }}{{ r.last_dive_position }}</span>
                <span v-if="r.last_dive_points != null" class="last-points">
                  → {{ Number(r.last_dive_points).toFixed(2) }}
                </span>
              </div>
              <div class="diver-card-foot">
                <span v-if="r.current_total != null">Running {{ Number(r.current_total).toFixed(1) }}</span>
                <span class="diver-card-cta">View profile →</span>
              </div>
            </RouterLink>
          </div>
        </section>

        <!-- UPCOMING — same shape, dimmer accent. Each card carries
             a small "✎ Dive lists" action that deep-links to the
             coach-on-behalf-of editor for that event. -->
        <section v-if="bucket.upcoming.length" class="diver-section">
          <div class="section-head">
            <span class="section-label">{{ $t('coach.dashboard.section_upcoming') }}</span>
            <span class="section-count">{{ bucket.upcoming.length }}</span>
          </div>
          <div class="diver-grid">
            <div v-for="r in bucket.upcoming"
                 :key="r.diver_id + r.event_id"
                 class="diver-card upcoming-card">
              <RouterLink :to="`/profile/${r.diver_id}`" class="diver-card-inner">
                <div class="diver-card-head">
                  <span class="diver-card-name">{{ r.full_name }}</span>
                  <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
                </div>
                <div v-if="r.club_name" class="diver-card-club">
                  {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
                </div>
                <div class="diver-card-event">
                  <span class="event-name">{{ r.event_name }}</span>
                </div>
                <div class="diver-card-next">
                  <span class="next-label">Round 1</span>
                  <span class="next-code">{{ r.dive_code }}{{ r.position }}</span>
                  <span v-if="r.dd" class="next-dd">DD {{ Number(r.dd).toFixed(1) }}</span>
                </div>
              </RouterLink>
              <div class="diver-card-foot diver-card-foot-actions">
                <RouterLink :to="`/coach/dive-lists/${r.event_id}`"
                            class="card-action card-action-dive-list">
                  ✎ Dive lists
                </RouterLink>
                <RouterLink :to="`/profile/${r.diver_id}`"
                            class="diver-card-cta">View profile →</RouterLink>
              </div>
            </div>
          </div>
        </section>

        <!-- IDLE — divers with no active event for this meet
             bucket. Rendered only inside the standalone bucket
             because divers with no event don't belong to a meet. -->
        <section v-if="bucket.idle.length && !bucket.meet_id" class="diver-section">
          <div class="section-head">
            <span class="section-label">{{ $t('coach.dashboard.section_idle') }}</span>
            <span class="section-count">{{ bucket.idle.length }}</span>
          </div>
          <div class="diver-grid">
            <RouterLink v-for="r in bucket.idle"
                        :key="r.diver_id"
                        :to="`/profile/${r.diver_id}`"
                        class="diver-card idle-card">
              <div class="diver-card-head">
                <span class="diver-card-name">{{ r.full_name }}</span>
                <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
              </div>
              <div v-if="r.club_name" class="diver-card-club">
                {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
              </div>
              <div v-if="r.note" class="diver-card-note">{{ r.note }}</div>
              <div class="diver-card-foot">
                <span class="diver-card-cta">View profile →</span>
              </div>
            </RouterLink>
          </div>
        </section>
      </template>

      <div class="actions-row">
        <RouterLink to="/compare" class="btn btn-ghost btn-sm">
          Compare two divers head-to-head →
        </RouterLink>
      </div>
    </template>
  </div>
</template>

<style scoped>
.coach-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-sans); font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.2; }
.page-sub   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; max-width: 600px; line-height: 1.6; }
.header-actions { display: flex; gap: 0.5rem; align-items: center; }

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

/* ─── Alert settings panel ────────────────────────────────────── */
.alert-settings-panel {
  margin-bottom: 1.25rem; padding: 1rem 1.1rem;
  border: 1px solid var(--cyan); border-radius: var(--radius-lg);
  background: var(--cyan-dim);
}
.alert-settings-title {
  font-family: var(--font-display); font-size: 12px; font-weight: 900;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.65rem;
}
.alert-settings-body {
  display: flex; flex-direction: column; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px; color: var(--text-2);
}
.alert-toggle { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.alert-toggle input[type="checkbox"] {
  width: 18px; height: 18px; accent-color: var(--cyan); cursor: pointer;
}
.alert-row label {
  display: inline-flex; align-items: center; gap: 0.5rem;
}
.alert-input { width: 70px; text-align: center; }
.alert-hint { font-size: 10.5px; color: var(--text-3); margin: 0; line-height: 1.5; }
.alert-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

/* ─── Up Next strip ───────────────────────────────────────────── */
.up-next-section {
  margin-bottom: 2rem;
  padding: 1rem 1.1rem;
  background: linear-gradient(180deg, rgba(6,182,212,0.06) 0%, rgba(6,182,212,0.02) 100%);
  border: 1px solid rgba(6,182,212,0.3);
  border-radius: var(--radius-lg);
}
.up-next-head {
  display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.85rem;
}
.up-next-label {
  font-family: var(--font-display); font-size: 12px; font-weight: 900;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--cyan);
}
.up-next-sub {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.up-next-strip {
  display: flex; gap: 0.7rem;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  padding-bottom: 0.3rem;
}
.up-next-card {
  flex: 0 0 230px;
  display: flex; flex-direction: column; gap: 0.35rem;
  padding: 0.85rem 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-decoration: none; color: inherit;
  transition: all 0.15s;
}
.up-next-card:hover {
  border-color: var(--cyan); background: rgba(6,182,212,0.05);
  transform: translateY(-1px);
}
.up-next-card.eta-now    { border-color: #ef4444; background: rgba(239,68,68,0.06); }
.up-next-card.eta-soon   { border-color: #f59e0b; background: rgba(245,158,11,0.05); }
.up-next-card.eta-watch  { border-color: rgba(6,182,212,0.5); }
.up-next-card.eta-later  { opacity: 0.92; }

.up-next-eta {
  display: flex; align-items: baseline; gap: 0.5rem;
  padding-bottom: 0.35rem; border-bottom: 1px solid var(--border);
}
.up-next-eta-value {
  font-family: var(--font-mono); font-size: 22px; font-weight: 500;
  font-style: normal; line-height: 1; color: var(--fg);
}
.up-next-card.eta-now   .up-next-eta-value { color: #ef4444; }
.up-next-card.eta-soon  .up-next-eta-value { color: #f59e0b; }
.up-next-card.eta-watch .up-next-eta-value { color: var(--cyan); }
.up-next-eta-detail {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
}
.up-next-diver { display: flex; align-items: baseline; gap: 0.5rem; }
.up-next-name {
  font-family: var(--font-sans); font-size: 15px; font-weight: 600;
  font-style: normal; color: var(--fg);
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.up-next-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}
.up-next-club {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.up-next-event {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.up-next-dive {
  display: flex; align-items: baseline; gap: 0.4rem;
  font-family: var(--font-mono); font-size: 11px;
  padding: 0.3rem 0.5rem; background: var(--bg-3);
  border-radius: var(--radius-sm); margin-top: 0.15rem;
}
.up-next-round { color: var(--cyan); font-weight: 700; }
.up-next-code  { color: var(--text); font-weight: 700; }
.up-next-dd    { color: var(--cyan); margin-inline-start: auto; font-size: 10px; }

/* ─── Meet section heading (only when >1 meet) ────────────────── */
.meet-section-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-top: 1rem; margin-bottom: 0.5rem;
  padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}
.meet-section-label {
  font-family: var(--font-sans); font-size: 14px; font-weight: 600;
  font-style: normal; color: var(--fg); letter-spacing: -0.01em;
}
.meet-section-link {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--cyan);
  text-decoration: none;
}
.meet-section-link:hover { text-decoration: underline; }

/* ─── Diver sections ──────────────────────────────────────────── */
.diver-section { margin-bottom: 2rem; }
.section-head {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--text-2);
}
.section-count {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.4rem;
}

.diver-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.875rem;
}
.diver-card {
  display: flex; flex-direction: column; gap: 0.45rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1rem 1.1rem;
  text-decoration: none; color: inherit;
  transition: all 0.15s; min-width: 0;
}
.diver-card:hover {
  border-color: var(--cyan); background: rgba(6,182,212,0.04);
  transform: translateY(-1px);
}
.diver-card.live-card {
  border-color: rgba(6,182,212,0.4);
  background: rgba(6,182,212,0.05);
  box-shadow: 0 4px 12px rgba(6,182,212,0.08);
}
.diver-card.upcoming-card {
  background: var(--surface);
}
.diver-card.idle-card {
  opacity: 0.85;
}

.diver-card-head { display: flex; align-items: baseline; gap: 0.5rem; }
.diver-card-name {
  font-family: var(--font-sans); font-size: 18px; font-weight: 600;
  font-style: normal; color: var(--fg); line-height: 1.1;
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diver-card-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}
.diver-card-rank {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--text); padding: 0.1rem 0.4rem;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--bg-3);
}
.diver-card-rank.place-gold   { color: #f59e0b; border-color: rgba(234,179,8,0.4);   background: rgba(234,179,8,0.06); }
.diver-card-rank.place-silver { color: #94a3b8; border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.diver-card-rank.place-bronze { color: #b45309; border-color: rgba(180,83,9,0.4);    background: rgba(180,83,9,0.06); }
.diver-card-rank .dim { color: var(--text-3); font-weight: 400; }

.diver-card-club {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.diver-card-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.3rem; margin-inline-start: 0.4rem;
}
.diver-card-event {
  display: flex; align-items: baseline; gap: 0.4rem;
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text); padding-top: 0.2rem;
  border-top: 1px solid var(--border);
}
.event-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.event-type {
  font-family: var(--font-display); font-size: 8px; font-weight: 900;
  letter-spacing: 0.18em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}
.diver-card-next {
  display: flex; align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
  padding: 0.4rem 0.5rem;
  background: var(--bg-3); border-radius: var(--radius-sm);
}
.next-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.next-round {
  font-family: var(--font-mono); font-size: 11px; color: var(--cyan);
  font-weight: 700;
}
.next-code { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text); }
.next-dd   { font-family: var(--font-mono); font-size: 11px; color: var(--cyan); margin-inline-start: auto; }

.diver-card-desc {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  font-style: italic; line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.diver-card-last {
  display: flex; align-items: center; gap: 0.55rem;
  font-family: var(--font-mono); font-size: 11px;
  padding: 0.3rem 0.5rem;
  background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.2);
  border-radius: var(--radius-sm);
}
.last-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.last-round { color: var(--text-2); font-weight: 700; }
.last-code  { color: var(--text); font-weight: 700; }
.last-points { color: #22c55e; font-weight: 700; margin-inline-start: auto; }

.diver-card-note { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); font-style: italic; }
.diver-card-foot {
  display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-top: 0.25rem;
}
.diver-card-cta {
  font-family: var(--font-display); font-weight: 700;
  letter-spacing: 0.15em; color: var(--cyan); text-transform: uppercase;
  text-decoration: none;
}
.diver-card-inner {
  display: flex; flex-direction: column; gap: 0.45rem;
  text-decoration: none; color: inherit;
  margin: -1rem -1.1rem -0.5rem -1.1rem;
  padding: 1rem 1.1rem 0.5rem;
}
.diver-card-foot-actions {
  margin-top: 0.5rem; padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}
.card-action {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  text-decoration: none; color: var(--text-2);
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border); border-radius: 3px;
  transition: all 0.12s;
}
.card-action:hover {
  border-color: var(--cyan); color: var(--cyan);
  background: var(--cyan-dim);
}
.card-action-dive-list { color: var(--text); }

.actions-row {
  display: flex; justify-content: center; margin-top: 1.5rem;
}

@media (max-width: 720px) {
  .coach-wrap { padding: 1rem; }
  .diver-grid { grid-template-columns: 1fr; }
  .up-next-card { flex: 0 0 200px; }
}
</style>
