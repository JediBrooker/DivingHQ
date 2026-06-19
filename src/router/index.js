import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/',
    component: () => import('@/views/HomeView.vue'),
    meta: { guestOnly: true },
  },
  {
    // Plain-English new-user primer. Public, no auth required —
    // linked from the home hero / footer and from the dashboard
    // footer. Deliberately NOT a wiki replacement; the page
    // points out to the full wiki for depth.
    path: '/guide',
    component: () => import('@/views/GuideView.vue'),
  },
  {
    path: '/login',
    component: () => import('@/views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    component: () => import('@/views/RegisterView.vue'),
  },
  {
    path: '/register-org',
    component: () => import('@/views/RegisterOrgView.vue'),
  },
  {
    path: '/forgot-password',
    component: () => import('@/views/ForgotPasswordView.vue'),
  },
  {
    path: '/reset-password',
    component: () => import('@/views/ResetPasswordView.vue'),
  },
  {
    // Step 2 of the self-service email change (Migration 044).
    // Public route — the token in the query string is the
    // credential. The view auto-posts on mount, swaps the user's
    // email server-side, and bounces them to /login since the
    // confirm bumps token_version (kills every active session).
    path: '/confirm-email-change',
    component: () => import('@/views/ConfirmEmailChangeView.vue'),
  },
  {
    path: '/dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAuth: true, appShell: true },
  },
  {
    path: '/manager',
    component: () => import('@/views/ManagerView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'], appShell: true },
  },
  {
    // First-run setup wizard — guides a brand-new org admin
    // through creating a club, sharing the invite link, and
    // opening Meet Manager. DashboardView auto-redirects here
    // for fresh accounts; the wizard itself bounces back if
    // already completed (localStorage stamp).
    path: '/setup',
    component: () => import('@/views/SetupWizardView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin'] },
  },
  {
    path: '/competitor',
    component: () => import('@/views/CompetitorView.vue'),
    meta: { requiresAuth: true, requiresRole: ['diver'], appShell: true },
  },
  {
    path: '/coach',
    component: () => import('@/views/CoachView.vue'),
    meta: { requiresAuth: true, requiresRole: ['coach'], appShell: true },
  },
  {
    // Coach-on-behalf-of dive list editor — Phase 2 of the coach
    // feature bundle. Lets a coach submit / edit dive lists for
    // any of their linked divers for a given event.
    path: '/coach/dive-lists/:event_id',
    component: () => import('@/views/CoachDiveListsView.vue'),
    meta: { requiresAuth: true, requiresRole: ['coach'] },
  },
  {
    path: '/control',
    // Flag-gated resolver (P5): VITE_CONTROL_V2_ENABLED=1 serves the
    // Stage-Rail ControlViewV2; unset/0 serves the untouched
    // ControlView.vue (the instant rollback). Route-split so V1 and V2
    // never co-bundle. meta is byte-identical so the beforeEach gate,
    // role checks, and App.vue useShell are unchanged.
    component: () =>
      import.meta.env.VITE_CONTROL_V2_ENABLED === '1'
        ? import('@/views/ControlViewV2.vue')
        : import('@/views/ControlView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager', 'referee'], appShell: true },
  },
  {
    path: '/judge',
    component: () => import('@/views/JudgeView.vue'),
    meta: { requiresAuth: true, requiresRole: ['judge'] },
  },
  {
    // Judge Analysis — public transparency dashboard for any
    // judge in the system. Anonymous spectators can land here
    // from a scoreboard / meet page and verify whether a panel
    // member's calls trend with a country / club / etc — same
    // public-by-default stance as /profile/:id for divers.
    //
    // /judge-profile        → owner's own analysis (auth required)
    // /judge-profile/:id    → public profile for that judge
    path: '/judge-profile/:id?',
    component: () => import('@/views/JudgeProfileView.vue'),
    meta: { requiresAuthIfNoId: true },
  },
  {
    // Public judge directory — paginated browse + search across
    // every active org's judges. Open to anonymous viewers as a
    // discovery surface for the public Judge Analysis pages.
    path: '/judges',
    component: () => import('@/views/JudgeDirectoryView.vue'),
  },
  {
    // Unified live + archive surface — the old /archive route
    // was retired once this view absorbed both browse-completed-
    // meets and live-broadcast modes.
    //
    // /scoreboard            → list mode (browse meets)
    // /scoreboard/:eventId   → detail mode (deep-link to one meet)
    // /scoreboard/:eventId/broadcast → projector / kiosk mode
    path: '/scoreboard/:eventId?/:mode?',
    component: () => import('@/views/ScoreboardView.vue'),
    meta: { appShell: true },
  },
  {
    // Judge Analysis — public-accessible landing surface that
    // composes the per-event ranking matrix (By Event) and the
    // public judge directory (By Judge). Shell for signed-in
    // users, standalone for the public — same stance as
    // /scoreboard (no requiresAuth; appShell flips the CRM shell).
    path: '/judge-analysis',
    component: () => import('@/views/JudgeAnalysisView.vue'),
    meta: { appShell: true },
  },
  {
    // Results Archive — public, read-only browse of historical
    // results mined from DiveRecorder Meet Explorer into the dr_*
    // tables. Same public/appShell stance as /scoreboard.
    path: '/results-archive',
    component: () => import('@/views/DrArchiveExplorer.vue'),
    meta: { appShell: true },
  },
  {
    // Multi-event broadcast — one display, every currently-Live
    // event side by side. Auto-grids by event count (1 fills the
    // screen, 2 splits horizontally, 3-4 form a 2×2 …). Refreshes
    // its event list every 30s so newly-Live events join the
    // grid without an operator action.
    path: '/broadcast/all',
    component: () => import('@/views/MultiBroadcastView.vue'),
  },
  {
    // Public meet landing page — meet metadata + every event
    // grouped by status. Each event card jumps into /scoreboard.
    path: '/meet/:id',
    component: () => import('@/views/MeetView.vue'),
  },
  {
    // Session scheduler. Public viewers get the timeline + .ics
    // feed; same-org org admins and meet managers see conflict
    // and edit affordances inside the view.
    path: '/meet/:meetId/schedule',
    component: () => import('@/views/SchedulerView.vue'),
  },
  {
    path: '/users',
    component: () => import('@/views/UserManagerView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin'], appShell: true },
  },
  {
    path: '/clubs',
    component: () => import('@/views/ClubsView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'], appShell: true },
  },
  {
    path: '/teams',
    component: () => import('@/views/TeamsView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'], appShell: true },
  },
  {
    path: '/teams/:teamId/events/:eventId/dive-list',
    component: () => import('@/views/TeamDiveListView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    path: '/assign-judges',
    component: () => import('@/views/AssignJudgesView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    // /profile/:id is a PUBLIC profile page — anonymous spectators
    // landing here from a scoreboard diver-link should see the
    // diver's competitive history without being bounced to /login.
    // /profile (no id) means "my profile" and still needs a session;
    // the guard below redirects in that case.
    path: '/profile/:id?',
    component: () => import('@/views/DiverProfileView.vue'),
    meta: { requiresAuthIfNoId: true, appShell: true },
  },
  {
    // Side-by-side diver comparison. Diver IDs in the query string
    // (?a=&b=) so the URL is shareable like the rest of the app.
    path: '/compare',
    component: () => import('@/views/CompareView.vue'),
    meta: { requiresAuth: true, appShell: true },
  },
  {
    path: '/events/:id/audit',
    component: () => import('@/views/ScoreAuditView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin', 'meet_manager'] },
  },
  {
    // Federation-wide audit log — three tabs: recent activity,
    // score corrections, role changes. Org-admin gated; sysadmin
    // passes the same gate (the API enforces org scope) and gets
    // an extra "all orgs" filter inside the view.
    path: '/audit',
    component: () => import('@/views/AuditLogView.vue'),
    meta: { requiresAuth: true, requiresRole: ['org_admin'], appShell: true },
  },
  {
    // Notifications inbox — every push notification + in-app
    // banner sent to the signed-in user. Available to any
    // authenticated user (each row is scoped server-side).
    path: '/inbox',
    component: () => import('@/views/InboxView.vue'),
    meta: { requiresAuth: true, appShell: true },
  },
  {
    // Diver meet-day view — focused phone-deck experience for
    // an athlete mid-competition. Shows their next dive, queue
    // position, current rank, and what they need to score for
    // gold/silver/bronze. Powered by /api/events/:id/me-meet-day,
    // which gates on competitor_dive_lists membership so any
    // diver entered in the event reaches it.
    path: '/me/meet/:eventId',
    component: () => import('@/views/MeetDayView.vue'),
    meta: { requiresAuth: true },
  },
  {
    // Dive Directory browser: read the World Aquatics catalog,
    // add custom rows for poolside / progression dives. Anyone
    // signed in can browse; the create/edit/delete affordances
    // gate themselves on row.is_custom + same-org membership.
    path: '/dive-directory',
    component: () => import('@/views/DiveDirectoryView.vue'),
    meta: { requiresAuth: true, appShell: true },
  },
  {
    // Cut 3 referee sign-off — the page where a referee types
    // the 6-digit handoff code the meet manager generated on
    // their device.
    path: '/sign-off-codes',
    component: () => import('@/views/SignOffCodeView.vue'),
    meta: { requiresAuth: true, requiresRole: ['referee', 'org_admin'] },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// The guard is called after app.use(createPinia()) so the store is safe to access here.
// We call useAuthStore() inside the guard (not at module scope) so Pinia is active.
//
// Auth redirects preserve the user's original URL as `?next=` so
// LoginView can land them on the page they were aiming at after
// sign-in. Used by the referee-side QR sign-off flow (scan QR ⇒
// land on /sign-off-codes?code=… ⇒ if logged out, bounced to
// /login?next=%2Fsign-off-codes%3Fcode%3D… ⇒ back to the deep
// link after sign-in). LoginView validates `next` is a same-
// origin path before honouring it (open-redirect guard).
function bounceToLogin(to) {
  // Don't pass next when the user was already heading to /login
  // (avoid loops) or to a guest-only entry point.
  if (to.path === '/login') return '/login'
  return {
    path: '/login',
    query: { next: to.fullPath },
  }
}

router.beforeEach((to, from, next) => {
  const auth = useAuthStore()
  const isLoggedIn = auth.isLoggedIn

  // Redirect logged-in users away from guest-only pages
  if (to.meta.guestOnly && isLoggedIn) {
    return next('/dashboard')
  }

  // Require auth
  if (to.meta.requiresAuth && !isLoggedIn) {
    return next(bounceToLogin(to))
  }

  // Public-with-id, owner-private without: /profile/:id is open to
  // anonymous viewers, but /profile (no id) means the viewer's own
  // profile and so needs a session.
  if (to.meta.requiresAuthIfNoId && !isLoggedIn && !to.params.id) {
    return next(bounceToLogin(to))
  }

  // Require specific roles
  if (to.meta.requiresRole && isLoggedIn) {
    if (!auth.hasAnyRole(to.meta.requiresRole)) {
      return next('/dashboard')
    }
  }

  next()
})

export default router
