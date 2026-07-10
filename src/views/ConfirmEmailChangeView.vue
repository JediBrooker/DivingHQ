<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// Step 2 of the email-change flow (Migration 044). The link in
// the verification email is /confirm-email-change?token=<64-hex>.
// We POST that token to /api/auth/confirm-email-change, the
// server hashes it, looks up the pending row, swaps users.email,
// clears the pending columns, and bumps token_version so every
// session (including this one, if the user's signed in on the
// new device) re-authenticates.
//
// Fires the POST automatically on mount so the user just lands on a
// finished page. No password re-entry needed here, proof-of-inbox-control
// IS the second factor, mirroring the registration-verification flow.

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()

const token = computed(() => route.query.token || '')
const submitting = ref(true)
const done = ref(false)
const error = ref('')

import { useI18n } from 'vue-i18n'
const { t } = useI18n()

async function confirm() {
  if (!token.value) {
    error.value = t('auth.confirm_email.missing_token')
    submitting.value = false
    return
  }
  try {
    const r = await fetch('/api/auth/confirm-email-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || t('auth.confirm_email.failed'))
    done.value = true
    // Sign out locally, the server already bumped token_version so the
    // current JWT is dead anyway. Best to drop it now so the next
    // navigation isn't a forced /login redirect from a 401.
    auth.clearSession()
    setTimeout(() => router.push('/login'), 2500)
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}

onMounted(confirm)
</script>

<template>
  <div class="confirm-wrap">
    <div class="confirm-mark brand-wordmark">DIVING<span>HQ</span></div>
    <h1>{{ $t('auth.confirm_email.title') }}</h1>
    <p class="subtitle">{{ $t('auth.confirm_email.subtitle') }}</p>

    <template v-if="submitting">
      <div class="msg msg-info">{{ $t('auth.confirm_email.confirming') }}</div>
    </template>

    <template v-else-if="done">
      <div class="msg msg-success">
        {{ $t('auth.confirm_email.success') }}
      </div>
    </template>

    <template v-else>
      <div class="msg msg-error">{{ error || $t('auth.confirm_email.fallback_error') }}</div>
      <RouterLink to="/login" class="btn btn-ghost btn-sm" style="margin-top:1.25rem">
        {{ $t('auth.confirm_email.back_to_sign_in') }}
      </RouterLink>
    </template>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  /* dvh: see LoginView for the iOS Safari rationale.
     vh first for pre-2022 browsers, dvh second so modern
     browsers prefer it */
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.confirm-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.confirm-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap`, see LoginView for the rationale */
}
.confirm-mark span { color: var(--cyan); }
.confirm-mark::before {
  content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan);
}
h1 { font-size: 44px; color: var(--text); margin-bottom: 0.25rem; font-style: italic; }
.subtitle {
  color: var(--text-3); font-size: 12px; letter-spacing: 0.15em;
  margin-bottom: 2rem; font-family: var(--font-display);
  font-weight: 600; text-transform: uppercase;
}
</style>
