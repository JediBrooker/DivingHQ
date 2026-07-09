<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()
const { t } = useI18n()

const eventId = computed(() => route.params.id)
const eventInfo = ref(null)
const entries = ref([])
const loading = ref(false)
const error = ref('')

// Filters
const filterCompetitor = ref('')
const filterJudge = ref('')
const filterAction = ref('all')

const filtered = computed(() => {
  return entries.value.filter(e => {
    if (filterCompetitor.value && e.competitor_id !== filterCompetitor.value) return false
    if (filterJudge.value && e.judge_id !== filterJudge.value) return false
    if (filterAction.value !== 'all' && e.action !== filterAction.value) return false
    return true
  })
})

// Distinct competitors / judges so the filters can populate their dropdowns
const competitors = computed(() => {
  const seen = new Map()
  for (const e of entries.value) {
    if (!seen.has(e.competitor_id)) seen.set(e.competitor_id, e.competitor_name)
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
})

const judges = computed(() => {
  const seen = new Map()
  for (const e of entries.value) {
    if (!seen.has(e.judge_id)) seen.set(e.judge_id, { name: e.judge_name, num: e.judge_number })
  }
  return [...seen.entries()].map(([id, v]) => ({ id, name: v.name, num: v.num })).sort((a, b) => (a.num || 99) - (b.num || 99))
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [audit, events] = await Promise.all([
      auth.apiFetch(`/api/events/${eventId.value}/score-audit`),
      auth.apiFetch('/api/events'),
    ])
    entries.value = audit
    eventInfo.value = events.find(e => e.id === eventId.value) || null
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function actionLabel(a) {
  if (a === 'insert') return 'Submitted'
  if (a === 'update') return 'Edited'
  if (a === 'delete') return 'Deleted'
  return a
}

function actionClass(a) {
  if (a === 'insert') return 'act-insert'
  if (a === 'update') return 'act-update'
  if (a === 'delete') return 'act-delete'
  return ''
}

function exportCsv() {
  const rows = [
    ['Time', 'Action', 'Competitor', 'Judge', 'Judge #', 'Round', 'Old Score', 'New Score', 'Actor', 'IP', 'User Agent'],
    ...filtered.value.map(e => [
      e.created_at,
      e.action,
      e.competitor_name || '',
      e.judge_name || '',
      e.judge_number ?? '',
      e.round_number,
      e.old_score ?? '',
      e.new_score ?? '',
      e.actor_name || '',
      e.ip_address || '',
      (e.user_agent || '').replace(/[\r\n,]/g, ' '),
    ]),
  ]
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit_${eventInfo.value?.name?.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'event'}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>

<template>
  <div class="audit-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('score_audit.title') }}</div>
        <h1 class="page-title">{{ eventInfo?.name || 'Event' }}</h1>
        <div class="page-tagline">{{ $t('score_audit.subtitle') }}</div>
        <div v-if="eventInfo" class="page-sub">
          {{ eventInfo.gender }} · {{ eventInfo.height || '—' }} · {{ eventInfo.total_rounds }} rounds
        </div>
      </div>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-ghost btn-sm" @click="exportCsv" :disabled="!filtered.length">Export CSV</button>
        <RouterLink to="/manager" class="btn btn-ghost btn-sm">← Manager</RouterLink>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <div class="field-inline">
        <label class="filter-label">Competitor</label>
        <select v-model="filterCompetitor" class="select select-sm">
          <option value="">All</option>
          <option v-for="c in competitors" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="field-inline">
        <label class="filter-label">Judge</label>
        <select v-model="filterJudge" class="select select-sm">
          <option value="">All</option>
          <option v-for="j in judges" :key="j.id" :value="j.id">
            {{ j.num ? `J${j.num} — ` : '' }}{{ j.name }}
          </option>
        </select>
      </div>
      <div class="field-inline">
        <label class="filter-label">Action</label>
        <select v-model="filterAction" class="select select-sm">
          <option value="all">All</option>
          <option value="insert">Submitted</option>
          <option value="update">Edited</option>
          <option value="delete">Deleted</option>
        </select>
      </div>
      <div class="result-count">
        Showing {{ filtered.length }} of {{ entries.length }} entries
      </div>
    </div>

    <div v-if="loading" class="empty">Loading audit log…</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="!entries.length" class="empty">
      No audit entries yet. Entries are created automatically as scores are submitted.
    </div>
    <div v-else class="table-wrap"><table class="audit-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Competitor</th>
          <th>Round</th>
          <th>Judge</th>
          <th>Old → New</th>
          <th>Actor</th>
          <th>IP</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in filtered" :key="e.id">
          <td class="mono dim">{{ fmtTime(e.created_at) }}</td>
          <td>
            <span :class="['action-pill', actionClass(e.action)]">{{ actionLabel(e.action) }}</span>
          </td>
          <td>{{ e.competitor_name }}</td>
          <td class="mono">R{{ e.round_number }}</td>
          <td>
            <span class="judge-num" v-if="e.judge_number">J{{ e.judge_number }}</span>
            {{ e.judge_name }}
          </td>
          <td class="mono">
            <span v-if="e.old_score != null" class="old">{{ Number(e.old_score).toFixed(1) }}</span>
            <span v-else class="dim">—</span>
            <span class="arr">→</span>
            <span v-if="e.new_score != null" class="new">{{ Number(e.new_score).toFixed(1) }}</span>
            <span v-else class="dim">—</span>
          </td>
          <td class="dim">{{ e.actor_name || '—' }}</td>
          <td class="mono dim" v-tip="e.user_agent || ''">{{ e.ip_address || '—' }}</td>
        </tr>
      </tbody>
    </table></div>
  </div>
</template>

<style scoped>
.audit-wrap { max-width: 1300px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 32px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.4rem; }

.filters {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  padding: 0.875rem 1rem; margin-bottom: 1rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.field-inline { display: flex; align-items: center; gap: 0.5rem; }
.filter-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }
.select-sm { padding: 0.3rem 0.5rem; font-size: 12px; min-width: 120px; }
/* iOS Safari zooms in on focus for any <select> under 16px font-size, avoid that here */
@media (max-width: 720px) {
  .select-sm { font-size: 16px; }
}
.result-count { margin-inline-start: auto; font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.audit-table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.audit-table th, .audit-table td {
  padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border);
  text-align: start; font-size: 13px; vertical-align: middle;
}
.audit-table th {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  background: var(--bg-2);
}
.audit-table tbody tr:hover { background: var(--bg-2); }
.audit-table tbody tr:last-child td { border-bottom: none; }

.mono { font-family: var(--font-mono); }
.dim  { color: var(--text-3); }

.action-pill {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-3);
}
.action-pill.act-insert { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.action-pill.act-update { color: var(--amber); border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }
.action-pill.act-delete { color: var(--red);   border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.08); }

.judge-num {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--cyan); border: 1px solid rgba(6,182,212,0.3);
  background: var(--cyan-dim); padding: 0.1rem 0.35rem; border-radius: 3px;
  margin-inline-end: 0.4rem;
}
.old { color: var(--text-3); }
.new { color: var(--text); font-weight: 700; }
.arr { color: var(--text-3); margin: 0 0.4rem; }
</style>
