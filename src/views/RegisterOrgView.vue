<script setup>
import { ref, watch, onMounted } from 'vue'
import { RouterLink } from 'vue-router'

// Public signups are gated OFF by default (coming-soon launch). null = still
// checking, true = open (show the form), false = closed (show the notice).
const signupsEnabled = ref(null)
onMounted(async () => {
  try {
    const res = await fetch('/api/auth/signups-status')
    signupsEnabled.value = !!(await res.json()).enabled
  } catch {
    signupsEnabled.value = false
  }
})

const orgName = ref('')
const countryCode = ref('')
const slug = ref('')
const fullName = ref('')
const email = ref('')
const username = ref('')
const password = ref('')
const msg = ref('')
const msgType = ref('')
const loading = ref(false)
const slugManuallyEdited = ref(false)

watch(orgName, (val) => {
  if (!slugManuallyEdited.value) {
    slug.value = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }
})

function onSlugInput() {
  slugManuallyEdited.value = true
}

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  loading.value = true
  try {
    const body = {
      org_name: orgName.value,
      slug: slug.value,
      full_name: fullName.value,
      email: email.value,
      username: username.value,
      password: password.value,
    }
    if (countryCode.value) body.country_code = countryCode.value.toUpperCase()

    const res = await fetch('/api/auth/register-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    msg.value = data.message
    msgType.value = 'success'
  } catch (err) {
    msg.value = err.message
    msgType.value = 'error'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="login-mark">DIVING<span>HQ</span></div>

    <template v-if="signupsEnabled === false">
      <h1>{{ $t('auth.register_org.title') }}</h1>
      <p class="subtitle">Coming soon</p>
      <p class="note">Federation sign-ups aren't open just yet — we're putting the finishing touches on DivingHQ. Please check back soon.</p>
      <p class="footer-link">{{ $t('auth.register_org.already_registered') }} <RouterLink to="/login">{{ $t('auth.register_org.sign_in_link') }}</RouterLink></p>
    </template>

    <template v-else-if="signupsEnabled === true">
    <h1>{{ $t('auth.register_org.title') }}</h1>
    <p class="subtitle">{{ $t('auth.register_org.subtitle') }}</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="section">
        <div class="section-label">{{ $t('auth.register_org.section_org') }}</div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.fed_name_label') }}</label>
          <input class="input" type="text" v-model="orgName" :placeholder="$t('auth.register_org.fed_name_placeholder')" required>
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="label">{{ $t('auth.register_org.country_label') }}</label>
            <input class="input" type="text" v-model="countryCode" :placeholder="$t('auth.register_org.country_placeholder')" maxlength="3" style="text-transform:uppercase">
          </div>
          <div class="field">
            <label class="label">{{ $t('auth.register_org.slug_label') }}</label>
            <input class="input" type="text" v-model="slug" @input="onSlugInput" :placeholder="$t('auth.register_org.slug_placeholder')" required>
            <div class="slug-preview">divedmeet.com/org/<span>{{ slug || '—' }}</span></div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-label">{{ $t('auth.register_org.section_admin') }}</div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.full_name') }}</label>
          <!-- autocomplete="name" lets iOS surface the contact-
               card AutoFill chip for the admin's own name. -->
          <input class="input" type="text" v-model="fullName"
                 autocomplete="name" required>
        </div>
        <div class="field">
          <!-- Reuses the auth.register.* email strings (present in every
               locale) — the org founder's email is required by
               /api/auth/register-org for the verification mail. -->
          <label class="label">{{ $t('auth.register.email') }}</label>
          <input class="input" type="email" v-model="email"
                 autocomplete="email"
                 :placeholder="$t('auth.register.email_placeholder')"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.username') }}</label>
          <!-- See LoginView: usernames are not sentences, suppress
               iOS keyboard auto-capitalize + autocorrect + spellcheck. -->
          <input class="input" type="text" v-model="username"
                 autocomplete="username"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.password') }}</label>
          <input class="input" type="password" v-model="password" autocomplete="new-password" required>
        </div>
      </div>

      <p class="note">{{ $t('auth.register_org.note') }}</p>

      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="loading">
        {{ loading ? $t('auth.register_org.submit_loading') : $t('auth.register_org.submit_idle') }}
      </button>
    </form>
    <p class="footer-link">{{ $t('auth.register_org.already_registered') }} <RouterLink to="/login">{{ $t('auth.register_org.sign_in_link') }}</RouterLink></p>
    </template>
  </div>
</template>

<style scoped>
/* dvh: see RegisterView.vue for the iOS Safari rationale.
   vh fallback first for browsers older than ~Q4-2022. */
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.wrap { width: 100%; max-width: 520px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap` — see LoginView for the rationale. */
}
.login-mark span { color: var(--cyan); }
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan); }
h1 { font-size: 44px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.section { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.slug-preview { font-size: 11px; color: var(--text-3); margin-top: 0.25rem; font-family: var(--font-mono); }
.slug-preview span { color: var(--cyan); }
</style>
