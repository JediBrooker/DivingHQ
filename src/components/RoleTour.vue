<script setup>
/* First-login role tour. Mounts globally; activates on the
 * first dashboard load that follows a fresh sign-in (per role).
 * The setup wizard already covers fresh-org-admin onboarding;
 * this fills the gap for the more common first experience —
 * a coach, judge, or diver getting handed a username + invite.
 *
 * Each role has a small ordered list of slides, each with:
 *   - emoji (visual anchor)
 *   - title (short imperative)
 *   - body (one sentence, plain English)
 *   - cta (optional next-action button)
 *
 * The tour is dismissible (Skip), one-slide-at-a-time, and
 * stamps localStorage on completion so it never replays for
 * that user. A Cmd-K palette entry under "Help" lets the user
 * replay any time.
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { onReplayRoleTour } from '@/composables/useAppChannel'

const auth = useAuthStore()
const router = useRouter()

const open    = ref(false)

// Lock background scroll while the tour overlay is up so iOS
// Safari can't drift the dashboard underneath.
useBodyScrollLock().lockWhile(open)
const role    = ref(null)        // 'coach' | 'judge' | 'diver'
const cursor  = ref(0)

// ---- Slides ----------------------------------------------------
const SLIDES = {
  coach: [
    { emoji: '🤝',
      title: 'You coach divers, not events',
      body: 'A coach mentors specific divers — once your federation admin links you, those divers and their analytics, history, and template prep show up here automatically.' },
    { emoji: '📈',
      title: 'See every meet at once',
      body: 'Live, upcoming, and recently completed events are grouped at the top of your dashboard, with the next-up dive for each diver visible at a glance.' },
    { emoji: '📐',
      title: 'Plan from existing dive lists',
      body: 'Open any diver to copy a previous list as a template, suggest tweaks, and compare DD totals against peers at the same age + height.' },
    { emoji: '📬',
      title: 'Notifications follow scores',
      body: 'Subscribe to push from your dashboard and your phone buzzes when a diver you coach gets a finalised result. Catch up later from /inbox.',
      cta: { label: 'Open my dashboard', to: '/dashboard' },
    },
  ],
  judge: [
    { emoji: '⚖️',
      title: 'You score from one screen',
      body: 'When a meet manager assigns you to a panel, the Judge view loads the active diver automatically. No event picker — just tap the score.' },
    { emoji: '📱',
      title: 'Built for the pool deck',
      body: 'Lock your phone in landscape, leave it face-up, and DivingHQ keeps the screen awake. Submitting a score buzzes the phone so you can confirm without looking.' },
    { emoji: '🚩',
      title: 'Need the referee?',
      body: 'Tap "Signal Referee" if you missed a dive or the dive list looks wrong. The referee gets a flag on the Control Room — tap again to clear it.' },
    { emoji: '✓',
      title: 'Score, then wait',
      body: 'Once you submit, the keypad locks until the next diver — no double-tap risk. To amend a score, the meet manager opens score correction with you in the room.',
      cta: { label: 'Open the dashboard', to: '/dashboard' },
    },
  ],
  diver: [
    { emoji: '🤿',
      title: 'Welcome — this is your home',
      body: 'Every meet you enter, every event you compete in, every score, club + federation record, and personal best lives on your profile.' },
    { emoji: '📋',
      title: 'Build your dive list before the cut-off',
      body: 'When a meet you\'re entered in is Upcoming, your list is editable until entries close. After that, only a meet manager can amend it on your behalf.' },
    { emoji: '🏆',
      title: 'Compare yourself + improve',
      body: 'Your profile shows splits, year-on-year deltas, and a peer compare against divers in the same age + height bucket. Use it to pick the next training focus.' },
    { emoji: '💬',
      title: 'Coaches need permission',
      body: 'A coach has to ask to link to you, and your federation admin approves. You always know who can see your data — check User Manager → your row → coach links.',
      cta: { label: 'Browse upcoming meets', to: '/scoreboard' },
    },
  ],
}

const slides = computed(() => SLIDES[role.value] || [])
const slide  = computed(() => slides.value[cursor.value] || null)
const isLast = computed(() => cursor.value === slides.value.length - 1)

// ---- Lifecycle -------------------------------------------------
function stampKey(r) { return `dr_tour_seen_${r}` }

function pickRoleForUser() {
  // Prefer the most onboarding-needed role the user has, in
  // priority order. Power roles (org_admin / meet_manager) get
  // the existing setup wizard, not this tour.
  if (!auth.user) return null
  if (auth.hasRole('org_admin') || auth.hasRole('meet_manager')) return null
  for (const r of ['coach', 'judge', 'diver']) {
    if (auth.hasRole(r)) return r
  }
  return null
}

function startIfFresh() {
  const r = pickRoleForUser()
  if (!r) return
  // Already seen → no replay (manual replay is via the helper
  // exported on window).
  if (localStorage.getItem(stampKey(r))) return
  role.value   = r
  cursor.value = 0
  open.value   = true
}

function next() {
  if (isLast.value) finish()
  else cursor.value += 1
}
function back() { if (cursor.value > 0) cursor.value -= 1 }

function skip() {
  if (role.value) localStorage.setItem(stampKey(role.value), '1')
  open.value = false
}
function finish() {
  if (role.value) localStorage.setItem(stampKey(role.value), '1')
  open.value = false
  const cta = slide.value?.cta
  if (cta?.to) router.push(cta.to)
}

// Replay-from-anywhere — used by the Cmd-K "Help" entry and the
// /setup link. Caller can pass a role to force; otherwise the
// most-needed-role heuristic kicks in.
function replayTour(forceRole = null) {
  const r = forceRole || pickRoleForUser()
  if (!r) return
  role.value   = r
  cursor.value = 0
  open.value   = true
}

let offReplayChannel = null
// Auto-start on first dashboard mount post-login. We listen to
// route changes via the router instance because the SPA mounts
// this component once at the app root.
onMounted(() => {
  // Start one tick after mount so auth is hydrated.
  setTimeout(() => {
    if (router.currentRoute.value.path === '/dashboard') startIfFresh()
  }, 0)
  router.afterEach((to) => {
    if (to.path === '/dashboard' && !open.value) startIfFresh()
  })
  offReplayChannel = onReplayRoleTour(replayTour)
})

onBeforeUnmount(() => {
  if (offReplayChannel) offReplayChannel()
})

// Watch for sign-out → bail.
watch(() => auth.isLoggedIn, (now) => { if (!now) open.value = false })

// Keyboard handling — Esc dismisses (treated as "skip"), the
// Next button auto-focuses on open so a keyboard-only user can
// hit Enter/Space immediately. Both gated on `open` so the
// listener doesn't fire while the tour is dormant. Without this,
// the previously-shipped role="dialog" + aria-modal="true" was
// only theatrical — no actual keyboard escape route.
const cardEl = ref(null)
const nextBtn = ref(null)
function onTourKey(e) {
  if (!open.value) return
  if (e.key === 'Escape') { e.preventDefault(); skip() }
}
watch(open, async (now) => {
  if (now) {
    document.addEventListener('keydown', onTourKey)
    await nextTick()
    // Focus the primary action so screen readers announce the
    // dialog title and Tab cycles within the card.
    nextBtn.value?.focus?.()
  } else {
    document.removeEventListener('keydown', onTourKey)
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onTourKey))
</script>

<template>
  <!-- Teleport defensively (see notes in ConfirmModal). -->
  <Teleport to="body">
  <div v-if="open && slide" class="role-tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="role-tour-title" @click.self="skip">
    <div ref="cardEl" class="role-tour-card" tabindex="-1">
      <div class="role-tour-progress">
        <span
          v-for="(_, i) in slides"
          :key="i"
          :class="['role-tour-pip', { 'is-done': i <= cursor }]"
          aria-hidden="true"
        />
      </div>

      <div class="role-tour-emoji" aria-hidden="true">{{ slide.emoji }}</div>
      <h2 id="role-tour-title" class="role-tour-title">{{ slide.title }}</h2>
      <p class="role-tour-body">{{ slide.body }}</p>

      <div class="role-tour-footer">
        <button class="btn btn-ghost btn-sm role-tour-skip" @click="skip">
          Skip
        </button>
        <span class="role-tour-step">{{ cursor + 1 }} / {{ slides.length }}</span>
        <div class="role-tour-controls">
          <button v-if="cursor > 0" class="btn btn-ghost btn-sm" @click="back">← Back</button>
          <button ref="nextBtn" class="btn btn-primary btn-sm" @click="next">
            {{ isLast ? (slide.cta?.label || 'Got it') : 'Next →' }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.role-tour-backdrop {
  position: fixed; inset: 0;
  background: rgba(2,6,18,0.78);
  -webkit-backdrop-filter: blur(4px);  /* iOS Safari */
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
  z-index: 9100;
}
.role-tour-card {
  background: var(--bg-2, #0f172a);
  border: 1px solid var(--border-2, #334155);
  border-radius: var(--radius-lg, 12px);
  padding: 2rem 2rem 1.25rem;
  width: min(520px, 100%);
  text-align: center;
  box-shadow: 0 30px 80px rgba(0,0,0,0.55);
  display: flex; flex-direction: column; align-items: center; gap: 0.6rem;
}
.role-tour-progress {
  display: flex; gap: 0.4rem; margin-bottom: 0.4rem;
}
.role-tour-pip {
  width: 22px; height: 4px; border-radius: 2px;
  background: var(--bg-3, #1e293b);
  transition: background 0.2s;
}
.role-tour-pip.is-done { background: var(--cyan, #06b6d4); }

.role-tour-emoji { font-size: 44px; line-height: 1; }
.role-tour-title {
  margin: 0;
  font-family: var(--font-display, sans-serif);
  font-size: 22px; font-weight: 900; font-style: italic;
  color: var(--text, #f8fafc);
  line-height: 1.15;
}
.role-tour-body {
  margin: 0; max-width: 420px;
  font-family: var(--font-mono, monospace);
  font-size: 13.5px; line-height: 1.6;
  color: var(--text-2, #cbd5e1);
}

.role-tour-footer {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%;
  margin-top: 1rem;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.role-tour-step {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-3, #94a3b8);
  letter-spacing: 0.08em;
}
.role-tour-controls { display: flex; gap: 0.5rem; }
.role-tour-skip { color: var(--text-3, #94a3b8); }
</style>
