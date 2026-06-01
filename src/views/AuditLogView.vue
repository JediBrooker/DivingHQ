<script setup>
// Federation-wide audit log. Three tabs:
//
//   1. Recent activity — the last 7 days of score + role events
//      interleaved chronologically. Lets an admin glance at
//      "what happened recently" without picking a target up
//      front.
//   2. Score corrections — every score insert / update / delete
//      across the federation, filterable by event, action,
//      reason text, and date range. Click a row to jump to the
//      per-event audit view (which also surfaces IP / UA).
//   3. Role changes — every role grant / revoke across the
//      federation, filterable by role, action, and target user.
//
// Sysadmin gets a fourth control: an org filter dropdown that
// scopes every tab to a specific federation. Default leaves it
// "all orgs" so a sysadmin's investigation starts wide.
//
// Rows are paginated server-side via limit + offset; the page
// shows 100 at a time with a Show more button. CSV export
// dumps the currently-filtered rows so an org admin can attach
// the file to a dispute resolution email.

import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'

const { t } = useI18n()
const auth = useAuthStore()
const router = useRouter()
const isSysAdmin = computed(() => !!auth.user?.is_system_admin)

// ----- Tab state -----
const TABS = [
  { id: 'recent',   labelKey: 'audit.tab_recent' },
  { id: 'scores',   labelKey: 'audit.tab_scores' },
  { id: 'roles',    labelKey: 'audit.tab_roles' },
  { id: 'activity', labelKey: 'audit.tab_activity' },
]
const activeTab = ref('recent')

// ----- Org filter (sysadmin only) -----
const orgs = ref([])
const orgFilter = ref('')   // '' = all orgs (sysadmin only)

// ----- Recent tab state -----
const recentDays = ref(7)
const recentRows = ref([])
const recentBusy = ref(false)

// ----- Score audit tab state -----
const scoreFilters = ref({
  action: 'all',     // 'all' | 'insert' | 'update' | 'delete'
  q:      '',
  from:   '',
  to:     '',
})
const scoreRows = ref([])
const scoreBusy = ref(false)
const scoreOffset = ref(0)
const scoreHasMore = ref(false)
const PAGE = 100

// ----- Role audit tab state -----
const roleFilters = ref({
  action: 'all',     // 'all' | 'granted' | 'revoked'
  role:   'all',     // org_role enum
  from:   '',
  to:     '',
})
const roleRows = ref([])
const roleBusy = ref(false)
const roleOffset = ref(0)
const roleHasMore = ref(false)

const ORG_ROLES = ['org_admin', 'meet_manager', 'referee', 'judge', 'coach', 'diver']

// ----- Activity (event + admin actions) tab state -----
const activityFilters = ref({
  action_prefix: 'all', // 'all' | 'event' | 'roster' | 'org' | 'club' | 'team'
  from:          '',
  to:            '',
})
const activityRows = ref([])
const activityBusy = ref(false)
const activityOffset = ref(0)
const activityHasMore = ref(false)
const ACTIVITY_PREFIXES = [
  { value: 'all',    labelKey: 'audit.activity.prefix_all' },
  { value: 'event',  labelKey: 'audit.activity.prefix_event' },
  { value: 'roster', labelKey: 'audit.activity.prefix_roster' },
  { value: 'org',    labelKey: 'audit.activity.prefix_org' },
  { value: 'club',   labelKey: 'audit.activity.prefix_club' },
  { value: 'team',   labelKey: 'audit.activity.prefix_team' },
]

// ----- Data loaders -----
async function loadOrgs() {
  if (!isSysAdmin.value) return
  try {
    orgs.value = await auth.apiFetch('/api/orgs')
  } catch { /* silent */ }
}

function orgQueryParam() {
  if (!isSysAdmin.value) return ''
  return orgFilter.value ? `&org_id=${encodeURIComponent(orgFilter.value)}` : ''
}

async function loadRecent() {
  recentBusy.value = true
  try {
    recentRows.value = await auth.apiFetch(
      `/api/audit/recent?days=${recentDays.value}&limit=${PAGE}${orgQueryParam()}`,
    )
  } catch (err) {
    showError(`Failed to load recent activity: ${err.message}`)
  } finally {
    recentBusy.value = false
  }
}

async function loadScores({ append = false } = {}) {
  scoreBusy.value = true
  try {
    const f = scoreFilters.value
    const params = new URLSearchParams()
    if (f.action !== 'all') params.set('action', f.action)
    if (f.q.trim())         params.set('q',      f.q.trim())
    if (f.from)             params.set('from',   f.from)
    if (f.to)               params.set('to',     f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? scoreOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/scores?${params.toString()}`)
    if (append) {
      scoreRows.value = [...scoreRows.value, ...rows]
    } else {
      scoreRows.value = rows
      scoreOffset.value = 0
    }
    scoreOffset.value += rows.length
    scoreHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load score audit: ${err.message}`)
  } finally {
    scoreBusy.value = false
  }
}

async function loadRoles({ append = false } = {}) {
  roleBusy.value = true
  try {
    const f = roleFilters.value
    const params = new URLSearchParams()
    if (f.action !== 'all') params.set('action', f.action)
    if (f.role !== 'all')   params.set('role',   f.role)
    if (f.from)             params.set('from',   f.from)
    if (f.to)               params.set('to',     f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? roleOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/roles?${params.toString()}`)
    if (append) {
      roleRows.value = [...roleRows.value, ...rows]
    } else {
      roleRows.value = rows
      roleOffset.value = 0
    }
    roleOffset.value += rows.length
    roleHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load role audit: ${err.message}`)
  } finally {
    roleBusy.value = false
  }
}

async function loadActivity({ append = false } = {}) {
  activityBusy.value = true
  try {
    const f = activityFilters.value
    const params = new URLSearchParams()
    if (f.action_prefix !== 'all') params.set('action_prefix', f.action_prefix)
    if (f.from)                    params.set('from',          f.from)
    if (f.to)                      params.set('to',            f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? activityOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/activity?${params.toString()}`)
    if (append) {
      activityRows.value = [...activityRows.value, ...rows]
    } else {
      activityRows.value = rows
      activityOffset.value = 0
    }
    activityOffset.value += rows.length
    activityHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load activity audit: ${err.message}`)
  } finally {
    activityBusy.value = false
  }
}

// Re-load whichever tab is active when its filters change. Each
// filter watcher hits its own loader so switching between tabs
// is cheap (loader runs once, cached in the row ref).
watch(() => activeTab.value, (next) => {
  if (next === 'recent'   && !recentRows.value.length)   loadRecent()
  if (next === 'scores'   && !scoreRows.value.length)    loadScores()
  if (next === 'roles'    && !roleRows.value.length)     loadRoles()
  if (next === 'activity' && !activityRows.value.length) loadActivity()
})
watch(() => orgFilter.value, () => {
  // Org filter is global — refetch whichever tab is visible.
  if (activeTab.value === 'recent')   loadRecent()
  if (activeTab.value === 'scores')   loadScores()
  if (activeTab.value === 'roles')    loadRoles()
  if (activeTab.value === 'activity') loadActivity()
})
watch(() => recentDays.value, () => {
  if (activeTab.value === 'recent') loadRecent()
})
// Score / role filter changes — debounce-free; if the operator
// types fast in the search box they'll hit Enter or blur to fire
// a refetch via a button. Action / date / role are select boxes
// so a change-event reload is fine.
watch(() => [scoreFilters.value.action, scoreFilters.value.from, scoreFilters.value.to], () => {
  if (activeTab.value === 'scores') loadScores()
})
watch(() => [roleFilters.value.action, roleFilters.value.role, roleFilters.value.from, roleFilters.value.to], () => {
  if (activeTab.value === 'roles') loadRoles()
})
watch(() => [activityFilters.value.action_prefix, activityFilters.value.from, activityFilters.value.to], () => {
  if (activeTab.value === 'activity') loadActivity()
})

function applyScoreSearch() {
  // Manual trigger so a fast-typing operator doesn't hit the
  // server every keystroke for the reason text search.
  if (activeTab.value === 'scores') loadScores()
}

// ----- Helpers -----
function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
// Friendlier label for each audit action. Score + role audits
// store short enums (insert / update / delete / granted /
// revoked); the activity log uses dotted verbs ('event.created',
// 'roster.late_entry_added') — both shapes feed in here.
const ACTIVITY_LABEL_KEYS = {
  'event.created':           'audit.activity.label_event_created',
  'event.deleted':           'audit.activity.label_event_deleted',
  'event.started':           'audit.activity.label_event_started',
  'event.finalised':         'audit.activity.label_event_finalised',
  'event.unfinalised':       'audit.activity.label_event_unfinalised',
  'event.status_changed':    'audit.activity.label_event_status_changed',
  'event.workflow_reset':    'audit.activity.label_event_workflow_reset',
  'org.created':             'audit.activity.label_org_created',
  'org.status_changed':      'audit.activity.label_org_status_changed',
  'club.deleted':            'audit.activity.label_club_deleted',
  'team.deleted':            'audit.activity.label_team_deleted',
  'roster.withdrew':         'audit.activity.label_roster_withdrew',
  'roster.reinstated':       'audit.activity.label_roster_reinstated',
  'roster.late_entry_added': 'audit.activity.label_roster_late_entry_added',
}
function actionLabel(a) {
  if (a === 'insert')  return t('audit.action_submitted')
  if (a === 'update')  return t('audit.action_edited')
  if (a === 'delete')  return t('audit.action_deleted')
  if (a === 'granted') return t('audit.action_granted')
  if (a === 'revoked') return t('audit.action_revoked')
  if (ACTIVITY_LABEL_KEYS[a]) return t(ACTIVITY_LABEL_KEYS[a])
  return a
}
function actionClass(a) {
  if (a === 'insert' || a === 'granted')   return 'act-pos'
  if (a === 'update')                      return 'act-warn'
  if (a === 'delete' || a === 'revoked')   return 'act-neg'
  // Activity-log actions: positive (created / reinstated /
  // started), warn (status_changed / workflow_reset / late_entry),
  // negative (deleted / withdrew / unfinalised).
  if (a.endsWith('.created'))    return 'act-pos'
  if (a.endsWith('.started'))    return 'act-pos'
  if (a.endsWith('.finalised'))  return 'act-pos'
  if (a.endsWith('.reinstated')) return 'act-pos'
  if (a.endsWith('.deleted'))    return 'act-neg'
  if (a.endsWith('.withdrew'))   return 'act-neg'
  if (a.endsWith('.unfinalised')) return 'act-neg'
  return 'act-warn'
}

// Compose a one-line "what happened" for an activity row. The
// metadata jsonb's shape varies by action so a switch is
// clearer than a generic JSON.stringify.
function activitySummary(r) {
  if (!r) return ''
  const m = r.metadata || {}
  if (r.action === 'event.created') {
    const bits = []
    if (m.event_type) bits.push(m.event_type)
    if (m.height)     bits.push(m.height)
    if (m.total_rounds) bits.push(t('audit.activity.rounds_suffix', { n: m.total_rounds }))
    if (m.number_of_judges) bits.push(t('audit.activity.judge_panel_suffix', { n: m.number_of_judges }))
    return bits.join(' · ')
  }
  if (r.action === 'event.deleted') {
    return m.previous_status ? t('audit.activity.was_status', { status: m.previous_status }) : ''
  }
  if (r.action === 'event.started')      return t('audit.activity.transition_upcoming_live')
  if (r.action === 'event.finalised')    return t('audit.activity.transition_live_completed')
  if (r.action === 'event.unfinalised')  return t('audit.activity.transition_completed_live')
  if (r.action === 'event.status_changed') return `${m.from} → ${m.to}`
  if (r.action === 'org.status_changed')   return `${m.from} → ${m.to}`
  if (r.action === 'roster.late_entry_added') {
    return t('audit.activity.round_of_event', {
      round: m.round_number,
      event: m.event_name || t('audit.fallback_event'),
    })
  }
  if (r.action === 'roster.withdrew' || r.action === 'roster.reinstated') {
    return m.event_name || ''
  }
  if (r.action === 'club.deleted') {
    const n = m.unassigned_members
    if (!n) return ''
    return n === 1
      ? t('audit.activity.member_unassigned_one', { n })
      : t('audit.activity.member_unassigned_many', { n })
  }
  if (r.action === 'team.deleted') {
    return [m.members_unbound && t('audit.activity.members_count', { n: m.members_unbound }),
            m.events_detached && t('audit.activity.events_count', { n: m.events_detached }),
           ].filter(Boolean).join(' · ')
  }
  return ''
}

// ----- CSV export -----
function exportCsv(rows, kind) {
  if (!rows.length) return
  let header, body
  if (kind === 'score') {
    header = ['Time','Action','Event','Org','Round','Competitor','Judge','Old','New','Actor','Reason']
    body = rows.map(r => [
      r.created_at, r.action, r.event_name || '', r.org_name || '', r.round_number,
      r.competitor_name || '', r.judge_name || '', r.old_score ?? '', r.new_score ?? '',
      r.actor_name || '', r.reason || '',
    ])
  } else if (kind === 'role') {
    header = ['Time','Action','Role','Target','Org','Actor','Note']
    body = rows.map(r => [
      r.created_at, r.action, r.role, r.target_name || '',
      r.org_name || '', r.actor_name || '', r.note || '',
    ])
  } else if (kind === 'activity') {
    header = ['Time','Action','Entity','Name','Org','Actor','Detail','Metadata']
    body = rows.map(r => [
      r.created_at, r.action, r.entity_type, r.entity_name || '',
      r.org_name || '', r.actor_name || '',
      activitySummary(r),
      r.metadata ? JSON.stringify(r.metadata) : '',
    ])
  } else {
    // recent (mixed)
    header = ['Time','Kind','Action','Subject','Org','Actor','Detail']
    body = rows.map(r => {
      let subject = ''
      let detail  = ''
      if (r.kind === 'score') {
        subject = r.competitor_name || ''
        detail  = `${r.event_name || ''} · R${r.round_number} · ${r.old_score ?? ''}→${r.new_score ?? ''}${r.reason ? ` · ${r.reason}` : ''}`
      } else if (r.kind === 'role') {
        subject = r.target_name || ''
        detail  = `${r.role}${r.note ? ` · ${r.note}` : ''}`
      } else {
        // activity
        subject = r.entity_name || r.entity_type
        detail  = activitySummary(r)
      }
      return [r.created_at, r.kind, r.action, subject, r.org_name || '', r.actor_name || '', detail]
    })
  }
  const csv = [header, ...body]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit_${kind}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ----- Mount -----
onMounted(async () => {
  await loadOrgs()
  await loadRecent()
})
</script>

<template>
  <div class="audit-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('audit.page_label') }}</div>
        <h1 class="page-title">{{ $t('audit.page_title') }}</h1>
        <div class="page-sub">
          {{ isSysAdmin ? $t('audit.page_sub_all') : $t('audit.page_sub_org') }}
          <span class="page-sub-dim">{{ $t('audit.page_sub_retention') }}</span>
        </div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">{{ $t('audit.back_dashboard') }}</RouterLink>
    </div>

    <!-- Sysadmin org scope. Default 'all orgs' so a sysadmin's
         investigation starts wide; org admins don't see this
         control. -->
    <div v-if="isSysAdmin" class="org-scope">
      <span class="filter-label">{{ $t('audit.org_scope') }}</span>
      <select class="select select-sm" v-model="orgFilter">
        <option value="">{{ $t('audit.all_orgs') }}</option>
        <option v-for="o in orgs" :key="o.id" :value="o.id">
          {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }}
        </option>
      </select>
    </div>

    <!-- Tab strip -->
    <div class="tabs" role="tablist">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        :class="['tab', activeTab === tab.id ? 'tab-active' : '']"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >{{ $t(tab.labelKey) }}</button>
    </div>

    <!-- Recent activity -->
    <section v-if="activeTab === 'recent'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_last') }}</span>
          <select class="select select-sm" v-model.number="recentDays">
            <option :value="1">{{ $t('audit.window_1d') }}</option>
            <option :value="7">{{ $t('audit.window_7d') }}</option>
            <option :value="14">{{ $t('audit.window_14d') }}</option>
            <option :value="30">{{ $t('audit.window_30d') }}</option>
            <option :value="90">{{ $t('audit.window_90d') }}</option>
          </select>
        </div>
        <span class="result-count">{{ $t('audit.entries_count', { n: recentRows.length }) }}</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!recentRows.length"
                @click="exportCsv(recentRows, 'mixed')">
          {{ $t('audit.export_csv') }}
        </button>
      </div>

      <div v-if="recentBusy && !recentRows.length" class="empty">{{ $t('audit.loading') }}</div>
      <div v-else-if="!recentRows.length" class="empty">
        {{ $t('audit.empty_recent') }}
      </div>
      <div v-else class="table-wrap"><table class="audit-table">
        <thead>
          <tr>
            <th>{{ $t('audit.col_time') }}</th>
            <th>{{ $t('audit.col_action') }}</th>
            <th>{{ $t('audit.col_what') }}</th>
            <th v-if="isSysAdmin && !orgFilter">{{ $t('audit.col_org') }}</th>
            <th>{{ $t('audit.col_actor') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in recentRows" :key="`${r.kind}-${r.id}`">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td>
              <span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span>
              <span class="kind-pill" :class="`kind-${r.kind}`">
                {{ r.kind === 'score' ? $t('audit.kind_score') : r.kind === 'role' ? $t('audit.kind_role') : $t('audit.kind_activity') }}
              </span>
            </td>
            <td>
              <template v-if="r.kind === 'score'">
                <strong>{{ r.competitor_name || $t('audit.fallback_competitor') }}</strong>
                <span class="dim"> in </span>
                <RouterLink :to="`/events/${r.event_id}/audit`" class="event-link">
                  {{ r.event_name || $t('audit.fallback_event') }}
                </RouterLink>
                <span class="dim"> · R{{ r.round_number }}</span>
                <span v-if="r.old_score != null || r.new_score != null" class="score-shift">
                  {{ r.old_score ?? '—' }} <span class="arr">→</span> <strong>{{ r.new_score ?? '—' }}</strong>
                </span>
                <div v-if="r.reason" class="reason">"{{ r.reason }}"</div>
              </template>
              <template v-else-if="r.kind === 'role'">
                <strong>{{ r.role }}</strong>
                {{ r.action === 'granted' ? $t('audit.granted_to') : $t('audit.revoked_from') }}
                <strong>{{ r.target_name || $t('audit.fallback_user') }}</strong>
                <div v-if="r.note" class="reason">"{{ r.note }}"</div>
              </template>
              <template v-else>
                <!-- activity -->
                <strong>{{ r.entity_name || r.entity_type }}</strong>
                <span v-if="activitySummary(r)" class="dim"> — {{ activitySummary(r) }}</span>
              </template>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
          </tr>
        </tbody>
      </table></div>
    </section>

    <!-- Score corrections -->
    <section v-if="activeTab === 'scores'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_action') }}</span>
          <select class="select select-sm" v-model="scoreFilters.action">
            <option value="all">{{ $t('audit.filter_all') }}</option>
            <option value="insert">{{ $t('audit.action_submitted') }}</option>
            <option value="update">{{ $t('audit.action_edited') }}</option>
            <option value="delete">{{ $t('audit.action_deleted') }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_from') }}</span>
          <input type="date" class="input input-sm" v-model="scoreFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_to') }}</span>
          <input type="date" class="input input-sm" v-model="scoreFilters.to">
        </div>
        <div class="field-inline filter-search">
          <input type="text" class="input input-sm" v-model="scoreFilters.q"
                 :placeholder="$t('audit.search_reason_placeholder')"
                 @keyup.enter="applyScoreSearch">
          <button type="button" class="btn btn-ghost btn-sm" @click="applyScoreSearch">{{ $t('audit.search_button') }}</button>
        </div>
        <span class="result-count">{{ $t('audit.entries_count', { n: scoreRows.length }) }}</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!scoreRows.length"
                @click="exportCsv(scoreRows, 'score')">
          {{ $t('audit.export_csv') }}
        </button>
      </div>

      <div v-if="scoreBusy && !scoreRows.length" class="empty">{{ $t('audit.loading') }}</div>
      <div v-else-if="!scoreRows.length" class="empty">
        {{ $t('audit.empty_filtered') }}
      </div>
      <div v-else class="table-wrap"><table class="audit-table">
        <thead>
          <tr>
            <th>{{ $t('audit.col_time') }}</th>
            <th>{{ $t('audit.col_action') }}</th>
            <th>{{ $t('audit.col_event') }}</th>
            <th v-if="isSysAdmin && !orgFilter">{{ $t('audit.col_org') }}</th>
            <th>{{ $t('audit.col_round') }}</th>
            <th>{{ $t('audit.col_competitor') }}</th>
            <th>{{ $t('audit.col_judge') }}</th>
            <th>{{ $t('audit.col_old_new') }}</th>
            <th>{{ $t('audit.col_actor') }}</th>
            <th>{{ $t('audit.col_reason') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in scoreRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td>
              <RouterLink :to="`/events/${r.event_id}/audit`" class="event-link">
                {{ r.event_name || '—' }}
              </RouterLink>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">R{{ r.round_number }}</td>
            <td>{{ r.competitor_name || '—' }}</td>
            <td>
              <span v-if="r.judge_number" class="judge-num">J{{ r.judge_number }}</span>
              {{ r.judge_name || '—' }}
            </td>
            <td class="mono">
              <span class="old">{{ r.old_score ?? '—' }}</span>
              <span class="arr">→</span>
              <span class="new">{{ r.new_score ?? '—' }}</span>
            </td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
            <td class="reason-cell" v-tip="r.reason || ''">{{ r.reason || '—' }}</td>
          </tr>
        </tbody>
      </table></div>
      <div v-if="scoreHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="scoreBusy"
                @click="loadScores({ append: true })">
          {{ scoreBusy ? $t('audit.loading') : $t('audit.show_more', { n: PAGE }) }}
        </button>
      </div>
    </section>

    <!-- Role changes -->
    <section v-if="activeTab === 'roles'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_action') }}</span>
          <select class="select select-sm" v-model="roleFilters.action">
            <option value="all">{{ $t('audit.filter_all') }}</option>
            <option value="granted">{{ $t('audit.action_granted') }}</option>
            <option value="revoked">{{ $t('audit.action_revoked') }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_role') }}</span>
          <select class="select select-sm" v-model="roleFilters.role">
            <option value="all">{{ $t('audit.filter_all') }}</option>
            <option v-for="r in ORG_ROLES" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_from') }}</span>
          <input type="date" class="input input-sm" v-model="roleFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_to') }}</span>
          <input type="date" class="input input-sm" v-model="roleFilters.to">
        </div>
        <span class="result-count">{{ $t('audit.entries_count', { n: roleRows.length }) }}</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!roleRows.length"
                @click="exportCsv(roleRows, 'role')">
          {{ $t('audit.export_csv') }}
        </button>
      </div>

      <div v-if="roleBusy && !roleRows.length" class="empty">{{ $t('audit.loading') }}</div>
      <div v-else-if="!roleRows.length" class="empty">
        {{ $t('audit.empty_filtered') }}
      </div>
      <div v-else class="table-wrap"><table class="audit-table">
        <thead>
          <tr>
            <th>{{ $t('audit.col_time') }}</th>
            <th>{{ $t('audit.col_action') }}</th>
            <th>{{ $t('audit.col_role') }}</th>
            <th>{{ $t('audit.col_target') }}</th>
            <th v-if="isSysAdmin && !orgFilter">{{ $t('audit.col_org') }}</th>
            <th>{{ $t('audit.col_actor') }}</th>
            <th>{{ $t('audit.col_note') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in roleRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td class="mono">{{ r.role }}</td>
            <td>
              {{ r.target_name || '—' }}
              <span v-if="r.target_username" class="dim mono"> · {{ r.target_username }}</span>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
            <td class="reason-cell" v-tip="r.note || ''">{{ r.note || '—' }}</td>
          </tr>
        </tbody>
      </table></div>
      <div v-if="roleHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="roleBusy"
                @click="loadRoles({ append: true })">
          {{ roleBusy ? $t('audit.loading') : $t('audit.show_more', { n: PAGE }) }}
        </button>
      </div>
    </section>

    <!-- Event & admin actions -->
    <section v-if="activeTab === 'activity'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_domain') }}</span>
          <select class="select select-sm" v-model="activityFilters.action_prefix">
            <option v-for="p in ACTIVITY_PREFIXES" :key="p.value" :value="p.value">{{ $t(p.labelKey) }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_from') }}</span>
          <input type="date" class="input input-sm" v-model="activityFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">{{ $t('audit.filter_to') }}</span>
          <input type="date" class="input input-sm" v-model="activityFilters.to">
        </div>
        <span class="result-count">{{ $t('audit.entries_count', { n: activityRows.length }) }}</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!activityRows.length"
                @click="exportCsv(activityRows, 'activity')">
          {{ $t('audit.export_csv') }}
        </button>
      </div>

      <div v-if="activityBusy && !activityRows.length" class="empty">{{ $t('audit.loading') }}</div>
      <div v-else-if="!activityRows.length" class="empty">
        {{ $t('audit.empty_filtered') }}
      </div>
      <div v-else class="table-wrap"><table class="audit-table">
        <thead>
          <tr>
            <th>{{ $t('audit.col_time') }}</th>
            <th>{{ $t('audit.col_action') }}</th>
            <th>{{ $t('audit.col_subject') }}</th>
            <th>{{ $t('audit.col_detail') }}</th>
            <th v-if="isSysAdmin && !orgFilter">{{ $t('audit.col_org') }}</th>
            <th>{{ $t('audit.col_actor') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in activityRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td>
              <strong>{{ r.entity_name || '—' }}</strong>
              <span class="dim"> · {{ r.entity_type }}</span>
            </td>
            <td class="reason-cell" v-tip="activitySummary(r)">{{ activitySummary(r) || '—' }}</td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
          </tr>
        </tbody>
      </table></div>
      <div v-if="activityHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="activityBusy"
                @click="loadActivity({ append: true })">
          {{ activityBusy ? $t('audit.loading') : $t('audit.show_more', { n: PAGE }) }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.audit-wrap { max-width: 1300px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
/* Back-to-dashboard is redundant inside the app shell sidebar. */
.page-header .btn { display: none; }
.page-label {
  font-family: var(--font-sans); font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--cyan); margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-sans); font-size: var(--text-h1); font-weight: 600;
  font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.2;
}
.page-sub {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text-3); margin-top: 0.4rem;
  max-width: 640px;
}
.page-sub-dim { opacity: 0.7; }

.org-scope {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 1rem;
}

.tabs {
  display: flex; align-items: center; gap: 1.25rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent; border: 0;
  padding: 0.6rem 0.25rem;
  font-family: var(--font-sans); font-size: 13.5px; font-weight: 500;
  letter-spacing: 0; text-transform: none;
  color: var(--fg-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s;
}
.tab:hover { color: var(--fg); }
.tab-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.filters {
  display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap;
  padding: 0.875rem 1rem; margin-bottom: 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.field-inline { display: flex; align-items: center; gap: 0.4rem; }
.filter-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.select-sm { padding: 0.3rem 0.5rem; font-size: 12px; min-width: 110px; }
.input-sm { padding: 0.3rem 0.5rem; font-size: 12px; min-width: 130px; }
/* iOS Safari auto-zooms whenever an <input> or <select> with
   font-size < 16px receives focus. That's especially jarring
   here because the date-range filters are tapped frequently
   when investigating an audit trail on a phone. Bump to 16px
   at phone widths only — desktop keeps the compact 12px. */
@media (max-width: 720px) {
  .select-sm, .input-sm { font-size: 16px; }
}
.filter-search {
  flex: 1 1 220px; min-width: 0;
  max-width: 360px;
}
.filter-search .input-sm { flex: 1; min-width: 0; }
.result-count {
  margin-inline-start: auto;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.empty {
  color: var(--text-3); padding: 3rem 0; text-align: center;
  font-family: var(--font-mono); font-size: 13px;
}

.audit-table {
  width: 100%; border-collapse: collapse;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.audit-table th, .audit-table td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  text-align: start; font-size: 13px; vertical-align: middle;
}
.audit-table th {
  font-family: var(--font-sans); font-size: var(--text-label); font-weight: 600;
  letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--fg-3);
  background: var(--bg-2);
}
.audit-table tbody tr:hover { background: var(--bg-2); }
.audit-table tbody tr:last-child td { border-bottom: none; }

.mono  { font-family: var(--font-mono); }
.dim   { color: var(--text-3); }

.action-pill {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-3);
  white-space: nowrap;
}
.action-pill.act-pos  { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.action-pill.act-warn { color: var(--amber); border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }
.action-pill.act-neg  { color: var(--red);   border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.08); }

.kind-pill {
  font-family: var(--font-mono); font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.05em;
  margin-inline-start: 0.4rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: var(--bg);
  color: var(--text-3);
  border: 1px solid var(--border);
}
.kind-score    { color: var(--cyan); border-color: rgba(6,182,212,0.4); }
.kind-role     { color: #a78bfa;     border-color: rgba(167,139,250,0.4); }
.kind-activity { color: var(--amber); border-color: rgba(245,158,11,0.4); }

.judge-num {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--cyan); border: 1px solid rgba(6,182,212,0.3);
  background: var(--cyan-dim); padding: 0.1rem 0.35rem; border-radius: 3px;
  margin-inline-end: 0.4rem;
}
.event-link {
  color: var(--cyan); text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: border-color 0.12s;
}
.event-link:hover { border-bottom-color: var(--cyan); }

.score-shift {
  font-family: var(--font-mono);
  margin-inline-start: 0.5rem;
  color: var(--text-3);
}
.old { color: var(--text-3); }
.new { color: var(--text); font-weight: 700; }
.arr { color: var(--text-3); margin: 0 0.4rem; }
.reason {
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--fg-2);
  font-style: normal;
  margin-top: 0.2rem;
  max-width: 520px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.reason-cell {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text-3);
  max-width: 280px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.more-row {
  display: flex; justify-content: center;
  margin-top: 0.85rem;
}
</style>
