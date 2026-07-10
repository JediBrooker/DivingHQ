<script setup>
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

// Step 1 of the password-reset flow. The server always responds
// 200 OK regardless of whether the email matches a real user
// (prevents account enumeration), so the success message here
// stays intentionally vague: "if an account exists, we sent a link".

const email = ref('')
const sending = ref(false)
const sent = ref(false)
const error = ref('')

import { useI18n } from 'vue-i18n'
const { t } = useI18n()

async function submit() {
  if (!email.value.trim()) {
    error.value = t('auth.forgot.missing_email')
    return
  }
  error.value = ''
  sending.value = true
  try {
    const r = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      throw new Error(body.error || t('auth.forgot.request_failed'))
    }
    sent.value = true
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="reset-wrap">
    <div class="reset-mark brand-wordmark">DIVING<span>HQ</span></div>
    <h1>{{ $t('auth.forgot.title') }}</h1>
    <p class="subtitle">{{ $t('auth.forgot.subtitle') }}</p>

    <template v-if="sent">
      <div class="msg msg-success">
        {{ $t('auth.forgot.sent_message') }}
      </div>
      <RouterLink to="/login" class="btn btn-ghost btn-sm" style="margin-top:1.25rem">{{ $t('auth.forgot.back_to_sign_in') }}</RouterLink>
    </template>

    <form v-else @submit.prevent="submit" class="form-stack">
      <div class="field">
        <label class="label">{{ $t('auth.forgot.email_label') }}</label>
        <input
          class="input"
          type="email"
          v-model="email"
          autocomplete="email"
          :placeholder="$t('auth.forgot.email_placeholder')"
          required
        >
      </div>
      <div v-if="error" class="msg msg-error">{{ error }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="sending" style="margin-top:0.5rem">
        {{ sending ? $t('auth.forgot.submit_loading') : $t('auth.forgot.submit_idle') }}
      </button>
      <RouterLink to="/login" class="back-link">{{ $t('auth.forgot.back_to_sign_in') }}</RouterLink>
    </form>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  /* dvh: see LoginView for the iOS Safari rationale.
     vh fallback for browsers older than ~Q4-2022. */
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.reset-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.reset-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap` here, see LoginView for the rationale. */
}
.reset-mark span { color: var(--cyan); }
.reset-mark::before {
  content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan);
}
h1 { font-size: 44px; color: var(--text); margin-bottom: 0.25rem; font-style: italic; }
.subtitle {
  color: var(--text-3); font-size: 12px; letter-spacing: 0.15em;
  margin-bottom: 2rem; font-family: var(--font-display);
  font-weight: 600; text-transform: uppercase;
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.back-link {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-3);
  text-decoration: none; text-align: center; margin-top: 0.5rem;
}
.back-link:hover { color: var(--cyan); }
</style>
