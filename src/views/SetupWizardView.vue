<script setup>
// First-run org setup wizard. Walks a brand-new org admin
// through the minimum config needed to make their dashboard
// productive: create a club, invite users, create their first
// event. Each step is skippable, so an admin who already knows
// what they're doing can just click Skip three times and land
// on the Meet Manager.
//
// Triggered from DashboardView.onMounted() when the org has
// zero events AND zero clubs AND the local "wizard dismissed"
// flag isn't set. User can also get here directly from the
// User Menu: route /setup.
import { ref, computed, onMounted } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()

// Wizard step index, 0..3. Each step renders independently, and
// the progress strip up top reflects wherever we currently are.
const STEPS = computed(() => [
  { key: 'welcome',    label: t('setup.step_intro') },
  { key: 'club',       label: t('setup.step_clubs') },
  { key: 'invite',     label: t('setup.step_users') },
  { key: 'event',      label: t('setup.step_done') },
])
const stepIdx = ref(0)
const currentStep = computed(() => STEPS.value[stepIdx.value])

function next()    { if (stepIdx.value < STEPS.value.length - 1) stepIdx.value++ }
function back()    { if (stepIdx.value > 0) stepIdx.value-- }
function dismiss() {
  // Persist so the next dashboard visit doesn't redirect here
  // again. Two keys: a global "skip this for now" flag, plus a
  // permanent "completed" stamp (set when the user clicks Done
  // at the end).
  try { localStorage.setItem('setup.wizardDismissed.v1', '1') } catch {}
  router.push('/dashboard')
}
function complete() {
  try { localStorage.setItem('setup.wizardCompleted.v1', '1') } catch {}
  try { localStorage.setItem('setup.wizardDismissed.v1', '1') } catch {}
  router.push('/manager')
}

// ---- Step 2: Create a club ----------------------------------
const clubName     = ref('')
const clubCode     = ref('')
const clubBusy     = ref(false)
const clubCreated  = ref(null)

async function createClub() {
  const name = clubName.value.trim()
  if (!name) return
  if (!auth.user?.org_id) {
    showError(t('setup.wizard.club_no_org_error'))
    return
  }
  clubBusy.value = true
  try {
    const club = await auth.apiFetch(
      `/api/orgs/${auth.user.org_id}/clubs`,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          short_code: clubCode.value.trim() || null,
        }),
      },
    )
    clubCreated.value = club
    showSuccess(t('setup.wizard.club_created_toast', { name: club.name }))
    next()
  } catch (err) {
    showError(t('setup.wizard.club_create_failed', { message: err.message }))
  } finally {
    clubBusy.value = false
  }
}

// ---- Step 3: Invite people ---------------------------------
// Public registration URL the admin can share with their
// members. /register lets users sign up under an existing org,
// then the admin approves their role from User Manager.
const registerUrl = computed(() => {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/register`
})
const copyState = ref('idle')   // 'idle' | 'copied' | 'error'
async function copyRegisterUrl() {
  try {
    await navigator.clipboard.writeText(registerUrl.value)
    copyState.value = 'copied'
    setTimeout(() => { copyState.value = 'idle' }, 1800)
  } catch {
    copyState.value = 'error'
    setTimeout(() => { copyState.value = 'idle' }, 1800)
  }
}

// On mount: if the wizard's already been completed, bounce to
// the Meet Manager. Dashboard's auto-redirect won't send us
// here once the completed flag is set, but a direct visit still
// could.
onMounted(() => {
  try {
    if (localStorage.getItem('setup.wizardCompleted.v1') === '1') {
      router.replace('/manager')
    }
  } catch { /* localStorage blocked, treat as fresh */ }
})
</script>

<template>
  <div class="wizard-shell">
    <header class="wizard-header">
      <RouterLink to="/dashboard" class="wizard-logo">DIVING<span>HQ</span></RouterLink>
      <button type="button" class="wizard-skip-link" @click="dismiss">
        {{ $t('setup.skip_setup') }} &rarr;
      </button>
    </header>

    <div class="wizard-frame">
      <!-- Progress strip: pip + label per step, current pip
           glows cyan. Click a pip to jump (lets a returning
           admin skip back without using Back/Next). -->
      <div class="wizard-stepper" role="tablist" :aria-label="$t('setup.wizard.aria_step_progress', { current: stepIdx + 1, total: STEPS.length })">
        <template v-for="(s, i) in STEPS" :key="s.key">
          <button
            type="button"
            :class="[
              'wizard-step',
              i < stepIdx ? 'wizard-step-done' : '',
              i === stepIdx ? 'wizard-step-active' : '',
              i > stepIdx ? 'wizard-step-future' : '',
            ]"
            :aria-selected="i === stepIdx"
            @click="stepIdx = i"
          >
            <span class="wizard-step-num">{{ i < stepIdx ? '✓' : i + 1 }}</span>
            <span class="wizard-step-label">{{ s.label }}</span>
          </button>
          <div v-if="i < STEPS.length - 1"
               :class="['wizard-step-divider', i < stepIdx ? 'wf-divider-done' : '']"></div>
        </template>
      </div>

      <!-- Step 1: Welcome -->
      <div v-if="currentStep.key === 'welcome'" class="wizard-card">
        <div class="wizard-eyebrow">{{ $t('setup.wizard.step_eyebrow', { current: 1, total: 4 }) }}</div>
        <h1 class="wizard-title">{{ $t('setup.title') }}</h1>
        <div class="wizard-subtitle">{{ $t('setup.subtitle') }}</div>
        <p class="wizard-body">
          {{ $t('setup.wizard.welcome_body') }}
        </p>
        <ul class="wizard-bullets">
          <li>
            <span class="wizard-bullet-icon">🏛</span>
            <div>
              <strong>{{ $t('setup.wizard.welcome_bullet_clubs_title') }}</strong> — {{ $t('setup.wizard.welcome_bullet_clubs_body') }}
            </div>
          </li>
          <li>
            <span class="wizard-bullet-icon">👥</span>
            <div>
              <strong>{{ $t('setup.wizard.welcome_bullet_people_title') }}</strong> — {{ $t('setup.wizard.welcome_bullet_people_body') }}
            </div>
          </li>
          <li>
            <span class="wizard-bullet-icon">📅</span>
            <div>
              <strong>{{ $t('setup.wizard.welcome_bullet_events_title') }}</strong> — {{ $t('setup.wizard.welcome_bullet_events_body') }}
            </div>
          </li>
        </ul>
        <div class="wizard-actions">
          <span></span>
          <button type="button" class="btn btn-primary" @click="next">
            {{ $t('setup.next') }}
          </button>
        </div>
      </div>

      <!-- Step 2: Create a club -->
      <div v-else-if="currentStep.key === 'club'" class="wizard-card">
        <div class="wizard-eyebrow">{{ $t('setup.wizard.step_eyebrow', { current: 2, total: 4 }) }}</div>
        <h1 class="wizard-title">{{ $t('setup.wizard.club_title') }}</h1>
        <i18n-t keypath="setup.wizard.club_body" tag="p" class="wizard-body">
          <template #code><code>NZL-1</code></template>
        </i18n-t>
        <form class="wizard-form" @submit.prevent="createClub">
          <label class="wizard-label">
            {{ $t('setup.wizard.club_name_label') }}
            <input class="input" type="text" v-model="clubName"
                   :placeholder="$t('setup.wizard.club_name_placeholder')" :disabled="clubBusy" required>
          </label>
          <label class="wizard-label">
            {{ $t('setup.wizard.club_code_label') }} <span class="wizard-label-hint">{{ $t('setup.wizard.club_code_label_hint') }}</span>
            <input class="input" type="text" v-model="clubCode"
                   :placeholder="$t('setup.wizard.club_code_placeholder')" maxlength="6" :disabled="clubBusy">
          </label>
        </form>
        <div class="wizard-actions">
          <button type="button" class="btn btn-ghost" @click="back">{{ $t('setup.back') }}</button>
          <div class="wizard-actions-right">
            <button type="button" class="btn btn-ghost" @click="next">{{ $t('setup.skip') }}</button>
            <button type="button" class="btn btn-primary" :disabled="!clubName.trim() || clubBusy" @click="createClub">
              {{ clubBusy ? $t('setup.wizard.club_creating') : $t('setup.wizard.club_create_btn') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Step 3: Invite users -->
      <div v-else-if="currentStep.key === 'invite'" class="wizard-card">
        <div class="wizard-eyebrow">{{ $t('setup.wizard.step_eyebrow', { current: 3, total: 4 }) }}</div>
        <h1 class="wizard-title">{{ $t('setup.wizard.invite_title') }}</h1>
        <p class="wizard-body">
          {{ $t('setup.wizard.invite_body') }}
        </p>
        <div class="wizard-invite-row">
          <input
            class="input wizard-invite-url"
            type="text"
            :value="registerUrl"
            readonly
            @focus="$event.target.select()"
            :aria-label="$t('setup.wizard.registration_link_aria')"
          >
          <button type="button" class="btn btn-primary" @click="copyRegisterUrl">
            <span v-if="copyState === 'copied'">{{ $t('setup.wizard.invite_copied') }}</span>
            <span v-else-if="copyState === 'error'">{{ $t('setup.wizard.invite_copy_failed') }}</span>
            <span v-else>{{ $t('setup.wizard.invite_copy') }}</span>
          </button>
        </div>
        <p class="wizard-hint">
          {{ $t('setup.wizard.invite_hint') }}
        </p>
        <div class="wizard-actions">
          <button type="button" class="btn btn-ghost" @click="back">{{ $t('setup.back') }}</button>
          <div class="wizard-actions-right">
            <button type="button" class="btn btn-primary" @click="next">
              {{ $t('setup.next') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Step 4: Create first event -->
      <div v-else-if="currentStep.key === 'event'" class="wizard-card">
        <div class="wizard-eyebrow">{{ $t('setup.wizard.step_eyebrow', { current: 4, total: 4 }) }}</div>
        <h1 class="wizard-title">{{ $t('setup.wizard.event_title') }}</h1>
        <p class="wizard-body">
          {{ $t('setup.wizard.event_body') }}
        </p>
        <ul class="wizard-bullets">
          <li>
            <span class="wizard-bullet-icon">🎚</span>
            <div>
              {{ $t('setup.wizard.event_bullet_panel') }}
            </div>
          </li>
          <li>
            <span class="wizard-bullet-icon">📋</span>
            <div>
              {{ $t('setup.wizard.event_bullet_roster') }}
            </div>
          </li>
          <li>
            <span class="wizard-bullet-icon">⚖️</span>
            <div>
              {{ $t('setup.wizard.event_bullet_judges') }}
            </div>
          </li>
        </ul>
        <div class="wizard-actions">
          <button type="button" class="btn btn-ghost" @click="back">{{ $t('setup.back') }}</button>
          <div class="wizard-actions-right">
            <RouterLink to="/dashboard" class="btn btn-ghost">
              {{ $t('setup.wizard.back_to_dashboard') }}
            </RouterLink>
            <button type="button" class="btn btn-primary" @click="complete">
              {{ $t('setup.finish') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard-shell {
  /* dvh: see LoginView for the iOS Safari rationale.
     vh fallback first for browsers older than ~Q4-2022. */
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg);
  display: flex; flex-direction: column;
}

.wizard-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.25rem 2rem;
  border-bottom: 1px solid var(--border);
}
.wizard-logo {
  font-family: var(--font-display);
  font-size: 16px; font-weight: 800; font-style: italic;
  letter-spacing: 0.04em;
  /* DIVING white, HQ cyan, matches the home-page hero. */
  color: var(--text);
  text-decoration: none;
}
.wizard-logo span { color: var(--cyan); }
.wizard-skip-link {
  background: transparent; border: 0;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.12s;
}
.wizard-skip-link:hover { color: var(--text); }

.wizard-frame {
  flex: 1;
  width: 100%; max-width: 720px;
  margin: 0 auto;
  padding: 2.5rem 2rem 4rem;
}

/* Stepper, same idea as the Pre-Meet stepper in ControlView:
   labels under pips, with a click-to-jump affordance. */
.wizard-stepper {
  display: flex; align-items: flex-start;
  justify-content: center;
  gap: 0;
  margin-bottom: 2.5rem;
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.wizard-step {
  display: flex; flex-direction: column; align-items: center;
  gap: 6px;
  background: transparent; border: 0;
  padding: 0; min-width: 78px;
  cursor: pointer;
  color: inherit;
}
.wizard-step-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px;
  border-radius: 50%;
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  letter-spacing: 0;
  border: 1.5px solid;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.wizard-step-done .wizard-step-num {
  background: var(--green-dim); color: var(--green); border-color: var(--green);
}
.wizard-step-done .wizard-step-label { color: var(--text-3); }
.wizard-step-active .wizard-step-num {
  background: var(--cyan-dim); color: var(--cyan); border-color: var(--cyan);
  box-shadow: 0 0 0 4px rgba(6, 182, 212, 0.18);
}
.wizard-step-active .wizard-step-label { color: var(--cyan); }
.wizard-step-future .wizard-step-num {
  background: transparent; color: var(--text-3); border-color: var(--border);
}
.wizard-step-future .wizard-step-label { color: var(--text-3); }
.wizard-step-divider {
  flex: 0 0 auto; width: 36px; height: 2px;
  background: var(--border);
  margin: 13px 4px 0;
  border-radius: 1px;
  transition: background 0.2s;
}
.wizard-step-divider.wf-divider-done { background: var(--green); }

.wizard-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2.25rem 2.5rem;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}
@media (max-width: 540px) {
  .wizard-card { padding: 1.5rem 1.5rem; }
}

.wizard-eyebrow {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 0.5rem;
}
.wizard-title {
  font-family: var(--font-display);
  font-size: 30px; font-weight: 800; font-style: italic;
  line-height: 1.15; color: var(--text);
  margin: 0 0 0.85rem;
  letter-spacing: 0.02em;
}
.wizard-body {
  font-family: var(--font-mono);
  font-size: 13.5px; line-height: 1.7;
  color: var(--text-2);
  margin: 0 0 1.4rem;
}
.wizard-subtitle {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-3);
  margin: -0.4rem 0 1rem;
}
.wizard-body code {
  background: var(--bg-3); padding: 0.05rem 0.35rem;
  border-radius: 3px; font-size: 12px; color: var(--cyan);
}

.wizard-bullets {
  list-style: none; padding: 0; margin: 0 0 1.6rem;
  display: flex; flex-direction: column; gap: 0.95rem;
}
.wizard-bullets li {
  display: flex; gap: 0.85rem;
  font-family: var(--font-mono);
  font-size: 13px; line-height: 1.55;
  color: var(--text-2);
}
.wizard-bullets strong {
  font-family: var(--font-display);
  font-style: italic;
  color: var(--text);
  letter-spacing: 0.02em;
}
.wizard-bullet-icon {
  flex-shrink: 0;
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 50%;
  font-size: 14px;
}

.wizard-form {
  display: flex; flex-direction: column; gap: 0.85rem;
  margin-bottom: 1.4rem;
}
.wizard-label {
  display: flex; flex-direction: column;
  gap: 0.35rem;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
}
.wizard-label-hint {
  font-weight: 400; letter-spacing: 0.04em;
  text-transform: none; color: var(--text-3);
  font-size: 10.5px; opacity: 0.85;
}

.wizard-invite-row {
  display: flex; gap: 0.5rem;
  margin-bottom: 0.9rem;
}
.wizard-invite-url { flex: 1; font-family: var(--font-mono); }
.wizard-hint {
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.55;
  color: var(--text-3);
  margin: 0 0 1.6rem;
}

.wizard-actions {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem;
  padding-top: 1.2rem;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.wizard-actions-right {
  display: flex; gap: 0.5rem;
  margin-inline-start: auto;
  flex-wrap: wrap;
}
</style>
