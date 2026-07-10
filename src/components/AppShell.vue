<script setup>
// Persistent CRM app shell: 244px collapsible left sidebar plus a
// 56px top bar, introduced by the "Marine CRM" redesign. Wraps
// authenticated routes that opt in via `meta.appShell` (see
// App.vue). The routed screen renders in the default slot.
//
// Nav is role-gated against the auth store (system admins see
// everything). Collapse state and theme live in the Pinia ui store.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'
import LogoMark from '@/components/LogoMark.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { openCommandPalette } from '@/composables/useAppChannel'
import {
  LayoutDashboard, Trophy, MonitorPlay, Calculator, ChartColumn, Waves, GraduationCap,
  ListChecks, BookOpen, Users, Building2, ScrollText,
  PanelLeftClose, PanelLeftOpen, ChevronRight, Search, CircleHelp,
  Bell, User, Inbox, LogOut, EllipsisVertical, CreditCard, Award, Gavel,
  History, Receipt, Heart, Layers, Wallet, UserCheck,
} from '@lucide/vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const ui = useUiStore()
const { t } = useI18n()

// Nav model. `roles` gates visibility, omit it for items every
// signed-in user can reach.
// Labels reuse existing (already-translated) i18n keys where one
// cleanly exists, wich keeps the strict i18n-parity gate happy without
// adding new keys. The few role-specific items without a clean key
// fall back to English via `label`.
// Each group carries a `key` (stable v-for key) and an `icon`; the icon
// is the group's face in the collapsed icon rail, where the whole group
// condenses to one button whose hover/focus flyout lists its items.
const NAV = [
  // Header-less lead item: Dashboard is the universal home, not a
  // "Competition" tool, so it sits above the first section header.
  { key: 'home', group: '', icon: LayoutDashboard, items: [
    { to: '/dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
  ] },
  // Live-competition workflow, roughly in the order it's used:
  // set up → run → participate → judge → results → analysis → reference.
  { key: 'competition', group: 'Competition', icon: Trophy, items: [
    { to: '/manager',        label: 'Meets & events', labelKey: 'manager.title',         icon: Trophy,        roles: ['org_admin', 'meet_manager'] },
    { to: '/control',        label: 'Control Room',   labelKey: 'control.page_label',     icon: MonitorPlay,   roles: ['org_admin', 'meet_manager', 'referee'] },
    { to: '/competitor',     label: 'Dive Sheets',    icon: Waves,         roles: ['diver'] },
    { to: '/judge',          label: 'Judge Terminal', icon: Calculator,    roles: ['judge'] },
    { to: '/scoreboard',     label: 'Scoreboard & Results', labelKey: 'scoreboard.page_label',  icon: ListChecks },
    { to: '/judge-analysis', label: 'Judge Analysis', icon: ChartColumn },
    { to: '/dive-directory', label: 'Dive directory', labelKey: 'dive_directory.title',   icon: BookOpen },
  ] },
  // Club training: distinct from competition, context-adaptive per role.
  { key: 'training', group: 'Training', icon: GraduationCap, items: [
    { to: '/coach',          label: 'Coaching',       icon: GraduationCap, roles: ['coach'] },
    { to: '/classes',        label: 'Classes',        labelKey: 'classes.menu', icon: Layers },
  ] },
  // Personal money: everything the signed-in user pays or is owed.
  // Flattened out of the old nested "User Payments" menu, money screens
  // are important enough to be one click, not two, and this removes the
  // name clash with the Federation admin payments hub below.
  { key: 'payments', group: 'Payments', icon: Wallet, items: [
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
  // personal section above.
  { key: 'federation', group: 'Federation', icon: Building2, items: [
    { to: '/users',    label: 'User Manager',       labelKey: 'user_manager.title', icon: Users,      roles: ['org_admin'] },
    { to: '/clubs',    label: 'Clubs & teams',      labelKey: 'clubs.title',        icon: Building2,  roles: ['org_admin', 'meet_manager'] },
    { to: '/fines',    label: 'Fines',              icon: Gavel,      roles: ['referee', 'org_admin'] },
    { to: '/payments', label: 'Payments & payouts', icon: CreditCard, roles: ['org_admin'] },
    { to: '/audit',    label: 'Audit Log',          labelKey: 'audit.page_label',   icon: ScrollText, roles: ['org_admin'] },
  ] },
]

function navLabel(it) {
  return it.labelKey ? t(it.labelKey) : it.label
}

function allowedBy(entry) {
  if (!entry.roles) return true
  if (entry.roles.some((r) => auth.hasRole(r))) return true
  return Boolean(entry.allowGuardian && auth.hasDependents)
}
function childVisible(c) {
  return allowedBy(c)
}
function itemVisible(it) {
  if (it.children) return it.children.some(childVisible)
  return allowedBy(it)
}
// A nested item (children) is shown if any child is visible; its child
// list is filtered to the roles the user actually has.
const visibleGroups = computed(() =>
  NAV.map((g) => ({
    ...g,
    items: g.items
      .filter(itemVisible)
      .map((it) => (it.children ? { ...it, children: it.children.filter(childVisible) } : it)),
  })).filter((g) => g.items.length),
)

// Nested-menu expansion. Hover expands it on desktop (CSS); this click
// state keeps it open on touch and after a tap.
const openMenu = ref(null)
function toggleMenu(key) {
  openMenu.value = openMenu.value === key ? null : key
}

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
}
function isParentActive(it) {
  return !!it.children && it.children.some((c) => isActive(c.to))
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
  for (const g of NAV) for (const it of g.items) {
    if (it.children) {
      for (const c of it.children) if (isActive(c.to)) return navLabel(c)
    } else if (isActive(it.to)) {
      return navLabel(it)
    }
  }
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
  return auth.formatRoles(auth.user?.org_roles || []) || 'Member'
})

// User menu popover
const menuOpen = ref(false)
function goProfile() { menuOpen.value = false; router.push('/profile') }
function goInbox() { menuOpen.value = false; router.push('/inbox') }
function signOut() {
  menuOpen.value = false
  auth.clearSession()
  router.push('/login')
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

const collapsed = computed(() => (isMobile.value ? !mobileOpen.value : ui.sidebarCollapsed))
// Desktop collapse = a slim icon rail (not hidden): each group condenses
// to one icon whose hover/focus flyout lists its items. Mobile keeps the
// off-canvas overlay, so the rail is desktop-only.
const railMode = computed(() => ui.sidebarCollapsed && !isMobile.value)
function toggleSidebar() {
  if (isMobile.value) mobileOpen.value = !mobileOpen.value
  else ui.toggleSidebar()
}
function closeMobile() { mobileOpen.value = false }
</script>

<template>
  <div class="app-shell" :class="{ collapsed, mobile: isMobile, 'mobile-open': isMobile && mobileOpen }">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <!-- Sidebar -->
    <aside class="sidebar">
      <RouterLink to="/dashboard" class="sb-brand">
        <LogoMark :size="28" />
        <span class="wm brand-wordmark">DIVING<span>HQ</span></span>
      </RouterLink>

      <nav class="sb-nav" :class="{ rail: railMode }" aria-label="Primary">
        <!-- COLLAPSED ICON RAIL: one button per group; the flyout (hover
             or keyboard focus) lists that group's items. Single-item
             groups (Dashboard) link directly. -->
        <template v-if="railMode">
          <div v-for="g in visibleGroups" :key="g.key" class="sb-rail-group">
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
              <button type="button" class="sb-rail-btn" :class="{ active: groupActive(g) }" :aria-label="g.group">
                <component :is="g.icon" class="sb-ic" />
              </button>
              <div class="sb-flyout" role="menu" :aria-label="g.group">
                <div class="sb-flyout-head">{{ g.group }}</div>
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
        <template v-for="g in visibleGroups" :key="g.group || 'root'">
          <div v-if="g.group" class="sb-group">{{ g.group }}</div>
          <template v-for="it in g.items" :key="it.to || it.menu">
            <!-- Nested menu: hover (desktop) or tap expands the sub-items -->
            <div v-if="it.children" class="sb-parent" :class="{ open: openMenu === it.menu }">
              <button
                type="button"
                class="sb-item sb-parent-btn"
                :class="{ active: isParentActive(it) }"
                :aria-expanded="openMenu === it.menu ? 'true' : 'false'"
                @click="toggleMenu(it.menu)"
              >
                <component :is="it.icon" class="sb-ic" />
                <span class="sb-label">{{ navLabel(it) }}</span>
                <ChevronRight class="sb-caret" />
              </button>
              <div class="sb-sub">
                <RouterLink
                  v-for="c in it.children"
                  :key="c.to"
                  :to="c.to"
                  class="sb-item sb-subitem"
                  :class="{ active: isActive(c.to) }"
                  @click="closeMobile"
                >
                  <component :is="c.icon" class="sb-ic" />
                  <span class="sb-label">{{ navLabel(c) }}</span>
                </RouterLink>
              </div>
            </div>
            <RouterLink
              v-else
              :to="it.to"
              class="sb-item"
              :class="{ active: isActive(it.to) }"
              @click="closeMobile"
            >
              <component :is="it.icon" class="sb-ic" />
              <span class="sb-label">{{ navLabel(it) }}</span>
            </RouterLink>
          </template>
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
            <div class="sb-menu-div"></div>
            <button class="sb-menu-item danger" type="button" @click="signOut"><LogOut class="mi-ic" />{{ $t('dashboard.sign_out') }}</button>
          </div>
        </div>
      </div>
    </aside>

    <!-- Scrim for the mobile off-canvas sidebar -->
    <div v-if="isMobile && mobileOpen" class="shell-scrim" @click="closeMobile"></div>

    <!-- Main column -->
    <div class="shell-main">
      <header class="topbar">
        <button class="icon-btn" type="button" :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar to icons'" @click="toggleSidebar">
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
        <ThemeToggle compact />
        <RouterLink to="/guide" class="icon-btn" aria-label="Help & user guide" v-tip:bottom.fixed="'Help & user guide'"><CircleHelp /></RouterLink>
        <RouterLink to="/inbox" class="icon-btn" aria-label="Notifications" v-tip:bottom.fixed="'Notifications'"><Bell /></RouterLink>
      </header>

      <main id="main-content" class="shell-content" tabindex="-1" :aria-label="currentLabel">
        <slot />
      </main>
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
}
/* Desktop collapse = a slim icon rail (mobile is handled off-canvas
   in the media query below, where this width is overridden to 1fr). */
.app-shell.collapsed { grid-template-columns: 64px 1fr; }

/* ── Sidebar ── */
.sidebar {
  background: var(--surface);
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

/* Nested 'User Payments' menu: inline accordion, opens on hover or tap. */
.sb-parent { display: flex; flex-direction: column; }
.sb-parent-btn { border: none; background: none; cursor: pointer; font: inherit; text-align: left; }
.sb-caret { width: 15px; height: 15px; margin-left: auto; flex-shrink: 0; stroke-width: 2;
  color: var(--fg-3); transition: transform var(--dur-fast) var(--ease); }
.sb-parent:hover .sb-caret,
.sb-parent.open .sb-caret { transform: rotate(90deg); }
.sb-sub { display: none; flex-direction: column; gap: 1px;
  margin: 2px 0 4px 16px; padding-left: 8px; border-left: 1px solid var(--border); }
.sb-parent:hover .sb-sub,
.sb-parent.open .sb-sub { display: flex; }
.sb-subitem { font-size: 12.5px; padding: 6px 10px; }
.sb-subitem .sb-ic { width: 15px; height: 15px; }

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
.shell-main { display: flex; flex-direction: column; min-width: 0; height: 100dvh; overflow: hidden; }
.topbar {
  height: 56px; flex-shrink: 0;
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

.shell-content { flex: 1; overflow-y: auto; background: var(--bg); }

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
    position: fixed; inset: 0 auto 0 0; width: 244px; z-index: 60;
    transform: translateX(-100%); transition: transform var(--dur-slow) var(--ease);
    box-shadow: var(--shadow-lg);
  }
  .app-shell.mobile-open .sidebar { transform: translateX(0); }
}
</style>
