<script setup>
// Cut 3 of the referee sign-off plan: the page where a referee
// types the 6-digit handoff code the meet manager generated on
// their screen, or lands here after scanning the QR code rendered
// next to it.
//
// The route is referee-only (router meta gate), but the credential
// rides on the user's existing JWT, so there's no separate auth
// dance. Server matches (target_referee_id = req.user.id, code) so
// a code generated for one referee can't be used by another.
//
// On success we patch the local notification banner (server fires
// the same referee_signoff_response broadcast as the push respond
// path, so any open Control Room tab updates too) and show a
// "Signed off" confirmation.
import { ref, computed, onMounted } from 'vue'
import { RouterLink, useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()

const code = ref('')
const busy = ref(false)
const errorMsg = ref('')
const successMsg = ref('')
// Auto-mode flag: true when we landed via QR scan (?code=…)
// rather than manual typing. Drives slightly different progress /
// success copy ("Auto-submitted from QR scan…") without touching
// any of the underlying logic.
const fromQr = ref(false)

const digits = computed(() => code.value.replace(/\D/g, '').slice(0, 6))

async function submit() {
  errorMsg.value = ''
  successMsg.value = ''
  if (digits.value.length !== 6) {
    errorMsg.value = 'Code must be 6 digits.'
    return
  }
  busy.value = true
  try {
    await auth.apiFetch('/api/sign-off/code/verify', {
      method: 'POST',
      body: JSON.stringify({ code: digits.value }),
    })
    successMsg.value = fromQr.value
      ? 'Signed off ✓ — picked up from your QR scan. The meet controller has been notified.'
      : 'Signed off ✓ — the meet controller has been notified.'
    code.value = ''
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    busy.value = false
  }
}

function paste(text) {
  // Handles the pasted-from-meet-controller-screen case. Strips
  // anything non-digit and caps at 6, just in case its pasted
  // with a stray space or dash mixed in.
  code.value = String(text || '').replace(/\D/g, '').slice(0, 6)
}

// Auto-redeem on ?code=…, set when the referee lands here via a
// QR scan from the manager's modal. We wait one tick so the
// reactive state settles, then submit. Falls through to manual
// input cleanly if the code is malformed (the submit guard
// rejects anything that isn't 6 digits).
onMounted(() => {
  const queryCode = String(route.query.code || '').replace(/\D/g, '').slice(0, 6)
  if (!queryCode) return
  fromQr.value = true
  code.value = queryCode
  if (queryCode.length === 6) {
    // Microtask delay keeps the input visually populated for a beat
    // before busy:true greys it out, so the referee gets visual
    // confirmation the right code came through via QR instead of
    // the form jumping straight from blank to "Verifying…".
    setTimeout(submit, 80)
  }
})
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">Sign-Off Code</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">{{ $t('common.dashboard') }}</RouterLink>
  </div>

  <div class="main">
    <p class="page-sub">
      A meet controller has asked you to sign off on the dive order for an
      event. Either <strong>scan the QR code</strong> on their screen with
      your phone camera (which loads this page with the code pre-filled and
      auto-submits), or read the 6-digit code from their screen and type it
      here. Codes expire 5 minutes after they're generated.
    </p>

    <form class="code-form" @submit.prevent="submit">
      <label class="code-label">Enter the 6-digit code</label>
      <input
        class="code-input"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        :value="digits"
        :disabled="busy || !!successMsg"
        autofocus
        placeholder="123456"
        @input="paste($event.target.value)">
      <button type="submit" class="btn btn-primary btn-lg"
              :disabled="busy || digits.length !== 6 || !!successMsg">
        {{ busy ? 'Verifying…' : 'Sign off' }}
      </button>

      <div v-if="errorMsg" class="msg msg-error">{{ errorMsg }}</div>
      <div v-if="successMsg" class="msg msg-success">{{ successMsg }}</div>
    </form>
  </div>
</template>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.5rem 2rem; border-bottom: 1px solid var(--border);
  max-width: 720px; margin: 0 auto;
}
.page-title { font-size: 32px; font-style: italic; }
.page-sub {
  max-width: 720px; margin: 0 auto; padding: 0 2rem;
  color: var(--text-3); font-size: 13px; line-height: 1.6;
}
.main {
  max-width: 720px; margin: 0 auto; padding: 1rem 2rem 3rem;
}
.code-form {
  display: flex; flex-direction: column; gap: 1rem;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2rem; margin-top: 1.5rem;
}
.code-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.code-input {
  font-family: var(--font-mono); font-size: 48px; font-weight: 700;
  letter-spacing: 0.25em; text-align: center;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; padding: 1.2rem 0.5rem;
  color: var(--cyan);
}
.code-input:focus { outline: none; border-color: var(--cyan); }
.code-input:disabled { opacity: 0.6; }
.btn-lg { padding: 0.75rem 1rem; font-size: 14px; }
.msg {
  padding: 0.7rem 0.9rem; border-radius: 4px; font-size: 13px;
}
.msg-error {
  background: rgba(239, 68, 68, 0.08); color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.msg-success {
  background: rgba(16, 185, 129, 0.08); color: var(--green);
  border: 1px solid rgba(16, 185, 129, 0.4);
}

/* =========================================================
   Phone, under 600 px. The 6-digit code is the headline of
   this page, since it has to be huge AND fit comfortably on a
   320 px phone (older iPhone SE). The desktop 48px + 0.25em
   spacing overflows at that width, so we trade a bit of
   spacing for fit and bump the submit button to a 44 px
   tap target. The form padding shrinks so the input gets
   maximum width.
   ========================================================= */
@media (max-width: 600px) {
  .page-header { padding: 1rem; }
  .page-title { font-size: 24px; }
  .page-sub { padding: 0 1rem; }
  .code-form { padding: 1.25rem 1rem; gap: 0.85rem; margin-top: 1rem; }
  .code-input {
    /* clamp so it scales between 320 and 600 px without
       crowding the digits or running off the edge. */
    font-size: clamp(28px, 11vw, 44px);
    letter-spacing: 0.15em;
    padding: 0.9rem 0.4rem;
  }
  .btn-lg {
    min-height: 44px;
    font-size: 14px;
    padding: 0.85rem 1rem;
  }
}
</style>
