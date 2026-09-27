<script setup>
// What a new account sees after signing up (RegisterView) or registering
// a federation (RegisterOrgView), in place of the form.
//
// It used to be a success line and a 2.5s redirect to /login, so the
// "check your email" part was gone before anyone had read it and the
// login page then refused them with no hint why. This stays put: which
// address the link went to, a way to get another one, and the sign-in
// link for once they've clicked it. The default slot carries anything
// the caller needs to add about what happens next (a claim's vote, a
// federation waiting for review).
//
// The resend button waits 60s, starting now, because a mail was just
// sent and it can take a minute to land. The server has its own
// per-account cooldown and answers ok regardless, so this is only about
// not inviting a row of identical emails.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  email:    { type: String, required: true },
  username: { type: String, required: true },
})

const COOLDOWN_S = 60
const wait = ref(COOLDOWN_S)
const sending = ref(false)
const resent = ref(false)
let timer = null

function startCooldown() {
  wait.value = COOLDOWN_S
  clearInterval(timer)
  timer = setInterval(() => {
    wait.value = Math.max(0, wait.value - 1)
    if (!wait.value) clearInterval(timer)
  }, 1000)
}

async function resend() {
  if (wait.value || sending.value) return
  sending.value = true
  try {
    await fetch('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: props.username.trim() }),
    })
  } catch {
    // Same answer either way (the endpoint never says who exists), so a
    // network blip gets the same "on its way" as a real send.
  } finally {
    sending.value = false
    resent.value = true
    startCooldown()
  }
}

onMounted(startCooldown)
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <section class="check-inbox" data-testid="check-inbox" role="status">
    <h2 class="ci-title">{{ $t('auth.check_inbox.title') }}</h2>
    <p class="ci-body">
      {{ $t('auth.check_inbox.body', { email }) }}
    </p>
    <slot />
    <p class="ci-hint">{{ $t('auth.check_inbox.no_mail') }}</p>
    <button type="button" class="btn btn-ghost ci-resend" data-testid="check-inbox-resend"
            :disabled="wait > 0 || sending" @click="resend">
      {{ wait > 0 ? $t('auth.check_inbox.resend_wait', { seconds: wait }) : $t('auth.verify_email.resend_button') }}
    </button>
    <p v-if="resent" class="msg msg-success ci-resent">{{ $t('auth.check_inbox.resent', { email }) }}</p>
    <p class="ci-signin">
      {{ $t('auth.check_inbox.already') }}
      <RouterLink to="/login">{{ $t('auth.register.sign_in_link') }}</RouterLink>
    </p>
  </section>
</template>

<style scoped>
.check-inbox {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface);
}
.ci-title { margin: 0; font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); }
.ci-body { margin: 0; color: var(--fg); font-size: var(--text-sm); line-height: 1.55; overflow-wrap: anywhere; }
.ci-hint { margin: 0; color: var(--fg-3); font-size: var(--text-xs); line-height: 1.5; }
.ci-resend { align-self: flex-start; }
.ci-resent { margin: 0; }
.ci-signin { margin: var(--space-2) 0 0; font-size: var(--text-sm); color: var(--fg-3); }
.ci-signin a { color: var(--accent); }
</style>
