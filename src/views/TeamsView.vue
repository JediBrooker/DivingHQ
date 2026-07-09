<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import { fmtDate } from '@/lib/format'

const auth = useAuthStore()

// Team list state
const teams = ref([])
const orgs = ref([])
const orgDivers = ref([])
const loading = ref(false)
const errorMsg = ref('')

// Filters
const searchTerm = ref('')
const orgFilter  = ref('')          // system admin only

// Create form
const creating = ref(false)
const createOrgId = ref('')
const createName  = ref('')
const createCode  = ref('')
const createBusy  = ref(false)

// Inline rename
const editing = ref(null)            // { id, name, short_code }
const editBusy = ref(false)

// Member drawer
const drawerTeam = ref(null)         // team object
// Lock background scroll while the team drawer's open.
useBodyScrollLock().lockWhile(computed(() => drawerTeam.value !== null))
const drawerMembers = ref([])
const drawerEvents = ref([])         // events the team is in
const drawerBusy = ref(false)
const memberToAdd = ref('')

const isSysAdmin = computed(() => !!auth.user?.is_system_admin)

const teamOrgs = computed(() => {
  // For system admin, derive the orgs from the team list. For
  // regular admin it's just the user's own org.
  if (!isSysAdmin.value) return []
  const seen = new Map()
  for (const t of teams.value) {
    if (!seen.has(t.org_id)) seen.set(t.org_id, { id: t.org_id, name: t.org_name })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
})

const filteredTeams = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return teams.value.filter(t => {
    if (orgFilter.value && t.org_id !== orgFilter.value) return false
    if (!term) return true
    return (
      (t.name || '').toLowerCase().includes(term) ||
      (t.short_code || '').toLowerCase().includes(term) ||
      (t.org_name || '').toLowerCase().includes(term)
    )
  })
})

const stats = computed(() => ({
  teams: teams.value.length,
  members: teams.value.reduce((a, t) => a + (t.member_count || 0), 0),
  empty: teams.value.filter(t => !t.member_count).length,
}))

async function loadTeams() {
  loading.value = true
  errorMsg.value = ''
  try {
    if (isSysAdmin.value) {
      // Fetch teams across all orgs by hitting each org's endpoint
      // (no global teams listing yet, this is wired off of org).
      const allOrgs = await auth.apiFetch('/api/orgs/active')
      const lists = await Promise.all(
        (Array.isArray(allOrgs) ? allOrgs : []).map(o =>
          auth.apiFetch(`/api/orgs/${o.id}/teams`).then(rows =>
            rows.map(t => ({ ...t, org_id: o.id, org_name: o.name, country_code: o.country_code })),
          ).catch(() => []),
        ),
      )
      teams.value = lists.flat()
    } else {
      const rows = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/teams`)
      teams.value = rows.map(t => ({ ...t, org_id: auth.user.org_id }))
    }
  } catch (err) {
    errorMsg.value = err.message
    teams.value = []
  } finally {
    loading.value = false
  }
}

async function loadOrgs() {
  if (!isSysAdmin.value) return
  try {
    const body = await auth.apiFetch('/api/orgs/active')
    orgs.value = Array.isArray(body) ? body : []
  } catch { orgs.value = [] }
}

async function loadOrgDivers(orgId) {
  if (!orgId) { orgDivers.value = []; return }
  try {
    const body = await auth.apiFetch(`/api/orgs/${orgId}/divers`)
    orgDivers.value = Array.isArray(body) ? body : []
  } catch { orgDivers.value = [] }
}

function openCreate() {
  creating.value = true
  createOrgId.value = isSysAdmin.value ? '' : (auth.user?.org_id || '')
  createName.value = ''
  createCode.value = ''
}
function cancelCreate() { creating.value = false }

async function submitCreate() {
  const targetOrgId = isSysAdmin.value ? createOrgId.value : auth.user?.org_id
  if (!targetOrgId || !createName.value.trim()) return
  createBusy.value = true
  try {
    await auth.apiFetch(`/api/orgs/${targetOrgId}/teams`, {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value.trim(),
        short_code: createCode.value.trim() || null,
      }),
    })
    creating.value = false
    await loadTeams()
  } catch (err) {
    showError(err.message)
  } finally {
    createBusy.value = false
  }
}

function openEdit(team) {
  editing.value = { id: team.id, name: team.name, short_code: team.short_code || '' }
}
function cancelEdit() { editing.value = null }

async function submitEdit() {
  if (!editing.value || !editing.value.name.trim()) return
  editBusy.value = true
  try {
    await auth.apiFetch(`/api/teams/${editing.value.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editing.value.name.trim(),
        short_code: editing.value.short_code.trim() || null,
      }),
    })
    editing.value = null
    await loadTeams()
  } catch (err) {
    showError(err.message)
  } finally {
    editBusy.value = false
  }
}

async function deleteTeam(team) {
  const consequences = []
  if (team.member_count) {
    consequences.push(
      `${team.member_count} member${team.member_count === 1 ? ' will be' : 's will be'} unassigned (their user accounts stay)`,
    )
  }
  consequences.push(
    'Historical dive list rows lose their team attribution',
    'Per-dive results, scores, and the audit log are preserved',
  )
  if (!await confirmAction({
    title: `Delete team "${team.name}"?`,
    body:  team.member_count
      ? `${team.member_count} member${team.member_count === 1 ? ' is' : 's are'} currently in this team.`
      : 'No active members in this team.',
    consequences,
    confirmLabel: 'Delete team',
    confirmKind:  'danger',
  })) return
  try {
    const res = await auth.apiFetch(`/api/teams/${team.id}`, { method: 'DELETE' })
    await loadTeams()
    showSuccess(`Deleted team "${team.name}"`)
    if (res.dives) {
      console.info(`[Teams] Deleted ${team.name} — ${res.members} members detached, ${res.dives} historical dives unbound, ${res.events} event entries removed.`)
    }
  } catch (err) {
    showError(err.message)
  }
}

async function openMembers(team) {
  drawerTeam.value = team
  drawerMembers.value = []
  drawerEvents.value = []
  drawerBusy.value = true
  memberToAdd.value = ''
  try {
    const [members, events] = await Promise.all([
      auth.apiFetch(`/api/teams/${team.id}/members`),
      auth.apiFetch(`/api/teams/${team.id}/events`),
      loadOrgDivers(team.org_id),
    ])
    drawerMembers.value = members
    drawerEvents.value = events
  } catch (err) {
    drawerMembers.value = []
    drawerEvents.value = []
  } finally {
    drawerBusy.value = false
  }
}

function closeMembers() {
  drawerTeam.value = null
  drawerMembers.value = []
  drawerEvents.value = []
  orgDivers.value = []
}

function fmtEventStatus(s) {
  if (s === 'Completed') return 'completed'
  if (s === 'Live')      return 'live'
  return 'upcoming'
}

const addableDivers = computed(() => {
  const have = new Set(drawerMembers.value.map(m => m.id))
  return orgDivers.value.filter(d => !have.has(d.id))
})

async function addMember() {
  if (!memberToAdd.value || !drawerTeam.value) return
  drawerBusy.value = true
  try {
    await auth.apiFetch(`/api/teams/${drawerTeam.value.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: memberToAdd.value }),
    })
    const refreshed = await auth.apiFetch(`/api/teams/${drawerTeam.value.id}/members`)
    drawerMembers.value = refreshed
    // reflect the new count in the table list
    const t = teams.value.find(x => x.id === drawerTeam.value.id)
    if (t) t.member_count = refreshed.length
    memberToAdd.value = ''
  } catch (err) {
    showError(err.message)
  } finally {
    drawerBusy.value = false
  }
}

async function removeMember(memberId) {
  if (!drawerTeam.value) return
  if (!await confirmAction({
    title: 'Remove diver from team?',
    body:  'The diver\'s account stays — only their team membership is removed.',
    confirmLabel: 'Remove from team',
    confirmKind:  'warn',
  })) return
  drawerBusy.value = true
  try {
    await auth.apiFetch(`/api/teams/${drawerTeam.value.id}/members/${memberId}`, {
      method: 'DELETE',
    })
    drawerMembers.value = drawerMembers.value.filter(m => m.id !== memberId)
    const t = teams.value.find(x => x.id === drawerTeam.value.id)
    if (t) t.member_count = drawerMembers.value.length
  } catch (err) {
    showError(err.message)
  } finally {
    drawerBusy.value = false
  }
}

// fmtDate imported from @/lib/format, single source of truth.

function onKeyDown(e) {
  if (e.key === 'Escape' && drawerTeam.value) closeMembers()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  await Promise.all([loadTeams(), loadOrgs()])
})

watch(() => drawerTeam.value, (val) => {
  if (!val) return
  // Loading already kicked off in openMembers; nothing extra here.
})
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">{{ $t('teams.title') }}</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">{{ $t('common.dashboard') }}</RouterLink>
  </div>

  <div class="main">
    <!-- Stats strip -->
    <div class="stats-strip">
      <div class="stat">
        <div class="stat-num">{{ stats.teams.toLocaleString() }}</div>
        <div class="stat-label">Teams</div>
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

    <!-- Toolbar -->
    <div class="toolbar">
      <input class="input" type="text" v-model="searchTerm" placeholder="Search teams by name, code, org…">
      <select v-if="isSysAdmin" class="select" v-model="orgFilter">
        <option value="">All organisations ({{ teamOrgs.length }})</option>
        <option v-for="o in teamOrgs" :key="o.id" :value="o.id">{{ o.name }}</option>
      </select>
      <span class="result-count">{{ filteredTeams.length.toLocaleString() }} of {{ teams.length.toLocaleString() }}</span>
      <button class="btn btn-primary btn-sm" @click="openCreate">{{ $t('teams.new_team') }}</button>
    </div>

    <!-- Inline create -->
    <div v-if="creating" class="create-block">
      <div class="create-head">Create a new team</div>
      <div class="create-fields">
        <div v-if="isSysAdmin" class="field">
          <label class="label">Organisation</label>
          <select class="select" v-model="createOrgId" required>
            <option value="">— Select organisation —</option>
            <option v-for="o in orgs" :key="o.id" :value="o.id">
              {{ o.name }}{{ o.country_code ? ' (' + o.country_code + ')' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="label">Team name</label>
          <input class="input" type="text" v-model="createName" placeholder="e.g. USA Team Alpha" required>
        </div>
        <div class="field">
          <label class="label">Short code (optional)</label>
          <input class="input" type="text" v-model="createCode" placeholder="e.g. USA-A" maxlength="20">
        </div>
      </div>
      <div class="create-actions">
        <button class="btn btn-ghost btn-sm" @click="cancelCreate">Cancel</button>
        <button class="btn btn-primary btn-sm"
                :disabled="createBusy || !createName.trim() || (isSysAdmin && !createOrgId)"
                @click="submitCreate">
          {{ createBusy ? 'Creating…' : 'Create team' }}
        </button>
      </div>
    </div>

    <!-- Teams table -->
    <div class="card" style="padding:0;overflow:hidden">
      <div class="table-wrap"><table class="data-table">
        <thead>
          <tr>
            <th>{{ $t('teams.col_name') }}</th>
            <th>Code</th>
            <th v-if="isSysAdmin">Organisation</th>
            <th class="num-col">{{ $t('teams.col_members') }}</th>
            <th>Created</th>
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
          <tr v-else-if="!filteredTeams.length && !teams.length">
            <td :colspan="isSysAdmin ? 6 : 5">
              <div class="empty-state-card">
                <div class="empty-state-icon">🏊‍♀️</div>
                <div class="empty-state-title">No teams yet</div>
                <div class="empty-state-body">
                  Teams sit alongside clubs as a separate grouping for
                  <strong>World Aquatics Team Event</strong> entries — multiple members
                  share a team and dive across rounds together. A diver can
                  belong to several teams over time. Click
                  <strong>+ New Team</strong> above to add your first one.
                </div>
              </div>
            </td>
          </tr>
          <tr v-else-if="!filteredTeams.length">
            <td :colspan="isSysAdmin ? 6 : 5" class="empty-state">
              No teams match the current filter.
            </td>
          </tr>
          <template v-for="t in filteredTeams" :key="t.id">
            <tr v-if="editing?.id !== t.id" class="team-row">
              <td><span class="team-name">{{ t.name }}</span></td>
              <td>
                <span v-if="t.short_code" class="team-code">{{ t.short_code }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td v-if="isSysAdmin" class="dim">{{ t.org_name || '—' }}</td>
              <td class="num-col">
                <span v-if="t.member_count" class="member-count">{{ t.member_count }}</span>
                <span v-else class="empty-pill">empty</span>
              </td>
              <td class="dim">{{ fmtDate(t.created_at) }}</td>
              <td class="actions-col">
                <button class="btn btn-ghost btn-sm" @click="openMembers(t)">Members</button>
                <button class="btn btn-ghost btn-sm" @click="openEdit(t)">Rename</button>
                <button class="btn btn-danger btn-sm" @click="deleteTeam(t)">Delete</button>
              </td>
            </tr>
            <tr v-else class="team-row team-row-editing">
              <td>
                <input class="input input-sm" type="text" v-model="editing.name"
                       placeholder="Team name" autofocus>
              </td>
              <td>
                <input class="input input-sm" type="text" v-model="editing.short_code"
                       placeholder="Code" maxlength="20" style="max-width:90px">
              </td>
              <td v-if="isSysAdmin" class="dim">{{ t.org_name || '—' }}</td>
              <td class="num-col dim">{{ t.member_count }}</td>
              <td class="dim">{{ fmtDate(t.created_at) }}</td>
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

  <!-- Member-management drawer -->
  <Transition name="drawer">
    <div v-if="drawerTeam" class="drawer-backdrop" @click="closeMembers"></div>
  </Transition>
  <Transition name="drawer-panel">
    <aside v-if="drawerTeam" class="drawer">
      <div class="drawer-head">
        <div class="drawer-id">
          <div class="drawer-name">{{ drawerTeam.name }}</div>
          <div class="drawer-meta">
            <span v-if="drawerTeam.short_code" class="team-code">{{ drawerTeam.short_code }}</span>
            <span v-if="drawerTeam.org_name" style="margin-inline-start:0.4rem">{{ drawerTeam.org_name }}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="closeMembers">Close ✕</button>
      </div>

      <div class="drawer-body">
        <!-- Events the team is in, links to per-event dive list editor -->
        <div class="drawer-section-label">Events ({{ drawerEvents.length }})</div>
        <ul v-if="drawerEvents.length" class="event-list">
          <li v-for="e in drawerEvents" :key="e.id" class="event-list-row">
            <div class="event-list-name">
              {{ e.name }}
              <span :class="['event-list-status', `status-${fmtEventStatus(e.status)}`]">{{ e.status }}</span>
            </div>
            <RouterLink :to="`/teams/${drawerTeam.id}/events/${e.id}/dive-list`"
                        class="btn btn-ghost btn-sm">
              Edit dive list
            </RouterLink>
          </li>
        </ul>
        <div v-else class="audit-empty">
          This team isn't entered in any event yet.
        </div>

        <div class="drawer-section-label" style="margin-top:1.25rem">Members ({{ drawerMembers.length }})</div>

        <div v-if="drawerBusy && !drawerMembers.length" class="audit-empty">Loading…</div>
        <ul v-else-if="drawerMembers.length" class="member-list">
          <li v-for="m in drawerMembers" :key="m.id" class="member-row">
            <span class="member-name">{{ m.full_name }}</span>
            <span class="member-username">@{{ m.username }}</span>
            <button class="btn btn-danger btn-sm" :disabled="drawerBusy"
                    @click="removeMember(m.id)">Remove</button>
          </li>
        </ul>
        <div v-else class="audit-empty">No members yet — add divers below.</div>

        <div class="drawer-section-label" style="margin-top:1.25rem">Add a Member</div>
        <div class="add-member-row">
          <select class="select" v-model="memberToAdd">
            <option value="">— Select a diver —</option>
            <option v-for="d in addableDivers" :key="d.id" :value="d.id">
              {{ d.full_name }}{{ d.club_code ? ' (' + d.club_code + ')' : '' }}
            </option>
          </select>
          <button class="btn btn-primary btn-sm"
                  :disabled="!memberToAdd || drawerBusy"
                  @click="addMember">Add</button>
        </div>
        <p v-if="!addableDivers.length" class="hint">
          No more divers available in this org — every diver in the org is already in this team, or the org has no other divers.
        </p>

        <div class="drawer-hint">
          Press <kbd>Esc</kbd> or click outside to close.
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
/* Title is redundant with the shell breadcrumb, so hidden. */
.page-header { display: none; }
.page-header .btn { display: none; }
.page-title { font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; }
.main { max-width: 1400px; margin: 0 auto; padding: 1.5rem 2rem; display: flex; flex-direction: column; gap: 1.25rem; }

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

.toolbar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.toolbar .input  { flex: 1 1 280px; max-width: 400px; }
.toolbar .select { flex: 0 1 240px; max-width: 280px; }
.result-count { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-inline-start: auto; }

.create-block {
  padding: 1rem 1.25rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-lg);
  background: var(--cyan-dim);
  display: flex; flex-direction: column; gap: 0.75rem;
}
.create-head { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan); }
.create-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
.create-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }

.team-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text); }
.team-code {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.15rem 0.5rem;
}
.dim { color: var(--text-3); }
.num-col { text-align: end; width: 110px; }
.actions-col { text-align: end; width: 280px; white-space: nowrap; }
.actions-col .btn + .btn { margin-inline-start: 0.4rem; }
.team-row-editing { background: var(--cyan-dim); }
.input-sm { padding: 0.3rem 0.5rem; font-size: 13px; }
/* Avoid iOS Safari's focus-zoom on <input> with font-size < 16px. */
@media (max-width: 720px) {
  .input-sm { font-size: 16px; }
}

.event-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.event-list-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.event-list-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-list-status {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  margin-inline-start: 0.4rem; padding: 0.1rem 0.4rem; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-3); background: var(--bg-2);
}
.event-list-status.status-live { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.event-list-status.status-completed { color: var(--text-3); }
.event-list-status.status-upcoming { color: var(--amber); border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }

.member-count { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text); }
.empty-pill { font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--text-3); font-style: italic; }
.empty-state { color: var(--text-3); font-size: 12px; padding: 1.5rem 0; text-align: center; }
.audit-empty { color: var(--text-3); font-family: var(--font-mono); font-size: 11px; padding: 0.75rem 0; font-style: italic; }

.sys-badge {
  display: inline-block;
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--bg); background: var(--cyan);
  padding: 0.15rem 0.5rem; border-radius: 3px;
  vertical-align: middle;
}

/* Drawer (mirrors UserManagerView's drawer) */
.drawer-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(3, 7, 18, 0.55);
  -webkit-backdrop-filter: blur(2px);  /* iOS Safari */
  backdrop-filter: blur(2px);
}
.drawer {
  position: fixed; top: 0; inset-inline-end: 0; bottom: 0; z-index: 100;
  width: min(440px, 100vw);
  display: flex; flex-direction: column;
  background: var(--surface); border-inline-start: 1px solid var(--border);
  box-shadow: -10px 0 30px rgba(0,0,0,0.35);
}
.drawer-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.75rem; padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--border);
}
.drawer-id { min-width: 0; }
.drawer-name { font-family: var(--font-sans); font-size: 22px; font-weight: 600; font-style: normal; letter-spacing: -0.01em; color: var(--fg); line-height: 1.1; }
.drawer-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.4rem; }
/* `overflow-x: clip` stops CSS's promote-to-auto from making
   the body silently horizontally scrollable. Bottom padding
   keeps content above iOS Safari's URL/toolbar, since the
   drawer extends to `bottom: 0` but the toolbar overlays the
   viewport bottom. */
.drawer-body {
  padding: 1rem 1.25rem max(1rem, env(safe-area-inset-bottom, 1rem) + 4rem);
  overflow-y: auto;
  overflow-x: clip;
}
.drawer-section-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3); margin-bottom: 0.5rem; }

.member-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.member-row {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.member-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); flex: 1; }
.member-username { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }

.add-member-row { display: flex; gap: 0.5rem; align-items: center; }
.add-member-row .select { flex: 1; }
.hint { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.4rem; }

.drawer-hint {
  margin-top: 1rem; padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.drawer-hint kbd {
  font-family: var(--font-mono); font-size: 10px;
  padding: 0.1rem 0.35rem; border-radius: 3px;
  background: var(--bg-2); border: 1px solid var(--border); color: var(--text-2);
}

.drawer-enter-active, .drawer-leave-active { transition: opacity 0.15s; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-panel-enter-active, .drawer-panel-leave-active { transition: transform 0.18s ease-out; }
.drawer-panel-enter-from, .drawer-panel-leave-to { transform: translateX(100%); }
</style>
