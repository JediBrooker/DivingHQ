<script setup>
// Notifications inbox.
//
// Until now, push notifications were transient: once a user dismissed
// the system toast (or had their phone off when one fired), it was
// gone. This view is the persistent record, every notification the
// push engine wrote to the `notifications` table for this user,
// sorted newest-first, with a "mark read" button.
//
// Backed by the existing endpoints:
//   GET  /api/notifications/me                  (list)
//   POST /api/notifications/:id/acknowledge     (mark read)
//
// Categories so far: signoff_request, role_decision,
// event_started, event_results_posted, generic. Each row
// carries a title + body + optional action_url; clicking the
// row opens action_url (in-app via RouterLink when local,
// otherwise window.open) AND marks the row acknowledged.
//
// Filter chips: All / Unread / By category. Pagination via
// ?since_id=<uuid>.
import { ref, computed, onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'
import { fmtRelative } from '@/lib/format'

const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()

const rows         = ref([])
const loading      = ref(false)
const showRead     = ref(false)
const categoryFilter = ref('all')
const laneFilter = ref('all')

// Lane labels resolve through i18n in laneCounts (below) so a locale
// switch re-renders them, just keep the stable id + key here.
const LANE_DEFS = [
  { id: 'all', labelKey: 'inbox.lane_all' },
  { id: 'action', labelKey: 'inbox.lane_action' },
  { id: 'team', labelKey: 'inbox.lane_team' },
  { id: 'results', labelKey: 'inbox.lane_results' },
  { id: 'ops', labelKey: 'inbox.lane_ops' },
]

const CATEGORY_LANES = {
  signoff_request:          'action',
  referee_signoff:          'action',
  role_request:             'action',
  org_pending:              'action',
  international_invite:     'action',
  'synchro.partner_invite': 'action',
  'coach.diver_up_next':    'team',
  'coach.dive_list_submitted': 'team',
  'coach.dive_list_withdrawn': 'team',
  dive_list_advanced:       'team',
  dive_list_reserve:        'team',
  reserve_promoted:         'team',
  event_results_posted:     'results',
  event_live:               'ops',
  h2h_seeded:               'ops',
  sf_seeded:                'ops',
  f_seeded:                 'ops',
}

async function load() {
  loading.value = true
  try {
    rows.value = await auth.apiFetch('/api/notifications/me?limit=100')
  } catch (err) {
    showError(t('inbox.load_failed', { error: err.message }))
  } finally {
    loading.value = false
  }
}

const categories = computed(() => {
  const seen = new Map()
  for (const r of rows.value) {
    if (!seen.has(r.category)) seen.set(r.category, 0)
    seen.set(r.category, seen.get(r.category) + 1)
  }
  return [...seen.entries()].map(([cat, n]) => ({ id: cat, count: n }))
})

const laneCounts = computed(() => {
  const counts = new Map(LANE_DEFS.map((lane) => [lane.id, 0]))
  for (const row of rows.value) {
    counts.set('all', (counts.get('all') || 0) + 1)
    const lane = CATEGORY_LANES[row.category] || 'ops'
    counts.set(lane, (counts.get(lane) || 0) + 1)
  }
  return LANE_DEFS.map((lane) => ({
    id: lane.id,
    label: t(lane.labelKey),
    count: counts.get(lane.id) || 0,
  }))
})

const filtered = computed(() => {
  let list = rows.value
  if (!showRead.value) {
    list = list.filter((r) => r.status !== 'acknowledged')
  }
  if (categoryFilter.value !== 'all') {
    list = list.filter((r) => r.category === categoryFilter.value)
  }
  if (laneFilter.value !== 'all') {
    list = list.filter((r) => (CATEGORY_LANES[r.category] || 'ops') === laneFilter.value)
  }
  return list
})

const unreadCount = computed(() =>
  rows.value.filter((r) => r.status !== 'acknowledged').length,
)

async function markRead(row) {
  if (row.status === 'acknowledged') return
  // optimistic update, revert below if the request fails
  row.status = 'acknowledged'
  row.acknowledged_at = new Date().toISOString()
  try {
    await auth.apiFetch(`/api/notifications/${row.id}/acknowledge`, { method: 'POST' })
  } catch {
    row.status = 'sent'
    row.acknowledged_at = null
    showError(t('inbox.mark_read_failed'))
  }
}

async function markAllRead() {
  const unread = rows.value.filter((r) => r.status !== 'acknowledged')
  if (!unread.length) return
  unread.forEach((r) => {
    r.status = 'acknowledged'
    r.acknowledged_at = new Date().toISOString()
  })
  try {
    await Promise.all(
      unread.map((r) =>
        auth.apiFetch(`/api/notifications/${r.id}/acknowledge`, { method: 'POST' }),
      ),
    )
    showSuccess(t('inbox.marked_read', { count: unread.length }))
  } catch {
    showError(t('inbox.ack_partial_failed'))
  }
}

function clickRow(row) {
  markRead(row)
  if (!row.action_url) return
  // internal links use the router, external URLs open in a new tab
  if (row.action_url.startsWith('/')) {
    router.push(row.action_url)
  } else {
    window.open(row.action_url, '_blank', 'noopener')
  }
}

// fmtTime used to be a local copy of the same fmtRelative the
// dashboard uses; just reuse the shared helper from @/lib/format now.
const fmtTime = fmtRelative

// Category -> i18n leaf under inbox.cat.*. Keys are sanitised (dots
// become underscores) because the raw category ids contain dots
// (e.g. "coach.diver_up_next") which vue-i18n would otherwise read
// as a nested path. Unknown categories fall back to the raw id.
const CATEGORY_LABEL_KEYS = {
  signoff_request:             'signoff_request',
  role_decision:               'role_decision',
  role_request:                'role_request',
  org_pending:                 'org_pending',
  event_started:               'event_started',
  event_live:                  'event_live',
  event_results_posted:        'event_results_posted',
  international_invite:         'international_invite',
  referee_signoff:             'referee_signoff',
  'coach.diver_up_next':       'coach_diver_up_next',
  'coach.dive_list_submitted': 'coach_dive_list_submitted',
  'coach.dive_list_withdrawn': 'coach_dive_list_withdrawn',
  'synchro.partner_invite':    'synchro_partner_invite',
  dive_list_advanced:          'dive_list_advanced',
  dive_list_reserve:           'dive_list_reserve',
  reserve_promoted:            'reserve_promoted',
  h2h_seeded:                  'h2h_seeded',
  sf_seeded:                   'sf_seeded',
  f_seeded:                    'f_seeded',
  generic:                     'generic',
}

function categoryLabel(cat) {
  const key = CATEGORY_LABEL_KEYS[cat]
  return key ? t(`inbox.cat.${key}`) : cat
}

onMounted(load)
</script>

<template>
  <div class="inbox-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('inbox.title') }}</div>
        <h1 class="page-title">{{ $t('inbox.heading') }}</h1>
        <div class="page-sub">
          {{ $t('inbox.subtitle') }}
          <span v-if="unreadCount" class="page-sub-strong"> · {{ $t('inbox.unread_count', { count: unreadCount }) }}</span>
        </div>
      </div>
      <div class="header-actions">
        <button v-if="unreadCount" type="button" class="btn btn-ghost btn-sm" @click="markAllRead">
          {{ $t('inbox.mark_all_read') }}
        </button>
      </div>
    </div>

    <div class="lane-strip" :aria-label="$t('inbox.lanes_aria')">
      <button v-for="lane in laneCounts" :key="lane.id"
              type="button"
              :class="['lane-card', laneFilter === lane.id ? 'active' : '']"
              @click="laneFilter = lane.id">
        <span>{{ lane.label }}</span>
        <strong>{{ lane.count }}</strong>
      </button>
    </div>

    <div class="filters">
      <div class="field-inline">
        <span class="filter-label">{{ $t('inbox.show') }}</span>
        <button type="button"
                :class="['chip', !showRead ? 'chip-active' : '']"
                @click="showRead = false">
          {{ $t('inbox.filter_unread') }} <span class="chip-count">{{ unreadCount }}</span>
        </button>
        <button type="button"
                :class="['chip', showRead ? 'chip-active' : '']"
                @click="showRead = true">
          {{ $t('inbox.filter_all') }} <span class="chip-count">{{ rows.length }}</span>
        </button>
      </div>
      <div v-if="categories.length > 1" class="field-inline">
        <span class="filter-label">{{ $t('inbox.filter_category') }}</span>
        <button type="button"
                :class="['chip', categoryFilter === 'all' ? 'chip-active' : '']"
                @click="categoryFilter = 'all'">
          {{ $t('inbox.filter_all') }}
        </button>
        <button v-for="c in categories" :key="c.id"
                type="button"
                :class="['chip', categoryFilter === c.id ? 'chip-active' : '']"
                @click="categoryFilter = c.id">
          {{ categoryLabel(c.id) }} <span class="chip-count">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading && !rows.length" class="empty">{{ $t('inbox.loading') }}</div>
    <EmptyState
      v-else-if="!filtered.length && !rows.length"
      icon="📭"
      v-tip="$t('inbox.empty_title')"
      :body="$t('inbox.empty_body')"
      :action-label="$t('inbox.open_dashboard')"
      action-to="/dashboard"
    />
    <EmptyState
      v-else-if="!filtered.length && !showRead && !unreadCount"
      icon="✓"
      v-tip="$t('inbox.caught_up_title')"
      :body="$t('inbox.caught_up_body')"
      variant="inline"
    />
    <div v-else-if="!filtered.length" class="empty">
      {{ $t('inbox.no_match') }}
    </div>

    <ul v-else class="inbox-list">
      <li v-for="r in filtered" :key="r.id"
          :class="['inbox-row', r.status === 'acknowledged' ? 'is-read' : '', r.action_url ? 'is-clickable' : '']"
          @click="clickRow(r)">
        <div class="inbox-row-bar" :data-cat="r.category"></div>
        <div class="inbox-row-body">
          <div class="inbox-row-head">
            <span class="inbox-row-cat">{{ categoryLabel(r.category) }}</span>
            <span class="inbox-row-time">{{ fmtTime(r.created_at) }}</span>
            <span v-if="r.status !== 'acknowledged'" class="inbox-unread-dot" :aria-label="$t('inbox.unread_aria')"></span>
          </div>
          <div class="inbox-row-title">{{ r.title }}</div>
          <div v-if="r.body" class="inbox-row-text">{{ r.body }}</div>
          <div v-if="r.action_url" class="inbox-row-action">{{ r.action_url.startsWith('/') ? $t('inbox.open_path', { path: r.action_url }) : $t('inbox.open') }} →</div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.inbox-wrap { max-width: 900px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-sans); font-size: var(--text-h1); font-weight: 600;
  font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.2;
}
.page-sub {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  margin-top: 0.4rem; max-width: 640px;
}
.page-sub-strong { color: var(--cyan); font-weight: 700; }
.header-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.lane-strip {
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.55rem; margin-bottom: 1rem;
}
.lane-card {
  min-width: 0; text-align: start;
  padding: 0.65rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.lane-card:hover,
.lane-card.active {
  border-color: var(--cyan);
  background: var(--cyan-dim);
}
.lane-card span {
  display: block;
  font-family: var(--font-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-3);
}
.lane-card strong {
  display: block; margin-top: 0.2rem;
  font-family: var(--font-display); font-size: 20px; line-height: 1;
  color: var(--text);
}
.lane-card.active span,
.lane-card.active strong { color: var(--cyan); }

.filters {
  display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap;
  margin-bottom: 1rem;
}
.field-inline { display: flex; align-items: center; gap: 0.4rem; }
.filter-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.chip {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.chip:hover { color: var(--text-2); border-color: var(--border-2); }
.chip-active {
  background: var(--cyan-dim);
  color: var(--cyan);
  border-color: var(--cyan);
}
.chip-count {
  font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
}

.empty {
  color: var(--text-3); padding: 3rem 0; text-align: center;
  font-family: var(--font-mono); font-size: 13px;
}

.inbox-list { list-style: none; margin: 0; padding: 0; }
.inbox-row {
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.6rem;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.15s;
}
.inbox-row.is-clickable { cursor: pointer; }
.inbox-row.is-clickable:hover {
  border-color: var(--border-2);
  transform: translateX(2px);
}
.inbox-row.is-read .inbox-row-title,
.inbox-row.is-read .inbox-row-text {
  color: var(--text-3);
}
.inbox-row.is-read .inbox-row-cat { opacity: 0.6; }

.inbox-row-bar {
  flex-shrink: 0; width: 4px;
  background: var(--cyan);
}
.inbox-row-bar[data-cat="signoff_request"]      { background: var(--amber); }
.inbox-row-bar[data-cat="referee_signoff"]      { background: var(--amber); }
.inbox-row-bar[data-cat="role_decision"]        { background: var(--green); }
.inbox-row-bar[data-cat="international_invite"] { background: #67e8f9; }
.inbox-row-bar[data-cat="role_request"]         { background: #a78bfa; }
.inbox-row-bar[data-cat="event_started"]        { background: var(--red); }
.inbox-row-bar[data-cat="event_live"]           { background: var(--red); }
.inbox-row-bar[data-cat="event_results_posted"] { background: var(--green); }
.inbox-row-bar[data-cat="coach.diver_up_next"]  { background: var(--cyan); }
.inbox-row-bar[data-cat="coach.dive_list_submitted"] { background: var(--green); }
.inbox-row-bar[data-cat="coach.dive_list_withdrawn"] { background: var(--red); }
.inbox-row-bar[data-cat="synchro.partner_invite"] { background: var(--amber); }
.inbox-row-bar[data-cat="dive_list_advanced"],
.inbox-row-bar[data-cat="dive_list_reserve"],
.inbox-row-bar[data-cat="reserve_promoted"] { background: #38bdf8; }
.inbox-row-bar[data-cat="h2h_seeded"],
.inbox-row-bar[data-cat="sf_seeded"],
.inbox-row-bar[data-cat="f_seeded"] { background: #a78bfa; }

.inbox-row-body {
  flex: 1; min-width: 0;
  padding: 0.85rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.25rem;
}
.inbox-row-head {
  display: flex; align-items: center; gap: 0.55rem;
  flex-wrap: wrap;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--text-3);
}
.inbox-row-cat { color: var(--cyan); }
.inbox-row-time {
  font-family: var(--font-mono); letter-spacing: 0.04em;
  text-transform: none; font-weight: 500; font-size: 11px;
}
.inbox-unread-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--cyan);
  margin-inline-start: auto;
}
.inbox-row-title {
  font-family: var(--font-sans); font-size: 15px; font-weight: 600;
  font-style: normal; color: var(--fg);
  letter-spacing: -0.01em;
}
.inbox-row-text {
  font-family: var(--font-mono); font-size: 13px; line-height: 1.5;
  color: var(--text-2);
}
.inbox-row-action {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--cyan);
  margin-top: 0.2rem;
}

@media (max-width: 760px) {
  .lane-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
