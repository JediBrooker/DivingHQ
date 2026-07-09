<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { cachedFetch, idbDelete } from '@/lib/idbCache'
import { isValidPassword } from '@/lib/passwordPolicy'
import { showSuccess } from '@/composables/useNotify'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

// Migration 053 surfaces: self-delete + reunite-on-return.
import DeleteAccountDialog   from '@/components/DeleteAccountDialog.vue'
import ClaimCandidatesModal  from '@/components/ClaimCandidatesModal.vue'
// Preferences (own profile): appearance + language, per the redesign.
import ThemeToggle from '@/components/ThemeToggle.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import { Palette, Languages } from '@lucide/vue'

// Per-widget components, see src/components/profile-widgets/.
// Each takes a `data` prop (the relevant analytics / profile
// slice) and renders its own .card block. Two of them also need
// auxiliary props: RecentFormWidget wants targetId for the
// score-sheet link, and ComparePeersWidget wants the org name
// for its header. `widgetProps()` below routes those through.
import ScoreTrendWidget       from '@/components/profile-widgets/ScoreTrendWidget.vue'
import PersonalBestsWidget    from '@/components/profile-widgets/PersonalBestsWidget.vue'
import RecentFormWidget       from '@/components/profile-widgets/RecentFormWidget.vue'
import PlacingsWidget         from '@/components/profile-widgets/PlacingsWidget.vue'
import HeightBreakdownWidget  from '@/components/profile-widgets/HeightBreakdownWidget.vue'
import RoundStaminaWidget     from '@/components/profile-widgets/RoundStaminaWidget.vue'
import QualityMixWidget       from '@/components/profile-widgets/QualityMixWidget.vue'
import DdRiskWidget           from '@/components/profile-widgets/DdRiskWidget.vue'
import FrequentDivesWidget    from '@/components/profile-widgets/FrequentDivesWidget.vue'
import StreakWidget           from '@/components/profile-widgets/StreakWidget.vue'
import ComparePeersWidget     from '@/components/profile-widgets/ComparePeersWidget.vue'
import EventTypeSplitsWidget  from '@/components/profile-widgets/EventTypeSplitsWidget.vue'
import YearOverYearWidget     from '@/components/profile-widgets/YearOverYearWidget.vue'

const route = useRoute()
const auth = useAuthStore()
const { t } = useI18n()

const profile = ref(null)
const loading = ref(false)
const error = ref('')
// True while we're rendering a stale (cached) copy and waiting
// for the network refresh to land. Surfaces as a small banner
// on the page so the diver knows the data is being verified.
const fromCache = ref(false)

// Analytics payload, populated alongside the profile via a
// seperate /analytics call so the heavy aggregations don't block
// the main profile render.
const analytics = ref(null)
const analyticsLoading = ref(false)

// Self-serve dashboard. The diver picks which widgets to show on
// their profile; the choices persist via PUT /api/users/me/dashboard.
// Catalog is the source of truth for labels + descriptions; the
// backend validates against the same set of IDs.
const WIDGET_CATALOG = [
  { id: 'score_trend',       label: 'Score Trend',           desc: 'Total scores across meets over time, as a line chart.' },
  { id: 'personal_bests',    label: 'Personal Bests',        desc: 'Best dive total per (code + position + height).' },
  { id: 'recent_form',       label: 'Recent Form',           desc: 'Last 5 meets with finishing position and total.' },
  { id: 'placings',          label: 'Medal Counts',          desc: 'Lifetime tally of gold / silver / bronze + finalist appearances.' },
  { id: 'height_breakdown',  label: 'Height Breakdown',      desc: 'Average and best dive total per board height.' },
  { id: 'round_stamina',     label: 'Round-by-Round Form',   desc: 'Average score by round number — do you fade in later rounds?' },
  { id: 'quality_mix',       label: 'Score Quality Mix',     desc: 'Distribution of judge scores across the World Aquatics categories.' },
  { id: 'dd_risk',           label: 'DD Risk Profile',       desc: 'Average + max DD attempted; how you score at the upper bound.' },
  { id: 'frequent_dives',    label: 'Go-To Dives',           desc: 'Top 5 most-attempted dives with avg / best totals.' },
  { id: 'streak',            label: 'Current Streak',        desc: 'Consecutive top-3 / top-1 finishes from your most recent meet.' },
  { id: 'compare_peers',     label: 'Compare to Peers',      desc: 'Your average DD and dive scores vs. the rest of your organisation.' },
  { id: 'event_type_splits', label: 'Synchro vs Individual', desc: 'Per-event-type split: meets, dive count, average + best totals.' },
  { id: 'year_over_year',    label: 'Year-over-Year',        desc: 'Calendar-year deltas: meets, average, best, podiums per year.' },
]
const customizing = ref(false)
const customizeSaving = ref(false)
const customizeErr = ref('')
// Index of the widget currently being dragged in the customize modal,
// or null when no drag is in progress. Used to drive the drop-target
// styling and to re-order on drop.
const dragIndex = ref(null)
const dragOverIndex = ref(null)
// Date-range filter state. Empty strings = "no filter on that side".
// The two inputs round-trip through query params on the analytics
// endpoint; the cache key in IndexedDB is the URL, so each distinct
// range gets its own cached payload.
const fromDate = ref('')
const toDate = ref('')

const enabledWidgets = computed(() =>
  Array.isArray(profile.value?.dashboard_widgets)
    ? profile.value.dashboard_widgets
    : ['score_trend', 'personal_bests', 'recent_form', 'placings'],
)
// Display order on the dashboard mirrors the saved order in
// dashboard_widgets, but only includes IDs that are still in the
// catalog (so a future widget removal doesn't leave a ghost entry).
const orderedEnabled = computed(() => {
  const known = new Set(WIDGET_CATALOG.map(w => w.id))
  return enabledWidgets.value.filter(id => known.has(id))
})
function isEnabled(id) { return enabledWidgets.value.includes(id) }
// Order index used by each widget card's inline `style="order: N"`
// so the dashboard reflects the saved drag order without repeating
// the entire template inside a v-for.
function widgetOrder(id) {
  const idx = orderedEnabled.value.indexOf(id)
  return idx === -1 ? 999 : idx
}
async function saveWidgets(next) {
  customizeSaving.value = true
  customizeErr.value = ''
  try {
    const r = await auth.apiFetch('/api/users/me/dashboard', {
      method: 'PUT',
      body: JSON.stringify({ widgets: next }),
    })
    profile.value.dashboard_widgets = r.widgets
  } catch (err) {
    customizeErr.value = err.message || 'Save failed'
  } finally {
    customizeSaving.value = false
  }
}
async function toggleWidget(id) {
  if (!isSelf.value) return
  const next = isEnabled(id)
    ? enabledWidgets.value.filter(w => w !== id)
    : [...enabledWidgets.value, id]
  await saveWidgets(next)
}

// Customize modal builds its own list (catalog order, with enabled
// items first in saved order, then disabled items in catalog order)
// so drag-to-reorder operates on a stable, complete list.
const customizeList = computed(() => {
  const enabledSet = new Set(enabledWidgets.value)
  // Enabled, in saved order; fall back to catalog order for any
  // saved IDs that aren't in the catalog (defensive).
  const enabledOrdered = enabledWidgets.value
    .filter(id => enabledSet.has(id))
    .map(id => WIDGET_CATALOG.find(w => w.id === id))
    .filter(Boolean)
  const disabled = WIDGET_CATALOG.filter(w => !enabledSet.has(w.id))
  return [...enabledOrdered, ...disabled]
})

function onDragStart(idx, ev) {
  dragIndex.value = idx
  // Required for Firefox drag init.
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    try { ev.dataTransfer.setData('text/plain', String(idx)) } catch { /* ignore */ }
  }
}
function onDragOver(idx, ev) {
  if (dragIndex.value == null) return
  ev.preventDefault()  // allow drop
  dragOverIndex.value = idx
}
function onDragLeave(idx) {
  if (dragOverIndex.value === idx) dragOverIndex.value = null
}
async function onDrop(idx, ev) {
  ev.preventDefault()
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from == null || from === idx) return
  // Apply the move to a copy of the customize list, then derive the
  // new enabled-only order from it (drag works across enabled +
  // disabled rows; only enabled IDs get persisted to the server).
  const list = customizeList.value.slice()
  const [moved] = list.splice(from, 1)
  list.splice(idx, 0, moved)
  const enabledSet = new Set(enabledWidgets.value)
  const next = list.map(w => w.id).filter(id => enabledSet.has(id))
  await saveWidgets(next)
}
function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

// Apply the date-range filter: re-fetches profile + analytics with
// the new query params. Triggered by the Apply button so a half-typed
// date doesn't fire a request mid-keystroke.
async function applyDateFilter() {
  await load()
}
function clearDateFilter() {
  fromDate.value = ''
  toDate.value = ''
  load()
}

// Build the query string for /profile and /analytics. Empty when no
// filter is set, otherwise leading "?".
function dateQS() {
  const parts = []
  if (fromDate.value) parts.push(`from_date=${encodeURIComponent(fromDate.value)}`)
  if (toDate.value)   parts.push(`to_date=${encodeURIComponent(toDate.value)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// Print / "save as PDF": relies on the browser's print dialog and
// our @media print stylesheet, which hides headers, buttons, and
// modals so the dashboard cards print cleanly across pages.
function exportPDF() {
  // Add a body class so print CSS can also kick in if the dialog is
  // dismissed (e.g. user takes a screenshot). Removed on afterprint.
  document.body.classList.add('printing-dashboard')
  const cleanup = () => {
    document.body.classList.remove('printing-dashboard')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  // Defer to next frame so the class lands before the print snapshot.
  requestAnimationFrame(() => window.print())
}

// :id route param is optional, falls back to the logged-in user.
const targetId = computed(() => route.params.id || auth.user?.id)
const isSelf = computed(() => targetId.value && targetId.value === auth.user?.id)

// Inline club edit state
const editing = ref(false)
const clubs = ref([])
const clubChoice = ref('')           // selected club_id or ''
const savingClub = ref(false)
const saveError = ref('')

// Password change state
const pwEditing  = ref(false)
const pwCurrent  = ref('')
const pwNew      = ref('')
const pwConfirm  = ref('')
const pwSaving   = ref(false)
const pwError    = ref('')
const pwSuccess  = ref(false)

function openPasswordEditor() {
  pwEditing.value = true
  pwCurrent.value = ''
  pwNew.value = ''
  pwConfirm.value = ''
  pwError.value = ''
  pwSuccess.value = false
}

// =============================================================
// Email change: Migration 044.
//
// Two-step flow: user confirms password + types a new email, we
// POST to /api/users/me/email/change-request, server mails a
// verification link to the NEW address. Clicking the link lands
// the user on /confirm-email-change (separate view), which posts
// the token to /api/auth/confirm-email-change and swaps the
// email server-side. Confirming bumps token_version so every
// session is forced through re-login.
// =============================================================
const emEditing  = ref(false)
const emNew      = ref('')
const emPassword = ref('')
const emSaving   = ref(false)
const emError    = ref('')
const emSuccess  = ref('')

function openEmailEditor() {
  emEditing.value = true
  emNew.value = ''
  emPassword.value = ''
  emError.value = ''
  emSuccess.value = ''
}
function closeEmailEditor() {
  emEditing.value = false
  emError.value = ''
}
async function saveEmail() {
  emError.value = ''
  emSuccess.value = ''
  const v = (emNew.value || '').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    emError.value = 'Enter a valid email address'
    return
  }
  if (!emPassword.value) {
    emError.value = 'Current password is required to change your email'
    return
  }
  emSaving.value = true
  try {
    const body = await auth.apiFetch('/api/users/me/email/change-request', {
      method: 'POST',
      body: JSON.stringify({
        new_email: v,
        current_password: emPassword.value,
      }),
    })
    emSuccess.value = body?.message
      || 'Check your new email inbox for a confirmation link. It expires in 30 minutes.'
    emPassword.value = ''
  } catch (err) {
    emError.value = err.message || 'Email change request failed'
  } finally {
    emSaving.value = false
  }
}

// =============================================================
// 2FA: Two-Factor Auth setup / disable. Backed by:
//   GET  /api/auth/2fa/status   { enabled, recovery_codes_remaining }
//   POST /api/auth/2fa/setup    → { base32, otpauth_url, qr_data_url, recovery_codes[] }
//   POST /api/auth/2fa/confirm  { code } → enables
//   POST /api/auth/2fa/disable  { password, code } → disables
//
// The flow is a small state machine:
//   stage = 'idle'    panel shows enabled/disabled status
//   stage = 'setup'   we have a fresh secret + QR; user enters code
//   stage = 'disable' user must provide password + a current code
// =============================================================
const tfaOpen   = ref(false)
// Lock background scroll for every modal on this profile screen.
// DeleteAccountDialog + ClaimCandidatesModal lock themselves via
// their own useBodyScrollLock calls, the composable's reference
// counter means double-locking is safe.
useBodyScrollLock().lockWhile(computed(() =>
  customizing.value || editing.value ||
  pwEditing.value || emEditing.value || tfaOpen.value
))
const tfaStage  = ref('idle')               // idle | setup | disable
const tfaStatus = ref(null)                  // { enabled, recovery_codes_remaining }
const tfaSetup  = ref(null)                  // { base32, qr_data_url, recovery_codes[] }
const tfaCode   = ref('')                    // 6-digit input
const tfaPassword = ref('')                  // for disable flow
const tfaError  = ref('')
const tfaBusy   = ref(false)
const tfaToast  = ref('')                    // success message

async function openTfa() {
  tfaOpen.value = true
  tfaStage.value = 'idle'
  tfaError.value = ''
  tfaCode.value = ''
  tfaPassword.value = ''
  tfaSetup.value = null
  tfaToast.value = ''
  await refreshTfaStatus()
}
function closeTfa() {
  tfaOpen.value = false
  tfaStage.value = 'idle'
  tfaError.value = ''
  // Drop the secret if the user closed mid-setup, no big deal,
  // they'll get a fresh one on the next attempt.
  tfaSetup.value = null
}
async function refreshTfaStatus() {
  try {
    tfaStatus.value = await auth.apiFetch('/api/auth/2fa/status')
  } catch (err) {
    tfaError.value = err.message || 'Could not load 2FA status'
  }
}
async function startTfaSetup() {
  tfaError.value = ''
  tfaBusy.value = true
  try {
    tfaSetup.value = await auth.apiFetch('/api/auth/2fa/setup', { method: 'POST' })
    tfaStage.value = 'setup'
    tfaCode.value = ''
  } catch (err) {
    tfaError.value = err.message || 'Could not start 2FA setup'
  } finally {
    tfaBusy.value = false
  }
}
async function confirmTfaSetup() {
  tfaError.value = ''
  if (!/^\d{6}$/.test(tfaCode.value)) {
    tfaError.value = 'Enter the 6-digit code from your authenticator'
    return
  }
  tfaBusy.value = true
  try {
    await auth.apiFetch('/api/auth/2fa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code: tfaCode.value }),
    })
    // Confirm bumps token_version server-side, which invalidates
    // the current session JWT. Force a re-login so the next API
    // call doesn't 401 silently.
    tfaToast.value = '2FA enabled. You\'ll be asked for a code on your next login.'
    tfaStage.value = 'idle'
    setTimeout(() => { auth.clearSession(); window.location.assign('/login') }, 2000)
  } catch (err) {
    tfaError.value = err.message || 'Could not confirm 2FA'
  } finally {
    tfaBusy.value = false
  }
}
function startTfaDisable() {
  tfaStage.value = 'disable'
  tfaError.value = ''
  tfaCode.value = ''
  tfaPassword.value = ''
}
async function confirmTfaDisable() {
  tfaError.value = ''
  if (!tfaPassword.value) {
    tfaError.value = 'Password is required'
    return
  }
  if (!/^\d{6}$/.test(tfaCode.value) && !/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(tfaCode.value)) {
    tfaError.value = 'Enter a 6-digit TOTP code or a recovery code'
    return
  }
  tfaBusy.value = true
  try {
    await auth.apiFetch('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({
        password: tfaPassword.value,
        code:     tfaCode.value,
      }),
    })
    tfaToast.value = '2FA disabled.'
    tfaStage.value = 'idle'
    await refreshTfaStatus()
  } catch (err) {
    tfaError.value = err.message || 'Could not disable 2FA'
  } finally {
    tfaBusy.value = false
  }
}
function closePasswordEditor() {
  pwEditing.value = false
  pwError.value = ''
}
async function savePassword() {
  pwError.value = ''
  if (!isValidPassword(pwNew.value)) {
    pwError.value = t('auth.reset.min_length_error')
    return
  }
  if (pwNew.value !== pwConfirm.value) {
    pwError.value = 'New passwords don\'t match'
    return
  }
  pwSaving.value = true
  try {
    const data = await auth.apiFetch('/api/users/me/password', {
      method: 'PUT',
      body: JSON.stringify({
        current_password: pwCurrent.value,
        new_password:     pwNew.value,
      }),
    })
    if (data?.token) auth.saveSession(data)
    pwSuccess.value = true
    setTimeout(() => { pwEditing.value = false; pwSuccess.value = false }, 1200)
  } catch (err) {
    pwError.value = err.message || 'Password change failed'
  } finally {
    pwSaving.value = false
  }
}

async function load() {
  if (!targetId.value) return
  const url = `/api/divers/${targetId.value}/profile${dateQS()}`
  loading.value = true
  error.value = ''
  fromCache.value = false
  try {
    // Stale-while-revalidate via IndexedDB. If we have a cached
    // copy from a previous load it shows instantly; the network
    // call updates it underneath. Critical for diver phones on
    // poolside wifi: the app stays usable when the network
    // momentarily drops.
    const result = await cachedFetch(
      url,
      {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',  // sends the httpOnly session cookie
      },
      {
        // Scope the cache to the signed-in identity so an owner's
        // private profile fields never get served to the next viewer
        // on a shared device (the fingerprint used to come off the
        // Authorization header, which the cookie replaced).
        fingerprint: auth.fingerprint,
        onUpdate(fresh) {
          profile.value = fresh
          fromCache.value = false
        },
      },
    )
    if (result.data) {
      profile.value = result.data
      fromCache.value = result.fromCache
    } else if (!profile.value) {
      error.value = 'Offline and no cached profile yet'
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
  // Analytics in parallel, separate endpoint so it doesn't
  // block the headline-stats / personal-bests / score-trend
  // render. Cached too, so a return visit feels instant.
  loadAnalytics()
}

async function loadAnalytics() {
  if (!targetId.value) return
  analyticsLoading.value = true
  try {
    const result = await cachedFetch(
      `/api/divers/${targetId.value}/analytics${dateQS()}`,
      {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',  // sends the httpOnly session cookie
      },
      {
        fingerprint: auth.fingerprint,
        onUpdate(fresh) { analytics.value = fresh },
      },
    )
    if (result.data) analytics.value = result.data
  } finally {
    analyticsLoading.value = false
  }
}

async function openClubEditor() {
  saveError.value = ''
  editing.value = true
  clubChoice.value = profile.value?.diver?.club_id ?? ''
  // Lazy-load clubs only when the editor opens
  try {
    const orgId = profile.value?.diver?.org_id
    if (!orgId) { clubs.value = []; return }
    const body = await auth.apiFetch(`/api/orgs/${orgId}/clubs`)
    clubs.value = Array.isArray(body) ? body : []
  } catch {
    clubs.value = []
  }
}

function closeClubEditor() {
  editing.value = false
  saveError.value = ''
}

async function saveClub() {
  savingClub.value = true
  saveError.value = ''
  try {
    await auth.apiFetch(`/api/users/${targetId.value}/club`, {
      method: 'PUT',
      body: JSON.stringify({ club_id: clubChoice.value || null }),
    })
    // Reflect new club in the local profile so the header updates
    if (clubChoice.value) {
      const c = clubs.value.find(c => c.id === clubChoice.value)
      profile.value.diver.club_id   = clubChoice.value
      profile.value.diver.club_name = c?.name ?? null
      profile.value.diver.club_code = c?.short_code ?? null
    } else {
      profile.value.diver.club_id   = null
      profile.value.diver.club_name = null
      profile.value.diver.club_code = null
    }
    editing.value = false
  } catch (err) {
    saveError.value = err.message
  } finally {
    savingClub.value = false
  }
}

// =========================================================
// Widget registry: maps each dashboard widget id to its Vue
// component, plus how to look up the data slice + extra props
// each component needs. The v-for in the template renders one
// `<component :is>` per enabled id; this object is the routing
// layer so the template doesn't carry per-widget branches.
// =========================================================
const widgets = {
  score_trend:       ScoreTrendWidget,
  personal_bests:    PersonalBestsWidget,
  recent_form:       RecentFormWidget,
  placings:          PlacingsWidget,
  height_breakdown:  HeightBreakdownWidget,
  round_stamina:     RoundStaminaWidget,
  quality_mix:       QualityMixWidget,
  dd_risk:           DdRiskWidget,
  frequent_dives:    FrequentDivesWidget,
  streak:            StreakWidget,
  compare_peers:     ComparePeersWidget,
  event_type_splits: EventTypeSplitsWidget,
  year_over_year:    YearOverYearWidget,
}
// score_trend + personal_bests are baked into the /profile
// response (heavy aggregates that already live on the row).
// Everything else comes from /analytics, which loads in parallel.
function widgetData(id) {
  if (id === 'score_trend')    return profile.value?.score_trend
  if (id === 'personal_bests') return profile.value?.personal_bests
  return analytics.value?.[id]
}
function widgetExtraProps(id) {
  if (id === 'recent_form') {
    return { targetId: targetId.value, loading: analyticsLoading.value }
  }
  if (id === 'compare_peers') {
    return { orgName: profile.value?.diver?.org_name || '' }
  }
  return {}
}

onMounted(load)
watch(targetId, load)

// --------------------------------------------------------------
// Account deletion + claim-past-results (Migration 053)
//
// Both flows live behind buttons in the danger zone at the
// bottom of the page. Self-only: public visitors and other
// org members never see them.
// --------------------------------------------------------------
const router = useRouter()
const deleteOpen = ref(false)
const claimOpen = ref(false)
const claimEmpty = ref(false)
const claimChecking = ref(false)

function openDeleteDialog() {
  deleteOpen.value = true
}

async function onAccountDeleted() {
  // Clear in-process auth + storage. The server already
  // invalidated the JWT (token_version bump) so any in-flight
  // request would 401 anyway, but explicit local cleanup means
  // the next view doesn't try to render stale "me" data.
  deleteOpen.value = false
  auth.clearSession()
  showSuccess(t('profile.delete.confirmation_toast'), { timeoutMs: 10000 })
  router.push('/')
}

// Manual "Find past competition entries" entry point. Kicks
// off a claim-candidates fetch, and if the server returns >0
// candidates we surface the modal; if zero, show a fleeting
// "nothing found" notice instead so the user at least knows
// the button did something.
async function openClaimDialog() {
  if (!isSelf.value) return
  claimChecking.value = true
  claimEmpty.value = false
  try {
    const data = await auth.apiFetch('/api/users/me/claim-candidates', {
      method: 'POST',
    })
    const list = Array.isArray(data?.candidates) ? data.candidates : []
    if (list.length === 0) {
      claimEmpty.value = true
      setTimeout(() => { claimEmpty.value = false }, 4000)
      return
    }
    claimOpen.value = true
  } catch (err) {
    // Surface server errors as a transient warning; the danger
    // zone isn't a primary path so we don't take over the page.
    claimEmpty.value = false
    showSuccess(err?.message || 'Failed to look up past entries')
  } finally {
    claimChecking.value = false
  }
}

function onClaimed() {
  claimOpen.value = false
  showSuccess(t('profile.claim.success_toast'))
  // Re-fetch the profile so the freshly-linked dives appear
  // in the widgets without a hard reload.
  load()
}
</script>

<template>
  <div class="profile-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Diver Profile</div>
        <h1 class="page-title">{{ profile?.diver?.full_name || 'Loading…' }}</h1>
        <div v-if="profile?.diver" class="page-sub">
          {{ profile.diver.org_name }}
          <span v-if="profile.diver.country_code"> · {{ profile.diver.country_code }}</span>
          <span v-if="profile.diver.club_name" class="page-sub-club">
            · {{ profile.diver.club_name }}<span v-if="profile.diver.club_code" class="club-code">{{ profile.diver.club_code }}</span>
          </span>
        </div>
      </div>
      <div class="header-actions">
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="customizing = true">
          ⚙ Customize
        </button>
        <button v-if="profile" class="btn btn-ghost btn-sm" @click="exportPDF" v-tip="'Open print dialog — choose \'Save as PDF\' to export.'">
          📄 Export PDF
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openClubEditor">
          Change Club
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openEmailEditor">
          Change Email
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openPasswordEditor">
          Change Password
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openTfa">
          🔐 Two-Factor Auth
        </button>
        <!-- Public visitors land here from a scoreboard diver-link
             with no session. Send them somewhere useful instead of
             a Dashboard link they can't enter. -->
        <RouterLink v-if="auth.isLoggedIn" to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
        <RouterLink v-else to="/scoreboard" class="btn btn-ghost btn-sm">← Scoreboard</RouterLink>
        <RouterLink v-if="!auth.isLoggedIn" to="/login" class="btn btn-primary btn-sm">Sign in</RouterLink>
      </div>
    </div>

    <!-- Date-range filter strip. Applies to every aggregate widget;
         empty fields = no filter on that side. The Apply button
         deliberately requires a click so partial input doesn't fire
         a request mid-edit. -->
    <div v-if="profile" class="filter-strip no-print">
      <span class="filter-label">Date range</span>
      <input type="date" class="filter-input" v-model="fromDate" :max="toDate || undefined" aria-label="From date">
      <span class="filter-sep">→</span>
      <input type="date" class="filter-input" v-model="toDate" :min="fromDate || undefined" aria-label="To date">
      <button class="btn btn-primary btn-sm" @click="applyDateFilter" :disabled="loading">
        Apply
      </button>
      <button v-if="fromDate || toDate" class="btn btn-ghost btn-sm" @click="clearDateFilter">
        Clear
      </button>
      <span v-if="fromDate || toDate" class="filter-active">
        Showing {{ fromDate || '…' }} → {{ toDate || 'today' }}
      </span>
    </div>

    <div v-if="loading && !profile" class="empty">Loading profile…</div>
    <div v-else-if="fromCache" class="cache-banner">
      <span class="cache-dot"></span>
      Showing your last saved copy — refreshing in the background
    </div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="profile" class="content">
      <!-- Headline stats: always pinned to the top via order: -1 -->
      <div class="stats-row" :style="{ order: -1 }">
        <div class="stat">
          <div class="stat-num">{{ profile.stats.total_meets || 0 }}</div>
          <div class="stat-label">Meets Entered</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ profile.stats.total_dives || 0 }}</div>
          <div class="stat-label">Dives Performed</div>
        </div>
        <div class="stat">
          <div class="stat-num">
            {{ profile.stats.avg_dd != null ? Number(profile.stats.avg_dd).toFixed(2) : '—' }}
          </div>
          <div class="stat-label">Avg DD Attempted</div>
        </div>
        <div class="stat">
          <div class="stat-num">
            {{ profile.stats.best_single_dive != null ? Number(profile.stats.best_single_dive).toFixed(1) : '—' }}
          </div>
          <div class="stat-label">Best Single Dive</div>
        </div>
      </div>

      <!-- Dashboard widgets: one component per id, in saved
           order. The wrapper carries the CSS `order` so drag-
           reorder still works without forcing every widget root
           to re-declare `:style`. Empty wrappers (e.g. StreakWidget
           with no active streak) get hidden via `.widget-slot:empty`. -->
      <div
        v-for="id in orderedEnabled"
        :key="id"
        class="widget-slot"
        :style="{ order: widgetOrder(id) }"
      >
        <component
          :is="widgets[id]"
          :data="widgetData(id)"
          v-bind="widgetExtraProps(id)"
        />
      </div>
    </div>

    <!-- Danger zone: self-delete + claim-past-results entry
         points. Self-only; never rendered for visitors viewing
         someone else's profile. Pinned to the bottom via a high
         CSS order so account-management actions stay below the
         analytics widgets even when widgets get reordered. -->
    <!-- Preferences (own profile only): appearance + language.
         Surfaced here per the redesign; both controls persist
         globally (theme via the ui store, locale via vue-i18n). -->
    <section v-if="isSelf" class="pref-section" :style="{ order: 9000 }">
      <h2 class="pref-title">Preferences</h2>
      <div class="pref-card">
        <div class="set-row">
          <div class="set-row-info">
            <div class="set-ic"><Palette /></div>
            <div>
              <div class="set-title">Appearance</div>
              <div class="set-desc">Choose a light or dark theme. Applies across DivingHQ on this device.</div>
            </div>
          </div>
          <div class="set-control"><ThemeToggle /></div>
        </div>
        <div class="set-row">
          <div class="set-row-info">
            <div class="set-ic"><Languages /></div>
            <div>
              <div class="set-title">Language</div>
              <div class="set-desc">Pick the language for the interface. Your choice is remembered on this device.</div>
            </div>
          </div>
          <div class="set-control"><LocaleSwitcher /></div>
        </div>
      </div>
    </section>

    <section
      v-if="profile && isSelf"
      class="danger-zone"
      :style="{ order: 9999 }"
      data-test-id="profile-danger-zone"
    >
      <h2 class="danger-title">{{ $t('profile.section_danger') }}</h2>
      <div class="danger-row">
        <div class="danger-text">
          <div class="danger-row-title">{{ $t('profile.claim.title') }}</div>
          <p class="danger-body">
            <span v-if="claimEmpty">{{ $t('profile.claim.find_none') }}</span>
          </p>
        </div>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="claimChecking"
          @click="openClaimDialog"
          data-test-id="claim-find-button"
        >
          {{ claimChecking ? '…' : $t('profile.claim.find_button') }}
        </button>
      </div>
      <div class="danger-row danger-row-destructive">
        <div class="danger-text">
          <div class="danger-row-title">{{ $t('profile.delete.title') }}</div>
          <p class="danger-body">{{ $t('profile.delete.body') }}</p>
        </div>
        <button
          class="btn btn-danger btn-sm"
          @click="openDeleteDialog"
          data-test-id="delete-account-button"
        >
          {{ $t('profile.delete.action') }}
        </button>
      </div>
    </section>
  </div>

  <DeleteAccountDialog
    v-if="deleteOpen"
    @close="deleteOpen = false"
    @deleted="onAccountDeleted"
  />

  <ClaimCandidatesModal
    v-if="claimOpen"
    variant="manual"
    @close="claimOpen = false"
    @skipped="claimOpen = false"
    @claimed="onClaimed"
  />

  <!-- Customize Dashboard modal: toggle on/off + drag-to-reorder.
       Order is taken from `customizeList`: enabled widgets first
       (in saved order), then disabled widgets. Dragging a row
       commits a new order through PUT /api/users/me/dashboard. -->
  <div v-if="customizing" class="modal-backdrop" @click.self="customizing = false">
    <div class="modal customize-modal">
      <div class="modal-head">
        <div class="modal-title">Customize Dashboard</div>
        <button class="btn btn-ghost btn-sm" @click="customizing = false">Done</button>
      </div>
      <div class="modal-body">
        <p class="modal-hint" style="margin-top:0">
          Toggle widgets on or off. Drag the ⋮⋮ handle to re-order.
          Changes save automatically.
        </p>
        <div class="widget-toggles" @dragend="onDragEnd">
          <div
            v-for="(w, idx) in customizeList"
            :key="w.id"
            :class="['widget-toggle',
                     { 'is-dragging': dragIndex === idx,
                       'is-drop-target': dragOverIndex === idx && dragIndex !== idx,
                       'is-disabled': !isEnabled(w.id) }]"
            :draggable="isSelf"
            @dragstart="onDragStart(idx, $event)"
            @dragover="onDragOver(idx, $event)"
            @dragleave="onDragLeave(idx)"
            @drop="onDrop(idx, $event)"
          >
            <span class="drag-handle" v-tip="isSelf ? 'Drag to re-order' : ''">⋮⋮</span>
            <input type="checkbox"
                   :checked="isEnabled(w.id)"
                   :disabled="customizeSaving || !isSelf"
                   @change="toggleWidget(w.id)">
            <div class="widget-toggle-text">
              <div class="widget-toggle-label">{{ w.label }}</div>
              <div class="widget-toggle-desc">{{ w.desc }}</div>
            </div>
          </div>
        </div>
        <div v-if="customizeErr" class="msg msg-error">{{ customizeErr }}</div>
      </div>
    </div>
  </div>

  <!-- Club edit modal -->
  <div v-if="editing" class="modal-backdrop" @click.self="closeClubEditor">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Change Club</div>
        <button class="btn btn-ghost btn-sm" @click="closeClubEditor">Close ✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">Club ({{ profile?.diver?.org_name || 'your organisation' }})</label>
          <select class="select" v-model="clubChoice">
            <option value="">— No club / independent —</option>
            <option v-for="c in clubs" :key="c.id" :value="c.id">
              {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
            </option>
          </select>
          <p v-if="!clubs.length" class="modal-hint">
            No clubs are registered for your organisation yet. Ask your org admin to create one,
            or <RouterLink to="/users">manage clubs from the User Manager</RouterLink> if you have access.
          </p>
        </div>
        <div v-if="saveError" class="msg msg-error">{{ saveError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" @click="closeClubEditor">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="savingClub" @click="saveClub">
            {{ savingClub ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Password change modal -->
  <div v-if="pwEditing" class="modal-backdrop" @click.self="closePasswordEditor">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Change Password</div>
        <button class="btn btn-ghost btn-sm" @click="closePasswordEditor">Close ✕</button>
      </div>
      <div class="modal-body">
        <div v-if="pwSuccess" class="msg msg-success">Password updated</div>
        <template v-else>
          <div class="field">
            <label class="label">Current password</label>
            <input class="input" type="password" autocomplete="current-password" v-model="pwCurrent">
          </div>
          <div class="field">
            <label class="label">New password</label>
            <input class="input" type="password" autocomplete="new-password" v-model="pwNew">
            <p class="modal-hint">{{ $t('auth.reset.min_length_error') }}</p>
          </div>
          <div class="field">
            <label class="label">Confirm new password</label>
            <input class="input" type="password" autocomplete="new-password" v-model="pwConfirm">
          </div>
          <div v-if="pwError" class="msg msg-error">{{ pwError }}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost btn-sm" @click="closePasswordEditor">Cancel</button>
            <button class="btn btn-primary btn-sm" :disabled="pwSaving" @click="savePassword">
              {{ pwSaving ? 'Saving…' : 'Save Password' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- Email change modal: Migration 044. -->
  <div v-if="emEditing" class="modal-backdrop" @click.self="closeEmailEditor">
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Change Email</div>
        <button class="btn btn-ghost btn-sm" @click="closeEmailEditor">Close ✕</button>
      </div>
      <div class="modal-body">
        <div v-if="emSuccess" class="msg msg-success">{{ emSuccess }}</div>
        <template v-else>
          <p class="modal-hint">
            We'll send a confirmation link to the new address — your
            email won't change until you click it. The link expires in
            30 minutes. Once confirmed you'll be signed out of every
            device for safety.
          </p>
          <div class="field">
            <label class="label">New email address</label>
            <input
              class="input"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              v-model="emNew"
            >
          </div>
          <div class="field">
            <label class="label">Current password</label>
            <input
              class="input"
              type="password"
              autocomplete="current-password"
              v-model="emPassword"
            >
          </div>
          <div v-if="emError" class="msg msg-error">{{ emError }}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost btn-sm" @click="closeEmailEditor">Cancel</button>
            <button class="btn btn-primary btn-sm" :disabled="emSaving" @click="saveEmail">
              {{ emSaving ? 'Sending…' : 'Send confirmation link' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- Two-Factor Auth modal: three-stage state machine. -->
  <div v-if="tfaOpen" class="modal-backdrop" @click.self="closeTfa">
    <div class="modal tfa-modal">
      <div class="modal-head">
        <div class="modal-title">Two-Factor Auth</div>
        <button class="btn btn-ghost btn-sm" @click="closeTfa">Close ✕</button>
      </div>
      <div class="modal-body">
      <div v-if="tfaToast" class="msg msg-success">{{ tfaToast }}</div>

      <!-- Stage: idle (status display + entry point) -->
      <template v-if="tfaStage === 'idle' && tfaStatus">
        <div v-if="tfaStatus.enabled" class="tfa-status tfa-status-on">
          <span class="tfa-badge">ENABLED</span>
          <p>
            Two-factor auth is on for this account. You'll be asked
            for a 6-digit code from your authenticator app on every
            login.
            <span v-if="tfaStatus.recovery_codes_remaining != null">
              <strong>{{ tfaStatus.recovery_codes_remaining }}</strong>
              recovery code{{ tfaStatus.recovery_codes_remaining === 1 ? '' : 's' }} remaining.
            </span>
          </p>
        </div>
        <div v-else class="tfa-status tfa-status-off">
          <span class="tfa-badge tfa-badge-off">OFF</span>
          <p>
            Two-factor auth adds a 6-digit code (from an
            authenticator app like 1Password, Authy, or Google
            Authenticator) on top of your password at login. We
            strongly recommend it for any account that runs meets.
          </p>
        </div>
        <div v-if="tfaError" class="msg msg-error">{{ tfaError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" @click="closeTfa">Close</button>
          <button v-if="tfaStatus.enabled"
                  class="btn btn-primary btn-sm tfa-disable-btn"
                  :disabled="tfaBusy"
                  @click="startTfaDisable">Disable 2FA</button>
          <button v-else
                  class="btn btn-primary btn-sm"
                  :disabled="tfaBusy"
                  @click="startTfaSetup">{{ tfaBusy ? 'Starting…' : 'Enable 2FA' }}</button>
        </div>
      </template>

      <!-- Stage: setup (show QR + recovery codes, ask for code) -->
      <template v-else-if="tfaStage === 'setup' && tfaSetup">
        <p class="tfa-step">
          1. Scan this QR code with your authenticator app, or paste
          the secret manually.
        </p>
        <div class="tfa-qr">
          <img :src="tfaSetup.qr_data_url" alt="2FA QR code" width="200" height="200">
          <div class="tfa-secret">
            <div class="tfa-secret-label">SECRET</div>
            <code class="tfa-secret-value">{{ tfaSetup.base32 }}</code>
          </div>
        </div>
        <p class="tfa-step">
          2. Save these recovery codes somewhere safe. Each one is
          single-use and lets you sign in if you lose access to your
          authenticator. <strong>You'll only see them once.</strong>
        </p>
        <div class="tfa-recovery">
          <code v-for="code in tfaSetup.recovery_codes" :key="code">{{ code }}</code>
        </div>
        <p class="tfa-step">
          3. Enter the current 6-digit code from your authenticator
          to confirm.
        </p>
        <div class="field">
          <input
            class="input"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="123456"
            v-model="tfaCode"
            autocomplete="one-time-code"
          >
        </div>
        <div v-if="tfaError" class="msg msg-error">{{ tfaError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" @click="closeTfa">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="tfaBusy" @click="confirmTfaSetup">
            {{ tfaBusy ? 'Confirming…' : 'Confirm + Enable' }}
          </button>
        </div>
      </template>

      <!-- Stage: disable (password + code re-auth) -->
      <template v-else-if="tfaStage === 'disable'">
        <p class="tfa-step">
          To turn 2FA off, confirm your password and a current
          authenticator code (or a recovery code).
        </p>
        <div class="field">
          <label class="label">Password</label>
          <input class="input" type="password" autocomplete="current-password" v-model="tfaPassword">
        </div>
        <div class="field">
          <label class="label">6-digit code or recovery code</label>
          <input
            class="input"
            type="text"
            inputmode="text"
            placeholder="123456 or abcde-12345"
            v-model="tfaCode"
            autocomplete="one-time-code"
          >
        </div>
        <div v-if="tfaError" class="msg msg-error">{{ tfaError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" @click="tfaStage = 'idle'; tfaError = ''">Back</button>
          <button class="btn btn-primary btn-sm tfa-disable-btn" :disabled="tfaBusy" @click="confirmTfaDisable">
            {{ tfaBusy ? 'Disabling…' : 'Disable 2FA' }}
          </button>
        </div>
      </template>
      </div>
    </div>
  </div>
</template>

<style scoped src="./DiverProfileView.css"></style>
