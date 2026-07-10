<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { isValidPassword } from '@/lib/passwordPolicy'

// Step 2 of the password-reset flow. The link in the email is
// /reset-password?token=<jwt>. We POST that token plus the new
// password to /api/auth/reset-password; the server verifies the
// JWT, checks the password fingerprint hasn't changed (this is
// the single-use guard), and updates the password.

const route  = useRoute()
const router = useRouter()

const token = computed(() => route.query.token || '')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const error = ref('')
const done = ref(false)

import { useI18n } from 'vue-i18n'
const { t } = useI18n()

onMounted(() => {
  if (!token.value) {
    error.value = t('auth.reset.missing_token')
  }
})

async function submit() {
  error.value = ''
  if (!isValidPassword(newPassword.value)) {
    error.value = t('auth.reset.min_length_error')
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = t('auth.reset.mismatch_error')
    return
  }
  submitting.value = true
  try {
    const r = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token.value,
        new_password: newPassword.value,
      }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || t('auth.reset.reset_failed'))
    done.value = true
    setTimeout(() => router.push('/login'), 2000)
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="reset-wrap">
    <div class="reset-mark brand-wordmark">DIVING<span>HQ</span></div>
    <h1>{{ $t('auth.reset.title') }}</h1>
    <p class="subtitle">{{ $t('auth.reset.subtitle') }}</p>

    <template v-if="done">
      <div class="msg msg-success">
        {{ $t('auth.reset.success') }}
      </div>
    </template>

    <form v-else-if="token" @submit.prevent="submit" class="form-stack">
      <div class="field">
        <label class="label">{{ $t('auth.reset.new_password_label') }}</label>
        <input class="input" type="password" autocomplete="new-password" v-model="newPassword" required>
        <p class="password-hint">{{ $t('auth.reset.min_length_error') }}</p>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.reset.confirm_password_label') }}</label>
        <input class="input" type="password" autocomplete="new-password" v-model="confirmPassword" required>
      </div>
      <div v-if="error" class="msg msg-error">{{ error }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="submitting" style="margin-top:0.5rem">
        {{ submitting ? $t('auth.reset.submit_loading') : $t('auth.reset.submit_idle') }}
      </button>
    </form>

    <template v-else>
      <div class="msg msg-error">{{ error || $t('auth.reset.no_token_message') }}</div>
      <RouterLink to="/forgot-password" class="btn btn-ghost btn-sm" style="margin-top:1.25rem">
        {{ $t('auth.reset.request_new_link') }}
      </RouterLink>
    </template>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  /* dvh, not vh: iOS Safari toolbar collapse. See RegisterView.
     vh fallback for browsers older than ~Q4-2022. */
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.reset-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.password-hint {
  margin: 0.35rem 0 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
}
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
</style>
