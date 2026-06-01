<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import { fmtDate } from '@/lib/format'

const auth = useAuthStore()

const clubs = ref([])
const orgs = ref([])               // active orgs — system admin uses these for cross-org create
const loading = ref(false)
const errorMsg = ref('')

// Filter state
const searchTerm = ref('')
const orgFilter  = ref('')         // system admin only

// Create form state
const creating = ref(false)
const createOrgId = ref('')        // system admin picks; org_admin uses own org
const createName  = ref('')
const createCode  = ref('')
const createBusy  = ref(false)

// Inline rename state — keyed by club id while editing
const editing = ref(null)          // { id, name, short_code }
const editBusy = ref(false)

const isSysAdmin = computed(() => !!auth.user?.is_system_admin)

const clubOrgs = computed(() => {
  const seen = new Map()
  for (const c of clubs.value) {
    if (!seen.has(c.org_id)) {
      seen.set(c.org_id, { id: c.org_id, name: c.org_name, country_code: c.country_code })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
})

const filteredClubs = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return clubs.value.filter(c => {
    if (orgFilter.value && c.org_id !== orgFilter.value) return false
    if (!term) return true
    return (
      (c.name || '').toLowerCase().includes(term) ||
      (c.short_code || '').toLowerCase().includes(term) ||
      (c.org_name || '').toLowerCase().includes(term) ||
      (c.country_code || '').toLowerCase().includes(term)
    )
  })
})

const stats = computed(() => ({
  clubs: clubs.value.length,
  members: clubs.value.reduce((a, c) => a + (c.member_count || 0), 0),
  empty: clubs.value.filter(c => !c.member_count).length,
}))

async function loadClubs() {
  loading.value = true
  errorMsg.value = ''
  try {
    clubs.value = await auth.apiFetch('/api/clubs')
  } catch (err) {
    errorMsg.value = err.message
    clubs.value = []
  } finally {
    loading.value = false
  }
}

async function loadOrgs() {
  if (!isSysAdmin.value) return
  try {
    const body = await auth.apiFetch('/api/orgs/active')
    orgs.value = Array.isArray(body) ? body : []
  } catch {
    orgs.value = []
  }
}

function openCreate() {
  creating.value = true
  createOrgId.value = isSysAdmin.value ? '' : (auth.user?.org_id || '')
  createName.value = ''
  createCode.value = ''
}

function cancelCreate() {
  creating.value = false
}

async function submitCreate() {
  const targetOrgId = isSysAdmin.value ? createOrgId.value : auth.user?.org_id
  if (!targetOrgId || !createName.value.trim()) return
  createBusy.value = true
  try {
    await auth.apiFetch(`/api/orgs/${targetOrgId}/clubs`, {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value.trim(),
        short_code: createCode.value.trim() || null,
      }),
    })
    creating.value = false
    await loadClubs()
  } catch (err) {
    showError(err.message)
  } finally {
    createBusy.value = false
  }
}

function openEdit(club) {
  editing.value = { id: club.id, name: club.name, short_code: club.short_code || '' }
}
function cancelEdit() { editing.value = null }

async function submitEdit() {
  if (!editing.value || !editing.value.name.trim()) return
  editBusy.value = true
  try {
    await auth.apiFetch(`/api/clubs/${editing.value.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editing.value.name.trim(),
        short_code: editing.value.short_code.trim() || null,
      }),
    })
    editing.value = null
    await loadClubs()
  } catch (err) {
    showError(err.message)
  } finally {
    editBusy.value = false
  }
}

async function deleteClub(club) {
  const consequences = []
  if (club.member_count) {
    consequences.push(
      `${club.member_count} member${club.member_count === 1 ? ' will be' : 's will be'} unassigned (their accounts stay)`,
    )
  }
  consequences.push('Historical scoreboard and recap views still show the club name on existing dives')
  if (!await confirmAction({
    title: `Delete club "${club.name}"?`,
    body:  club.member_count
      ? `${club.member_count} member${club.member_count === 1 ? ' is' : 's are'} currently in this club.`
      : 'No active members in this club.',
    consequences,
    confirmLabel: 'Delete club',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/clubs/${club.id}`, { method: 'DELETE' })
    await loadClubs()
    showSuccess(`Deleted "${club.name}"`)
  } catch (err) {
    showError(err.message)
  }
}

// fmtDate imported from @/lib/format — single source of truth.

onMounted(async () => {
  await Promise.all([loadClubs(), loadOrgs()])
})
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">{{ $t('clubs.title') }}</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">{{ $t('common.dashboard') }}</RouterLink>
  </div>

  <div class="main">
    <!-- Stats strip -->
    <div class="stats-strip">
      <div class="stat">
        <div class="stat-num">{{ stats.clubs.toLocaleString() }}</div>
        <div class="stat-label">Clubs</div>
      </div>
      <div class="stat">
        <div class="stat-num">{{ stats.members.toLocaleString() }}</div>
        <div class="stat-label">Members</div>
      </div>
      <div :class="['stat', stats.empty ? 'stat-amber' : '']">
        <div class="stat-num">{{ stats.empty }}</div>
        <div class="stat-label">Empty</div>
      </div>
      <span v-if="isSysAdmin" class="sys-badge" style="margin-inline-start:auto">System Admin · all orgs</span>
    </div>

    <!-- Filters + create -->
    <div class="toolbar">
      <input class="input" type="text" v-model="searchTerm" :placeholder="$t('clubs.search')">
      <select v-if="isSysAdmin" class="select" v-model="orgFilter">
        <option value="">All organisations ({{ clubOrgs.length }})</option>
        <option v-for="o in clubOrgs" :key="o.id" :value="o.id">
          {{ o.name }}{{ o.country_code ? ' · ' + o.country_code : '' }}
        </option>
      </select>
      <span class="result-count">
        {{ filteredClubs.length.toLocaleString() }} of {{ clubs.length.toLocaleString() }}
      </span>
      <button class="btn btn-primary btn-sm" @click="openCreate">{{ $t('clubs.new_club') }}</button>
    </div>

    <!-- Inline create form -->
    <div v-if="creating" class="create-block">
      <div class="create-head">Create a new club</div>
      <div class="create-fields">
        <div v-if="isSysAdmin" class="field">
          <label class="label">Organisation</label>
          <select class="select" v-model="createOrgId" required>
            <option value="">— Select an organisation —</option>
            <option v-for="o in orgs" :key="o.id" :value="o.id">
              {{ o.name }}{{ o.country_code ? ' (' + o.country_code + ')' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="label">Club name</label>
          <input class="input" type="text" v-model="createName"
                 placeholder="e.g. Sydney Springboard" required>
        </div>
        <div class="field">
          <label class="label">Short code (optional)</label>
          <input class="input" type="text" v-model="createCode"
                 placeholder="e.g. SYD" maxlength="20">
        </div>
      </div>
      <div class="create-actions">
        <button class="btn btn-ghost btn-sm" @click="cancelCreate">Cancel</button>
        <button class="btn btn-primary btn-sm"
                :disabled="createBusy || !createName.trim() || (isSysAdmin && !createOrgId)"
                @click="submitCreate">
          {{ createBusy ? 'Creating…' : 'Create club' }}
        </button>
      </div>
    </div>

    <!-- Clubs table -->
    <div class="card" style="padding:0;overflow:hidden">
      <div class="table-wrap"><table class="data-table">
        <thead>
          <tr>
            <th>{{ $t('clubs.col_name') }}</th>
            <th>{{ $t('clubs.col_code') }}</th>
            <th v-if="isSysAdmin">Organisation</th>
            <th class="num-col">{{ $t('clubs.col_members') }}</th>
            <th>{{ $t('clubs.col_created') }}</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td :colspan="isSysAdmin ? 6 : 5" class="empty-state">Loading…</td>
          </tr>
          <tr v-else-if="errorMsg">
            <td :colspan="isSysAdmin ? 6 : 5" class="empty-state">{{ errorMsg }}</td>
          </tr>
          <tr v-else-if="!filteredClubs.length && !clubs.length">
            <td :colspan="isSysAdmin ? 6 : 5">
              <div class="empty-state-card">
                <div class="empty-state-icon">🏢</div>
                <div class="empty-state-title">No clubs yet</div>
                <div class="empty-state-body">
                  Clubs are the local groupings under your federation. They
                  surface as the cyan short-code pill on the scoreboard
                  ("NZL-1", "AUS-3", etc.) — useful when an event has divers
                  from multiple clubs. Click <strong>+ New Club</strong> above
                  to add your first one.
                </div>
              </div>
            </td>
          </tr>
          <tr v-else-if="!filteredClubs.length">
            <td :colspan="isSysAdmin ? 6 : 5" class="empty-state">
              No clubs match the current filter.
            </td>
          </tr>
          <template v-for="c in filteredClubs" :key="c.id">
            <!-- Display row -->
            <tr v-if="editing?.id !== c.id" class="club-row">
              <td><span class="club-name">{{ c.name }}</span></td>
              <td>
                <span v-if="c.short_code" class="club-code">{{ c.short_code }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td v-if="isSysAdmin" class="org-cell">
                <span class="org-name">{{ c.org_name }}</span>
                <span v-if="c.country_code" class="org-country">{{ c.country_code }}</span>
              </td>
              <td class="num-col">
                <span v-if="c.member_count" class="member-count">{{ c.member_count }}</span>
                <span v-else class="empty-pill">empty</span>
              </td>
              <td class="dim">{{ fmtDate(c.created_at) }}</td>
              <td class="actions-col">
                <button class="btn btn-ghost btn-sm" @click="openEdit(c)">Rename</button>
                <button class="btn btn-danger btn-sm" @click="deleteClub(c)">Delete</button>
              </td>
            </tr>
            <!-- Edit row -->
            <tr v-else class="club-row club-row-editing">
              <td>
                <input class="input input-sm" type="text" v-model="editing.name"
                       placeholder="Club name" autofocus>
              </td>
              <td>
                <input class="input input-sm" type="text" v-model="editing.short_code"
                       placeholder="Code" maxlength="20" style="max-width:90px">
              </td>
              <td v-if="isSysAdmin" class="dim">{{ c.org_name }}</td>
              <td class="num-col dim">{{ c.member_count }}</td>
              <td class="dim">{{ fmtDate(c.created_at) }}</td>
              <td class="actions-col">
                <button class="btn btn-ghost btn-sm" @click="cancelEdit">Cancel</button>
                <button class="btn btn-primary btn-sm"
                        :disabled="editBusy || !editing.name.trim()"
                        @click="submitEdit">
                  {{ editBusy ? 'Saving…' : 'Save' }}
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table></div>
    </div>
  </div>
</template>

<style scoped>
/* Title is redundant with the shell breadcrumb — hidden. */
.page-header { display: none; }
/* Back-to-dashboard is redundant inside the app shell sidebar. */
.page-header .btn { display: none; }
.page-title { font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; }
.main {
  max-width: 1400px; margin: 0 auto; padding: 1.5rem 2rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}

/* Stats strip — mirrors the User Manager pattern */
.stats-strip {
  display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
  padding: 1rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.stat { min-width: 70px; }
.stat-num { font-family: var(--font-mono); font-size: 24px; font-weight: 500; font-style: normal; color: var(--fg); line-height: 1; }
.stat-amber .stat-num { color: var(--amber); }
.stat-label { font-family: var(--font-display); font-size: 9px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-top: 0.25rem; }

.toolbar {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
}
.toolbar .input  { flex: 1 1 280px; max-width: 400px; }
.toolbar .select { flex: 0 1 240px; max-width: 280px; }
.result-count {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-inline-start: auto;
}

.create-block {
  padding: 1rem 1.25rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-lg);
  background: var(--cyan-dim);
  display: flex; flex-direction: column; gap: 0.75rem;
}
.create-head {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan);
}
.create-fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.75rem;
}
.create-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }

.club-name {
  font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text);
}
.club-code {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.15rem 0.5rem;
}
.dim { color: var(--text-3); }
.num-col { text-align: end; width: 110px; }
.actions-col { text-align: end; width: 200px; white-space: nowrap; }
.actions-col .btn + .btn { margin-inline-start: 0.4rem; }

.member-count {
  font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text);
}
.empty-pill {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--text-3); font-style: italic;
}
.empty-state { color: var(--text-3); font-size: 12px; padding: 1.5rem 0; text-align: center; }

.org-cell { white-space: nowrap; }
.org-name { font-family: var(--font-display); font-size: 13px; font-weight: 600; color: var(--text-2); }
.org-country {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}

.club-row-editing { background: var(--cyan-dim); }
.input-sm { padding: 0.3rem 0.5rem; font-size: 13px; }
/* Avoid iOS Safari's focus-zoom on <input> with font-size < 16px. */
@media (max-width: 720px) {
  .input-sm { font-size: 16px; }
}

.sys-badge {
  display: inline-block;
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--bg); background: var(--cyan);
  padding: 0.15rem 0.5rem; border-radius: 3px;
  vertical-align: middle;
}
</style>
