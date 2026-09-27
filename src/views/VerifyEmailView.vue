<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'

// Landing page for the link in the sign-up email:
// /verify-email?token=<jwt>. POSTs the token to /api/auth/verify-email,
// which stamps users.email_verified_at (the login gate) and opens any
// claim that was waiting on it. Posting on mount rather than on a
// click is fine here, mail scanners fetch the URL but don't run the JS.
//
// When the link has expired (they last 24h) the page offers a fresh one
// straight away, rather than sending people back to register again.

const route = useRoute()
const { t } = useI18n()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const state = ref('working') // working | done | failed
const next = ref('sign_in')
const error = ref('')

const who = ref('')
const resending = ref(false)
const resent = ref(false)

const successText = computed(() => ({
  claim_open:  t('auth.verify_email.success_claim'),
  org_pending: t('auth.verify_email.success_org_pending'),
}[next.value] || t('auth.verify_email.success_sign_in')))

async function verify() {
  if (!token.value) {
    error.value = t('auth.verify_email.missing_token')
    state.value = 'failed'
    return
  }
  try {
    const r = await fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || t('auth.verify_email.failed'))
    next.value = body.next || 'sign_in'
    state.value = 'done'
  } catch (err) {
    error.value = err.message
    state.value = 'failed'
  }
}

async function resend() {
  if (!who.value.trim()) return
  resending.value = true
  try {
    await fetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(who.value.includes('@') ? { email: who.value.trim() } : { username: who.value.trim() }),
    })
  } catch {
    // The server answers ok whatever happens, so there's nothing useful
    // to show for a network blip beyond the same "check your inbox".
  } finally {
    resending.value = false
    resent.value = true
  }
}

onMounted(verify)
</script>

<template>
  <div class="verify-wrap">
    <div class="verify-mark brand-wordmark">DIVING<span>HQ</span></div>
    <h1>{{ $t('auth.verify_email.title') }}</h1>
    <p class="subtitle">{{ $t('auth.verify_email.subtitle') }}</p>

    <div v-if="state === 'working'" class="msg msg-info" data-testid="verify-working">
      {{ $t('auth.verify_email.verifying') }}
    </div>

    <template v-else-if="state === 'done'">
      <div class="msg msg-success" data-testid="verify-done">{{ successText }}</div>
      <RouterLink to="/login" class="btn btn-primary-lg verify-cta">{{ $t('auth.verify_email.sign_in') }}</RouterLink>
    </template>

    <template v-else>
      <div class="msg msg-error" data-testid="verify-failed">{{ error || $t('auth.verify_email.failed') }}</div>
      <form v-if="!resent" class="form-stack verify-resend" @submit.prevent="resend">
        <p class="verify-hint">{{ $t('auth.verify_email.resend_prompt') }}</p>
        <div class="field">
          <label class="label" for="verify-who">{{ $t('auth.verify_email.resend_label') }}</label>
          <input id="verify-who" v-model="who" class="input" type="text"
                 autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
        </div>
        <button type="submit" class="btn btn-primary-lg" :disabled="resending">
          {{ $t('auth.verify_email.resend_button') }}
        </button>
      </form>
      <div v-else class="msg msg-info" data-testid="verify-resent">{{ $t('auth.verify_email.resend_sent') }}</div>
      <RouterLink to="/login" class="btn btn-ghost btn-sm verify-back">
        {{ $t('auth.verify_email.back_to_sign_in') }}
      </RouterLink>
    </template>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.verify-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.verify-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
}
.verify-mark span { color: var(--cyan); }
.verify-mark::before {
  content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan);
}
h1 { font-size: 44px; color: var(--text); margin-bottom: 0.25rem; font-style: italic; }
.subtitle {
  color: var(--text-3); font-size: 12px; letter-spacing: 0.15em;
  margin-bottom: 2rem; font-family: var(--font-display);
  font-weight: 600; text-transform: uppercase;
}
.verify-cta { margin-top: 1.25rem; display: block; text-align: center; text-decoration: none; }
.verify-resend { margin-top: 1.5rem; }
.verify-hint { color: var(--text-2); font-size: 14px; margin: 0; }
.verify-back { margin-top: 1.25rem; }
</style>
