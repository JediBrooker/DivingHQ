<script setup>
// Persistent CRM app shell — 244px collapsible left sidebar +
// 56px top bar — introduced by the "Marine CRM" redesign. Wraps
// authenticated routes that opt in via `meta.appShell` (see
// App.vue). The routed screen renders in the default slot.
//
// Nav is role-gated against the auth store (system admins see
// everything). Collapse state + theme live in the Pinia ui store.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'
import LogoMark from '@/components/LogoMark.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import {
  LayoutDashboard, Trophy, MonitorPlay, Gavel, Scale, Waves, GraduationCap,
  ListChecks, BookOpen, Users, Building2, ScrollText,
  PanelLeftClose, PanelLeftOpen, ChevronRight, Search, CircleHelp,
  Bell, User, Inbox, LogOut, EllipsisVertical,
} from '@lucide/vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const ui = useUiStore()
const { t } = useI18n()

// Nav model. `roles` gates visibility; omit it for items every
// signed-in user can reach.
// Labels reuse existing (already-translated) i18n keys where one
// cleanly exists — keeps the strict i18n-parity gate happy without
// adding new keys. The few role-specific items without a clean key
// fall back to English via `label`.
const NAV = [
  { group: 'Competition', items: [
    { to: '/dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
    { to: '/manager',        label: 'Meets & events', labelKey: 'manager.title',         icon: Trophy,        roles: ['org_admin', 'meet_manager'] },
    { to: '/control',        label: 'Control Room',   labelKey: 'control.page_label',     icon: MonitorPlay,   roles: ['org_admin', 'meet_manager', 'referee'] },
    { to: '/judge',          label: 'Judge terminal', icon: Gavel,         roles: ['judge'] },
    { to: '/competitor',     label: 'Dive Sheets',    icon: Waves,         roles: ['diver'] },
    { to: '/coach',          label: 'Coaching',       icon: GraduationCap, roles: ['coach'] },
    { to: '/scoreboard',     label: 'Scoreboard',     labelKey: 'scoreboard.page_label',  icon: ListChecks },
    { to: '/judge-analysis', label: 'Judge Analysis', icon: Scale },
    { to: '/dive-directory', label: 'Dive directory', labelKey: 'dive_directory.title',   icon: BookOpen },
  ] },
  { group: 'Federation', items: [
    { to: '/users', label: 'User Manager',  labelKey: 'user_manager.title', icon: Users,      roles: ['org_admin'] },
    { to: '/clubs', label: 'Clubs & teams', labelKey: 'clubs.title',        icon: Building2,  roles: ['org_admin', 'meet_manager'] },
    { to: '/audit', label: 'Audit Log',     labelKey: 'audit.page_label',   icon: ScrollText, roles: ['org_admin'] },
  ] },
]

function navLabel(it) {
  return it.labelKey ? t(it.labelKey) : it.label
}

function itemVisible(it) {
  return !it.roles || it.roles.some((r) => auth.hasRole(r))
}
const visibleGroups = computed(() =>
  NAV.map((g) => ({ ...g, items: g.items.filter(itemVisible) })).filter((g) => g.items.length),
)

function isActive(to) {
  return route.path === to || route.path.startsWith(to + '/')
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

// Search → reuse the global command palette (⌘K).
function openSearch() {
  if (typeof window !== 'undefined' && typeof window.__openCommandPalette === 'function') {
    window.__openCommandPalette()
  }
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
function toggleSidebar() {
  if (isMobile.value) mobileOpen.value = !mobileOpen.value
  else ui.toggleSidebar()
}
function closeMobile() { mobileOpen.value = false }
</script>

<template>
  <div class="app-shell" :class="{ collapsed, mobile: isMobile, 'mobile-open': isMobile && mobileOpen }">
    <!-- Sidebar -->
    <aside class="sidebar">
      <RouterLink to="/dashboard" class="sb-brand">
        <LogoMark :size="28" />
        <span class="wm">DIVING<span>HQ</span></span>
      </RouterLink>

      <nav class="sb-nav">
        <template v-for="g in visibleGroups" :key="g.group">
          <div class="sb-group">{{ g.group }}</div>
          <RouterLink
            v-for="it in g.items"
            :key="it.to"
            :to="it.to"
            class="sb-item"
            :class="{ active: isActive(it.to) }"
            @click="closeMobile"
          >
            <component :is="it.icon" class="sb-ic" />
            <span class="sb-label">{{ navLabel(it) }}</span>
          </RouterLink>
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
        <button class="icon-btn" type="button" :aria-label="collapsed ? 'Show sidebar' : 'Hide sidebar'" @click="toggleSidebar">
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
        <RouterLink to="/guide" class="icon-btn" aria-label="Help & user guide" v-tip:bottom="'Help & user guide'"><CircleHelp /></RouterLink>
        <RouterLink to="/inbox" class="icon-btn" aria-label="Notifications" v-tip:bottom="'Notifications'"><Bell /></RouterLink>
      </header>

      <div class="shell-content">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
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
.app-shell.collapsed { grid-template-columns: 0 1fr; }

/* ── Sidebar ── */
.sidebar {
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  min-width: 0; overflow: hidden;
}
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
