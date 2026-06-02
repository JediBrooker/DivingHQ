<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { CircleHelp } from '@lucide/vue'
// Migration 053: reunite-on-return prompt fires on every login
// when there are deleted-account candidates in the user's org
// with the same name. The modal is dismissable; checking is a
// single tiny POST so it doesn't slow the landing.
import ClaimCandidatesModal from '@/components/ClaimCandidatesModal.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const { t } = useI18n()

const username = ref('')
const password = ref('')
const errorMsg = ref('')
const loading = ref(false)

// Post-login destination — defaults to the dashboard, but if
// the router guard bounced the user here from a protected
// route we honour the `next` query param so they land where
// they were aiming. Validated as same-origin (must start with
// "/" and NOT "//", which would be a protocol-relative URL
// pointing at an attacker's host) so an attacker can't craft
// a /login?next=https://evil.example link via email and ride
// the legitimate session through.
function safeNextPath() {
  const raw = route.query.next
  if (typeof raw !== 'string' || !raw) return '/dashboard'
  // Reject anything that isn't a clean local path. Same-origin
  // check covers absolute URLs (http://…), protocol-relative
  // URLs (//evil.example), and javascript: schemes — every
  // attacker-controllable target starts with a non-"/" or with
  // "//".
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}

onMounted(() => {
  if (auth.isLoggedIn) router.push(safeNextPath())
})

// Claim-candidates state (Migration 053). When non-empty the
// post-login redirect is held until the user dismisses or
// confirms the modal. The session-storage flag suppresses
// re-prompting on subsequent logins from the same browser tab
// — anyone who explicitly Skip'd doesn't want to be asked again
// every time they sign in.
const claimCandidates = ref(null)
const CLAIM_SEEN_KEY = 'profile.claim.seen'

async function checkClaimCandidates() {
  if (sessionStorage.getItem(CLAIM_SEEN_KEY)) return false
  try {
    const data = await auth.apiFetch('/api/users/me/claim-candidates', {
      method: 'POST',
    })
    const list = Array.isArray(data?.candidates) ? data.candidates : []
    if (list.length === 0) {
      // Mark seen so we don't probe every login on this tab.
      sessionStorage.setItem(CLAIM_SEEN_KEY, '1')
      return false
    }
    claimCandidates.value = list
    return true
  } catch {
    // Server error → don't block the login. Just route through.
    return false
  }
}

function dismissClaim() {
  sessionStorage.setItem(CLAIM_SEEN_KEY, '1')
  claimCandidates.value = null
  router.push(safeNextPath())
}

function onClaimDone() {
  sessionStorage.setItem(CLAIM_SEEN_KEY, '1')
  claimCandidates.value = null
  router.push(safeNextPath())
}

async function handleSubmit() {
  errorMsg.value = ''
  loading.value = true
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || t('auth.login.submit_failed'))
    auth.saveSession(data)
    // Before routing to the dashboard, probe for claim
    // candidates. Hits one tiny endpoint; if there are no
    // matches we route immediately. The modal handles its own
    // close + claim transitions back to safeNextPath().
    const held = await checkClaimCandidates()
    if (!held) {
      router.push(safeNextPath())
    }
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-top">
      <div class="login-mark">DIVING<span>HQ</span></div>
      <div class="login-top-actions">
        <ThemeToggle compact />
        <RouterLink to="/guide" class="login-help" aria-label="Help & user guide" v-tip:bottom.fixed="'Help & user guide'"><CircleHelp /></RouterLink>
        <LocaleSwitcher />
      </div>
    </div>
    <h1>{{ $t('auth.login.title') }}</h1>
    <p class="subtitle">{{ $t('auth.login.subtitle') }}</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="field">
        <label class="label">{{ $t('auth.login.username_label') }}</label>
        <!-- iOS Safari capitalises the first letter of any text
             input by default and red-underlines it as a typo.
             Usernames in this app are not sentences — disable the
             keyboard helpers so iOS doesn't fight the user. -->
        <input class="input" type="text" v-model="username"
               autocomplete="username"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.login.password_label') }}</label>
        <input class="input" type="password" v-model="password" autocomplete="current-password" required>
      </div>
      <div v-if="errorMsg" class="msg msg-error">{{ errorMsg }}</div>
      <button type="submit" class="btn btn-primary-lg" style="margin-top:0.5rem" :disabled="loading">
        {{ loading ? $t('auth.login.submit_loading') : $t('auth.login.submit_idle') }}
      </button>
    </form>

    <div class="footer-links">
      <RouterLink to="/forgot-password">{{ $t('auth.login.forgot_password') }} <span>{{ $t('auth.login.forgot_password_action') }}</span></RouterLink>
      <RouterLink to="/register">{{ $t('auth.login.no_account') }} <span>{{ $t('auth.login.no_account_action') }}</span></RouterLink>
      <RouterLink to="/register-org">{{ $t('auth.login.register_federation') }} <span>{{ $t('auth.login.register_federation_action') }}</span></RouterLink>
      <RouterLink to="/guide">{{ $t('auth.login.new_here') }} <span>{{ $t('auth.login.new_here_action') }}</span></RouterLink>
      <a href="https://github.com/JediBrooker/DivingHQ/issues/new?labels=bug&title=Bug%3A%20"
         target="_blank"
         rel="noopener">{{ $t('auth.login.found_bug') }} <span>{{ $t('auth.login.found_bug_action') }}</span></a>
    </div>

    <ClaimCandidatesModal
      v-if="claimCandidates"
      variant="signup"
      :candidates="claimCandidates"
      @close="dismissClaim"
      @skipped="dismissClaim"
      @claimed="onClaimDone"
    />
  </div>
</template>

<style scoped>
:global(body) {
  display: flex;
  align-items: center;
  justify-content: center;
  /* dvh, not vh — iOS Safari's collapsing URL bar makes 100vh
     equal the large viewport, so on iPhone SE-class screens
     with the bar expanded the Sign In button sits below the
     visible area. dvh tracks the live viewport. vh fallback
     first so browsers older than ~Q4-2022 still get a sane
     min-height; modern browsers ignore it and use dvh. */
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.login-wrap {
  width: 100%;
  max-width: 420px;
  animation: fadeUp 0.4s ease;
}
.login-top {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 2.5rem;
}
.login-top-actions { display: flex; align-items: center; gap: 0.5rem; }
.login-help {
  width: 34px; height: 34px; display: inline-grid; place-items: center;
  border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--surface); color: var(--fg-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.login-help:hover { background: var(--surface-hover); color: var(--fg); }
.login-help :deep(svg) { width: 18px; height: 18px; }
.login-mark {
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-transform: none;
  /* DIVING white, HQ cyan — match the public home page hero
     mark's colour rhythm. The cyan accent on HQ keeps the
     brand recognisable at a glance while the white DIVING
     reads cleanly against the dark page. */
  color: var(--text);
  /* margin-bottom moved to .login-top, which now wraps the mark + locale switcher */
  display: flex;
  align-items: center;
  /* No `gap` here — flex would treat the text "DIVING" and
     the <span>HQ</span> as two flex items and put the gap
     between them, producing a visible "DIVING HQ" rather
     than "DIVINGHQ". Spacing between the dash (::before) and
     the wordmark is on the dash's margin-inline-end instead. */
}
.login-mark span { color: var(--accent); }
.login-mark::before {
  content: '';
  display: block;
  width: 22px;
  height: 2px;
  margin-inline-end: 0.6rem;
  background: var(--accent);
}
h1 {
  font-size: 28px;
  color: var(--fg);
  margin-bottom: 0.35rem;
  font-style: normal;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.subtitle {
  color: var(--fg-2);
  font-size: 14px;
  letter-spacing: 0;
  margin-bottom: 2.5rem;
  font-family: var(--font-sans);
  font-weight: 400;
  text-transform: none;
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.footer-links {
  margin-top: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  text-align: center;
}
.footer-links a {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: var(--fg-2);
  text-decoration: none;
  transition: color 0.15s;
}
.footer-links a:hover { color: var(--accent); }
.footer-links a span { color: var(--accent); font-weight: 600; }
</style>
