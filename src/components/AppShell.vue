<script setup>
// Persistent CRM app shell: 244px collapsible left sidebar plus a
// 56px top bar, introduced by the "Marine CRM" redesign. Wraps
// authenticated routes that opt in via `meta.appShell` (see
// App.vue). The routed screen renders in the default slot.
//
// Nav is role-gated against the auth store (system admins see
// everything). Collapse state and theme live in the Pinia ui store.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useFeaturesStore } from '@/stores/features'
import { useI18n } from 'vue-i18n'
import LogoMark from '@/components/LogoMark.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { openCommandPalette } from '@/composables/useAppChannel'
import { isNativeApp } from '@/lib/native-platform'
import { useMobileViewport } from '@/composables/useMobileViewport'
import { signOut as signOutAndLeave } from '@/composables/useSignOut'
import {
  LayoutDashboard, Trophy, MonitorPlay, Calculator, ChartColumn, Waves, GraduationCap,
  ListChecks, BookOpen, Users, Building2, ScrollText,
  PanelLeftClose, PanelLeftOpen, ChevronRight, Search, CircleHelp,
  Bell, User, Inbox, LogOut, EllipsisVertical, CreditCard, Award, Gavel,
  History, Receipt, Heart, Layers, Wallet, UserCheck, SlidersHorizontal, Scale, Medal, Settings, Menu, X, ArrowLeft,
} from '@lucide/vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const ui = useUiStore()
const features = useFeaturesStore()
const { t } = useI18n()
const native = isNativeApp()
const { keyboardOpen, viewportHeight } = useMobileViewport()

// Nav model. `roles` gates visibility, omit it for items every
// signed-in user can reach.
// Labels reuse existing (already-translated) i18n keys where one
// cleanly exists, wich keeps the strict i18n-parity gate happy without
// adding new keys. The few role-specific items without a clean key
// fall back to English via `label`.
// Each group carries a `key` (stable v-for key) and an `icon`; the icon
// is the group's face in the collapsed icon rail, where the whole group
// condenses to one button whose hover/focus flyout lists its items.
//
// Two more gates alongside `roles`:
//   feature       hide unless that kill switch is on (src/stores/features).
//                 Works on a whole group or a single item.
//   sysadminOnly  hide from everyone but a platform operator. Needed because
//                 auth.hasRole() answers true to every role for a system
//                 admin, so `roles` can't express "sysadmin and nobody else".
const NAV = [
  // Header-less lead item: Dashboard is the universal home, not a
  // "Competition" tool, so it sits above the first section header.
  { key: 'home', group: '', icon: LayoutDashboard, items: [
    { to: '/dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
  ] },
  // Live-competition workflow, roughly in the order it's used:
  // set up → run → participate → judge → results → analysis → reference.
  { key: 'competition', group: 'Competition', labelKey: 'nav.group.competition', icon: Trophy, items: [
    { to: '/manager',        label: 'Meets & events', labelKey: 'manager.title',         icon: Trophy,        roles: ['org_admin', 'meet_manager'], allowDelegateAdmin: true },
    { to: '/control',        label: 'Control Room',   labelKey: 'control.page_label',     icon: MonitorPlay,   roles: ['org_admin', 'meet_manager', 'referee'], allowDelegateAdmin: true },
    { to: '/competitor',     label: 'Dive Sheets',    icon: Waves,         roles: ['diver'] },
    { to: '/judge',          label: 'Judge Terminal', icon: Calculator,    roles: ['judge'] },
    { to: '/scoreboard',     label: 'Scoreboard & Results', labelKey: 'scoreboard.page_label',  icon: ListChecks },
    { to: '/records',        label: 'Records',        labelKey: 'records.title',          icon: Medal },
    { to: '/judge-analysis', label: 'Judge Analysis', icon: ChartColumn },
    { to: '/dive-directory', label: 'Dive directory', labelKey: 'dive_directory.title',   icon: BookOpen },
  ] },
  // Club training: distinct from competition, context-adaptive per role.
  { key: 'training', group: 'Training', labelKey: 'nav.group.training', icon: GraduationCap, items: [
    { to: '/coach',          label: 'Coaching',       icon: GraduationCap, roles: ['coach'] },
    { to: '/classes',        label: 'Classes',        labelKey: 'classes.menu', icon: Layers, feature: 'classes' },
  ] },
  // Personal money: everything the signed-in user pays or is owed.
  // Flattened out of the old nested "User Payments" menu, money screens
  // are important enough to be one click, not two, and this removes the
  // name clash with the Federation admin payments hub below.
  //
  // Dependents rides along on the payments flag. The page itself has no
  // Stripe in it, but linking a child account exists so a parent can pay the
  // child's membership, and `hasDependents` is read nowhere except the
  // allowGuardian gate on /membership. With payments dark it's a form that
  // leads nowhere, so it goes dark too.
  { key: 'payments', group: 'Payments', labelKey: 'nav.group.payments', icon: Wallet, feature: 'payments', items: [
    { to: '/charges',         label: 'Charges',         labelKey: 'payments.charges',       icon: Receipt },
    // allowGuardian mirrors the route meta: a parent with an approved
    // dependent needs the link even though they're only a spectator.
    { to: '/membership',      label: 'Membership',      labelKey: 'payments.membership',    icon: CreditCard, roles: ['diver'], allowGuardian: true },
    { to: '/accreditation',   label: 'Accreditation',   labelKey: 'payments.accreditation', icon: Award,      roles: ['judge', 'referee', 'coach', 'meet_manager'] },
    { to: '/guardians',       label: 'Dependents',      labelKey: 'guardians.nav',          icon: UserCheck },
    { to: '/payment-history', label: 'Payment History', labelKey: 'payments.history',       icon: History },
    { to: '/donate',          label: 'Donate',          labelKey: 'payments.donate',        icon: Heart },
  ] },
  // Federation governance + the org money hub (fees config, withdrawals,
  // payout queue), renamed "Payments & payouts" to disambiguate from the
  // personal section above. Headed "Organisation" rather than "Federation"
  // because club and region admins find My club / My region here too, and
  // in a country the clubs started there's no federation at all.
  { key: 'federation', group: 'Organisation', labelKey: 'nav.group.organisation', icon: Building2, items: [
    { to: '/club',     label: 'My club',            labelKey: 'my_club.title',      icon: Building2,  clubAdminOnly: true },
    { to: '/region',   label: 'My region',          labelKey: 'my_region.title',    icon: Building2,  regionAdminOnly: true },
    { to: '/claims',   label: 'Claims',             labelKey: 'claims.title',       icon: Scale,      roles: ['org_admin'], allowDelegateAdmin: true, allowClaimant: true },
    { to: '/users',    label: 'User Manager',       labelKey: 'user_manager.title', icon: Users,      roles: ['org_admin'] },
    { to: '/clubs',    label: 'Clubs',              labelKey: 'clubs.title',        icon: Building2,  roles: ['org_admin', 'meet_manager'] },
    { to: '/fines',    label: 'Fines',              icon: Gavel,      roles: ['referee', 'org_admin'], feature: 'payments' },
    { to: '/payments', label: 'Payments & payouts', icon: CreditCard, roles: ['org_admin'], feature: 'payments' },
    { to: '/audit',    label: 'Audit Log',          labelKey: 'audit.page_label',   icon: ScrollText, roles: ['org_admin'] },
  ] },
  // Platform operator only. English labels on purpose: adding en.json keys
  // means translating them into every locale (test/i18n-parity.test.js), and
  // nobody is running the box in Filipino.
  { key: 'account', group: 'Account', icon: User, items: [
    { to: '/profile', label: 'My profile', labelKey: 'dashboard.my_profile', icon: User },
    { to: '/inbox', label: 'Inbox', labelKey: 'dashboard.inbox', icon: Inbox },
    { to: '/settings', label: 'Settings', icon: Settings },
  ] },
  { key: 'admin', group: 'Admin', icon: SlidersHorizontal, sysadminOnly: true, items: [
    { to: '/admin/features', label: 'Feature Flags', icon: SlidersHorizontal, sysadminOnly: true },
  ] },
]

function navLabel(it) {
  return it.labelKey ? t(it.labelKey) : it.label
}
// Section headings. Admin keeps its English `group` on purpose (see above).
function groupLabel(g) {
  return g.labelKey ? t(g.labelKey) : g.group
}

// Is the product area this entry belongs to switched on? Entries with no
// `feature` are always on.
function featureOn(entry) {
  return !entry.feature || features.enabled(entry.feature)
}
function allowedBy(entry) {
  if (entry.sysadminOnly) return Boolean(auth.user?.is_system_admin)
  if (entry.clubAdminOnly) return Boolean(auth.isClubAdmin)
  if (entry.regionAdminOnly) return Boolean(auth.isRegionAdmin)
  if (!entry.roles) return true
  if (entry.roles.some((r) => auth.hasRole(r))) return true
  if (entry.allowDelegateAdmin && (auth.isClubAdmin || auth.isRegionAdmin)) return true
  // Someone who filed a claim follows it on /claims (the route is open to
  // any signed-in user, this just puts it in their nav).
  if (entry.allowClaimant && auth.hasClaim) return true
  return Boolean(entry.allowGuardian && auth.hasDependents)
}
// Groups and items share one test: the feature is on and the user gets
// past the entry's gate.
function visible(entry) {
  return featureOn(entry) && allowedBy(entry)
}
// Groups drop out either because their own gate says so (a switched-off
// feature, a sysadmin-only section) or because every item inside them was
// filtered away, which is what keeps an empty section header off the rail.
const visibleGroups = computed(() =>
  NAV.filter(visible)
    .map((g) => ({ ...g, items: g.items.filter(visible) }))
    .filter((g) => g.items.length),
)

// The complete menu uses exactly the same permissions as the sidebar.
const navSearch = ref('')
const displayedGroups = computed(() => {
  const query = navSearch.value.trim().toLocaleLowerCase()
  return visibleGroups.value.map(g => ({ ...g, items: g.items.filter(it =>
    !query || `${navLabel(it)} ${groupLabel(g)}`.toLocaleLowerCase().includes(query),
  ) })).filter(g => g.items.length)
})
const primaryWork = computed(() => {
  const items = visibleGroups.value.flatMap(g => g.items)
  // The most immediate poolside task; every other role stays one Menu tap away.
  const destinations = ['/control', '/judge', '/competitor', '/coach', '/scoreboard']
  return destinations.map(to => items.find(it => it.to === to)).find(Boolean)
})
const primaryRoots = ['/dashboard', '/control', '/judge', '/competitor', '/coach', '/scoreboard', '/inbox', '/settings']
const showBack = computed(() => native && !primaryRoots.includes(route.path))
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/dashboard')
}

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
// A whole group is "active" (highlights its rail icon) when the current
// route is one of its items.
function groupActive(g) {
  return g.items.some((it) => isActive(it.to))
}
// Sub-routes that aren't a nav item still deserve a real breadcrumb
// label; reuse existing translated keys.
const SUBROUTE_LABELS = {
  '/teams': 'teams.title',
  '/profile': 'dashboard.my_profile',
  '/inbox': 'dashboard.inbox',
}
const currentLabel = computed(() => {
  for (const g of NAV) for (const it of g.items) if (isActive(it.to)) return navLabel(it)
  for (const [p, k] of Object.entries(SUBROUTE_LABELS)) if (route.path.startsWith(p)) return t(k)
  return 'DivingHQ'
})

// Identity
const fullName = computed(() => auth.user?.full_name || auth.user?.username || 'Account')
const initials = computed(() =>
  fullName.value.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?',
)
const roleLabel = computed(() => {
  if (auth.user?.is_system_admin) return 'System admin'
  return auth.roleLine || 'Member'
})

// User menu popover
const menuOpen = ref(false)
function goProfile() { menuOpen.value = false; router.push('/profile') }
function goInbox() { menuOpen.value = false; router.push('/inbox') }
function goSettings() { menuOpen.value = false; router.push('/settings') }
function signOut() {
  menuOpen.value = false
  signOutAndLeave(auth, router)
}

// Search → reuse the global command palette (⌘K) via the app channel
// (no window global; mount-order independent).
function openSearch() {
  openCommandPalette()
}

// Collapse / responsive. Desktop: shrink the grid (persisted).
// Mobile (≤860px): the sidebar is off-canvas; the same button
// toggles a local overlay instead.
const isMobile = ref(false)
const mobileOpen = ref(false)
function syncViewport() {
  isMobile.value = typeof window !== 'undefined' && window.innerWidth <= 860
  if (!isMobile.value) mobileOpen.value = false
}
onMounted(() => { syncViewport(); window.addEventListener('resize', syncViewport) })
onBeforeUnmount(() => window.removeEventListener('resize', syncViewport))

const collapsed = computed(() => (isMobile.value ? !mobileOpen.value : (native ? false : ui.sidebarCollapsed)))
// Desktop collapse = a slim icon rail (not hidden): each group condenses
// to one icon whose hover/focus flyout lists its items. Mobile keeps the
// off-canvas overlay, so the rail is desktop-only.
const railMode = computed(() => !native && ui.sidebarCollapsed && !isMobile.value)
// The closed drawer is only slid off-screen, so it's also made inert
// (template) or its links sat in the tab order and the a11y tree while
// invisible. That means focus has to be walked in and out by hand.
const sidebarEl = ref(null)
const toggleBtn = ref(null)
let drawerOpener = null
function toggleSidebar() {
  if (native && !isMobile.value) return
  if (!isMobile.value) { ui.toggleSidebar(); return }
  if (!mobileOpen.value) drawerOpener = document.activeElement
  navSearch.value = ''
  mobileOpen.value = !mobileOpen.value
  // inert only comes off on the next render, focus() before that is a no-op.
  if (mobileOpen.value) nextTick(() => sidebarEl.value?.querySelector('a[href], button')?.focus())
}
// restoreFocus for scrim/Esc. A nav link click is heading to a new page,
// so there's no point dragging focus back to the toggle for that.
function closeMobile(restoreFocus = false) {
  if (!mobileOpen.value) return
  mobileOpen.value = false
  if (restoreFocus) nextTick(() => (drawerOpener?.isConnected ? drawerOpener : toggleBtn.value)?.focus())
}

function onDrawerKeydown(event) {
  if (!isMobile.value || !mobileOpen.value || event.key !== 'Tab') return
  const items = [...sidebarEl.value.querySelectorAll('a[href], button, input')]
    .filter(el => !el.disabled && el.offsetParent !== null)
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
function onDeviceBack(event) {
  if (!mobileOpen.value) return
  event.preventDefault()
  closeMobile(true)
}
onMounted(() => window.addEventListener('dhq:back', onDeviceBack))
onBeforeUnmount(() => window.removeEventListener('dhq:back', onDeviceBack))
watch(() => route.fullPath, async () => {
  closeMobile()
  menuOpen.value = false
  navSearch.value = ''
  await nextTick()
  const content = document.getElementById('main-content')
  if (content) { content.scrollTop = 0; content.focus({ preventScroll: true }) }
})
</script>

<template>
  <div class="app-shell" :class="{ collapsed, mobile: isMobile, native, 'keyboard-open': keyboardOpen, 'mobile-open': isMobile && mobileOpen }" :style="viewportHeight ? { height: `${viewportHeight}px` } : undefined">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <!-- Sidebar -->
    <aside
      ref="sidebarEl"
      class="sidebar"
      :inert="isMobile && !mobileOpen"
      @keydown.esc="closeMobile(true)"
      @keydown="onDrawerKeydown"
      :role="isMobile && mobileOpen ? 'dialog' : undefined"
      :aria-modal="isMobile && mobileOpen ? true : undefined"
      aria-label="App menu"
    >
      <RouterLink to="/dashboard" class="sb-brand" @click="closeMobile()">
        <LogoMark :size="28" />
        <span class="wm brand-wordmark">DIVING<span>HQ</span></span>
      </RouterLink>

      <div v-if="isMobile" class="mobile-menu-tools">
        <label class="menu-search"><Search aria-hidden="true" /><input v-model="navSearch" type="search" placeholder="Find a tool…" aria-label="Find a tool" /></label>
        <button type="button" class="icon-btn" aria-label="Close menu" @click="closeMobile(true)"><X /></button>
      </div>
      <p v-if="isMobile && !displayedGroups.length" class="menu-empty">No tools match. Try a different name.</p>
      <nav class="sb-nav" :class="{ rail: railMode }" aria-label="Primary">
        <!-- COLLAPSED ICON RAIL: one button per group; the flyout (hover
             or keyboard focus) lists that group's items. Single-item
             groups (Dashboard) link directly. -->
        <template v-if="railMode">
          <div v-for="g in displayedGroups" :key="g.key" class="sb-rail-group">
            <RouterLink
              v-if="!g.group"
              :to="g.items[0].to"
              class="sb-rail-btn"
              :class="{ active: isActive(g.items[0].to) }"
              v-tip:right.fixed="navLabel(g.items[0])"
            >
              <component :is="g.items[0].icon" class="sb-ic" />
            </RouterLink>
            <div v-else class="sb-rail-group-wrap">
              <button type="button" class="sb-rail-btn" :class="{ active: groupActive(g) }" :aria-label="groupLabel(g)">
                <component :is="g.icon" class="sb-ic" />
              </button>
              <div class="sb-flyout" role="menu" :aria-label="groupLabel(g)">
                <div class="sb-flyout-head">{{ groupLabel(g) }}</div>
                <RouterLink
                  v-for="it in g.items"
                  :key="it.to"
                  :to="it.to"
                  class="sb-item sb-flyout-item"
                  :class="{ active: isActive(it.to) }"
                  role="menuitem"
                >
                  <component :is="it.icon" class="sb-ic" />
                  <span class="sb-label">{{ navLabel(it) }}</span>
                </RouterLink>
              </div>
            </div>
          </div>
        </template>
        <!-- EXPANDED: full labelled list. -->
        <template v-else>
        <template v-for="g in displayedGroups" :key="g.group || 'root'">
          <div v-if="g.group" class="sb-group">{{ groupLabel(g) }}</div>
          <RouterLink
            v-for="it in g.items"
            :key="it.to"
            :to="it.to"
            class="sb-item"
            :class="{ active: isActive(it.to) }"
            @click="closeMobile()"
          >
            <component :is="it.icon" class="sb-ic" />
            <span class="sb-label">{{ navLabel(it) }}</span>
          </RouterLink>
        </template>
        </template>
      </nav>

      <div class="sb-foot">
        <div class="sb-user-wrap">
          <button class="sb-user" type="button" @click="menuOpen = !menuOpen" :aria-expanded="menuOpen">
            <span class="avatar">{{ initials }}</span>
            <span class="sb-user-id">
              <span class="nm">{{ fullName }}</span>
              <span class="rl">{{ roleLabel }}</span>
            </span>
            <EllipsisVertical class="sb-user-caret" />
          </button>
          <div v-if="menuOpen" class="sb-menu-scrim" @click="menuOpen = false"></div>
          <div v-if="menuOpen" class="sb-menu">
            <button class="sb-menu-item" type="button" @click="goProfile"><User class="mi-ic" />{{ $t('dashboard.my_profile') }}</button>
            <button class="sb-menu-item" type="button" @click="goInbox"><Inbox class="mi-ic" />{{ $t('dashboard.inbox') }}</button>
            <button class="sb-menu-item" type="button" @click="goSettings"><Settings class="mi-ic" />Settings</button>
            <div class="sb-menu-div"></div>
            <button class="sb-menu-item danger" type="button" @click="signOut"><LogOut class="mi-ic" />{{ $t('dashboard.sign_out') }}</button>
          </div>
        </div>
      </div>
    </aside>

    <!-- Scrim for the mobile off-canvas sidebar -->
    <div v-if="isMobile && mobileOpen" class="shell-scrim" @click="closeMobile(true)"></div>

    <!-- Main column -->
    <div class="shell-main" :inert="isMobile && mobileOpen">
      <header class="topbar">
        <button v-if="showBack" class="icon-btn" type="button" aria-label="Back" @click="goBack"><ArrowLeft /></button>
        <button v-if="!native || isMobile" ref="toggleBtn" class="icon-btn" type="button" :aria-label="isMobile ? 'Open app menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar to icons'" :aria-expanded="isMobile ? mobileOpen : undefined" @click="toggleSidebar">
          <PanelLeftOpen v-if="collapsed" />
          <PanelLeftClose v-else />
        </button>
        <nav class="crumb" aria-label="Breadcrumb">
          <span class="crumb-root">DivingHQ</span>
          <ChevronRight class="crumb-sep" />
          <span class="here">{{ currentLabel }}</span>
        </nav>
        <button class="topbar-search" type="button" @click="openSearch">
          <Search class="ts-ic" />
          <span class="ts-ph">Search meets, divers, judges…</span>
          <kbd>⌘K</kbd>
        </button>
        <div class="spacer"></div>
        <ThemeToggle v-if="!isMobile" compact />
        <button v-if="isMobile" class="icon-btn" type="button" aria-label="Search" @click="openSearch"><Search /></button>
        <RouterLink v-if="!isMobile" to="/guide" class="icon-btn" aria-label="Help & user guide" v-tip:bottom.fixed="'Help & user guide'"><CircleHelp /></RouterLink>
        <RouterLink v-if="!isMobile" to="/inbox" class="icon-btn" aria-label="Notifications" v-tip:bottom.fixed="'Notifications'"><Bell /></RouterLink>
      </header>

      <main id="main-content" class="shell-content" tabindex="-1" :aria-label="currentLabel">
        <slot />
      </main>
      <nav v-if="isMobile && !keyboardOpen" class="mobile-tabs" aria-label="App tabs">
        <RouterLink to="/dashboard" :class="{ active: isActive('/dashboard') }"><LayoutDashboard /><span>Home</span></RouterLink>
        <RouterLink v-if="primaryWork" :to="primaryWork.to" :class="{ active: isActive(primaryWork.to) }" :aria-label="navLabel(primaryWork)"><component :is="primaryWork.icon" /><span>{{ primaryWork.to === '/scoreboard' ? 'Results' : 'Work' }}</span></RouterLink>
        <RouterLink to="/inbox" :class="{ active: isActive('/inbox') }"><Inbox /><span>Inbox</span></RouterLink>
        <button type="button" :aria-expanded="mobileOpen" @click="toggleSidebar"><Menu /><span>Menu</span></button>
        <RouterLink to="/settings" :class="{ active: isActive('/settings') }"><Settings /><span>Settings</span></RouterLink>
      </nav>
    </div>
  </div>
</template>

<style scoped>
/* P1: skip-to-content link, off-screen until focused, then pinned
   top-left. The first focusable element on every shelled page. */
.skip-link {
  position: absolute;
  left: 8px;
  top: -52px;
  z-index: 1000;
  padding: 8px 14px;
  background: var(--surface);
  color: var(--fg);
  border: 2px solid var(--accent);
  border-radius: var(--radius-sm, 6px);
  text-decoration: none;
  transition: top 0.15s ease;
}
.skip-link:focus { top: 8px; outline: none; }

/* position:fixed + inset:0 makes the shell own the full viewport
   regardless of any body styling (some public auth views set
   `body { display:flex; padding }` globally, which would otherwise
   push the sidebar off-screen). The sidebar is therefore always
   full-height and fixed; only .shell-content scrolls. */
.app-shell {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: 244px 1fr;
  transition: grid-template-columns var(--dur-slow) var(--ease);
  background: var(--bg);
  /* The installed iOS app draws edge to edge (index.html asks for
     viewport-fit=cover + a black-translucent status bar), so keep the
     chrome out of the notch in landscape. Physical sides because
     that's what the insets are. 0 everywhere else. */
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}
/* Desktop collapse = a slim icon rail (mobile is handled off-canvas
   in the media query below, where this width is overridden to 1fr). */
.app-shell.collapsed { grid-template-columns: 64px 1fr; }

/* ── Sidebar ── */
.sidebar {
  background: var(--surface);
  /* Status-bar band, see .topbar. */
  border-top: env(safe-area-inset-top, 0px) solid var(--status-band);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  min-width: 0; overflow: hidden;
  position: relative; z-index: 30;   /* keep flyouts above the main column */
}
/* In the rail, the sidebar must not clip the flyouts that escape it. */
.app-shell.collapsed .sidebar { overflow: visible; }
.sb-brand {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
  text-decoration: none; white-space: nowrap;
}
.sb-brand .wm { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; color: var(--fg); }
.sb-brand .wm span { color: var(--accent); }

.sb-nav { padding: 6px 12px; overflow-y: auto; flex: 1; }
.sb-group {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--fg-3); padding: 14px 10px 5px; white-space: nowrap;
}
.sb-item {
  display: flex; align-items: center; gap: 11px; width: 100%;
  padding: 8px 10px; border-radius: var(--radius);
  font-size: 13.5px; font-weight: 500; color: var(--fg-2); text-decoration: none;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.sb-item .sb-ic { width: 17px; height: 17px; flex-shrink: 0; stroke-width: 1.9; }
.sb-item:hover { background: var(--surface-hover); color: var(--fg); }
.sb-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }

/* ── Collapsed icon rail + hover/focus flyouts ── */
.sb-nav.rail { overflow: visible; padding: 6px 8px; }
.sb-rail-group { display: flex; justify-content: center; }
.sb-rail-group + .sb-rail-group { margin-top: 3px; }
.sb-rail-group-wrap { position: relative; width: 100%; display: flex; justify-content: center; }
.sb-rail-btn {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border: none; background: none; cursor: pointer;
  border-radius: var(--radius); color: var(--fg-2);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.sb-rail-btn:hover { background: var(--surface-hover); color: var(--fg); }
.sb-rail-btn.active { background: var(--accent-soft); color: var(--accent); }
.sb-rail-btn .sb-ic { width: 19px; height: 19px; }

/* The flyout floats to the right of the rail, above the main column.
   A transparent bridge (::before) spans the gap so the pointer never
   leaves a hoverable surface on its way across. */
.sb-flyout {
  position: absolute; left: 100%; top: -4px; z-index: 60;
  min-width: 178px; margin-left: 12px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px); padding: 6px;
  box-shadow: 0 10px 30px rgba(0,0,0,.16);
  opacity: 0; visibility: hidden; transform: translateX(-4px);
  transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease), visibility var(--dur-fast);
}
.sb-flyout::before { content: ''; position: absolute; left: -12px; top: 0; bottom: 0; width: 12px; }
.sb-rail-group-wrap:hover .sb-flyout,
.sb-rail-group-wrap:focus-within .sb-flyout {
  opacity: 1; visibility: visible; transform: translateX(0);
}
.sb-flyout-head {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--fg-3); padding: 4px 10px 6px;
}
.sb-flyout-item { font-size: 13px; }
/* Rail: logo mark only, avatar only, hide the wide bits. */
.app-shell.collapsed .sb-brand { justify-content: center; padding: 14px 0; }
.app-shell.collapsed .sb-brand .wm { display: none; }
.app-shell.collapsed .sb-user { justify-content: center; padding: 8px 0; }
.app-shell.collapsed .sb-user-id,
.app-shell.collapsed .sb-user-caret { display: none; }

.sb-foot { padding: 10px 12px; border-top: 1px solid var(--border); }
.sb-user-wrap { position: relative; }
.sb-user {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 9px; border: none; background: none; border-radius: var(--radius);
  cursor: pointer; text-align: left;
}
.sb-user:hover { background: var(--surface-hover); }
.sb-user .avatar {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  background: var(--role-manager-bg); color: var(--role-manager-fg);
  display: grid; place-items: center; font-size: 12px; font-weight: 700;
}
.sb-user-id { flex: 1; min-width: 0; overflow: hidden; }
.sb-user .nm { display: block; font-size: 13px; font-weight: 600; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-user .rl { display: block; font-size: 11px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-user-caret { width: 15px; height: 15px; color: var(--fg-3); flex-shrink: 0; }

.sb-menu-scrim { position: fixed; inset: 0; z-index: 40; }
.sb-menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; z-index: 41;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg); padding: 6px;
}
.sb-menu-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 9px 10px; border: none; background: none; border-radius: var(--radius);
  font-size: 13.5px; font-weight: 500; color: var(--fg); text-align: left; cursor: pointer;
}
.sb-menu-item:hover { background: var(--surface-hover); }
.sb-menu-item .mi-ic { width: 16px; height: 16px; color: var(--fg-3); }
.sb-menu-item.danger { color: var(--danger-fg); }
.sb-menu-item.danger .mi-ic { color: var(--danger-fg); }
.sb-menu-div { height: 1px; background: var(--border); margin: 5px 4px; }

/* ── Main column ── */
.shell-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; }
.topbar {
  /* Grows by the status-bar inset in the installed iOS app, where the
     page runs up under the clock. The band is a border in the brand
     blue (the theme-color) because iOS draws that status text white
     and it vanished against the light topbar. */
  height: calc(56px + env(safe-area-inset-top, 0px)); flex-shrink: 0;
  border-top: env(safe-area-inset-top, 0px) solid var(--status-band);
  background: var(--surface); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px; padding: 0 16px;
}
.icon-btn {
  width: 34px; height: 34px; flex-shrink: 0;
  display: grid; place-items: center;
  border-radius: var(--radius); border: 1px solid transparent; background: none;
  color: var(--fg-2); cursor: pointer; text-decoration: none;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.icon-btn:hover { background: var(--surface-hover); color: var(--fg); }
.icon-btn :deep(svg) { width: 18px; height: 18px; }
.icon-btn-accent { color: var(--accent); }
.icon-btn-accent:hover { background: var(--accent-soft); color: var(--accent); }

.crumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--fg-3); white-space: nowrap; }
.crumb .crumb-sep { width: 15px; height: 15px; }
.crumb .here { color: var(--fg); font-weight: 600; }
@media (max-width: 600px) { .crumb-root, .crumb-sep { display: none; } }

.topbar-search {
  display: flex; align-items: center; gap: 8px;
  width: 300px; max-width: 34vw; margin-left: 6px;
  padding: 7px 10px; border-radius: var(--radius);
  background: var(--bg); border: 1px solid var(--border); cursor: text;
  color: var(--fg-3); font-size: 13px; font-family: var(--font-sans);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.topbar-search:hover { border-color: var(--border-2); }
.topbar-search .ts-ic { width: 16px; height: 16px; flex-shrink: 0; }
.topbar-search .ts-ph { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar-search kbd {
  font-family: var(--font-mono); font-size: 10px; color: var(--fg-3);
  background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
}
@media (max-width: 720px) { .topbar-search { display: none; } }
.spacer { flex: 1; }

.shell-content { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }

/* Full-width on desktop: the converted views constrain their
   content with `max-width: …; margin: 0 auto`. Inside the shell
   we want the full 100% width, so neutralise those caps. */
.shell-content :deep(.main),
.shell-content :deep(.panel),
.shell-content :deep(.header-inner),
.shell-content :deep(.page-header),
.shell-content :deep(.page-sub),
.shell-content :deep(.profile-wrap),
.shell-content :deep(.audit-wrap),
.shell-content :deep(.compare-wrap),
.shell-content :deep(.inbox-wrap),
.shell-content :deep(.coach-wrap),
.shell-content :deep(.dashboard),
.shell-content :deep(.manager-toolbar),
.shell-content :deep(.pulse-strip) {
  max-width: none;
}

/* ── Mobile off-canvas ── */
.shell-scrim { position: fixed; inset: 0; z-index: 55; background: rgba(15,23,42,0.45); }
@media (max-width: 860px) {
  .app-shell, .app-shell.collapsed { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 60;
    /* Wider by the landscape notch so the links clear it; translateX
       below still takes the whole thing off-screen. */
    width: calc(244px + env(safe-area-inset-left, 0px));
    padding-left: env(safe-area-inset-left, 0px);
    transform: translateX(-100%); transition: transform var(--dur-slow) var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .app-shell.mobile-open .sidebar { transform: translateX(0); }
  .topbar { gap: 6px; padding: 0 10px; }
  .crumb { min-width: 0; overflow: hidden; }
  .crumb .here { overflow: hidden; text-overflow: ellipsis; }
  .icon-btn, .sb-item, .sb-menu-item { min-height: 44px; }
  .icon-btn { min-width: 44px; }
  .sidebar { width: min(340px, 100vw); padding-bottom: env(safe-area-inset-bottom, 0px); }
  .sb-user { min-height: 48px; }
  .shell-content { overscroll-behavior-y: contain; scroll-padding-bottom: 20px; }
  .shell-content :deep(input:not([type=checkbox]):not([type=radio])),
  .shell-content :deep(select), .shell-content :deep(textarea) { font-size: 16px; }
  .shell-content :deep(.btn) { min-height: 44px; }
  .shell-content :deep(.page-header), .shell-content :deep(.header-inner) { flex-wrap: wrap; gap: 10px; }

}
.mobile-menu-tools { display: flex; align-items: center; gap: 8px; padding: 12px; }
.menu-search { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); padding: 0 10px; }
.menu-search svg { width: 18px; flex-shrink: 0; color: var(--fg-3); }
.menu-search input { min-width: 0; width: 100%; height: 44px; background: transparent; border: 0; color: var(--fg); font-size: 16px; }
.menu-empty { padding: 0 16px; color: var(--fg-2); }
.mobile-tabs { display: flex; flex-shrink: 0; border-top: 1px solid var(--border); background: var(--surface); padding: 4px 4px calc(4px + env(safe-area-inset-bottom, 0px)); }
.mobile-tabs a, .mobile-tabs button { flex: 1; min-width: 0; min-height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--fg-2); text-decoration: none; border: 0; border-radius: var(--radius); background: transparent; font-family: inherit; font-size: 11px; cursor: pointer; }
.mobile-tabs svg { width: 22px; height: 22px; }
.mobile-tabs .active { color: var(--accent); background: var(--accent-soft); font-weight: 700; }
.native .sb-item, .native .sb-menu-item, .native .sb-user { min-height: 44px; }
.native .icon-btn { width: 44px; height: 44px; }
.native .sb-foot { padding-bottom: max(10px, env(safe-area-inset-bottom, 0px)); }
@media (prefers-reduced-motion: reduce) {
  .app-shell, .sidebar, .skip-link { transition: none; }
}
</style>
