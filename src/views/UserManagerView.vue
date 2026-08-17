<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'

const { t } = useI18n()
const auth = useAuthStore()

const requests = ref([])
const clubRequests = ref([])     // club-change / org-transfer requests
const pendingOrgs = ref([])      // federations awaiting approval (system admin only)
const allUsers = ref([])

// View state
const activeTab = ref('members')      // 'members' | 'requests'
const searchTerm = ref('')
const orgFilter = ref('')              // org_id (system admin only)
const roleFilters = ref(new Set())     // OR-combined role chips
const userRoles = ref({})              // { userId: Set<role> }
const currentPage = ref(1)
const PAGE_SIZE = 50

// Per-row save state machine: 'dirty' | 'saving' | 'saved' | 'error'
const rowState = ref({})
const saveTimers = {}                  // userId → debounce handle

// Bulk selection
const selectedIds = ref(new Set())
const bulkRole = ref('judge')
const bulkBusy = ref(false)
const bulkSummary = ref('')            // last operation result, shown briefly

// Group by org (system admin only), collapsible org sections in
// place of the flat paged list
const groupByOrg = ref(false)
const collapsedOrgs = ref(new Set())

// Primary roles drive the stats strip and the role-filter chips
// (filtering by "spectator" is useless because everyone has it).
const PRIMARY_ROLES = ['org_admin', 'meet_manager', 'referee', 'judge', 'coach', 'diver']
// Full role set is editable inside the per-user drawer and
// rendered as a pill in the table summary.
const ALL_ROLES = [...PRIMARY_ROLES, 'spectator']

// Visual ordering: primary roles by responsibility, spectator last
const ROLE_ORDER = { org_admin: 0, meet_manager: 1, referee: 2, judge: 3, coach: 4, diver: 5, spectator: 6 }

// Per-user edit drawer
const drawerUserId = ref(null)
// Lock background scroll while the user drawer is open.
useBodyScrollLock().lockWhile(computed(() => drawerUserId.value !== null))
const drawerUser = computed(() =>
  drawerUserId.value
    ? allUsers.value.find(u => u.id === drawerUserId.value) || null
    : null
)

const isSysAdmin = computed(() => !!auth.user?.is_system_admin)

const orgs = computed(() => {
  const seen = new Map()
  for (const u of allUsers.value) {
    if (!u.org_id) continue
    if (!seen.has(u.org_id)) {
      seen.set(u.org_id, {
        id: u.org_id,
        name: u.org_name || '—',
        country_code: u.country_code || '',
      })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
})

// Top-of-page stats, meant to give an instant sense of scale and
// where to look. We deliberately don't count spectator: everyone
// has it, so a "1,012 spectators" pill is just total membership restated.
// Pending club-change / org-transfer requests, used by both the
// Requests tab list and folded into the pending badge count.
const pendingClubRequests = computed(() =>
  clubRequests.value.filter(r => r.status === 'pending'),
)

const stats = computed(() => {
  const counts = {
    total: allUsers.value.length,
    pending: requests.value.length + pendingClubRequests.value.length + pendingOrgs.value.length,
  }
  PRIMARY_ROLES.forEach(r => { counts[r] = 0 })
  for (const u of allUsers.value) {
    for (const r of (u.org_roles || [])) {
      if (counts[r] != null) counts[r]++
    }
  }
  return counts
})

// Roles a user holds, sorted for display as pills
function userPills(userId) {
  const set = userRoles.value[userId]
  if (!set) return []
  return [...set].sort((a, b) => (ROLE_ORDER[a] ?? 99) - (ROLE_ORDER[b] ?? 99))
}

// Per-user role audit log loaded lazily when the drawer opens.
const auditEntries = ref([])
const auditLoading = ref(false)

// Personal & competition details (drawer-scoped). Seeded from
// drawerUser when the drawer opens; saved as one PUT.
const drawerFullName = ref('')
const drawerDob = ref('')               // YYYY-MM-DD or ''
const drawerGender = ref('')
const drawerNationality = ref('')
const drawerProfileSaving = ref(false)
const drawerProfileStatus = ref('')     // 'saved' | 'error' | ''

// Account lifecycle (drawer-scoped). One in-flight guard across
// suspend / reactivate / resend-verification / reset-password.
const drawerAccountBusy = ref(false)

// Club editor state (drawer-scoped)
const drawerClubs = ref([])             // clubs in target user's org
const drawerClubChoice = ref('')        // selected club_id or '' (none)
const drawerClubSaving = ref(false)
const drawerClubStatus = ref('')        // 'saved' | 'error' | ''
const drawerCreatingClub = ref(false)   // toggles inline new-club form
const drawerNewClubName = ref('')
const drawerNewClubCode = ref('')

// Coach-link state (drawer-scoped). The User Manager admin
// manages coach ↔ diver links from this drawer; the section
// shows every link involving the open user (whether they're the
// coach or the diver) and lets the admin add or remove links.
const drawerCoachLinks = ref([])        // links in this user's org
const drawerOrgUsers = ref([])          // candidates for the "other side" picker
const drawerLinkOtherId = ref('')       // selected partner user
const drawerLinkRole = ref('coach')     // 'coach' | 'diver', which side this user plays
const drawerLinkNote  = ref('')
const drawerLinkSaving = ref(false)
const drawerLinkError  = ref('')

// Filter the org's full link list down to those involving the
// open user. Lets us reuse the org-level GET endpoint without a
// per-user backend round trip.
const drawerLinks = computed(() => {
  if (!drawerUserId.value) return []
  return drawerCoachLinks.value.filter(
    l => l.coach_id === drawerUserId.value || l.diver_id === drawerUserId.value,
  )
})

// Shorthand: which role does the open user have inside a given
// link? Lets the template render "as Coach of …" vs "as Diver of …"
// without exposing column names.
function linkSideForUser(link) {
  if (!drawerUserId.value) return ''
  return link.coach_id === drawerUserId.value ? 'coach' : 'diver'
}
function linkOtherName(link) {
  if (!drawerUserId.value) return ''
  return link.coach_id === drawerUserId.value ? link.diver_name : link.coach_name
}

async function loadAudit(userId) {
  auditLoading.value = true
  auditEntries.value = []
  try {
    auditEntries.value = await auth.apiFetch(`/api/users/${userId}/role-audit`)
  } catch {
    auditEntries.value = []
  } finally {
    auditLoading.value = false
  }
}

async function loadClubs(orgId, currentClubId) {
  drawerClubs.value = []
  drawerClubChoice.value = currentClubId ?? ''
  drawerCreatingClub.value = false
  drawerNewClubName.value = ''
  drawerNewClubCode.value = ''
  if (!orgId) return
  try {
    const body = await auth.apiFetch(`/api/orgs/${orgId}/clubs`)
    drawerClubs.value = Array.isArray(body) ? body : []
  } catch {
    drawerClubs.value = []
  }
}

// Pull every coach link in the user's org. The candidate picker
// for "the other user in the link" comes from allUsers, already
// loaded by the User Manager. Saves a second round trip and
// guarantees the picker only contains org-mates the admin has
// permission to manage.
async function loadCoachLinks(orgId, currentUserId) {
  drawerCoachLinks.value = []
  drawerOrgUsers.value = []
  drawerLinkOtherId.value = ''
  drawerLinkRole.value = 'coach'
  drawerLinkNote.value = ''
  drawerLinkError.value = ''
  if (!orgId) return
  // Pick the candidate list from the cached users straight away
  // so the dropdown is responsive while the link list loads.
  drawerOrgUsers.value = allUsers.value
    .filter(u => u.org_id === orgId && u.id !== currentUserId)
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''))
  try {
    const links = await auth.apiFetch(`/api/orgs/${orgId}/coach-links`)
    drawerCoachLinks.value = Array.isArray(links) ? links : []
  } catch {
    drawerCoachLinks.value = []
  }
}

async function addCoachLink() {
  drawerLinkError.value = ''
  if (!drawerLinkOtherId.value) {
    drawerLinkError.value = t('user_manager.coach_pick_other_error')
    return
  }
  const me = drawerUserId.value
  const other = drawerLinkOtherId.value
  const coach_id = drawerLinkRole.value === 'coach' ? me : other
  const diver_id = drawerLinkRole.value === 'coach' ? other : me
  const u = allUsers.value.find(x => x.id === me)
  if (!u?.org_id) return
  drawerLinkSaving.value = true
  try {
    const link = await auth.apiFetch(`/api/orgs/${u.org_id}/coach-links`, {
      method: 'POST',
      body: JSON.stringify({
        coach_id,
        diver_id,
        note: drawerLinkNote.value.trim() || null,
      }),
    })
    // Server returns the link minus the names; resolve them
    // locally so the row renders immediately.
    const coach = allUsers.value.find(x => x.id === coach_id)
    const diver = allUsers.value.find(x => x.id === diver_id)
    drawerCoachLinks.value = [
      ...drawerCoachLinks.value,
      {
        ...link,
        coach_name: coach?.full_name || '',
        diver_name: diver?.full_name || '',
      },
    ]
    drawerLinkOtherId.value = ''
    drawerLinkNote.value = ''
  } catch (err) {
    drawerLinkError.value = err.message || t('user_manager.coach_add_failed')
  } finally {
    drawerLinkSaving.value = false
  }
}

async function removeCoachLink(id) {
  if (!await confirmAction({
    title: t('user_manager.coach_remove_title'),
    body:  t('user_manager.coach_remove_body'),
    confirmLabel: t('user_manager.coach_remove_confirm'),
    confirmKind:  'warn',
  })) return
  try {
    await auth.apiFetch(`/api/coach-links/${id}`, { method: 'DELETE' })
    drawerCoachLinks.value = drawerCoachLinks.value.filter(l => l.id !== id)
    showSuccess(t('user_manager.coach_link_removed_toast'))
  } catch (err) {
    showError(t('user_manager.coach_link_remove_failed', { message: err.message }))
  }
}

// Seed the editable personal-details form from the open user.
// Mirrors how loadClubs seeds drawerClubChoice: pulled straight
// from the cached row so the inputs are populated on open.
function seedDrawerProfile(u) {
  drawerFullName.value = u?.full_name || ''
  drawerDob.value = u?.date_of_birth || ''
  drawerGender.value = u?.gender || ''
  drawerNationality.value = u?.nationality || ''
  drawerProfileStatus.value = ''
}

function openDrawer(userId) {
  drawerUserId.value = userId
  loadAudit(userId)
  const u = allUsers.value.find(x => x.id === userId)
  loadClubs(u?.org_id, u?.club_id)
  loadCoachLinks(u?.org_id, userId)
  seedDrawerProfile(u)
  drawerClubStatus.value = ''
  drawerAccountBusy.value = false
}
function closeDrawer() {
  drawerUserId.value = null
  auditEntries.value = []
  drawerClubs.value = []
  drawerCoachLinks.value = []
  drawerOrgUsers.value = []
  drawerLinkError.value = ''
  drawerClubStatus.value = ''
  drawerProfileStatus.value = ''
  drawerAccountBusy.value = false
}

// Save the personal & competition details. Empty strings get sent
// as null since the backend treats '' / null as clearing the field.
async function saveDrawerProfile() {
  if (!drawerUserId.value) return
  drawerProfileSaving.value = true
  drawerProfileStatus.value = ''
  const nz = v => {
    const s = (v ?? '').trim()
    return s === '' ? null : s
  }
  try {
    await auth.apiFetch(`/api/users/${drawerUserId.value}/profile`, {
      method: 'PUT',
      body: JSON.stringify({
        full_name:     nz(drawerFullName.value),
        date_of_birth: nz(drawerDob.value),
        gender:        nz(drawerGender.value),
        nationality:   nz(drawerNationality.value)?.toUpperCase() ?? null,
      }),
    })
    // Refresh the source-of-truth list so the table + drawer header
    // reflect the new name / details immediately.
    await loadUsers()
    drawerProfileStatus.value = 'saved'
    setTimeout(() => { drawerProfileStatus.value = '' }, 1500)
  } catch (err) {
    drawerProfileStatus.value = 'error'
    showError(err.message || t('user_manager.drawer_club_save_failed'))
  } finally {
    drawerProfileSaving.value = false
  }
}

// --- Account lifecycle actions. Each hits it's endpoint then
// refreshes the user list so suspended_at / email_verified_at
// flags update in place. ---
async function runAccountAction(path, successMsg, opts = {}) {
  if (!drawerUserId.value || drawerAccountBusy.value) return
  if (opts.confirm && !await confirmAction(opts.confirm)) return
  drawerAccountBusy.value = true
  try {
    await auth.apiFetch(`/api/users/${drawerUserId.value}/${path}`, { method: 'POST' })
    if (opts.refresh !== false) await loadUsers()
    showSuccess(successMsg)
  } catch (err) {
    showError(err.message || successMsg)
  } finally {
    drawerAccountBusy.value = false
  }
}

function suspendAccount() {
  return runAccountAction('suspend', 'Account suspended', {
    confirm: {
      title: 'Suspend account?',
      body: `${drawerUser.value?.full_name || 'This user'} will be unable to sign in until reactivated.`,
      confirmLabel: 'Suspend',
      confirmKind: 'danger',
    },
  })
}
function reactivateAccount() {
  return runAccountAction('reactivate', 'Account reactivated')
}
function resendVerification() {
  return runAccountAction('resend-verification', 'Verification email sent', { refresh: false })
}
function sendPasswordReset() {
  return runAccountAction('reset-password', 'Password reset email sent', {
    refresh: false,
    confirm: {
      title: 'Send password reset?',
      body: `A password-reset link will be emailed to ${drawerUser.value?.email || 'this user'}.`,
      confirmLabel: 'Send reset',
      confirmKind: 'warn',
    },
  })
}

async function saveDrawerClub() {
  if (!drawerUserId.value) return
  drawerClubSaving.value = true
  drawerClubStatus.value = ''
  try {
    await auth.apiFetch(`/api/users/${drawerUserId.value}/club`, {
      method: 'PUT',
      body: JSON.stringify({ club_id: drawerClubChoice.value || null }),
    })
    // Mirror change into the table row so the org cell updates
    const u = allUsers.value.find(x => x.id === drawerUserId.value)
    if (u) {
      const c = drawerClubs.value.find(c => c.id === drawerClubChoice.value)
      u.club_id   = drawerClubChoice.value || null
      u.club_name = c?.name ?? null
      u.club_code = c?.short_code ?? null
    }
    drawerClubStatus.value = 'saved'
    setTimeout(() => { drawerClubStatus.value = '' }, 1500)
  } catch (err) {
    drawerClubStatus.value = 'error'
  } finally {
    drawerClubSaving.value = false
  }
}

async function createDrawerClub() {
  const u = allUsers.value.find(x => x.id === drawerUserId.value)
  if (!u?.org_id || !drawerNewClubName.value.trim()) return
  drawerClubSaving.value = true
  try {
    const club = await auth.apiFetch(`/api/orgs/${u.org_id}/clubs`, {
      method: 'POST',
      body: JSON.stringify({
        name: drawerNewClubName.value.trim(),
        short_code: drawerNewClubCode.value.trim() || null,
      }),
    })
    drawerClubs.value = [...drawerClubs.value, club].sort(
      (a, b) => a.name.localeCompare(b.name),
    )
    drawerClubChoice.value = club.id
    drawerCreatingClub.value = false
    drawerNewClubName.value = ''
    drawerNewClubCode.value = ''
    // Auto-save the freshly-created club to the user
    await saveDrawerClub()
  } catch (err) {
    drawerClubStatus.value = 'error'
  } finally {
    drawerClubSaving.value = false
  }
}

function fmtAuditTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function onKeyDown(e) {
  if (e.key === 'Escape' && drawerUserId.value) closeDrawer()
}

const ROLE_LABELS = computed(() => ({
  org_admin: t('user_manager.role_org_admin'),
  meet_manager: t('user_manager.role_meet_manager'),
  referee: t('user_manager.role_referee'),
  judge: t('user_manager.role_judge'),
  coach: t('user_manager.role_coach'),
  diver: t('user_manager.role_diver'),
  spectator: t('user_manager.role_spectator'),
}))

const filteredUsers = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  const roles = roleFilters.value
  return allUsers.value.filter(u => {
    if (orgFilter.value && u.org_id !== orgFilter.value) return false
    if (roles.size > 0) {
      const userRoles = u.org_roles || []
      // OR semantics: user must have at least one selected role
      if (!userRoles.some(r => roles.has(r))) return false
    }
    if (!term) return true
    return (
      u.full_name.toLowerCase().includes(term) ||
      u.username.toLowerCase().includes(term) ||
      (u.org_name || '').toLowerCase().includes(term) ||
      (u.country_code || '').toLowerCase().includes(term) ||
      (u.club_name || '').toLowerCase().includes(term) ||
      (u.club_code || '').toLowerCase().includes(term)
    )
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredUsers.value.length / PAGE_SIZE)))
const pagedUsers = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return filteredUsers.value.slice(start, start + PAGE_SIZE)
})

// Reset to page 1 whenever the filter changes underneath us
watch([searchTerm, orgFilter, roleFilters], () => { currentPage.value = 1 }, { deep: true })

async function loadRequests() {
  try { requests.value = await auth.apiFetch('/api/role-requests') }
  catch { requests.value = [] }
}

async function loadClubRequests() {
  try {
    const rows = await auth.apiFetch('/api/club-change-requests')
    clubRequests.value = Array.isArray(rows) ? rows : []
  } catch { clubRequests.value = [] }
}

// Human-readable summary of where a club/org request is moving the
// diver. Org transfers read org→org; within-org changes read
// club→club. "No club" stands in for a null source/target club.
function clubRequestSummary(rq) {
  if (rq.kind === 'org_transfer') {
    const club = rq.to_club_name ? ` · ${rq.to_club_name}` : ''
    return `${rq.from_org_name || '—'} → ${rq.to_org_name || '—'}${club}`
  }
  return `${rq.from_club_name || 'No club'} → ${rq.to_club_name || 'No club'}`
}

async function reviewClubRequest(id, decision) {
  try {
    await auth.apiFetch(`/api/club-change-requests/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    // A club move can change the affected user's row, so refresh both.
    await Promise.all([loadClubRequests(), loadUsers()])
  } catch (err) {
    showError(err.message)
  }
}

// Federations awaiting approval. System admin only — /api/orgs 403s
// for everyone else, so skip the call rather than eat a console error.
async function loadPendingOrgs() {
  if (!isSysAdmin.value) { pendingOrgs.value = []; return }
  try {
    const orgs = await auth.apiFetch('/api/orgs')
    pendingOrgs.value = (orgs || []).filter(o => o.status === 'pending')
  } catch { pendingOrgs.value = [] }
}

// /api/orgs doesn't carry a contact — cross-reference allUsers
// (already loaded, sysadmin sees every org) for the founding
// org_admin so a sysadmin reviewing the pending card has someone
// to email without hunting through the Members tab first.
function orgAdminContact(orgId) {
  return allUsers.value.find(u => u.org_id === orgId && (u.org_roles || []).includes('org_admin')) || null
}

// Approve activates the org; deny suspends it (organisations only
// have pending/active/suspended states, there's no separate
// "declined" — see PUT /api/orgs/:id/status).
async function reviewOrg(id, decision) {
  try {
    await auth.apiFetch(`/api/orgs/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: decision === 'approved' ? 'active' : 'suspended' }),
    })
    await loadPendingOrgs()
  } catch (err) {
    showError(err.message)
  }
}

async function loadUsers() {
  try {
    const users = await auth.apiFetch('/api/users')
    allUsers.value = users
    userRoles.value = {}
    users.forEach(u => { userRoles.value[u.id] = new Set(u.org_roles || []) })
  } catch { allUsers.value = [] }
}

async function reviewRequest(id, decision) {
  try {
    await auth.apiFetch(`/api/role-requests/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    await Promise.all([loadRequests(), loadUsers()])
  } catch (err) {
    showError(err.message)
  }
}

function toggleRoleFilter(role) {
  const next = new Set(roleFilters.value)
  if (next.has(role)) next.delete(role)
  else next.add(role)
  roleFilters.value = next
}

function clearRoleFilters() { roleFilters.value = new Set() }

function hasRole(userId, role) {
  return userRoles.value[userId]?.has(role) || false
}

// Toggle a role and schedule a debounced save. Rapid clicks on
// multiple checkboxes only fire one save per ~400ms of quiet.
function toggleRole(userId, role) {
  const set = userRoles.value[userId]
  if (!set) return
  if (set.has(role)) set.delete(role)
  else set.add(role)
  // Force reactivity (Set mutation is reactive, but the wrapping
  // ref won't re-emit unless the assignment gets replaced). Hacky but it works.
  userRoles.value[userId] = new Set(set)
  rowState.value[userId] = 'dirty'
  clearTimeout(saveTimers[userId])
  saveTimers[userId] = setTimeout(() => saveUserRoles(userId), 400)
}

async function saveUserRoles(userId) {
  rowState.value[userId] = 'saving'
  try {
    const roles = [...(userRoles.value[userId] || [])]
    await auth.apiFetch(`/api/users/${userId}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ roles }),
    })
    // Mirror the saved state back into the source-of-truth list
    // so the stats strip and filter chips stay accurate.
    const u = allUsers.value.find(x => x.id === userId)
    if (u) u.org_roles = roles
    rowState.value[userId] = 'saved'
    setTimeout(() => {
      if (rowState.value[userId] === 'saved') rowState.value[userId] = null
    }, 1500)
    // If the drawer is currently showing this user, refresh the
    // audit log so the new grant/revoke entries appear immediately.
    if (drawerUserId.value === userId) loadAudit(userId)
  } catch {
    rowState.value[userId] = 'error'
  }
}

function rowStatusLabel(userId) {
  const s = rowState.value[userId]
  if (s === 'saving') return t('user_manager.status_saving')
  if (s === 'saved')  return t('user_manager.status_saved')
  if (s === 'dirty')  return t('user_manager.status_dirty')
  if (s === 'error')  return t('user_manager.status_error')
  return ''
}

function retrySave(userId) {
  if (rowState.value[userId] === 'error') saveUserRoles(userId)
}

// Group filteredUsers by org for the system-admin grouped view.
// Sorted by org name; users inside each group preserve the the
// alphabetical order from the API.
const groupedUsers = computed(() => {
  if (!groupByOrg.value) return []
  const map = new Map()
  for (const u of filteredUsers.value) {
    const key = u.org_id || 'no-org'
    if (!map.has(key)) {
      map.set(key, {
        org_id: u.org_id,
        org_name: u.org_name || 'No Organisation',
        country_code: u.country_code || '',
        users: [],
      })
    }
    map.get(key).users.push(u)
  }
  return [...map.values()].sort((a, b) => a.org_name.localeCompare(b.org_name))
})

// IDs visible right now: depends on whether we're paged or grouped.
const visibleIds = computed(() => {
  if (groupByOrg.value) {
    return groupedUsers.value.flatMap(g =>
      collapsedOrgs.value.has(g.org_id) ? [] : g.users.map(u => u.id),
    )
  }
  return pagedUsers.value.map(u => u.id)
})

const allVisibleSelected = computed(() => {
  const ids = visibleIds.value
  return ids.length > 0 && ids.every(id => selectedIds.value.has(id))
})

function toggleSelect(userId) {
  const next = new Set(selectedIds.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  selectedIds.value = next
}

function toggleSelectAllVisible() {
  const ids = visibleIds.value
  const next = new Set(selectedIds.value)
  if (allVisibleSelected.value) ids.forEach(id => next.delete(id))
  else ids.forEach(id => next.add(id))
  selectedIds.value = next
}

function clearSelection() { selectedIds.value = new Set() }

function toggleOrgCollapsed(orgId) {
  const next = new Set(collapsedOrgs.value)
  if (next.has(orgId)) next.delete(orgId)
  else next.add(orgId)
  collapsedOrgs.value = next
}

function expandAllOrgs()   { collapsedOrgs.value = new Set() }
function collapseAllOrgs() {
  collapsedOrgs.value = new Set(groupedUsers.value.map(g => g.org_id))
}

// Run an async function over a list with a concurrency cap so we
// don't fire off 1000 simultaneous PUTs at the server during a bulk
// operation, yeah that would be bad.
async function runWithConcurrency(items, fn, concurrency = 8) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (item != null) await fn(item)
    }
  })
  await Promise.all(workers)
}

async function applyBulkRole(action) {
  if (bulkBusy.value) return
  const role = bulkRole.value
  const ids = [...selectedIds.value]
  if (!ids.length) return
  bulkBusy.value = true
  bulkSummary.value = ''
  let ok = 0, skipped = 0, failed = 0

  await runWithConcurrency(ids, async (id) => {
    const set = userRoles.value[id]
    if (!set) { skipped++; return }
    if (action === 'add' && set.has(role))    { skipped++; return }
    if (action === 'remove' && !set.has(role)){ skipped++; return }

    if (action === 'add') set.add(role)
    else set.delete(role)
    userRoles.value[id] = new Set(set)
    rowState.value[id] = 'saving'

    try {
      const roles = [...set]
      await auth.apiFetch(`/api/users/${id}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roles }),
      })
      const u = allUsers.value.find(x => x.id === id)
      if (u) u.org_roles = roles
      rowState.value[id] = 'saved'
      ok++
      setTimeout(() => {
        if (rowState.value[id] === 'saved') rowState.value[id] = null
      }, 1500)
    } catch {
      // Revert local state so the UI matches the server
      if (action === 'add') set.delete(role)
      else set.add(role)
      userRoles.value[id] = new Set(set)
      rowState.value[id] = 'error'
      failed++
    }
  })

  bulkBusy.value = false
  selectedIds.value = new Set()
  const skippedStr = skipped ? t('user_manager.bulk_skipped_suffix', { n: skipped }) : ''
  const failedStr = failed ? t('user_manager.bulk_failed_suffix', { n: failed }) : ''
  const roleLabel = ROLE_LABELS.value[role] || role
  bulkSummary.value = action === 'add'
    ? t('user_manager.bulk_summary_added', { role: roleLabel, ok, skipped: skippedStr, failed: failedStr })
    : t('user_manager.bulk_summary_removed', { role: roleLabel, ok, skipped: skippedStr, failed: failedStr })
  setTimeout(() => { bulkSummary.value = '' }, 4000)
}

// CSV export of the *currently filtered* users, respects search,
// role chips and org filter. Handy for offline triage and for
// onboarding emails.
function exportCsv() {
  const rows = filteredUsers.value
  const headers = ['Name', 'Username', 'Organisation', 'Country', 'Club', 'Club Code', 'Roles', 'System Admin']
  const lines = [headers.join(',')]
  const esc = v => `"${String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`
  for (const u of rows) {
    lines.push([
      esc(u.full_name),
      esc(u.username),
      esc(u.org_name),
      esc(u.country_code),
      esc(u.club_name),
      esc(u.club_code),
      esc((u.org_roles || []).join('; ')),
      esc(u.is_system_admin ? 'yes' : 'no'),
    ].join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `members_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function pageNums() {
  // Compact page list: first, last, current ± 2, with ellipses
  const total = totalPages.value
  const cur = currentPage.value
  const set = new Set([1, total, cur - 1, cur, cur + 1])
  const nums = [...set].filter(n => n >= 1 && n <= total).sort((a, b) => a - b)
  const out = []
  let prev = 0
  for (const n of nums) {
    if (n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  await Promise.all([loadRequests(), loadClubRequests(), loadPendingOrgs(), loadUsers()])
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">{{ $t('user_manager.title') }}</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">{{ $t('user_manager.back_dashboard') }}</RouterLink>
  </div>

  <div class="main">

    <!-- Stats strip -->
    <div class="stats-strip">
      <div class="stat">
        <div class="stat-num">{{ stats.total.toLocaleString() }}</div>
        <div class="stat-label">{{ $t('user_manager.stat_members') }}</div>
      </div>
      <div :class="['stat', stats.pending ? 'stat-cyan' : '']">
        <div class="stat-num">{{ stats.pending }}</div>
        <div class="stat-label">{{ $t('user_manager.stat_pending') }}</div>
      </div>
      <div class="stat-sep"></div>
      <div v-for="r in PRIMARY_ROLES" :key="r" class="stat stat-mini">
        <div class="stat-num">{{ stats[r].toLocaleString() }}</div>
        <div class="stat-label">{{ ROLE_LABELS[r] }}</div>
      </div>
      <span v-if="isSysAdmin" class="sys-badge" style="margin-inline-start:auto">{{ $t('user_manager.sys_admin_badge') }}</span>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="['tab', activeTab === 'members' ? 'tab-active' : '']"
              @click="activeTab = 'members'">
        {{ $t('user_manager.tab_members') }} <span class="tab-count">{{ stats.total.toLocaleString() }}</span>
      </button>
      <button :class="['tab', activeTab === 'requests' ? 'tab-active' : '']"
              @click="activeTab = 'requests'">
        {{ $t('user_manager.tab_pending') }} <span :class="['tab-count', stats.pending ? 'tab-count-active' : '']">{{ stats.pending }}</span>
      </button>
    </div>

    <!-- Requests tab -->
    <div v-if="activeTab === 'requests'" class="card">
      <div v-if="!requests.length && !pendingClubRequests.length && !pendingOrgs.length" class="empty-state">{{ $t('user_manager.no_pending') }}</div>

      <!-- Pending federation registrations (system admin only) -->
      <div v-if="pendingOrgs.length" class="club-requests-block">
        <div class="club-requests-head">Federation registrations</div>
        <div class="requests-grid">
          <div v-for="org in pendingOrgs" :key="org.id" class="request-card">
            <div style="flex:1;min-width:0">
              <div class="request-name">{{ org.name }}</div>
              <div class="request-meta">
                <span class="badge">federation</span>
                {{ org.country_code || '—' }}
              </div>
              <div v-if="orgAdminContact(org.id)" class="user-email">
                {{ orgAdminContact(org.id).full_name }} · {{ orgAdminContact(org.id).email }}
              </div>
            </div>
            <div class="request-actions">
              <button class="btn btn-sm btn-approve" @click="reviewOrg(org.id, 'approved')">{{ $t('user_manager.approve') }}</button>
              <button class="btn btn-danger btn-sm" @click="reviewOrg(org.id, 'rejected')">{{ $t('user_manager.deny') }}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Role requests -->
      <div v-if="requests.length" class="requests-grid">
        <div v-for="rq in requests" :key="rq.id" class="request-card">
          <div style="flex:1;min-width:0">
            <div class="request-name">{{ rq.full_name }}</div>
            <div class="request-meta">
              @{{ rq.username }} · {{ $t('user_manager.requesting_label') }}
              <span class="badge">{{ rq.requested_role.replace('_', ' ') }}</span>
              <span v-if="isSysAdmin && rq.org_name" class="org-country">
                {{ rq.org_name }}{{ rq.country_code ? ' · ' + rq.country_code : '' }}
              </span>
            </div>
            <div v-if="rq.note" class="request-note">"{{ rq.note }}"</div>
          </div>
          <div class="request-actions">
            <button class="btn btn-sm btn-approve" @click="reviewRequest(rq.id, 'approved')">{{ $t('user_manager.approve') }}</button>
            <button class="btn btn-danger btn-sm" @click="reviewRequest(rq.id, 'rejected')">{{ $t('user_manager.deny') }}</button>
          </div>
        </div>
      </div>

      <!-- Club change requests -->
      <div v-if="pendingClubRequests.length" class="club-requests-block">
        <div class="club-requests-head">Club change requests</div>
        <div class="requests-grid">
          <div v-for="rq in pendingClubRequests" :key="rq.id" class="request-card">
            <div style="flex:1;min-width:0">
              <div class="request-name">{{ rq.diver_name }}</div>
              <div class="request-meta">
                @{{ rq.diver_username }} ·
                <span class="badge">{{ rq.kind === 'org_transfer' ? 'transfer' : 'club change' }}</span>
                {{ clubRequestSummary(rq) }}
              </div>
              <!-- Org transfers need three approvals, this shows which are in. -->
              <div v-if="rq.kind === 'org_transfer'" class="club-approvals">
                <span :class="['approval-chip', rq.source_approved_at ? 'approval-on' : 'approval-off']">
                  Source {{ rq.source_approved_at ? '✓' : '–' }}
                </span>
                <span :class="['approval-chip', rq.target_approved_at ? 'approval-on' : 'approval-off']">
                  Target {{ rq.target_approved_at ? '✓' : '–' }}
                </span>
                <span :class="['approval-chip', rq.diver_confirmed_at ? 'approval-on' : 'approval-off']">
                  Diver {{ rq.diver_confirmed_at ? '✓' : '–' }}
                </span>
              </div>
            </div>
            <div class="request-actions">
              <button class="btn btn-sm btn-approve" @click="reviewClubRequest(rq.id, 'approved')">{{ $t('user_manager.approve') }}</button>
              <button class="btn btn-danger btn-sm" @click="reviewClubRequest(rq.id, 'rejected')">{{ $t('user_manager.deny') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Members tab -->
    <div v-else>
      <!-- Filters -->
      <div class="filters">
        <input class="input" type="text" v-model="searchTerm" :placeholder="$t('user_manager.search_placeholder')">
        <select v-if="isSysAdmin" class="select" v-model="orgFilter">
          <option value="">{{ $t('user_manager.all_orgs_count', { n: orgs.length }) }}</option>
          <option v-for="o in orgs" :key="o.id" :value="o.id">
            {{ o.name }}{{ o.country_code ? ' · ' + o.country_code : '' }}
          </option>
        </select>
        <label v-if="isSysAdmin" class="toggle">
          <input type="checkbox" v-model="groupByOrg">
          {{ $t('user_manager.group_by_org') }}
        </label>
        <button class="btn btn-ghost btn-sm" @click="exportCsv" :disabled="!filteredUsers.length">
          {{ $t('user_manager.export_csv') }}
        </button>
        <span class="result-count">{{ $t('user_manager.result_count', { shown: filteredUsers.length.toLocaleString(), total: allUsers.length.toLocaleString() }) }}</span>
      </div>

      <!-- Role chip filter, primary roles only. Filtering by
           spectator would just show every member -->
      <div class="chip-row">
        <span class="chip-label">{{ $t('user_manager.role_label_short') }}</span>
        <button v-for="r in PRIMARY_ROLES" :key="r"
                :class="['chip', roleFilters.has(r) ? 'chip-active' : '']"
                @click="toggleRoleFilter(r)">
          {{ ROLE_LABELS[r] }}
        </button>
        <button v-if="roleFilters.size" class="chip chip-clear" @click="clearRoleFilters">{{ $t('user_manager.clear_filter') }}</button>
      </div>

      <!-- Bulk action bar, only visible while at least one row is selected -->
      <div v-if="selectedIds.size" class="bulk-bar">
        <div class="bulk-count">{{ $t('user_manager.selected_count', { n: selectedIds.size }) }}</div>
        <select class="select bulk-select" v-model="bulkRole">
          <option v-for="r in ALL_ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
        </select>
        <button class="btn btn-sm bulk-add" :disabled="bulkBusy" @click="applyBulkRole('add')">{{ $t('user_manager.bulk_add_role') }}</button>
        <button class="btn btn-sm bulk-remove" :disabled="bulkBusy" @click="applyBulkRole('remove')">{{ $t('user_manager.bulk_remove_role') }}</button>
        <button class="btn btn-ghost btn-sm" @click="clearSelection">{{ $t('user_manager.clear_selection') }}</button>
        <span v-if="bulkBusy" class="bulk-status">{{ $t('user_manager.bulk_working') }}</span>
      </div>
      <div v-if="bulkSummary" class="bulk-summary">{{ bulkSummary }}</div>

      <!-- Grouped-by-org controls -->
      <div v-if="groupByOrg" class="group-controls">
        <button class="btn btn-ghost btn-sm" @click="expandAllOrgs">{{ $t('user_manager.expand_all') }}</button>
        <button class="btn btn-ghost btn-sm" @click="collapseAllOrgs">{{ $t('user_manager.collapse_all') }}</button>
      </div>

      <!-- Users table -->
      <div class="card" style="padding:0;overflow:hidden">
        <div class="table-wrap"><table class="data-table">
          <thead>
            <tr>
              <th class="select-col">
                <input type="checkbox"
                       :checked="allVisibleSelected"
                       :disabled="!visibleIds.length"
                       @change="toggleSelectAllVisible">
              </th>
              <th>{{ $t('user_manager.col_name') }}</th>
              <th>{{ $t('user_manager.col_username') }}</th>
              <th v-if="isSysAdmin && !groupByOrg">{{ $t('user_manager.col_org') }}</th>
              <th>{{ $t('user_manager.col_roles') }}</th>
              <th class="status-col">{{ $t('user_manager.col_status') }}</th>
            </tr>
          </thead>

          <!-- Flat (paged) view -->
          <tbody v-if="!groupByOrg">
            <tr v-if="!filteredUsers.length">
              <td :colspan="isSysAdmin ? 6 : 5" class="empty-state">{{ $t('user_manager.no_users_found') }}</td>
            </tr>
            <tr v-for="user in pagedUsers" :key="user.id"
                :class="['user-row', 'clickable', rowState[user.id] || '', selectedIds.has(user.id) ? 'selected' : '']"
                @click="openDrawer(user.id)">
              <td class="select-col" @click.stop>
                <input type="checkbox"
                       :checked="selectedIds.has(user.id)"
                       @change="toggleSelect(user.id)">
              </td>
              <td>
                <span class="user-name">{{ user.full_name }}</span>
                <span v-if="user.is_system_admin" class="sys-badge sys-badge-inline">{{ $t('user_manager.sys_badge_short') }}</span>
              </td>
              <td class="dim">
                <div>@{{ user.username }}</div>
                <div v-if="user.email" class="user-email">{{ user.email }}</div>
              </td>
              <td v-if="isSysAdmin" class="org-cell">
                <div class="org-stack">
                  <span class="org-name">
                    {{ user.org_name }}
                    <span v-if="user.country_code" class="org-country">{{ user.country_code }}</span>
                  </span>
                  <span v-if="user.club_name" class="club-line">{{ user.club_name }}</span>
                  <span v-else class="club-line club-line-empty">{{ $t('user_manager.no_club') }}</span>
                </div>
              </td>
              <td>
                <div class="role-pills">
                  <span v-for="role in userPills(user.id)" :key="role"
                        :class="['role-pill', `role-pill-${role}`]">
                    {{ ROLE_LABELS[role] }}
                  </span>
                  <span v-if="!userPills(user.id).length" class="role-pill role-pill-empty">
                    {{ $t('user_manager.no_roles') }}
                  </span>
                  <span class="role-edit-hint">{{ $t('user_manager.edit_hint') }}</span>
                </div>
              </td>
              <td class="status-col" @click.stop>
                <span v-if="rowState[user.id]"
                      :class="['status-pill', `status-${rowState[user.id]}`]"
                      @click="retrySave(user.id)">
                  {{ rowStatusLabel(user.id) }}
                </span>
              </td>
            </tr>
          </tbody>

          <!-- Grouped-by-org view (system admin) -->
          <template v-else>
            <tbody v-if="!groupedUsers.length">
              <tr><td colspan="5" class="empty-state">{{ $t('user_manager.no_users_found') }}</td></tr>
            </tbody>
            <template v-for="g in groupedUsers" :key="g.org_id">
              <tbody>
                <tr class="group-head" @click="toggleOrgCollapsed(g.org_id)">
                  <td colspan="5">
                    <span class="group-caret">{{ collapsedOrgs.has(g.org_id) ? '▸' : '▾' }}</span>
                    <span class="group-name">{{ g.org_name }}</span>
                    <span v-if="g.country_code" class="org-country">{{ g.country_code }}</span>
                    <span class="group-count">{{ g.users.length === 1 ? $t('user_manager.group_members_one', { n: g.users.length }) : $t('user_manager.group_members_many', { n: g.users.length }) }}</span>
                  </td>
                </tr>
                <template v-if="!collapsedOrgs.has(g.org_id)">
                  <tr v-for="user in g.users" :key="user.id"
                      :class="['user-row', 'clickable', rowState[user.id] || '', selectedIds.has(user.id) ? 'selected' : '']"
                      @click="openDrawer(user.id)">
                    <td class="select-col" @click.stop>
                      <input type="checkbox"
                             :checked="selectedIds.has(user.id)"
                             @change="toggleSelect(user.id)">
                    </td>
                    <td>
                      <span class="user-name">{{ user.full_name }}</span>
                      <span v-if="user.is_system_admin" class="sys-badge sys-badge-inline">{{ $t('user_manager.sys_badge_short') }}</span>
                    </td>
                    <td class="dim">
                      <div>@{{ user.username }}</div>
                      <div v-if="user.email" class="user-email">{{ user.email }}</div>
                    </td>
                    <td>
                      <div class="role-pills">
                        <span v-for="role in userPills(user.id)" :key="role"
                              :class="['role-pill', `role-pill-${role}`]">
                          {{ ROLE_LABELS[role] }}
                        </span>
                        <span v-if="!userPills(user.id).length" class="role-pill role-pill-empty">
                          {{ $t('user_manager.no_roles') }}
                        </span>
                        <span class="role-edit-hint">{{ $t('user_manager.edit_hint') }}</span>
                      </div>
                    </td>
                    <td class="status-col" @click.stop>
                      <span v-if="rowState[user.id]"
                            :class="['status-pill', `status-${rowState[user.id]}`]"
                            @click="retrySave(user.id)">
                        {{ rowStatusLabel(user.id) }}
                      </span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </template>
          </template>
        </table></div>
      </div>

      <!-- Pagination, only meaningful in flat (non-grouped) mode -->
      <div v-if="!groupByOrg && totalPages > 1" class="pagination">
        <button class="page-btn" :disabled="currentPage === 1" @click="currentPage--">{{ $t('user_manager.page_prev') }}</button>
        <button v-for="(n, i) in pageNums()" :key="i"
                :class="['page-btn', n === currentPage ? 'page-btn-active' : '']"
                :disabled="n === '…'"
                @click="typeof n === 'number' && (currentPage = n)">
          {{ n }}
        </button>
        <button class="page-btn" :disabled="currentPage === totalPages" @click="currentPage++">{{ $t('user_manager.page_next') }}</button>
        <span class="page-info">
          {{ $t('user_manager.page_info', {
            from: ((currentPage - 1) * PAGE_SIZE + 1).toLocaleString(),
            to: Math.min(currentPage * PAGE_SIZE, filteredUsers.length).toLocaleString(),
            total: filteredUsers.length.toLocaleString(),
          }) }}
        </span>
      </div>
    </div>

  </div>

  <!-- Per-user edit drawer. Renders when a row is clicked.
       Backdrop click and Escape both close it. -->
  <Transition name="drawer">
    <div v-if="drawerUserId" class="drawer-backdrop" @click="closeDrawer"></div>
  </Transition>
  <Transition name="drawer-panel">
    <aside v-if="drawerUserId && drawerUser" class="drawer">
      <div class="drawer-head">
        <div class="drawer-id">
          <div class="drawer-name">
            {{ drawerUser.full_name }}
            <span v-if="drawerUser.is_system_admin" class="sys-badge sys-badge-inline">SYS</span>
          </div>
          <div class="drawer-meta">
            @{{ drawerUser.username }}<span v-if="drawerUser.email"> · {{ drawerUser.email }}</span>
          </div>
          <div class="drawer-org">
            <span v-if="drawerUser.org_name" class="drawer-org-name">{{ drawerUser.org_name }}</span>
            <span v-if="drawerUser.country_code" class="org-country">{{ drawerUser.country_code }}</span>
            <span v-if="drawerUser.club_name" class="drawer-club">
              {{ drawerUser.club_name }}<span v-if="drawerUser.club_code" class="club-code">{{ drawerUser.club_code }}</span>
            </span>
            <span v-else class="club-line club-line-empty">{{ $t('user_manager.no_club') }}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="closeDrawer" aria-label="Close drawer">{{ $t('user_manager.close_drawer') }}</button>
      </div>

      <div class="drawer-body">
        <!-- Club editor: assign or create a club within the
             target user's org. Only orgs they belong to are
             selectable, cross-org assignment isn't a real flow. -->
        <div class="drawer-section-label">{{ $t('user_manager.drawer_section_club') }}</div>
        <div class="club-editor">
          <select v-if="!drawerCreatingClub"
                  class="select"
                  v-model="drawerClubChoice"
                  @change="saveDrawerClub">
            <option value="">{{ $t('user_manager.drawer_no_club_option') }}</option>
            <option v-for="c in drawerClubs" :key="c.id" :value="c.id">
              {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
            </option>
          </select>
          <button v-if="!drawerCreatingClub"
                  class="btn btn-ghost btn-sm"
                  @click="drawerCreatingClub = true">
            {{ $t('user_manager.drawer_new_club_btn') }}
          </button>

          <!-- Inline create form -->
          <div v-if="drawerCreatingClub" class="club-create-block">
            <div class="field">
              <label class="label">{{ $t('user_manager.drawer_new_club_name_label') }}</label>
              <input class="input" type="text" v-model="drawerNewClubName"
                     :placeholder="$t('user_manager.drawer_new_club_name_placeholder')">
            </div>
            <div class="field">
              <label class="label">{{ $t('user_manager.drawer_new_club_code_label') }}</label>
              <input class="input" type="text" v-model="drawerNewClubCode"
                     :placeholder="$t('user_manager.drawer_new_club_code_placeholder')" maxlength="20">
            </div>
            <div style="display:flex;gap:0.4rem;justify-content:flex-end">
              <button class="btn btn-ghost btn-sm"
                      @click="drawerCreatingClub = false">{{ $t('user_manager.drawer_cancel') }}</button>
              <button class="btn btn-primary btn-sm"
                      :disabled="drawerClubSaving || !drawerNewClubName.trim()"
                      @click="createDrawerClub">
                {{ drawerClubSaving ? $t('user_manager.drawer_creating') : $t('user_manager.drawer_create_assign') }}
              </button>
            </div>
          </div>

          <span v-if="drawerClubStatus === 'saved'" class="club-status-saved">{{ $t('user_manager.drawer_club_saved') }}</span>
          <span v-else-if="drawerClubStatus === 'error'" class="club-status-error">{{ $t('user_manager.drawer_club_save_failed') }}</span>
        </div>

        <!-- Personal & competition details. Editable form seeded
             from the user row when the drawer opens; saved as one
             PUT that clears any field left blank. -->
        <div class="drawer-section-label" style="margin-top:1.5rem">Personal &amp; competition details</div>
        <div class="profile-editor">
          <div class="field">
            <label class="label">Full name</label>
            <input class="input" type="text" v-model="drawerFullName">
          </div>
          <div class="profile-grid">
            <div class="field">
              <label class="label">Date of birth</label>
              <input class="input" type="date" v-model="drawerDob">
            </div>
            <div class="field">
              <label class="label">Gender</label>
              <select class="select" v-model="drawerGender">
                <option value="">—</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
                <option value="prefer_not_to_say">Prefer not to say</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label class="label">Nationality</label>
            <input class="input profile-nat" type="text" v-model="drawerNationality"
                   maxlength="3" placeholder="GBR"
                   style="text-transform:uppercase">
          </div>
          <div class="profile-save-row">
            <button class="btn btn-primary btn-sm"
                    :disabled="drawerProfileSaving"
                    @click="saveDrawerProfile">
              {{ drawerProfileSaving ? $t('user_manager.drawer_creating') : 'Save details' }}
            </button>
            <span v-if="drawerProfileStatus === 'saved'" class="club-status-saved">{{ $t('user_manager.drawer_club_saved') }}</span>
            <span v-else-if="drawerProfileStatus === 'error'" class="club-status-error">{{ $t('user_manager.drawer_club_save_failed') }}</span>
          </div>
        </div>

        <!-- Account lifecycle. Suspend / reactivate, resend
             verification, and password reset. Each refreshes the
             user list so the suspended / verified flags update. -->
        <div class="drawer-section-label" style="margin-top:1.5rem">Account</div>
        <div class="account-actions">
          <div v-if="drawerUser.suspended_at" class="account-suspended-row">
            <span class="badge badge-amber">Suspended</span>
            <button v-if="!drawerUser.is_system_admin"
                    class="btn btn-primary btn-sm"
                    :disabled="drawerAccountBusy"
                    @click="reactivateAccount">Reactivate</button>
          </div>
          <button v-else-if="!drawerUser.is_system_admin"
                  class="btn btn-danger btn-sm"
                  :disabled="drawerAccountBusy"
                  @click="suspendAccount">Suspend account</button>

          <button v-if="drawerUser.email && !drawerUser.email_verified_at"
                  class="btn btn-ghost btn-sm"
                  :disabled="drawerAccountBusy"
                  @click="resendVerification">Resend verification email</button>

          <button class="btn btn-ghost btn-sm"
                  :disabled="drawerAccountBusy"
                  @click="sendPasswordReset">Send password reset</button>
        </div>

        <div class="drawer-section-label" style="margin-top:1.5rem">{{ $t('user_manager.drawer_section_roles') }}</div>
        <div class="drawer-roles">
          <label v-for="role in ALL_ROLES" :key="role"
                 :class="['drawer-role', hasRole(drawerUserId, role) ? 'drawer-role-on' : '']">
            <input type="checkbox"
                   :checked="hasRole(drawerUserId, role)"
                   @change="toggleRole(drawerUserId, role)">
            <span class="drawer-role-name">{{ ROLE_LABELS[role] }}</span>
            <span :class="['role-pill', `role-pill-${role}`, 'role-pill-inline']">{{ ROLE_LABELS[role] }}</span>
          </label>
        </div>

        <div v-if="rowState[drawerUserId]" class="drawer-status">
          <span :class="['status-pill', `status-${rowState[drawerUserId]}`]">
            {{ rowStatusLabel(drawerUserId) }}
          </span>
        </div>

        <!-- Coach ↔ Diver links. Org admins curate them here;
             the linked-side user sees them on their /coach
             dashboard. -->
        <div class="drawer-section-label" style="margin-top:1.5rem">{{ $t('user_manager.drawer_section_coach_links') }}</div>
        <div class="coach-links">
          <div v-if="!drawerLinks.length" class="coach-empty">
            {{ $t('user_manager.coach_empty') }}
          </div>
          <div v-for="link in drawerLinks" :key="link.id" class="coach-link-row">
            <span :class="['coach-side', `coach-side-${linkSideForUser(link)}`]">
              {{ linkSideForUser(link) === 'coach' ? $t('user_manager.coach_of') : $t('user_manager.diver_of') }}
            </span>
            <span class="coach-other">{{ linkOtherName(link) }}</span>
            <span v-if="link.note" class="coach-note">{{ link.note }}</span>
            <button class="btn btn-ghost btn-sm coach-remove"
                    @click="removeCoachLink(link.id)"
                    v-tip="$t('user_manager.coach_remove_tip')">✕</button>
          </div>
        </div>

        <div class="coach-add">
          <div class="coach-add-row">
            <span class="coach-add-label">{{ $t('user_manager.coach_add_label_prefix') }}</span>
            <select class="select coach-add-role" v-model="drawerLinkRole">
              <option value="coach">{{ $t('user_manager.coach_role_coach') }}</option>
              <option value="diver">{{ $t('user_manager.coach_role_diver') }}</option>
            </select>
            <span class="coach-add-label">{{ $t('user_manager.coach_add_label_of') }}</span>
            <select class="select coach-add-other" v-model="drawerLinkOtherId">
              <option value="">{{ $t('user_manager.coach_pick_user') }}</option>
              <option v-for="u in drawerOrgUsers" :key="u.id" :value="u.id">
                {{ u.full_name }}
              </option>
            </select>
          </div>
          <input class="input coach-add-note" type="text"
                 v-model="drawerLinkNote"
                 :placeholder="$t('user_manager.coach_note_placeholder')">
          <div v-if="drawerLinkError" class="msg msg-error">{{ drawerLinkError }}</div>
          <button class="btn btn-primary btn-sm coach-add-btn"
                  :disabled="drawerLinkSaving || !drawerLinkOtherId"
                  @click="addCoachLink">
            {{ drawerLinkSaving ? $t('user_manager.coach_saving') : $t('user_manager.coach_add_btn') }}
          </button>
        </div>

        <!-- Audit history: every grant / revoke event for this user
             across the lifetime of their account. Updates after each
             role toggle saves successfully. -->
        <div class="drawer-section-label" style="margin-top:1.5rem">{{ $t('user_manager.drawer_section_audit') }}</div>
        <div v-if="auditLoading" class="audit-empty">{{ $t('user_manager.audit_loading') }}</div>
        <div v-else-if="!auditEntries.length" class="audit-empty">
          {{ $t('user_manager.audit_empty') }}
        </div>
        <ol v-else class="audit-list">
          <li v-for="a in auditEntries" :key="a.id" class="audit-item">
            <span :class="['audit-action', `audit-action-${a.action}`]">
              {{ a.action === 'granted' ? '+' : '−' }}
            </span>
            <span class="audit-role">{{ ROLE_LABELS[a.role] || a.role }}</span>
            <span class="audit-meta">
              <span class="audit-time">{{ fmtAuditTime(a.created_at) }}</span>
              <span v-if="a.actor_name" class="audit-actor">{{ $t('user_manager.audit_by_actor', { name: a.actor_name }) }}</span>
              <span v-else class="audit-actor audit-actor-system">{{ $t('user_manager.audit_by_system') }}</span>
              <span v-if="a.note" class="audit-note">· {{ a.note }}</span>
            </span>
          </li>
        </ol>

        <div class="drawer-hint">
          {{ $t('user_manager.drawer_hint') }}
        </div>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
/* Title is redundant with the shell breadcrumb, so it's hidden. */
.page-header { display: none; }
/* Back-to-dashboard is redundant inside the app shell sidebar. */
.page-header .btn { display: none; }
.page-title { font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; }
.main { max-width: 1400px; margin: 0 auto; padding: 1.5rem 2rem; display: flex; flex-direction: column; gap: 1.25rem; }

/* Stats strip */
.stats-strip {
  display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;
  padding: 1rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.stat { min-width: 70px; }
.stat-num { font-family: var(--font-display); font-size: 24px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.stat-mini .stat-num { font-size: 20px; color: var(--text-2); }
.stat-cyan .stat-num { color: var(--cyan); }
.stat-label { font-family: var(--font-display); font-size: 9px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-top: 0.25rem; }
.stat-sep { width: 1px; height: 32px; background: var(--border); margin: 0 0.25rem; }

/* Tabs */
.tabs { display: flex; gap: 1.25rem; border-bottom: 1px solid var(--border); }
.tab {
  font-family: var(--font-sans); font-size: 13.5px; font-weight: 500;
  letter-spacing: 0; text-transform: none;
  padding: 0.6rem 0.25rem; cursor: pointer;
  background: transparent; border: none; color: var(--fg-2);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover { color: var(--text-2); }
.tab-active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.tab-count {
  font-family: var(--font-mono); font-size: 11px; font-weight: 500;
  letter-spacing: 0; padding: 0.05rem 0.45rem; border-radius: var(--radius-pill);
  background: var(--bg-sunken); border: none; color: var(--fg-2);
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.tab-count-active { background: var(--cyan-dim); border-color: rgba(6,182,212,0.4); color: var(--cyan); }

/* Filters row */
.filters { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.filters .input  { max-width: 360px; flex: 1 1 220px; }
.filters .select { max-width: 360px; flex: 1 1 240px; }
.result-count { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-inline-start: auto; }

/* Role chips */
.chip-row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.875rem; }
.chip-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-inline-end: 0.25rem; }
.chip {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.3rem 0.7rem; border-radius: 999px; cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--text-2);
  transition: background 0.1s, color 0.1s, border-color 0.1s;
}
.chip:hover { color: var(--text); border-color: var(--border-2); }
.chip-active { background: var(--cyan-dim); border-color: var(--cyan); color: var(--cyan); }
.chip-clear { color: var(--text-3); border-style: dashed; }
.chip-clear:hover { color: var(--red); border-color: var(--red); }

/* Requests grid (unchanged behaviour, restyled card) */
.requests-grid { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.5rem; }
.request-card {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0.875rem 1.125rem; gap: 1rem;
}
.request-name  { font-family: var(--font-display); font-size: 16px; font-weight: 700; color: var(--text); }
.request-meta  { font-size: 11px; color: var(--text-3); margin-top: 0.2rem; }
.request-note  { font-size: 11px; color: var(--text-2); margin-top: 0.35rem; font-style: italic; }
.request-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.btn-approve { background: var(--green-dim); color: var(--green); border: 1px solid rgba(16,185,129,0.3); }

/* Club-change request list, sits below role requests in the
   Requests tab, separated by a faint rule + section heading. */
.club-requests-block { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.club-requests-block:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.club-requests-head {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  padding: 0 0.5rem 0.5rem;
}
.club-approvals { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.4rem; }
.approval-chip {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase;
  padding: 0.1rem 0.45rem; border-radius: var(--radius-pill);
  border: 1px solid var(--border); white-space: nowrap;
}
.approval-on  { color: var(--ok-fg); background: var(--ok-bg); border-color: var(--ok-solid); }
.approval-off { color: var(--text-3); background: var(--surface-2); }

/* Members table */
.user-row { transition: background 0.15s; }
.user-row.dirty  { background: rgba(245,158,11,0.06); }
.user-row.saving { background: rgba(6,182,212,0.05); }
.user-row.saved  { background: rgba(16,185,129,0.05); }
.user-row.error  { background: rgba(239,68,68,0.06); }

.user-name { font-family: var(--font-display); font-size: 16px; font-weight: 700; }
.dim { color: var(--text-3); }

.roles-checkboxes { display: flex; flex-wrap: wrap; gap: 0.6rem; }
.role-label {
  display: flex; align-items: center; gap: 0.35rem; cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2);
}
.role-label input { accent-color: var(--cyan); width: 14px; height: 14px; }
.role-label:has(input:checked) { color: var(--cyan); }
.empty-state { color: var(--text-3); font-size: 12px; padding: 1.5rem 0; text-align: center; }

.status-col { width: 110px; text-align: end; }
.status-pill {
  display: inline-block;
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text-3);
}
.status-pill.status-dirty  { color: var(--amber); border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }
.status-pill.status-saving { color: var(--cyan);  border-color: rgba(6,182,212,0.4);  background: var(--cyan-dim); }
.status-pill.status-saved  { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.status-pill.status-error  { color: var(--red);   border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.08); cursor: pointer; }

/* Pagination */
.pagination { display: flex; align-items: center; gap: 0.4rem; margin-top: 1rem; flex-wrap: wrap; }
.page-btn {
  font-family: var(--font-mono); font-size: 12px;
  padding: 0.35rem 0.6rem; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--surface); border: 1px solid var(--border); color: var(--text-2);
  min-width: 32px;
}
.page-btn:hover:not(:disabled) { border-color: var(--cyan); color: var(--cyan); }
.page-btn:disabled { opacity: 0.4; cursor: default; }
.page-btn-active { background: var(--cyan-dim); border-color: var(--cyan); color: var(--cyan); }
.page-info { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-inline-start: auto; }

/* Group-by-org toggle and CSV export sit alongside the filters */
.toggle {
  display: inline-flex; align-items: center; gap: 0.4rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2);
  padding: 0.4rem 0.7rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); cursor: pointer;
}
.toggle input { accent-color: var(--cyan); width: 14px; height: 14px; }
.toggle:has(input:checked) { color: var(--cyan); border-color: var(--cyan); background: var(--cyan-dim); }

/* Bulk action bar: sticky-feeling band that appears above the
   table whenever a row is selected */
.bulk-bar {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.7rem 1rem; margin-bottom: 0.5rem;
  background: var(--cyan-dim); border: 1px solid var(--cyan);
  border-radius: var(--radius-lg);
  animation: slideDown 0.15s ease;
}
@keyframes slideDown { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.bulk-count {
  font-family: var(--font-display); font-size: 12px; font-weight: 900;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--cyan);
  padding-inline-end: 0.5rem; border-inline-end: 1px solid rgba(6,182,212,0.3);
}
.bulk-select { max-width: 180px; padding: 0.35rem 0.55rem; font-size: 12px; }
.bulk-add    { background: var(--green-dim); color: var(--green); border: 1px solid rgba(16,185,129,0.4); }
.bulk-remove { background: rgba(239,68,68,0.08); color: var(--red); border: 1px solid rgba(239,68,68,0.4); }
.bulk-add:disabled, .bulk-remove:disabled { opacity: 0.5; cursor: default; }
.bulk-status {
  margin-inline-start: auto; font-family: var(--font-mono); font-size: 11px; color: var(--cyan);
}
.bulk-summary {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  padding: 0.4rem 0.6rem; margin-bottom: 0.5rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}

/* Group controls row */
.group-controls { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }

/* Org group header row (system admin grouped view) */
.group-head {
  background: var(--bg-2); cursor: pointer;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.group-head:hover { background: var(--bg-3); }
.group-head td {
  padding: 0.6rem 1rem;
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text);
}
.group-caret { font-size: 10px; color: var(--text-3); margin-inline-end: 0.5rem; display: inline-block; width: 10px; }
.group-name { color: var(--text); font-weight: 700; }
.group-count {
  font-family: var(--font-mono); font-size: 11px; font-weight: 400;
  color: var(--text-3); margin-inline-start: 0.6rem;
  text-transform: none; letter-spacing: 0;
}

/* Selection */
.select-col { width: 32px; text-align: center; }
.select-col input { accent-color: var(--cyan); width: 14px; height: 14px; cursor: pointer; }
.user-row.selected { background: rgba(6,182,212,0.06); }
.user-row.selected.dirty  { background: rgba(245,158,11,0.10); }
.user-row.selected.saving { background: rgba(6,182,212,0.10); }
.user-row.selected.saved  { background: rgba(16,185,129,0.10); }

/* Role pills, read-only summary in the table.
   Click anywhere on the row to open the drawer for editing. */
.role-pills {
  display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center;
}
.role-pill {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text-2);
  white-space: nowrap;
}
.role-pill-org_admin    { color: var(--role-admin-fg); border-color: rgba(139,92,246,0.45); background: rgba(139,92,246,0.10); }
.role-pill-meet_manager { color: #fbbf24; border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.10); }
.role-pill-referee      { color: #fb923c; border-color: rgba(249,115,22,0.45); background: rgba(249,115,22,0.10); }
.role-pill-judge        { color: #67e8f9; border-color: rgba(6,182,212,0.45);  background: rgba(6,182,212,0.10); }
.role-pill-coach        { color: #f472b6; border-color: rgba(236,72,153,0.45); background: rgba(236,72,153,0.10); }
.role-pill-diver        { color: #34d399; border-color: rgba(16,185,129,0.45); background: rgba(16,185,129,0.10); }
.role-pill-spectator    { color: var(--text-3); border-color: var(--border); background: var(--bg-2); opacity: 0.7; }
.role-pill-empty        { color: var(--text-3); font-style: italic; border-style: dashed; }

.role-edit-hint {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  opacity: 0; transition: opacity 0.12s;
  margin-inline-start: 0.4rem;
}
.user-row.clickable { cursor: pointer; }
.user-row.clickable:hover { background: var(--bg-2); }
.user-row.clickable:hover .role-edit-hint { opacity: 1; color: var(--cyan); }
.user-row.clickable.selected:hover  { background: rgba(6,182,212,0.10); }

/* Drawer */
.drawer-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(3, 7, 18, 0.55);
  -webkit-backdrop-filter: blur(2px);  /* iOS Safari */
  backdrop-filter: blur(2px);
}
.drawer {
  position: fixed; top: 0; inset-inline-end: 0; bottom: 0; z-index: 100;
  width: min(420px, 100vw);
  display: flex; flex-direction: column;
  background: var(--surface);
  border-inline-start: 1px solid var(--border);
  box-shadow: -10px 0 30px rgba(0,0,0,0.35);
}
.drawer-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.75rem; padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--border);
}
.drawer-id { min-width: 0; }
.drawer-name {
  font-family: var(--font-display); font-size: 22px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.1;
}
.drawer-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.4rem; word-break: break-word;
}
/* `overflow-x: clip` prevents CSS's promote-to-auto from
   making the body silently horizontally scrollable whenever
   a wide descendant exceeds the drawer's width. Bottom padding
   keeps drawer content above iOS Safari's URL/toolbar, since the
   drawer itself extends to `bottom: 0` but the toolbar overlays
   the bottom of the viewport. */
.drawer-body {
  padding: 1rem 1.25rem max(1rem, env(safe-area-inset-bottom, 1rem) + 4rem);
  overflow-y: auto;
  overflow-x: clip;
}
.drawer-section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.5rem;
}
.club-editor {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
  margin-bottom: 0.25rem;
}
.club-editor .select { flex: 1 1 200px; }
.club-create-block {
  flex-basis: 100%;
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 0.75rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-sm);
  background: var(--cyan-dim);
}
.club-status-saved {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--green);
  padding: 0.15rem 0.5rem; border-radius: 3px;
  background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.4);
}
.club-status-error {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--red);
  padding: 0.15rem 0.5rem; border-radius: 3px;
  background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.4);
}

/* Personal & competition details editor */
.profile-editor { display: flex; flex-direction: column; gap: 0.6rem; }
.profile-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem;
}
.profile-nat { max-width: 120px; letter-spacing: 0.08em; }
.profile-save-row {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  margin-top: 0.15rem;
}

/* Account lifecycle actions */
.account-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.account-suspended-row { display: flex; align-items: center; gap: 0.5rem; }

.drawer-roles { display: flex; flex-direction: column; gap: 0.3rem; }
.drawer-role {
  display: grid; grid-template-columns: 18px 1fr auto;
  align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.6rem; border-radius: var(--radius-sm);
  background: var(--bg-3); border: 1px solid var(--border); cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.drawer-role:hover { background: var(--bg-2); border-color: var(--border-2); }
.drawer-role-on    { border-color: var(--cyan); background: var(--cyan-dim); }
.drawer-role input { accent-color: var(--cyan); width: 14px; height: 14px; }
.drawer-role-name {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2);
}
.drawer-role-on .drawer-role-name { color: var(--text); }
.role-pill-inline { opacity: 0.6; }
.drawer-role-on .role-pill-inline { opacity: 1; }

.drawer-status { margin-top: 0.75rem; }
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

/* Drawer transitions */
.drawer-enter-active, .drawer-leave-active { transition: opacity 0.15s; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-panel-enter-active, .drawer-panel-leave-active { transition: transform 0.18s ease-out; }
.drawer-panel-enter-from, .drawer-panel-leave-to { transform: translateX(100%); }

/* Existing badges */
.sys-badge {
  display: inline-block;
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--bg); background: var(--cyan);
  padding: 0.15rem 0.5rem; border-radius: 3px;
  vertical-align: middle;
}
.sys-badge-inline { font-size: 9px; padding: 0.1rem 0.35rem; margin-inline-start: 0.5rem; }

.org-cell { white-space: nowrap; }
.org-stack { display: flex; flex-direction: column; gap: 0.15rem; }
.org-name { font-family: var(--font-display); font-size: 13px; font-weight: 600; color: var(--text-2); }
.org-country {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.club-line {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.club-line-empty { font-style: italic; opacity: 0.7; }
.user-email {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.15rem; word-break: break-all;
}
.club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}

/* Drawer org/club block */
.drawer-org {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
  margin-top: 0.6rem;
}
.drawer-org-name {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text-2);
}
.drawer-club {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  flex-basis: 100%;
}

/* Coach link section */
.coach-links { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.75rem; }
.coach-empty {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  padding: 0.5rem 0; font-style: italic;
}
.coach-link-row {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.coach-side {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  padding: 0.1rem 0.4rem; border-radius: 3px;
  flex-shrink: 0;
}
.coach-side-coach {
  color: #f472b6; background: rgba(236,72,153,0.10);
  border: 1px solid rgba(236,72,153,0.45);
}
.coach-side-diver {
  color: #34d399; background: rgba(16,185,129,0.10);
  border: 1px solid rgba(16,185,129,0.45);
}
.coach-other {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.coach-note {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  font-style: italic; flex-shrink: 0;
}
.coach-remove {
  padding: 0.2rem 0.5rem; min-width: auto;
  color: var(--text-3); border-color: var(--border);
}
.coach-remove:hover { color: var(--red); border-color: var(--red); }

/* Add-link form */
.coach-add {
  display: flex; flex-direction: column; gap: 0.5rem;
  padding: 0.7rem 0.8rem;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.coach-add-row {
  display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
}
.coach-add-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-3);
  white-space: nowrap;
}
.coach-add-role  { flex: 0 0 90px;  font-size: 11px; padding: 0.35rem 0.5rem; }
.coach-add-other { flex: 1 1 140px; font-size: 11px; padding: 0.35rem 0.5rem; min-width: 0; }
.coach-add-note  { font-size: 11px; padding: 0.4rem 0.55rem; }
.coach-add-btn   { align-self: flex-start; }

/* Audit history list */
.audit-empty {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  padding: 0.75rem 0; font-style: italic;
}
.audit-list {
  list-style: none; padding: 0; margin: 0;
  max-height: 280px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.audit-item {
  display: flex; align-items: flex-start; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.audit-item:last-child { border-bottom: none; }
.audit-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  font-family: var(--font-display); font-weight: 900; font-size: 12px;
  flex-shrink: 0; margin-top: 0.05rem;
}
.audit-action-granted { background: rgba(16,185,129,0.15); color: var(--green); border: 1px solid rgba(16,185,129,0.4); }
.audit-action-revoked { background: rgba(239,68,68,0.15);  color: var(--red);   border: 1px solid rgba(239,68,68,0.4); }
.audit-role {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text);
  margin-inline-end: 0.4rem;
}
.audit-meta {
  display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  flex: 1; min-width: 0;
}
.audit-time { color: var(--text-2); }
.audit-actor { color: var(--text-3); }
.audit-actor-system { font-style: italic; }
.audit-note { color: var(--text-3); }
</style>
