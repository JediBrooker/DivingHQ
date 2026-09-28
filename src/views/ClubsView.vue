<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'

const { t } = useI18n()
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import { fmtDate } from '@/lib/format'
import AdminRosterModal from '@/components/AdminRosterModal.vue'
import ClubApproveModal from '@/components/ClubApproveModal.vue'
import ClubRejectModal from '@/components/ClubRejectModal.vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { usePlural } from '@/composables/usePlural'

const auth = useAuthStore()
const { tn } = usePlural()

const clubs = ref([])
const orgs = ref([])               // active orgs, system admin uses these for cross-org create
const loading = ref(false)
const errorMsg = ref('')

// filter state
const searchTerm = ref('')
const orgFilter  = ref('')         // system admin only

// create form state
const creating = ref(false)
const createOrgId = ref('')        // system admin picks, org_admin just uses their own org
const createName  = ref('')
const createCode  = ref('')
const createBusy  = ref(false)

// Inline rename state, keyed by club id while editing
const editing = ref(null)          // { id, name, short_code }
const editBusy = ref(false)

// Club whose admins dialog is open, null when it's closed.
const adminsFor = ref(null)
const regionAdminsFor = ref(null)
// Pending club being approved / rejected (migration 096).
const approving = ref(null)
const rejecting = ref(null)
useBodyScrollLock().lockWhile(computed(() =>
  !!adminsFor.value || !!regionAdminsFor.value || !!approving.value || !!rejecting.value))

const isSysAdmin = computed(() => !!auth.user?.is_system_admin)
// Only the federation admin configures club fees. Meet managers can view
// the roster + who's paid but not the billing setup.
const isOrgAdmin = computed(() => (auth.user?.org_roles || []).includes('org_admin'))
// Affiliation / accreditation are paid through Stripe. With payments
// switched off nobody can have paid, so the column read as every club
// being in arrears. Hide it (and the note pointing at hidden pages).
const features = useFeaturesStore()
const billingOn = computed(() => features.enabled('payments'))
// Who decides clubs that signed up under the federation. The server only
// sends pending rows to these two anyway.
const canDecide = computed(() => isSysAdmin.value || isOrgAdmin.value)
// Full-width rows (loading, empty, errors) span however many columns
// are actually showing.
const tableCols = computed(() =>
  5 + (isSysAdmin.value ? 1 : 0) + (regions.value.regions.length ? 1 : 0) + (billingOn.value ? 1 : 0))

const clubOrgs = computed(() => {
  const seen = new Map()
  for (const c of clubs.value) {
    if (!seen.has(c.org_id)) {
      seen.set(c.org_id, { id: c.org_id, name: c.org_name, country_code: c.country_code })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
})

// The registry proper is approved clubs. Ones still waiting on the
// federation get their own panel above the table and stay out of it and
// out of the counts, so an unvetted signup can't be renamed, deleted or
// handed admins from the table by mistake.
const activeClubs = computed(() => clubs.value.filter(c => c.status !== 'pending'))
const pendingClubs = computed(() => clubs.value
  .filter(c => c.status === 'pending' && (!orgFilter.value || c.org_id === orgFilter.value))
  .sort((a, b) => +new Date(a.submitted_at || a.created_at) - +new Date(b.submitted_at || b.created_at)))

// Founders often don't know their club is already here, so point out an
// approved club in the same org with the same code or much the same name.
// Accents, case and punctuation don't count; a name inside the other one
// does, once it's long enough not to match everything.
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
}
function lookalike(p) {
  const n = normName(p.name)
  const code = (p.short_code || '').toUpperCase()
  return activeClubs.value.find((c) => {
    if (c.org_id !== p.org_id) return false
    if (code && (c.short_code || '').toUpperCase() === code) return true
    const m = normName(c.name)
    if (m === n) return true
    return n.length >= 5 && m.length >= 5 && (m.includes(n) || n.includes(m))
  }) || null
}
const lookalikes = computed(() => new Map(pendingClubs.value.map(p => [p.id, lookalike(p)])))

// Where a rejected club's members can go: approved clubs in its org.
function rejectCandidates(p) {
  return activeClubs.value
    .filter(c => c.org_id === p.org_id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function onApproved(out) {
  const name = out?.name || approving.value?.name
  approving.value = null
  await Promise.all([loadClubs(), loadRegions()])
  showSuccess(t('clubs.approved_toast', { club: name }))
}

async function onRejected() {
  const name = rejecting.value?.name
  rejecting.value = null
  await loadClubs()
  showSuccess(t('clubs.rejected_toast', { club: name }))
}

const filteredClubs = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return activeClubs.value.filter(c => {
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
  clubs: activeClubs.value.length,
  members: activeClubs.value.reduce((a, c) => a + (c.member_count || 0), 0),
  empty: activeClubs.value.filter(c => !c.member_count).length,
  pending: clubs.value.length - activeClubs.value.length,
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

// fmtDate imported from @/lib/format, single source of truth for this.

// Regions (states, provinces, home nations; migration 088) for one org at
// a time: your own, or, for a sysadmin, the org picked in the filter.
const regionOrgId = computed(() =>
  isSysAdmin.value ? (orgFilter.value || null) : (auth.user?.org_id || null))
const regions = ref({ label: null, regions: [], catalogue: false })
const regionsBusy = ref(false)
const canManageRegions = computed(() => isSysAdmin.value || isOrgAdmin.value)
// Only offer "Set up regions" where it can work: the seed route refuses
// any country lib/regions.json has no list for (most of them, today).
const showRegionsPanel = computed(() =>
  canManageRegions.value && !!regionOrgId.value && (regions.value.regions.length > 0 || regions.value.catalogue))

// The column is headed with what this org calls them (State, Province...).
const regionColLabel = computed(() => t(`regions.label.${regions.value.label || 'region'}`))

// Everyone who sees the Region column gets the club's region in it, not
// just the admins who get a picker.
const regionById = computed(() => new Map(regions.value.regions.map(r => [r.id, r])))

// A sysadmin flicking through the org filter fires one load per org; only
// the latest may land, or the per-club selects end up offering another
// org's regions (and saving one 400s).
let regionsReq = 0

async function loadRegions() {
  const req = ++regionsReq
  const orgId = regionOrgId.value
  // Only blank the list when the org changes. A refresh for new club
  // counts keeps showing the column instead of blinking it away.
  if (regions.value.orgId !== orgId) regions.value = { label: null, regions: [], catalogue: false }
  if (!orgId) return
  try {
    const body = await auth.apiFetch(`/api/orgs/${orgId}/regions`)
    if (req === regionsReq) regions.value = { ...body, orgId }
  } catch { /* none */ }
}

// Opt in to the built-in list for this country. A federation isn't
// given regions until it asks, it may run without them.
async function seedRegions() {
  regionsBusy.value = true
  try {
    const r = await auth.apiFetch(`/api/orgs/${regionOrgId.value}/regions/seed`, { method: 'POST' })
    await loadRegions()
    showSuccess(tn('counts.regions_added', r.added))
  } catch (err) {
    showError(err.message)
  } finally {
    regionsBusy.value = false
  }
}

async function setClubRegion(club, regionId) {
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/region`, {
      method: 'PUT',
      body: JSON.stringify({ region_id: regionId || null }),
    })
    club.region_id = regionId || null
    await loadRegions()   // club counts
  } catch (err) {
    showError(err.message)
  }
}

// "New clubs from signup": wait for approval, or join automatically.
// Only a claimed org has the choice (an unclaimed country approves
// nothing), so it shows once the settings say claimed. Same org as the
// regions strip: your own, or the one a sysadmin picked in the filter.
const clubSettings = ref(null)
const settingBusy = ref(false)
let settingsReq = 0
const showClubSetting = computed(() => canDecide.value && clubSettings.value?.claim_state === 'claimed')

async function loadClubSettings() {
  const req = ++settingsReq
  clubSettings.value = null
  const orgId = regionOrgId.value
  if (!orgId || !canDecide.value) return
  try {
    const body = await auth.apiFetch(`/api/orgs/${orgId}/club-settings`)
    if (req === settingsReq) clubSettings.value = body
  } catch { /* leave the control hidden */ }
}

async function setAutoApprove(value) {
  settingBusy.value = true
  try {
    clubSettings.value = await auth.apiFetch(`/api/orgs/${regionOrgId.value}/club-settings`, {
      method: 'PUT',
      body: JSON.stringify({ auto_approve_clubs: value }),
    })
    showSuccess(t(value ? 'clubs.setting_auto_saved' : 'clubs.setting_approval_saved'))
  } catch (err) {
    showError(err.message)
  } finally {
    settingBusy.value = false
  }
}

watch(regionOrgId, () => { loadRegions(); loadClubSettings() })

onMounted(async () => {
  await Promise.all([loadClubs(), loadOrgs(), loadRegions(), loadClubSettings()])
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
      <div v-if="canDecide" :class="['stat', stats.pending ? 'stat-amber' : '']" data-testid="clubs-stat-pending">
        <div class="stat-num">{{ stats.pending }}</div>
        <div class="stat-label">{{ $t('clubs.stat_pending') }}</div>
      </div>
      <span v-if="isSysAdmin" class="sys-badge" style="margin-inline-start:auto">System Admin · all orgs</span>
    </div>

    <!-- Club billing (affiliation + accreditation) -->
    <p v-if="isOrgAdmin && billingOn" class="billing-note">
      Set your clubs’ affiliation and accreditation prices in Payments →
      Fees &amp; pricing. Club admins pay from their club’s Classes → Payouts
      page; the Billing column below shows who’s paid.
    </p>

    <!-- Regions: states / provinces / home nations for one org. -->
    <div v-if="showRegionsPanel" class="regions-panel">
      <template v-if="regions.regions.length">
        <span class="regions-head">{{ $t('regions.strip_title') }}</span>
        <button v-for="r in regions.regions" :key="r.id" class="region-chip" type="button"
                v-tip="$t('regions.manage_admins', { name: r.name })" @click="regionAdminsFor = r">
          {{ r.short_code }} <span class="region-count">{{ r.club_count }}</span>
        </button>
      </template>
      <template v-else>
        <span class="regions-empty">{{ $t('regions.none_set_up') }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="regionsBusy" @click="seedRegions">{{ $t('regions.set_up') }}</button>
      </template>
    </div>

    <!-- New clubs from signup: the federation approves them, or lets them
         straight in (migration 096). -->
    <div v-if="showClubSetting" class="club-setting">
      <label class="setting-label" for="club-join-setting">{{ $t('clubs.setting_label') }}</label>
      <select id="club-join-setting" class="select select-sm"
              :value="clubSettings.auto_approve_clubs ? 'auto' : 'approval'" :disabled="settingBusy"
              @change="setAutoApprove($event.target.value === 'auto')">
        <option value="approval">{{ $t('clubs.setting_approval') }}</option>
        <option value="auto">{{ $t('clubs.setting_auto') }}</option>
      </select>
      <span class="setting-hint">
        {{ clubSettings.auto_approve_clubs ? $t('clubs.setting_auto_hint') : $t('clubs.setting_approval_hint') }}
      </span>
    </div>

    <!-- Clubs that signed up under the federation and are waiting on it.
         Only the org admin and the sysadmin get these rows. -->
    <section v-if="canDecide && pendingClubs.length" class="pending-panel" data-testid="pending-clubs">
      <div class="pending-head">
        {{ $t('clubs.pending_title') }} <span class="pending-count">{{ pendingClubs.length }}</span>
      </div>
      <p class="pending-intro">{{ $t('clubs.pending_intro') }}</p>
      <ul class="pending-list">
        <li v-for="p in pendingClubs" :key="p.id" class="pending-row" :data-club-id="p.id">
          <div class="pending-main">
            <div class="pending-name">
              <span class="club-name">{{ p.name }}</span>
              <span v-if="p.short_code" class="club-code">{{ p.short_code }}</span>
              <span v-if="regionById.get(p.region_id)" class="dim">{{ regionById.get(p.region_id).name }}</span>
              <span v-if="isSysAdmin" class="org-country">{{ p.org_name }}</span>
            </div>
            <div class="pending-meta">
              <span v-if="p.founder_name">
                {{ $t('clubs.pending_started_by', { name: p.founder_name }) }}<template v-if="p.founder_username"> · @{{ p.founder_username }}</template><template v-if="p.founder_email"> · {{ p.founder_email }}</template>
              </span>
              <span v-if="p.founder_email_verified" class="verified-pill">{{ $t('clubs.email_verified') }}</span>
              <span>{{ $t('clubs.pending_waiting_since', { date: fmtDate(p.submitted_at || p.created_at) }) }}</span>
            </div>
            <div v-if="lookalikes.get(p.id)" class="pending-similar">
              {{ $t('clubs.pending_similar', { club: lookalikes.get(p.id).name }) }}
            </div>
          </div>
          <div class="pending-actions">
            <button class="btn btn-ghost btn-sm" type="button" @click="rejecting = p">{{ $t('clubs.reject') }}</button>
            <button class="btn btn-primary btn-sm" type="button" @click="approving = p">{{ $t('clubs.approve') }}</button>
          </div>
        </li>
      </ul>
    </section>

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
        {{ filteredClubs.length.toLocaleString() }} of {{ activeClubs.length.toLocaleString() }}
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
            <th v-if="regions.regions.length">{{ regionColLabel }}</th>
            <th class="num-col">{{ $t('clubs.col_members') }}</th>
            <th v-if="billingOn" class="affil-head">{{ $t('clubs.col_billing') }}</th>
            <th>{{ $t('clubs.col_created') }}</th>
            <th class="actions-col">{{ $t('clubs.col_actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td :colspan="tableCols" class="empty-state">Loading…</td>
          </tr>
          <tr v-else-if="errorMsg">
            <td :colspan="tableCols" class="empty-state">{{ errorMsg }}</td>
          </tr>
          <tr v-else-if="!filteredClubs.length && !activeClubs.length">
            <td :colspan="tableCols">
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
            <td :colspan="tableCols" class="empty-state">
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
              <td v-if="regions.regions.length">
                <select v-if="canManageRegions && c.org_id === regionOrgId" class="select select-sm"
                        :value="c.region_id || ''" @change="setClubRegion(c, $event.target.value)"
                        :aria-label="$t('regions.region_for', { club: c.name })">
                  <option value="">—</option>
                  <option v-for="r in regions.regions" :key="r.id" :value="r.id">{{ r.short_code }}</option>
                </select>
                <span v-else-if="regionById.get(c.region_id)" class="club-code"
                      v-tip="regionById.get(c.region_id).name">{{ regionById.get(c.region_id).short_code }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="num-col">
                <span v-if="c.member_count" class="member-count">{{ c.member_count }}</span>
                <span v-else class="empty-pill">empty</span>
              </td>
              <td v-if="billingOn" class="affil-cell">
                <span class="affil-pill" :class="c.affiliation_active ? 'on' : 'off'"
                      v-tip="'Annual affiliation'">Affil {{ c.affiliation_active ? '✓' : '—' }}</span>
                <span class="affil-pill" :class="c.accreditation_active ? 'on' : 'off'"
                      v-tip="'Accreditation'">Accred {{ c.accreditation_active ? '✓' : '—' }}</span>
              </td>
              <td class="dim">{{ fmtDate(c.created_at) }}</td>
              <td class="actions-col">
                <button v-if="isOrgAdmin || isSysAdmin" class="btn btn-ghost btn-sm"
                        @click="adminsFor = c">{{ $t('clubs.admins_button') }}</button>
                <button class="btn btn-ghost btn-sm" @click="openEdit(c)">{{ $t('clubs.rename') }}</button>
                <button class="btn btn-danger btn-sm" @click="deleteClub(c)">{{ $t('common.delete') }}</button>
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
              <td v-if="regions.regions.length" class="dim">—</td>
              <td class="num-col dim">{{ c.member_count }}</td>
              <td v-if="billingOn" class="dim">—</td>
              <td class="dim">{{ fmtDate(c.created_at) }}</td>
              <td class="actions-col">
                <button class="btn btn-ghost btn-sm" @click="cancelEdit">{{ $t('common.cancel') }}</button>
                <button class="btn btn-primary btn-sm"
                        :disabled="editBusy || !editing.name.trim()"
                        @click="submitEdit">
                  {{ editBusy ? $t('common.saving') : $t('common.save') }}
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table></div>
    </div>
  </div>

  <AdminRosterModal v-if="adminsFor" kind="club" :target="adminsFor" @close="adminsFor = null" />
  <AdminRosterModal v-if="regionAdminsFor" kind="region" :target="regionAdminsFor" @close="regionAdminsFor = null" />
  <ClubApproveModal v-if="approving" :club="approving" @close="approving = null" @done="onApproved" />
  <ClubRejectModal v-if="rejecting" :club="rejecting" :candidates="rejectCandidates(rejecting)"
                   :suggested="lookalikes.get(rejecting.id)?.id || ''"
                   @close="rejecting = null" @done="onRejected" />
</template>

<style scoped>
.billing-note { margin: 0; padding: .6rem .85rem; border-radius: .5rem; background: var(--accent-soft, #eef); color: var(--fg-2, #555); font-size: .9rem; }
/* Title is redundant with the shell breadcrumb, so hide it. */
.page-header { display: none; }
/* Back-to-dashboard is redundant inside the app shell sidebar */
.page-header .btn { display: none; }
.page-title { font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; }
.main {
  max-width: 1400px; margin: 0 auto; padding: 1.5rem 2rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}

/* Stats strip, mirrors the User Manager pattern */
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
.actions-col { text-align: end; width: 260px; white-space: nowrap; }
.actions-col .btn + .btn { margin-inline-start: 0.4rem; }

.member-count {
  font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text);
}
.empty-pill {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--text-3); font-style: italic;
}
.empty-state { color: var(--text-3); font-size: 12px; padding: 1.5rem 0; text-align: center; }

/* Affiliation / accreditation billing status pills */
.affil-head { width: 170px; }
.affil-cell { white-space: nowrap; }

/* Regions strip */
.regions-panel {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  padding: 0.6rem 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface);
}
.regions-head { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-inline-end: 0.25rem; }
.regions-empty { font-size: 13px; color: var(--fg-3); }
.region-chip {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700; color: var(--fg-2);
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: 0.2rem 0.6rem; cursor: pointer;
}
.region-chip:hover { border-color: var(--accent); color: var(--accent); }
.region-count { font-weight: 400; color: var(--text-3); margin-inline-start: 0.2rem; }
.select-sm { padding: 0.25rem 0.4rem; font-size: 12px; min-width: 70px; }
.affil-pill {
  display: inline-block; font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.04em; border-radius: 3px; padding: 0.12rem 0.4rem;
  border: 1px solid var(--border); color: var(--text-3); background: var(--bg-2);
}
.affil-pill + .affil-pill { margin-inline-start: 0.3rem; }
.affil-pill.on {
  color: var(--green); border-color: var(--green); background: var(--cyan-dim);
}

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

/* New clubs from signup setting */
.club-setting {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.6rem 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface);
}
.setting-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }
.setting-hint { font-size: 12px; color: var(--text-3); flex: 1 1 220px; }
.club-setting .select-sm { width: auto; flex: 0 1 240px; min-width: 180px; }

/* Clubs waiting for approval */
.pending-panel {
  padding: 1rem 1.25rem;
  border: 1px solid var(--amber); border-radius: var(--radius-lg);
  background: var(--surface);
  display: flex; flex-direction: column; gap: 0.6rem;
}
.pending-head {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--amber);
}
.pending-count { font-family: var(--font-mono); margin-inline-start: 0.35rem; }
.pending-intro { margin: 0; font-size: 13px; color: var(--text-3); }
.pending-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.pending-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;
  padding: 0.65rem 0.85rem; background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.pending-main { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; flex: 1 1 280px; }
.pending-name { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.pending-meta { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; font-size: 12px; color: var(--text-3); overflow-wrap: anywhere; }
.pending-similar { font-size: 12px; font-weight: 600; color: var(--amber); }
.pending-actions { display: flex; gap: 0.4rem; }
.verified-pill {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700; color: var(--green);
  border: 1px solid var(--green); border-radius: 3px; padding: 0.05rem 0.35rem;
}
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
