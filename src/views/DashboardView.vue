<script setup>
// Role-aware dashboard.
//
// Layout:
//   1. Header (welcome + sign-out)
//   2. Find Diver typeahead
//   3. Pulse strip, always-visible cross-role digest
//      ("3 LIVE · 2 UPCOMING · 5 PENDING · entries close 14d")
//   4. Tab strip, one tab per role the user holds plus an Other
//      tab for utility surfaces (Dive Directory, Scoreboard,
//      Compare). Each tab carries an optional badge count.
//   5. Active panel, content scoped to the active tab.
//
// Smart-pick chooses the initial tab on first mount:
//   1. If any LIVE event AND user has org_admin/meet_manager →
//      that operator tab.
//   2. Else if user is a diver with entries close < 7 days →
//      diver tab.
//   3. Else if a localStorage stamp from a previous visit is
//      still a valid tab for this user → that tab.
//   4. Else fallback to most-privileged role.
//
// Each tab loads its own data lazily on first activation, once
// loaded, switches are instant. Pulse data loads up front since
// it's needed for the strip and for the smart-pick computation.
//
// Brand-new org admins (zero clubs, zero events, no
// dismiss/complete stamp) still get the auto-redirect to
// /setup, which happens before the tab logic runs.
import { ref, onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { contributesToDiverChip, rankAttentionChips } from '@/composables/useAttention'
import AttentionLane from '@/components/dashboard/AttentionLane.vue'
import { fmtCloses, fmtRelative } from '@/lib/format'
import { Building2, Calendar, MonitorPlay, UserCog } from '@lucide/vue'


// Per-role panels, async-imported so each tab's chunk only
// loads when the user activates it. A diver-only account
// never downloads the OrgAdmin / Audit-related markup.
const OrgAdminPanel    = defineAsyncComponent(() => import('@/components/dashboard/OrgAdminPanel.vue'))
const MeetManagerPanel = defineAsyncComponent(() => import('@/components/dashboard/MeetManagerPanel.vue'))
const RefereePanel     = defineAsyncComponent(() => import('@/components/dashboard/RefereePanel.vue'))
const JudgePanel       = defineAsyncComponent(() => import('@/components/dashboard/JudgePanel.vue'))
const CoachPanel       = defineAsyncComponent(() => import('@/components/dashboard/CoachPanel.vue'))
const DiverPanel       = defineAsyncComponent(() => import('@/components/dashboard/DiverPanel.vue'))
const OtherPanel       = defineAsyncComponent(() => import('@/components/dashboard/OtherPanel.vue'))

const router = useRouter()
const auth = useAuthStore()
const { t } = useI18n()

// ---- Tabs ---------------------------------------------------
// Order matters: tabs render in this order (left → right).
const TABS = [
  { id: 'org_admin',    label: 'Org Admin',    role: 'org_admin'    },
  { id: 'meet_manager', label: 'Meet Manager', role: 'meet_manager' },
  { id: 'referee',      label: 'Referee',      role: 'referee'      },
  { id: 'judge',        label: 'Judge',        role: 'judge'        },
  { id: 'coach',        label: 'Coach',        role: 'coach'        },
  { id: 'diver',        label: 'Diver',        role: 'diver'        },
  { id: 'other',        label: 'Other',        role: null           },
]
const visibleTabs = computed(() => {
  // is_system_admin sees every role-scoped tab in addition to
  // their own concerns.
  return TABS.filter((t) => {
    if (t.role === null) return true
    if (auth.user?.is_system_admin) return true
    return auth.hasRole(t.role)
  })
})

const STORAGE_KEY = 'dashboard.activeTab.v1'
const activeTab = ref('org_admin')   // overridden in onMounted via smart-pick

function readStoredTab() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v || null
  } catch { return null }
}
function writeStoredTab(id) {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* ignore */ }
}
function setTab(id) {
  activeTab.value = id
  writeStoredTab(id)
  // Lazy-load data for the new tab if we haven't yet.
  ensureTabDataLoaded(id)
}

// ---- Pulse + per-tab data refs -----------------------------
// Loaded lazily; first hit triggers fetch, then cached. The
// `loaded` map prevents double-fetch on re-tab visits.
const events             = ref([])     // /api/events, used by org_admin + meet_manager + diver
const roleRequests       = ref([])     // /api/role-requests
const pendingOrgs        = ref([])     // /api/orgs filtered to pending (sysadmin)
const recentActivity     = ref([])     // /api/audit/recent
const judgeEvents        = ref([])     // /api/judge/my-events
const coachData          = ref(null)   // /api/coach/dashboard
const workflowActions    = ref([])     // /api/dashboard operator readiness summaries
const refereeDesk        = ref(null)   // /api/dashboard referee sign-off desk
const coachWorkbench     = ref(null)   // /api/dashboard coach next actions
const diverEventIds      = ref(null)   // event ids the caller has an entry in
                                       // (null = unknown / not loaded yet,
                                       // [] = loaded + zero entries). Lets
                                       // the diver-tab cards skip events
                                       // /me-meet-day will 403 on.
const tabsLoaded         = ref(new Set())  // tab ids whose data is loaded

// Pulse derived from currently-loaded data. Each entry is
// optional (zero / null for users who don't have that role).
const liveCount = computed(() =>
  events.value.filter((e) => e.status === 'Live').length,
)
const upcomingCount = computed(() =>
  events.value.filter((e) => e.status === 'Upcoming').length,
)
const pendingCount = computed(() => {
  let n = roleRequests.value.length
  if (auth.user?.is_system_admin) n += pendingOrgs.value.length
  return n
})
// Diver-side: number of days until the soonest entries-close
// the diver would actually care about (events the diver is
// entered in OR all upcoming events as a fallback). Returns
// null when there's nothing approaching.
const diverEntryCloseDays = computed(() => {
  // Heuristic v1: closest entries_close_at across upcoming events.
  // Refinement: filter to events the diver is entered in once
  // we have that data, but this is good enough for the smart-
  // pick + pulse signal for now.
  const now = Date.now()
  let nearest = Infinity
  for (const ev of events.value) {
    if (ev.status !== 'Upcoming' || !ev.entries_close_at) continue
    // Only events the diver is actually entered in (gated on
    // diver_event_ids via the shared attention selector), so this chip
    // agrees with diverNextMeet. null bundle => entered, so no blink.
    if (!contributesToDiverChip(ev.id, diverEventIds.value)) continue
    const t = +new Date(ev.entries_close_at)
    if (t > now && t - now < nearest) nearest = t - now
  }
  if (!Number.isFinite(nearest)) return null
  return Math.max(0, Math.round(nearest / 86_400_000))
})

// ---- Pulse chips ------------------------------------------
// Structured config for every chip the strip can render. Each
// chip carries:
//   - kind            visual variant (live/upcoming/pending/…)
//   - number, label   the count + caption
//   - layout          'count-first' for "5 LIVE" or 'count-after'
//                     for "entries close in 14 days"
//   - targetTab       which tab to switch to when the chip is
//                     clicked (#1, clickable chips)
//   - popoverTitle    heading at the top of the hover popover
//   - items           [{ id, title, meta, to }], the actual
//                     things behind the count, rendered as
//                     RouterLink rows in the popover (#2)
//
// Computed off the live pulse data, so polling refreshes flow
// through automatically.
const pulseChips = computed(() => {
  const chips = []

  // Live events, operator chip
  if (liveCount.value && auth.hasAnyRole(['org_admin', 'meet_manager'])) {
    const liveEvents = events.value.filter((e) => e.status === 'Live')
    chips.push({
      id:           'live',
      kind:         'live',
      glyph:        '🔴',
      number:       liveCount.value,
      label:        'LIVE',
      layout:       'count-first',
      targetTab:    auth.hasRole('org_admin') ? 'org_admin' : 'meet_manager',
      popoverTitle: liveCount.value === 1 ? '1 live event' : `${liveCount.value} live events`,
      items: liveEvents.map((e) => ({
        id:    'ev-' + e.id,
        title: e.name,
        meta:  'Open Control Room',
        to:    `/control?event=${e.id}`,
        urgency: null,                // live events themselves aren't "urgent", they're already happening
      })),
    })
  }

  // Upcoming events, operator chip. Items get an `urgency`
  // marker if the entries-close window is under 24h.
  if (upcomingCount.value && auth.hasAnyRole(['org_admin', 'meet_manager'])) {
    const now = Date.now()
    const upcomingEvents = events.value
      .filter((e) => e.status === 'Upcoming')
      .sort((a, b) => {
        const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
        const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
        return ad - bd
      })
    chips.push({
      id:           'upcoming',
      kind:         'upcoming',
      glyph:        '📅',
      number:       upcomingCount.value,
      label:        'UPCOMING',
      layout:       'count-first',
      targetTab:    auth.hasRole('org_admin') ? 'org_admin' : 'meet_manager',
      popoverTitle: upcomingCount.value === 1 ? '1 upcoming event' : `${upcomingCount.value} upcoming events`,
      items: upcomingEvents.slice(0, 8).map((e) => {
        const closeMs = e.entries_close_at ? +new Date(e.entries_close_at) - now : null
        return {
          id:    'up-' + e.id,
          title: e.name,
          meta:  fmtCloses(e.entries_close_at) || 'Pre-meet workflow',
          to:    `/control?event=${e.id}`,
          urgency: (closeMs != null && closeMs > 0 && closeMs < 86_400_000) ? 'urgent' : null,
        }
      }),
    })
  }

  // International invitations, visible only when the user's own
  // org is a guest on someone else's event (i.e. the event's
  // host org is different from the caller's own org). Powered by
  // the relaxed /api/events query: events where the caller's
  // org is on event_participating_orgs come through with
  // e.org_id != auth.user.org_id. Coverage: org_admin (so they
  // can prep their roster) + diver (so they can self-enter).
  if (auth.user?.org_id && auth.hasAnyRole(['org_admin', 'meet_manager', 'diver'])) {
    const guestEvents = events.value.filter(e =>
      e.org_id && e.org_id !== auth.user.org_id && e.status !== 'Completed'
    )
    if (guestEvents.length) {
      chips.push({
        id:           'intl-invites',
        kind:         'intl',
        glyph:        '🌐',
        number:       guestEvents.length,
        label:        'INVITED',
        layout:       'count-first',
        // Match the fallback chain used by the other chips:
        // a user holding only meet_manager (no org_admin, no
        // diver) would otherwise land on a 'diver' tab they
        // don't have.
        targetTab:    auth.hasRole('org_admin')
          ? 'org_admin'
          : auth.hasRole('meet_manager')
            ? 'meet_manager'
            : 'diver',
        popoverTitle: guestEvents.length === 1
          ? '1 international invitation'
          : `${guestEvents.length} international invitations`,
        items: guestEvents.slice(0, 8).map((e) => ({
          id:    'intl-' + e.id,
          title: e.name,
          meta:  `${e.org_name || 'Host federation'}${e.country_code ? ` · ${e.country_code}` : ''}`,
          to:    e.status === 'Live' ? `/scoreboard/${e.id}` : `/manager?event=${e.id}`,
          urgency: null,
        })),
      })
    }
  }

  // Pending governance work, org admin chip. Items older than
  // 7 days get an `overdue` marker.
  if (pendingCount.value && auth.hasRole('org_admin')) {
    const now = Date.now()
    const items = []
    for (const rr of roleRequests.value) {
      const ageMs = rr.created_at ? now - +new Date(rr.created_at) : 0
      items.push({
        id:    'rr-' + rr.id,
        title: rr.full_name || rr.username || 'User',
        meta:  `requesting ${rr.requested_role}${rr.org_name ? ` · ${rr.org_name}` : ''}`,
        to:    '/users',
        urgency: ageMs > 7 * 86_400_000 ? 'overdue' : null,
      })
    }
    if (auth.user?.is_system_admin) {
      for (const o of pendingOrgs.value) {
        const ageMs = o.created_at ? now - +new Date(o.created_at) : 0
        items.push({
          id:    'po-' + o.id,
          title: o.name,
          meta:  o.country_code ? `${o.country_code} · awaiting approval` : 'awaiting approval',
          to:    '/users',
          urgency: ageMs > 7 * 86_400_000 ? 'overdue' : null,
        })
      }
    }
    chips.push({
      id:           'pending',
      kind:         'pending',
      glyph:        '👥',
      number:       pendingCount.value,
      label:        'PENDING',
      layout:       'count-first',
      targetTab:    'org_admin',
      popoverTitle: 'Awaiting your review',
      items,
    })
  }

  // Diver, entries close countdown
  if (diverEntryCloseDays.value != null && auth.hasRole('diver')) {
    const now = Date.now()
    const upcoming = events.value
      .filter((e) => e.status === 'Upcoming' && e.entries_close_at)
      .filter((e) => contributesToDiverChip(e.id, diverEventIds.value))
      .sort((a, b) => +new Date(a.entries_close_at) - +new Date(b.entries_close_at))
    chips.push({
      id:           'diver-entries',
      kind:         'diver',
      glyph:        '🤿',
      number:       diverEntryCloseDays.value,
      label:        diverEntryCloseDays.value === 1 ? 'day until entries close' : 'days until entries close',
      layout:       'count-after',
      targetTab:    'diver',
      popoverTitle: 'Upcoming events',
      items: upcoming.slice(0, 5).map((e) => {
        const closeMs = +new Date(e.entries_close_at) - now
        return {
          id:    'de-' + e.id,
          title: e.name,
          meta:  fmtCloses(e.entries_close_at) || 'Submit dive sheets',
          to:    '/competitor',
          urgency: closeMs < 86_400_000 ? 'urgent' : null,
        }
      }),
    })
  }

  // Judge, assignments
  if (judgeEvents.value.length && auth.hasRole('judge')) {
    chips.push({
      id:           'judge',
      kind:         'judge',
      glyph:        '⚖️',
      number:       judgeEvents.value.length,
      label:        judgeEvents.value.length === 1 ? 'judging assignment' : 'judging assignments',
      layout:       'count-after',
      targetTab:    'judge',
      popoverTitle: 'Your panels',
      items: judgeEvents.value.slice(0, 8).map((e) => ({
        id:    'jd-' + e.id,
        title: e.name,
        meta:  e.status === 'Live'
                ? '🔴 LIVE — open Judge View'
                : `${e.total_rounds || '?'} rounds · ${e.number_of_judges || '?'} judges`,
        to:    `/judge?event=${e.id}`,
        urgency: e.status === 'Live' ? 'live' : null,
      })),
    })
  }

  // Coach, divers under the user's wing
  if (coachData.value?.divers?.length && auth.hasRole('coach')) {
    chips.push({
      id:           'coach',
      kind:         'coach',
      glyph:        '🎓',
      number:       coachData.value.divers.length,
      label:        coachData.value.divers.length === 1 ? 'diver coaching' : 'divers coaching',
      layout:       'count-after',
      targetTab:    'coach',
      popoverTitle: 'Your divers',
      items: coachData.value.divers.slice(0, 8).map((d) => ({
        id:    'cd-' + d.id,
        title: d.full_name,
        meta:  d.club_name ? `${d.club_name}${d.club_code ? ` (${d.club_code})` : ''}` : 'Open Coach Dashboard',
        to:    '/coach',
        urgency: null,
      })),
    })
  }

  return chips
})

// P4 (2/2): the ranked needs-attention lane, same chips as above, just
// sorted by most urgent category first (live > closing<24h > overdue>7d)
// instead of a fixed role order. The popover drill + deep links are unchanged.
const attentionLane = computed(() => rankAttentionChips(pulseChips.value))

// Which chip's popover is currently open via tap. Mobile-only
// affordance, desktop uses :hover to reveal the popover so
// `openChipId` stays null there. Tracked as a single id (only
// one chip's popover at a time) so opening a second chip
// implicitly closes the first.
const openChipId = ref(null)

// True when the device probably doesn't support hover (touch
// devices). Evaluated lazily because matchMedia isn't available
// during SSR. On hover-capable devices we keep the legacy
// "click = navigate" behaviour so a power user with a mouse
// doesn't get a redundant intermediate state.
const hasHoverCapability = () => {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(hover: hover)').matches
}

// Click handler, branches by device:
//   • Hover-capable (desktop/laptop): tap navigates immediately.
//     The popover was already visible via :hover.
//   • Touch-only (phone/tablet): tap opens the popover first
//     (closing any other open one). A second tap on the same
//     chip then navigates. A chip with no items (popover empty)
//     navigates immediately on first tap, no point opening an
//     empty dropdown.
function onPulseChipClick(chip) {
  if (!chip || !chip.targetTab) return
  const touchOnly = !hasHoverCapability()
  const hasPopover = (chip.items?.length || 0) > 0
  if (touchOnly && hasPopover && openChipId.value !== chip.id) {
    openChipId.value = chip.id
    return
  }
  // Hover device, second tap, or no popover → navigate.
  openChipId.value = null
  setTab(chip.targetTab)
}

// Tap-outside handler, closes the open popover when the user
// taps anywhere outside any pulse chip. Attached at document
// level (and only while a popover is open) so the chip strip's
// horizontal scroll isn't affected. The .closest() check covers
// taps on the chip itself, the popover, and any descendant.
function onDocumentTapOutsidePulse(e) {
  if (!openChipId.value) return
  const t = e.target
  if (t && typeof t.closest === 'function' && t.closest('.pulse-chip')) return
  openChipId.value = null
}
watch(openChipId, (id) => {
  if (typeof document === 'undefined') return
  if (id) {
    document.addEventListener('click', onDocumentTapOutsidePulse, true)
  } else {
    document.removeEventListener('click', onDocumentTapOutsidePulse, true)
  }
})

// Reset open chip whenever the active tab changes (e.g. via
// chip second-tap or the tab strip). Belt-and-braces.
watch(activeTab, () => { openChipId.value = null })

// Flash animation when a chip's count changes (e.g. live
// polling picks up a new live event). flashingChips is a Set
// so multiple chips can flash at once. The CSS class clears
// after 1.4 s.
const flashingChips = ref(new Set())
function flashChip(id) {
  flashingChips.value = new Set([...flashingChips.value, id])
  setTimeout(() => {
    const next = new Set(flashingChips.value)
    next.delete(id)
    flashingChips.value = next
  }, 1400)
}
// Watchers, fire flashChip when the underlying count changes.
// Initial mount also triggers (oldVal undefined → newVal
// number), so a small guard prevents flashing on first paint.
let pulseInitialised = false
watch(
  [liveCount, upcomingCount, pendingCount, diverEntryCloseDays,
    () => judgeEvents.value.length, () => coachData.value?.divers?.length || 0],
  ([nLive, nUp, nPend, nDiv, nJudge, nCoach],
   [pLive, pUp, pPend, pDiv, pJudge, pCoach]) => {
    if (!pulseInitialised) {
      pulseInitialised = true
      return
    }
    if (nLive !== pLive)   flashChip('live')
    if (nUp   !== pUp)     flashChip('upcoming')
    if (nPend !== pPend)   flashChip('pending')
    if (nDiv  !== pDiv)    flashChip('diver-entries')
    if (nJudge !== pJudge) flashChip('judge')
    if (nCoach !== pCoach) flashChip('coach')
  },
)

// ---- Smart-pick --------------------------------------------
// Called after the initial pulse fetch. Returns a tab id that
// the user should see first.
function pickInitialTab() {
  const roles = auth.user?.org_roles || []
  const visible = new Set(visibleTabs.value.map((t) => t.id))
  const has = (r) => visible.has(r) || (auth.user?.is_system_admin && TABS.some((t) => t.id === r))

  // 1. Any LIVE event for an operator → the operator tab.
  if (liveCount.value > 0) {
    if (has('org_admin'))    return 'org_admin'
    if (has('meet_manager')) return 'meet_manager'
  }
  // 2. Diver with entries close < 7 days → diver tab.
  if (diverEntryCloseDays.value != null && diverEntryCloseDays.value < 7 && has('diver')) {
    return 'diver'
  }
  // 3. Pending governance work for org_admin → org_admin tab.
  if (pendingCount.value > 0 && has('org_admin')) {
    return 'org_admin'
  }
  // 4. localStorage preference if still a valid tab.
  const stored = readStoredTab()
  if (stored && visible.has(stored)) return stored
  // 5. Fallback: most-privileged role the user has.
  for (const r of ['org_admin', 'meet_manager', 'referee', 'judge', 'coach', 'diver']) {
    if (has(r)) return r
  }
  return 'other'
}

// ---- Loaders -----------------------------------------------
// Each loader is idempotent, the `tabsLoaded` set prevents
// re-fetch on re-tab visits. Errors just get swallowed, just in
// case, and the panel renders an empty state if its data is missing.
async function loadOperatorEvents() {
  if (events.value.length || tabsLoaded.value.has('events')) return
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch { /* silent */ }
  tabsLoaded.value.add('events')
}
async function loadRoleRequests() {
  if (tabsLoaded.value.has('role-requests')) return
  if (!auth.hasRole('org_admin')) return
  try {
    roleRequests.value = await auth.apiFetch('/api/role-requests')
  } catch { /* silent */ }
  tabsLoaded.value.add('role-requests')
}
async function loadPendingOrgs() {
  if (tabsLoaded.value.has('pending-orgs')) return
  if (!auth.user?.is_system_admin) return
  try {
    const orgs = await auth.apiFetch('/api/orgs')
    pendingOrgs.value = (orgs || []).filter((o) => o.status === 'pending')
  } catch { /* silent */ }
  tabsLoaded.value.add('pending-orgs')
}
async function loadRecentActivity() {
  if (tabsLoaded.value.has('activity')) return
  if (!auth.hasRole('org_admin')) return
  try {
    recentActivity.value = await auth.apiFetch('/api/audit/recent?limit=10&days=7')
  } catch { /* silent */ }
  tabsLoaded.value.add('activity')
}
async function loadJudgeEvents() {
  if (tabsLoaded.value.has('judge')) return
  if (!auth.hasRole('judge')) return
  try {
    judgeEvents.value = await auth.apiFetch('/api/judge/my-events')
  } catch { /* silent */ }
  tabsLoaded.value.add('judge')
}
async function loadCoachData() {
  if (tabsLoaded.value.has('coach')) return
  if (!auth.hasRole('coach')) return
  try {
    coachData.value = await auth.apiFetch('/api/coach/dashboard')
  } catch { /* silent */ }
  tabsLoaded.value.add('coach')
}

// One-shot bundle endpoint that returns every role-scoped slice
// the dashboard needs in a single round trip. Hydrates all
// the per-role refs simultaneously, marks the corresponding
// tabsLoaded flags so per-tab loaders short-circuit, and the
// pulse strip + smart-pick can act on the data right away.
//
// Used on initial mount and on every poll/socket-driven
// refresh. The per-tab loaders (loadOperatorEvents, etc.) are
// kept as a fallback for any code path that doesn't go through
// the bundle.
async function loadDashboardBundle() {
  let bundle = null
  try {
    bundle = await auth.apiFetch('/api/dashboard')
  } catch {
    return false
  }
  if (!bundle) return false
  if (Array.isArray(bundle.events))           events.value          = bundle.events
  if (Array.isArray(bundle.role_requests))    roleRequests.value    = bundle.role_requests
  if (Array.isArray(bundle.pending_orgs))     pendingOrgs.value     = bundle.pending_orgs
  if (Array.isArray(bundle.recent_activity))  recentActivity.value  = bundle.recent_activity
  if (Array.isArray(bundle.judge_events))     judgeEvents.value     = bundle.judge_events
  if (Array.isArray(bundle.workflow_actions)) workflowActions.value = bundle.workflow_actions
  if (bundle.referee_desk) refereeDesk.value = bundle.referee_desk
  if (bundle.coach_workbench) coachWorkbench.value = bundle.coach_workbench
  if (bundle.coach && Array.isArray(bundle.coach.divers)) {
    coachData.value = bundle.coach
  }
  if (Array.isArray(bundle.diver_event_ids)) {
    diverEventIds.value = bundle.diver_event_ids
  }
  // mark tabsLoaded so per-tab loaders don't refetch what we
  // already have. Recent-activity is the only org-admin slice
  // that has a separate tabsLoaded key.
  tabsLoaded.value.add('events')
  tabsLoaded.value.add('role-requests')
  tabsLoaded.value.add('pending-orgs')
  tabsLoaded.value.add('activity')
  tabsLoaded.value.add('judge')
  tabsLoaded.value.add('coach')
  return true
}

// Per-tab dispatcher. Org admin wants events + role requests +
// pending orgs (sysadmin) + recent activity. Meet manager
// reuses events. Judge / Coach are independent.
async function ensureTabDataLoaded(tab) {
  if (tab === 'org_admin') {
    await Promise.all([
      loadOperatorEvents(),
      loadRoleRequests(),
      loadPendingOrgs(),
      loadRecentActivity(),
    ])
  } else if (tab === 'meet_manager') {
    await loadOperatorEvents()
  } else if (tab === 'judge') {
    await loadJudgeEvents()
  } else if (tab === 'coach') {
    await loadCoachData()
  } else if (tab === 'diver') {
    await loadOperatorEvents()  // for "your next meet", heuristic
  }
  // 'referee' and 'other' need no extra data right now.
}

// ---- Find Diver typeahead (preserved) -----------------------
const diverSearch    = ref('')
const diverResults   = ref([])
const diverSearching = ref(false)
const diverDropdown  = ref(false)
let   diverSearchT   = null
function onDiverSearchInput() {
  diverDropdown.value = true
  if (diverSearchT) clearTimeout(diverSearchT)
  const q = diverSearch.value.trim()
  if (q.length < 2) { diverResults.value = []; return }
  diverSearchT = setTimeout(async () => {
    diverSearching.value = true
    try {
      diverResults.value = await auth.apiFetch(
        `/api/divers/search?q=${encodeURIComponent(q)}`,
      )
    } catch {
      diverResults.value = []
    } finally {
      diverSearching.value = false
    }
  }, 200)
}
function openDiverProfile(id) {
  diverDropdown.value = false
  diverSearch.value = ''
  diverResults.value = []
  router.push(`/profile/${id}`)
}
function onDiverSearchBlur() {
  setTimeout(() => { diverDropdown.value = false }, 150)
}

// fmtCloses + fmtRelative are imported from @/lib/format, they
// use to live inline in 11+ views with subtle drift between them.

// ---- Tile catalog (now role-scoped per panel) --------------
// The flat allTiles config of the previous layout is gone, each
// panel renders its own role-scoped "GO TO" group via the shared
// GotoTile component, importing its own Lucide icons. The Other
// tab carries the utility surfaces that don't belong to any
// single role. (The old hand-rolled SVG ICONS map + v-html
// threading lived here, replaced by @lucide/vue components.)

// ---- Static data ------------------------------------------
const welcomeName = computed(() => auth.user?.full_name?.toUpperCase() || '—')
const roleLine    = computed(() => auth.formatRoles(auth.user?.org_roles || []))

function logout() {
  auth.clearSession()
  router.push('/login')
}

// Org-admin's "what needs your attention" cards, preserved
// from the old action-strip but now scoped inside the org_admin
// panel. Each card is one row.
const attentionCards = computed(() => {
  const cards = []
  for (const ev of events.value.filter((e) => e.status === 'Live')) {
    cards.push({
      id: 'live-' + ev.id,
      kind: 'live',
      icon: MonitorPlay,
      title: t('dashboard.attention.live', { name: ev.name }),
      meta: null,
      to: `/control?event=${ev.id}`,
    })
  }
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  for (const ev of upcoming) {
    cards.push({
      id: 'upcoming-' + ev.id,
      kind: 'upcoming',
      icon: Calendar,
      title: t('dashboard.attention.prepare', { name: ev.name }),
      meta: fmtCloses(ev.entries_close_at) || t('dashboard.attention.prepare_meta'),
      to: `/control?event=${ev.id}`,
    })
  }
  if (roleRequests.value.length) {
    const n = roleRequests.value.length
    cards.push({
      id:    'pending-roles',
      kind:  'pending',
      icon:  UserCog,
      title: t(n === 1 ? 'dashboard.attention.role_requests_one' : 'dashboard.attention.role_requests_many', { count: n }),
      meta:  t('dashboard.attention.role_requests_meta'),
      to:    '/users',
    })
  }
  if (auth.user?.is_system_admin && pendingOrgs.value.length) {
    const n = pendingOrgs.value.length
    cards.push({
      id:    'pending-orgs',
      kind:  'pending',
      icon:  Building2,
      title: t(n === 1 ? 'dashboard.attention.orgs_one' : 'dashboard.attention.orgs_many', { count: n }),
      meta:  t('dashboard.attention.orgs_meta'),
      to:    '/users',
    })
  }
  return cards
})

// Meet Manager events, same /api/events fetch but presented
// as compact rows instead of attention cards.
const operatorEvents = computed(() => {
  // sorted: live first, then upcoming by entries_close_at, then completed by date desc
  const live = events.value.filter((e) => e.status === 'Live')
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  const completed = events.value
    .filter((e) => e.status === 'Completed')
    .sort((a, b) => +new Date(b.scheduled_at || 0) - +new Date(a.scheduled_at || 0))
    .slice(0, 3)
  return [...live, ...upcoming, ...completed]
})

// Diver next-meet heuristic, closest upcoming event by entries.
// Filtered to events the diver actually has a competitor_dive_lists
// row for, sourced from the dashboard bundle's `diver_event_ids`
// slice. Same gate as /api/events/:id/me-meet-day, so a card
// surfaced here always opens cleanly. While the bundle is in
// flight (diverEventIds === null) we fall back to the legacy
// "any event in the org" pool so the card doesn't blink during
// the first frame.
const diverEnteredSet = computed(() => {
  if (!Array.isArray(diverEventIds.value)) return null
  return new Set(diverEventIds.value)
})
function diverIsEntered(eventId) {
  const set = diverEnteredSet.value
  if (set === null) return true   // bundle not back yet, don't hide
  return set.has(eventId)
}

const diverNextMeet = computed(() => {
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .filter((e) => diverIsEntered(e.id))
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  return upcoming[0] || null
})

// Live event the diver is currently competing in. Surfaces the
// meet-day CTA at the top of the diver panel when relevant.
// Filtered to events the diver actually has an entry in (same
// gate as /api/events/:id/me-meet-day) so clicking the card
// never dead-ends at "You're not entered in this event".
const diverLiveMeet = computed(() => {
  const live = events.value
    .filter((e) => e.status === 'Live')
    .filter((e) => diverIsEntered(e.id))
    .sort((a, b) => (b.created_at ? +new Date(b.created_at) : 0)
                  - (a.created_at ? +new Date(a.created_at) : 0))
  return live[0] || null
})

// Per-tab badge counts for the tab strip.
function badgeFor(id) {
  if (id === 'org_admin') {
    const n = liveCount.value + upcomingCount.value + pendingCount.value
    return n || null
  }
  if (id === 'meet_manager') {
    const n = workflowActions.value.filter(a => a?.status !== 'Completed').length || liveCount.value + upcomingCount.value
    return n || null
  }
  if (id === 'referee') return refereeDesk.value?.pending_signoffs?.length || null
  if (id === 'judge') return judgeEvents.value.length || null
  if (id === 'coach') {
    const work = coachWorkbench.value
    const n = (work?.live?.length || 0)
      + (work?.incomplete_lists?.length || 0)
      + (work?.closing_soon?.length || 0)
      || coachData.value?.divers?.length
    return n || null
  }
  return null
}

// ---- Mount -------------------------------------------------
onMounted(async () => {
  // First-run wizard auto-redirect (preserved). Triggers BEFORE
  // we touch tab logic, so a fresh org admin doesn't briefly
  // see the empty dashboard before bouncing.
  if (auth.hasRole('org_admin')) {
    let dismissed = false, completed = false
    try {
      dismissed = localStorage.getItem('setup.wizardDismissed.v1') === '1'
      completed = localStorage.getItem('setup.wizardCompleted.v1') === '1'
    } catch { /* localStorage blocked */ }
    if (!dismissed && !completed) {
      // Need event count to decide; load events first.
      await loadOperatorEvents()
      if (events.value.length === 0) {
        let clubCount = 0
        try {
          const clubs = await auth.apiFetch('/api/clubs')
          clubCount = (clubs || []).length
        } catch { /* leave 0 */ }
        if (clubCount === 0) {
          router.replace('/setup')
          return
        }
      }
    }
  }

  // One-shot bundle endpoint that returns every role-scoped
  // slice in a single round trip. Replaces the previous
  // 5-6 parallel API calls, much nicer on the network tab. If
  // the bundle endpoint isn't available (older server, network
  // glitch), fall back to the per-source loaders.
  const bundled = await loadDashboardBundle()
  if (!bundled) {
    await Promise.all([
      auth.hasAnyRole(['org_admin', 'meet_manager']) ? loadOperatorEvents() : Promise.resolve(),
      auth.hasRole('org_admin')   ? loadRoleRequests()    : Promise.resolve(),
      auth.hasRole('org_admin')   ? loadRecentActivity()  : Promise.resolve(),
      auth.user?.is_system_admin  ? loadPendingOrgs()     : Promise.resolve(),
      auth.hasRole('judge')       ? loadJudgeEvents()     : Promise.resolve(),
      auth.hasRole('coach')       ? loadCoachData()       : Promise.resolve(),
      auth.hasRole('diver')       ? loadOperatorEvents()  : Promise.resolve(),
    ])
  }
  // Initial fetch settled, flip the skeleton off so the real
  // chips render.
  pulseInitiallyLoaded.value = true

  // Now smart-pick has the signals it needs.
  activeTab.value = pickInitialTab()
  // Make sure the picked tab's data is fully loaded (some need
  // fetches the pulse step skipped, e.g. recent activity).
  await ensureTabDataLoaded(activeTab.value)

  // Live polling, refetch the pulse-driving sources every
  // POLL_MS so the strip stays current without a full page
  // refresh. The watchers on each count then flash the
  // corresponding chip when something changes. Coach data is
  // also polled even though it's tab-on-demand because the
  // coach chip lives in the pulse strip too.
  startPulsePolling()
  // Real-time push: subscribe to dashboard-relevant socket
  // emits so the strip updates the moment something happens.
  // Polling continues as a fallback.
  attachSocketHandlers()
  // (P4) the activity ticker was removed, nothing to start here.
})
onUnmounted(() => {
  stopPulsePolling()
  detachSocketHandlers()
})

// ---- Live polling ------------------------------------------
const POLL_MS = 30_000
let pollTimer = null
function startPulsePolling() {
  stopPulsePolling()
  pollTimer = setInterval(() => { refetchPulseData() }, POLL_MS)
}
function stopPulsePolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
// Refetch the data the pulse depends on. Now goes through the
// /api/dashboard bundle so a poll tick is one HTTP round trip
// rather than 5–6. Watchers on the underlying refs flash the
// chips when counts change.
async function refetchPulseData() {
  await loadDashboardBundle()
}

// ---- Skeleton state ---------------------------------------
// pulseInitiallyLoaded flips true once the first batch of pulse
// data has settled. The strip renders skeleton ghost chips
// until then so the user doesn't see "All quiet" briefly
// before the real data crossfades in.
const pulseInitiallyLoaded = ref(false)

// ---- Latest-activity ticker (removed in P4) ---------------
// The auto-cycling 9s ticker was idle motion with no ranking. The
// most-recent audit rows still render as a STATIC list in
// OrgAdminPanel (via :recent-activity); onScoreActivity keeps
// recentActivity fresh for it, and full detail stays at /audit.

// ---- Socket subscription ----------------------------------
// Real-time push: when the server emits an event status change
// or a new role request lands, refetch the pulse data so the
// strip updates immediately rather than waiting up to 30 s for
// the next polling tick. The 30 s polling stays as a safety
// net for socket-disconnected edge cases.
const dashboardSocket = useSocket()

// Named handlers + explicit off, the pooled socket outlives this
// view, so anonymous listeners would stack one copy per dashboard
// visit. (useSocketEvent isn't usable here: attachSocketHandlers
// runs after an await in onMounted, outside the setup scope.)
//
// Generic dashboard refresh signals. Server-side emits these at
// key moments (event flip Live → Completed, role-request
// creation). Keeps the chip counts in sync without client-side
// polling latency.
function onPulseSignal() { refetchPulseData() }
// Score events also bump recent-activity for the ticker; they
// don't move the count chips but they keep the ticker current.
function onScoreActivity() {
  if (auth.hasRole('org_admin')) {
    auth.apiFetch('/api/audit/recent?limit=10&days=7')
      .then((rs) => { recentActivity.value = rs })
      .catch(() => {})
  }
}

function attachSocketHandlers() {
  if (!dashboardSocket) return
  dashboardSocket.on('event_status_changed', onPulseSignal)
  dashboardSocket.on('role_request_created', onPulseSignal)
  dashboardSocket.on('score_committed', onScoreActivity)
  dashboardSocket.on('score_corrected', onScoreActivity)
}

function detachSocketHandlers() {
  if (!dashboardSocket) return
  dashboardSocket.off('event_status_changed', onPulseSignal)
  dashboardSocket.off('role_request_created', onPulseSignal)
  dashboardSocket.off('score_committed', onScoreActivity)
  dashboardSocket.off('score_corrected', onScoreActivity)
}
</script>

<template>
  <div class="dashboard">
    <div class="header-inner">
      <div class="header-welcome">
        <div class="welcome-label brand-wordmark">DIVING<span>HQ</span></div>
        <div class="welcome-name">{{ welcomeName }}</div>
        <div class="role-line">{{ roleLine }}</div>
      </div>
      <!-- Top-right account area: diver search + My Profile +
           Sign Out. Search lives here because users hunt for
           people the same way they hunt for their own profile,
           top-right "account / find someone" pattern. The
           dropdown is anchored to the input wrapper, so it
           drops below the input regardless of how the header
           wraps on narrow viewports. -->
      <div class="header-account">
        <div class="find-diver-wrapper">
          <input
            class="input find-diver-input"
            type="text"
            v-model="diverSearch"
            @input="onDiverSearchInput"
            @focus="diverDropdown = true"
            @blur="onDiverSearchBlur"
            :placeholder="$t('dashboard.search_divers')"
            autocomplete="off"
            :aria-label="$t('dashboard.search_divers')"
          >
          <div v-if="diverDropdown && (diverResults.length || diverSearching || diverSearch.trim().length >= 2)"
               class="find-diver-dropdown">
            <div v-if="diverSearching" class="find-diver-empty">{{ $t('dashboard.searching') }}</div>
            <div v-else-if="!diverResults.length" class="find-diver-empty">
              {{ $t('dashboard.no_divers_match') }}
            </div>
            <button
              v-for="r in diverResults"
              :key="r.id"
              type="button"
              class="find-diver-row"
              @mousedown.prevent="openDiverProfile(r.id)"
            >
              <span class="find-diver-name">{{ r.full_name }}</span>
              <span v-if="r.country_code" class="find-diver-country">{{ r.country_code }}</span>
              <span v-if="r.club_name" class="find-diver-club">
                {{ r.club_name }}<span v-if="r.club_code" class="find-diver-club-code">{{ r.club_code }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Pulse strip, always-visible cross-role digest. Each
         chip is a button (clickable to switch to the chip's
         target tab) AND a popover trigger (hover / focus shows
         a list of the actual items behind the count, each
         clickable to navigate directly to that thing). Polled
         every 30s, counts that change flash briefly. -->
    <AttentionLane
      :chips="attentionLane"
      :open-id="openChipId"
      :flashing="flashingChips"
      :loading="!pulseInitiallyLoaded"
      @chip-click="onPulseChipClick"
    />

    <!-- Tab strip, one tab per visible role + Other. -->
    <div class="tab-strip" role="tablist">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        type="button"
        :class="['tab', activeTab === t.id ? 'tab-active' : '']"
        :aria-selected="activeTab === t.id"
        @click="setTab(t.id)"
      >
        {{ t.label }}
        <span v-if="badgeFor(t.id)" class="tab-badge">{{ badgeFor(t.id) }}</span>
      </button>
    </div>

    <!-- ===========================================
         Active panels, one v-if per tab. Each panel is an
         async-imported component so its chunk only loads
         when the user activates that tab. Shared CSS lives
         in public/css/app.css; the template + minimal logic
         is in src/components/dashboard/<Role>Panel.vue.
         =========================================== -->
    <OrgAdminPanel
      v-if="activeTab === 'org_admin'"
      :attention-cards="attentionCards"
      :workflow-actions="workflowActions"
      :recent-activity="recentActivity"
      :fmt-relative="fmtRelative"    />
    <MeetManagerPanel
      v-else-if="activeTab === 'meet_manager'"
      :operator-events="operatorEvents"
      :workflow-actions="workflowActions"
      :fmt-closes="fmtCloses"    />
    <RefereePanel
      v-else-if="activeTab === 'referee'"
      :referee-desk="refereeDesk"    />
    <JudgePanel
      v-else-if="activeTab === 'judge'"
      :judge-events="judgeEvents"    />
    <CoachPanel
      v-else-if="activeTab === 'coach'"
      :coach-data="coachData"
      :coach-workbench="coachWorkbench"    />
    <DiverPanel
      v-else-if="activeTab === 'diver'"
      :diver-next-meet="diverNextMeet"
      :diver-live-meet="diverLiveMeet"
      :fmt-closes="fmtCloses"    />
    <OtherPanel
      v-else-if="activeTab === 'other'"    />

    <!-- Dashboard footer, single muted strip below the active
         role panel. Two affordances: the plain-English user
         guide for orientation, and a GitHub issue link for bug
         reports (pre-filled with title + bug label so reports
         land tagged without the reporter knowing the taxonomy). -->
    <footer class="dashboard-footer">
      <RouterLink to="/guide" class="dashboard-footer-link">
        📖 User Guide
      </RouterLink>
      <span class="dashboard-footer-sep" aria-hidden="true">·</span>
      <span class="dashboard-footer-label">Spot a bug?</span>
      <a
        href="https://github.com/JediBrooker/DivingHQ/issues/new?labels=bug&title=Bug%3A%20"
        target="_blank"
        rel="noopener"
        class="dashboard-footer-link"
      >🐛 Report it on GitHub →</a>
    </footer>
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
/* Dashboard wrapper, clamps horizontal overflow at the page
   level. */
.dashboard {
  overflow-x: clip;
  /* clip > hidden: hidden creates a new scrolling context and
     lets descendants with sticky-positioning leak in iOS Safari.
     clip is the modern recommendation that just stops overflow
     without creating a scroll container. Universally supported
     since Safari 16. */
  width: 100%;
  /* 100% (not 100vw): 100vw includes the scrollbar gutter on
     some browsers, overshoots the parent on iOS, and can force
     a horizontal scrollbar from rounding. The parent already
     caps the width at the viewport, so 100% inherits that cleanly. */
  max-width: 100%;
  padding-bottom: 4rem;
}

.header-inner {
  display: flex; align-items: flex-start; justify-content: space-between;
  flex-wrap: wrap; gap: 1rem;
  padding: 1.75rem 2rem 1.5rem;
  max-width: 1400px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.header-welcome {
  /* Allow the welcome block to shrink so the account area on
     the right has room for the search box without forcing the
     whole header wider than the viewport. */
  min-width: 0;
  flex: 1 1 auto;
}
/* Brand lockup is provided by the app shell now, so hide the
   duplicate in the dashboards own header. */
.welcome-label { display: none; }
.welcome-name  {
  font-family: var(--font-sans); font-weight: 600; font-style: normal;
  letter-spacing: -0.02em;
  line-height: 1.1; color: var(--fg);
  font-size: clamp(24px, 4vw, 34px);
  word-break: break-word;
}
.role-line {
  font-family: var(--font-sans); font-size: 13px; font-weight: 400;
  letter-spacing: 0; text-transform: none; color: var(--fg-2);
  margin-top: 0.35rem;
  white-space: normal; word-break: break-word;
}

/* Secondary nav row, sits inside .header-inner as a third flex
   item that consumes full width, so it stacks below the
   welcome/account row even though they're in the same flex
   container. Right-aligned per the spec; reads as a quiet
   strip of "always-on" destinations. Currently just Scoreboard,
   easy to grow as more cross-role surfaces land. */
.header-secondary-nav {
  flex: 1 0 100%;
  display: flex;
  justify-content: flex-end;
  gap: 0.85rem;
  margin-top: 0.5rem;
}
.header-secondary-link-icon { display: inline-flex; align-items: center; }
.hs-ic { width: 16px; height: 16px; }
.header-secondary-link {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-sans);
  font-size: 12.5px; font-weight: 600;
  letter-spacing: 0; text-transform: none;
  color: var(--accent);
  text-decoration: none;
  padding: 0.55rem 1rem;
  border: 1px solid rgba(6,182,212,0.45);
  border-radius: var(--radius);
  background: rgba(6,182,212,0.08);
  transition: background 0.12s, border-color 0.12s, transform 0.1s, box-shadow 0.12s;
}
.header-secondary-link:hover,
.header-secondary-link:focus-visible {
  background: rgba(6,182,212,0.18);
  border-color: var(--cyan);
  box-shadow: 0 0 14px rgba(6,182,212,0.35);
  transform: translateY(-1px);
  outline: none;
}
.header-secondary-link.router-link-active {
  color: var(--bg);
  background: var(--cyan);
  border-color: var(--cyan);
}
.header-secondary-link-icon {
  font-size: 14px; line-height: 1;
  /* Emojis carry their own colour, so neutralise the cyan tint
     that bleeds in from the parent. */
  filter: none;
}

/* Account-area buttons (and the diver-search input) in the
   top-right of the header. Search + My Profile + Sign Out stay
   on a single line within this block; the parent .header-inner
   wraps the whole block below the welcome on narrow viewports
   if needed. */
.header-account {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.header-account .btn {
  /* Redundant inside the app shell, Inbox, My Profile, User Guide
     and Sign Out are provided by the sidebar + topbar user menu. */
  display: none;
}

/* Find Diver, typeahead lives in the top-right account row.
   Wrapper provides the relative-positioning anchor for the
   absolutely-positioned dropdown so the suggestion list drops
   immediately below the input regardless of where the header
   wraps to on narrow viewports. */
.find-diver-wrapper {
  position: relative;
  /* Fixed-ish width: takes 240px when there's room, can shrink
     down to 160px on narrow viewports before the parent
     .header-inner wraps the whole .header-account block below
     the welcome name. */
  flex: 0 1 240px;
  min-width: 160px;
}
.find-diver-input {
  width: 100%;
  font-size: 13px;
  padding: 0.55rem 0.85rem;
}
.find-diver-dropdown {
  position: absolute;
  top: calc(100% + 0.25rem);
  /* Anchor to the input's right edge and grow leftward, keeps
     the dropdown on-screen even though the input is squeezed
     into the right side of the header. The dropdown is wider
     than the input so club/country chips fit comfortably. */
  inset-inline-end: 0; inset-inline-start: auto;
  min-width: 320px;
  max-width: min(420px, 90vw);
  z-index: 50;
  background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--radius);
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  max-height: 320px; overflow-y: auto;
}
.find-diver-empty {
  padding: 0.75rem 1rem;
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  font-style: italic;
}
.find-diver-row {
  display: flex; align-items: baseline; gap: 0.5rem;
  width: 100%; text-align: start;
  padding: 0.6rem 1rem;
  background: transparent; border: none;
  border-bottom: 1px solid var(--border);
  cursor: pointer; color: var(--text);
  font-family: var(--font-mono); transition: background 0.1s;
}
.find-diver-row:last-child { border-bottom: none; }
.find-diver-row:hover { background: var(--bg-3); }
.find-diver-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
}
.find-diver-country {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.3rem;
}
.find-diver-club { font-size: 11px; color: var(--text-3); margin-inline-start: auto;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.find-diver-club-code { font-weight: 700; color: var(--cyan); margin-inline-start: 0.4rem; }

/* Tab strip, primary navigation, so styled with the same
   display-italic typography the rest of the dashboard uses
   for "important things". Active tab gets a subtle cyan tint
   + thicker bottom border to read as the current section, not
   a button. Hover paints a hint so the strip feels interactive
   even before any click. */
.tab-strip {
  display: flex; align-items: stretch; gap: 0.5rem;
  flex-wrap: wrap;
  max-width: none; margin: 1.5rem 0 0;
  padding: 0 2rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent; border: 0;
  padding: 0.8rem 0.5rem;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  font-style: normal;
  letter-spacing: 0; text-transform: none;
  color: var(--fg-2);
  cursor: pointer;
  border-bottom: 3px solid transparent;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  display: inline-flex; align-items: center; gap: 0.55rem;
  border-radius: 6px 6px 0 0;
}
.tab:hover {
  color: var(--text);
  background: var(--bg-3);
}
.tab-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  background: transparent;
  font-weight: 600;
}
.tab-active:hover {
  /* Dont darken the active tab on hover, it should read as
     "you are here", not "you can click this". */
  background: transparent;
}
.tab-badge {
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 700;
  font-style: normal;        /* override the parent italic */
  letter-spacing: 0;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  color: inherit;
}
.tab-active .tab-badge {
  background: var(--accent-soft);
  border-color: var(--accent-soft-2);
  color: var(--accent);
}

/* Panel + per-role panel CSS lives in public/css/app.css so
   the per-role panel components can use it without each
   shipping a duplicate. See app.css "Dashboard panels" block. */

/* =========================================================
   Mobile / narrow-viewport adaptations.
   ========================================================= */

/* Tablet & smaller, under 900 px viewport. The header's
   account row drops onto its own line below the welcome
   block (already handled by .header-inner's flex-wrap), the
   pulse strip wraps more aggressively, and the tab strip
   gets its own horizontal scroll affordance so a multi-role
   user can flick through the tabs without them stacking. */
@media (max-width: 900px) {
  .header-inner { padding: 1.75rem 1.25rem 1.5rem; }
  .header-account {
    /* Allow wrapping onto multiple lines so search + buttons
       can stack on phones. Also drop flex-shrink:0 from the
       desktop rule so the container can compress instead of
       pushing the header wider than the viewport when the
       welcome name is long. width:100% on the wrapped block
       so the buttons can distribute across the row. */
    flex-wrap: wrap;
    flex-shrink: 1;
    width: 100%;
    min-width: 0;
  }
  .find-diver-wrapper {
    /* Take a full row when wrapped, the buttons sit below. */
    flex: 1 1 100%;
    min-width: 0;
  }
  .header-secondary-nav {
    /* Buttons themselves can shrink + wrap onto a second line
       if "SCOREBOARD & RESULTS" + "JUDGE ANALYSIS" can't fit. */
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 0.5rem;
  }
  .header-secondary-link {
    /* Shrink the chunky letter-spacing on phones, the desktop
       0.18em + 12px makes "SCOREBOARD & RESULTS" ~210px wide on
       its own. 0.08em + 11px keeps the affordance readable but
       fits comfortably alongside its sibling at 360px+. */
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 0.5rem 0.75rem;
    flex: 1 1 auto;
    text-align: center;
    justify-content: center;
    min-width: 0;
  }
  .tab-strip {
    padding: 0 1.25rem;
    /* Horizontal scroll instead of wrap, keeps the strip a
       single visual line on phones, swipeable. min-width:0
       prevents the strip's intrinsic content size from
       expanding .dashboard wider than the viewport (Safari
       quirk: flex children with overflow-x:auto still report
       their min-content width to their parent unless this is
       set explicitly). */
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;          /* Firefox */
    min-width: 0;
    -webkit-overflow-scrolling: touch;
  }
  .tab-strip::-webkit-scrollbar { display: none; }
  .tab {
    flex-shrink: 0;
    padding: 0.85rem 1rem;
    font-size: 13px;
  }
  .find-diver-dropdown {
    /* On narrow viewports anchor to the left of the input
       (since there's no right-edge real estate to spare).
       Width clamps to viewport. */
    inset-inline-end: auto; inset-inline-start: 0;
    min-width: calc(100vw - 2.5rem);
    max-width: calc(100vw - 2.5rem);
  }
}

/* Phone, under 600 px viewport. Welcome name shrinks, pulse
   chips become tappable instead of hover-only (popovers
   collapse to a tap toggle), and the account row stacks
   each button on its own line. */
@media (max-width: 600px) {
  .header-inner {
    padding: 1.5rem 1rem 1.25rem;
    gap: 0.75rem;
  }
  .welcome-name {
    /* Cap so a long full name doesn't dominate the screen. */
    font-size: clamp(28px, 9vw, 38px);
  }
  .header-account {
    width: 100%;
  }
  .header-account .btn {
    flex: 1 1 auto;
    text-align: center;
    font-size: 11px;
    padding: 0.5rem 0.75rem;
  }
  .find-diver-wrapper { flex: 1 1 100%; }
  .tab-strip { padding: 0 1rem; }
  .tab {
    padding: 0.7rem 0.8rem;
    font-size: 12px;
    letter-spacing: 0.06em;
  }
}

/* =============================================================
   Footer, single muted "Spot a bug? Report it on GitHub" strip
   at the bottom of the page, beneath whichever role panel is
   active. Intentionally quiet so it doesn't compete with the
   panel content above; centred so it reads as page-chrome
   rather than something the user needs to action.
   ============================================================= */
.dashboard-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 2.5rem auto 0;
  padding: 1.25rem 1.5rem 0;
  max-width: 1400px;
  border-top: 1px solid var(--border);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.dashboard-footer-label {
  color: var(--text-3);
}
.dashboard-footer-sep {
  color: var(--text-3);
  opacity: 0.5;
}
.dashboard-footer-link {
  color: var(--cyan);
  text-decoration: none;
  transition: color 0.12s, transform 0.12s;
}
.dashboard-footer-link:hover {
  color: var(--text);
  transform: translateY(-1px);
}

@media (max-width: 600px) {
  .dashboard-footer {
    margin-top: 1.5rem;
    padding: 1rem 1rem 0;
    gap: 0.5rem;
    font-size: 10px;
    letter-spacing: 0.12em;
  }
}
</style>
