<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRouter, RouterLink } from 'vue-router'

const router = useRouter()

const fullName = ref('')
const username = ref('')
const email = ref('')
const password = ref('')
const orgId = ref('')
// Default to "diver", the most common public-registration use case.
// Spectator-only sign-ups will pick "Spectator" explicitly.
const requestedRole = ref('diver')
const note = ref('')
const orgs = ref([])

// Club state, populated whenever an org is picked. The club
// dropdown has three modes: pick an existing one, "I want to create
// a new club", or leave it empty (independent diver).
const clubs = ref([])
const clubChoice = ref('')           // '' | 'new' | <club_id>
const newClubName = ref('')
const newClubCode = ref('')

const msg = ref('')
const msgType = ref('')
const loading = ref(false)

// Public signups are gated off by default (coming-soon launch). null means
// still checking, true is open (show the form), false is closed (show the notice).
const signupsEnabled = ref(null)

onMounted(async () => {
  try {
    const res = await fetch('/api/auth/signups-status')
    signupsEnabled.value = !!(await res.json()).enabled
  } catch {
    signupsEnabled.value = false
  }
  if (!signupsEnabled.value) return
  try {
    const res = await fetch('/api/orgs/active')
    orgs.value = await res.json()
  } catch { /* leave empty */ }
})

watch(orgId, async (id) => {
  // Reset club state whenever the user changes org
  clubs.value = []
  clubChoice.value = ''
  newClubName.value = ''
  newClubCode.value = ''
  if (!id) return
  try {
    const r = await fetch(`/api/orgs/${id}/clubs`)
    const body = await r.json()
    clubs.value = Array.isArray(body) ? body : []
  } catch {
    clubs.value = []
  }
})

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  loading.value = true
  try {
    const body = {
      full_name: fullName.value,
      username: username.value,
      email:    email.value || undefined,
      password: password.value,
      org_id:   orgId.value,
    }
    if (requestedRole.value) body.requested_role = requestedRole.value
    if (note.value) body.note = note.value
    if (clubChoice.value === 'new' && newClubName.value.trim()) {
      body.new_club_name = newClubName.value.trim()
      if (newClubCode.value.trim()) body.new_club_short_code = newClubCode.value.trim()
    } else if (clubChoice.value && clubChoice.value !== 'new') {
      body.club_id = clubChoice.value
    }

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    msg.value = data.message
    msgType.value = 'success'
    setTimeout(() => router.push('/login'), 2500)
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
      <h1>{{ $t('auth.register.title') }}</h1>
      <p class="subtitle">Coming soon</p>
      <p class="note">Account sign-ups aren't open just yet — we're putting the finishing touches on DivingHQ. Please check back soon.</p>
      <p class="footer-link">{{ $t('auth.register.already_have_account') }} <RouterLink to="/login">{{ $t('auth.register.sign_in_link') }}</RouterLink></p>
    </template>

    <template v-else-if="signupsEnabled === true">
    <h1>{{ $t('auth.register.title') }}</h1>
    <p class="subtitle">{{ $t('auth.register.subtitle') }}</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="field">
        <label class="label">{{ $t('auth.register.full_name') }}</label>
        <!-- autocomplete="name" lets iOS surface the contact-card
             AutoFill chip for the user's own name. -->
        <input class="input" type="text" v-model="fullName"
               autocomplete="name" required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.username') }}</label>
        <!-- See LoginView: usernames are not sentences, suppress
             iOS keyboard auto-capitalize + autocorrect + spellcheck. -->
        <input class="input" type="text" v-model="username"
               autocomplete="username"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.email') }}</label>
        <input
          class="input"
          type="email"
          v-model="email"
          autocomplete="email"
          :placeholder="$t('auth.register.email_placeholder')"
          required
        >
        <span class="hint-line">{{ $t('auth.register.email_hint') }}</span>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.password') }}</label>
        <input class="input" type="password" v-model="password" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.organisation') }}</label>
        <select class="select" v-model="orgId" required>
          <option value="">{{ $t('auth.register.org_placeholder') }}</option>
          <option v-for="org in orgs" :key="org.id" :value="org.id">
            {{ org.name }}{{ org.country_code ? ` (${org.country_code})` : '' }}
          </option>
        </select>
      </div>

      <!-- Club, only meaningful once an org is picked. Lets you
           pick an existing club, create a new one inline, or skip. -->
      <div class="field" v-if="orgId">
        <label class="label">{{ $t('auth.register.club') }}</label>
        <select class="select" v-model="clubChoice">
          <option value="">{{ $t('auth.register.club_independent') }}</option>
          <option v-for="c in clubs" :key="c.id" :value="c.id">
            {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
          </option>
          <option value="new">{{ $t('auth.register.club_new') }}</option>
        </select>
        <p v-if="!clubs.length && clubChoice !== 'new'" class="hint-line">
          {{ $t('auth.register.club_no_clubs') }}
        </p>
      </div>

      <!-- Inline new-club form, only shows when "Create a new club" is picked -->
      <div v-if="orgId && clubChoice === 'new'" class="field new-club-block">
        <div class="field">
          <label class="label">{{ $t('auth.register.new_club_name') }}</label>
          <input class="input" type="text" v-model="newClubName" placeholder="e.g. Sydney Springboard" required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register.short_code_optional') }}</label>
          <input class="input" type="text" v-model="newClubCode" placeholder="e.g. SYD" maxlength="20">
        </div>
      </div>

      <div class="field">
        <label class="label">{{ $t('auth.register.requested_role') }}</label>
        <select class="select" v-model="requestedRole">
          <option value="diver">{{ $t('auth.register.role_default') }}</option>
          <option value="judge">{{ $t('role.judge') }}</option>
          <option value="referee">{{ $t('role.referee') }}</option>
          <option value="meet_manager">{{ $t('role.manager') }}</option>
          <option value="">{{ $t('auth.register.role_spectator') }}</option>
        </select>
      </div>
      <div class="field" v-if="requestedRole">
        <label class="label">{{ $t('auth.register.note_label') }}</label>
        <input class="input" type="text" v-model="note" :placeholder="$t('auth.register.note_placeholder')">
      </div>
      <p class="note">{{ $t('auth.register.spectator_note') }}</p>
      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem" :disabled="loading">
        {{ loading ? $t('auth.register.submit_loading') : $t('auth.register.submit_idle') }}
      </button>
    </form>
    <p class="footer-link">{{ $t('auth.register.already_have_account') }} <RouterLink to="/login">{{ $t('auth.register.sign_in_link') }}</RouterLink></p>
    </template>
  </div>
</template>

<style scoped>
/* dvh, not vh: iOS Safari's collapsing URL bar makes 100vh equal
   the *large* viewport (bar collapsed). With the bar expanded, the
   Submit button on iPhone SE-class screens ends up below the visible
   area. dvh tracks the live viewport instead. vh fallback goes first
   so browsers older than ~Q4-2022 still get a sane min-height; modern
   browsers just ignore it and use dvh. */
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.wrap { width: 100%; max-width: 460px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap` here, see LoginView for the rationale. */
}
.login-mark span { color: var(--cyan); }
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan); }
h1 { font-size: 48px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.hint-line { margin-top: 0.4rem; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.new-club-block {
  display: flex; flex-direction: column; gap: 0.75rem;
  padding: 0.85rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-sm);
  background: var(--cyan-dim);
}
</style>
