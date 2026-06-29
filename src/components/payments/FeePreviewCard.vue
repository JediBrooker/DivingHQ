<script setup>
// End-user functional preview of an upcoming fee. Fetches the resolved
// fee from `loadUrl` (the server makes it member/tier/discipline-aware)
// and renders the price with a DISABLED pay action + a ComingSoonBanner
// while payments are dormant (payments_enabled === false). When payments
// go live and a `checkoutUrl` is supplied, the button becomes a real
// "Pay" that hands off to Stripe. One card reused across membership,
// club affiliation, fines, spectator access, owed entry charges, etc.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({
  loadUrl: { type: String, required: true },     // GET -> { fee: {price,currency,is_member,tier}|null, payments_enabled }
  checkoutUrl: { type: String, default: '' },    // POST -> { url }; only used once payments are live
  title: { type: String, default: 'Fee' },
  comingSoonMessage: { type: String, default: 'Online payments are coming soon.' },
  // When true, render nothing if no fee is configured (keeps public pages
  // clean until a federation sets one). Default shows a "not set" note.
  hideWhenUnset: { type: Boolean, default: false },
})

const auth = useAuthStore()
const fee = ref(null)
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function load() {
  loading.value = true
  try {
    const r = await auth.apiFetch(props.loadUrl)
    fee.value = r.fee
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    showError(e.message || 'Could not load the fee')
  } finally {
    loading.value = false
  }
}

async function pay() {
  if (!props.checkoutUrl || !enabled.value) return
  busy.value = true
  try {
    const { url } = await auth.apiFetch(props.checkoutUrl, { method: 'POST', body: JSON.stringify({}) })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="fee-preview">
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else-if="fee && fee.price">
      <p class="fp-price">
        <span class="fp-title">{{ title }}:</span>
        <strong>{{ money(fee.price.amount_cents, fee.currency) }}</strong>
        <span v-if="fee.is_member" class="fp-badge">member</span>
        <span v-else-if="fee.tier" class="fp-badge">{{ fee.tier }}</span>
      </p>
      <button class="fp-pay" :disabled="!enabled || busy || !checkoutUrl" @click="pay">
        {{ !enabled ? 'Coming soon' : (busy ? 'Redirecting…' : 'Pay') }}
      </button>
      <ComingSoonBanner v-if="!enabled" :message="comingSoonMessage" />
    </template>
    <p v-else-if="!hideWhenUnset" class="muted">No {{ title.toLowerCase() }} is set for this yet.</p>
  </div>
</template>

<style scoped>
.fee-preview { display: flex; flex-direction: column; gap: .5rem; }
.fp-price { margin: 0; }
.fp-title { color: var(--muted, #777); }
.fp-badge { margin-left: .4rem; font-size: .72rem; padding: .05rem .4rem; border-radius: .4rem; background: var(--accent-soft, #eef); color: var(--accent, #3b6); text-transform: capitalize; }
.fp-pay { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.fp-pay:disabled { opacity: .6; cursor: default; }
.muted { color: var(--muted, #777); }
</style>
