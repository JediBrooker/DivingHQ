<script setup>
// The link a junior diver gets at 13 (routes/juniors.js handover): their
// profile, run by their parents or club until now, becomes their own
// account. /junior-handover?token=... Public, the token is the credential.
// The address the link went to becomes the sign-in email, already
// verified, so they can sign in the moment this is done.
import AuthLayout from '@/components/AuthLayout.vue'
import LegalConsent from '@/components/LegalConsent.vue'
import { ref, computed, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { isValidPassword } from '@/lib/passwordPolicy'

const { t } = useI18n()
const route = useRoute()
const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))

const who = ref(null)
const gone = ref(false)
const loading = ref(true)
const username = ref('')
const password = ref('')
const confirm = ref('')
const ageOk = ref(false)
const submitting = ref(false)
const error = ref('')
const done = ref(false)

onMounted(async () => {
  if (!token.value) { gone.value = true; loading.value = false; return }
  try {
    const r = await fetch(`/api/junior-handover/${encodeURIComponent(token.value)}`)
    if (!r.ok) { gone.value = true; return }
    who.value = await r.json()
  } catch {
    gone.value = true
  } finally {
    loading.value = false
  }
})

async function submit() {
  error.value = ''
  if (!isValidPassword(password.value)) { error.value = t('auth.reset.min_length_error'); return }
  if (password.value !== confirm.value) { error.value = t('auth.reset.mismatch_error'); return }
  if (!ageOk.value) { error.value = t('auth.register.age_confirmation'); return }
  submitting.value = true
  try {
    const r = await fetch('/api/junior-handover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token.value, username: username.value.trim(), password: password.value, age_13_or_older: true,
      }),
    })
    const body = await r.json().catch(() => ({}))
    if (r.status === 404) { gone.value = true; return }
    if (!r.ok) throw new Error(body.error || t('common.error_generic'))
    done.value = true
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthLayout>
    <div class="hand-wrap">
      <div class="hand-mark brand-wordmark">DIVING<span>HQ</span></div>
      <h1>{{ $t('juniors.page_title') }}</h1>

      <p v-if="loading" class="lead">{{ $t('common.loading') }}</p>

      <template v-else-if="done">
        <div class="msg msg-success" data-testid="handover-done">{{ $t('juniors.page_done') }}</div>
        <RouterLink to="/login" class="btn btn-primary-lg">{{ $t('juniors.page_sign_in') }}</RouterLink>
      </template>

      <div v-else-if="gone" class="msg msg-error" data-testid="handover-gone">{{ $t('juniors.page_link_gone') }}</div>

      <form v-else class="form-stack" @submit.prevent="submit">
        <p class="lead">
          <strong>{{ who.full_name }}</strong><br>
          {{ who.club_name ? $t('juniors.page_intro', { club: who.club_name }) : $t('juniors.page_intro_no_club') }}
        </p>
        <p class="lead">{{ $t('juniors.page_email', { email: who.email }) }}</p>
        <label class="field">
          <span class="label">{{ $t('juniors.page_username') }}</span>
          <input v-model="username" class="input" autocomplete="username" autocapitalize="off" required minlength="2"
                 maxlength="50" data-testid="handover-username">
        </label>
        <label class="field">
          <span class="label">{{ $t('juniors.page_password') }}</span>
          <input v-model="password" class="input" type="password" autocomplete="new-password" required data-testid="handover-password">
          <span class="password-hint">{{ $t('auth.reset.min_length_error') }}</span>
        </label>
        <label class="field">
          <span class="label">{{ $t('juniors.page_password_confirm') }}</span>
          <input v-model="confirm" class="input" type="password" autocomplete="new-password" required data-testid="handover-confirm">
        </label>
        <label class="age">
          <input v-model="ageOk" type="checkbox" required data-testid="handover-age">
          <span>{{ $t('auth.register.age_confirmation') }}</span>
        </label>
        <LegalConsent />
        <div v-if="error" class="msg msg-error">{{ error }}</div>
        <button type="submit" class="btn btn-primary-lg" :disabled="submitting" data-testid="handover-submit">
          {{ $t('juniors.page_submit') }}
        </button>
      </form>
    </div>
  </AuthLayout>
</template>

<style scoped>
.hand-wrap { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 1rem; animation: fadeUp 0.4s ease; }
.hand-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 1.5rem; display: flex; align-items: center;
}
.hand-mark span { color: var(--cyan); }
.hand-mark::before {
  content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan);
}
h1 { font-size: 36px; color: var(--text); margin: 0; font-style: italic; }
.lead { color: var(--fg-2); font-size: var(--text-sm); line-height: 1.5; margin: 0; }
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.password-hint { color: var(--text-3); font-size: 12px; line-height: 1.45; }
.age { display: flex; gap: 0.5rem; align-items: flex-start; font-size: var(--text-sm); color: var(--fg); }
.age input { margin-top: 3px; }
</style>
