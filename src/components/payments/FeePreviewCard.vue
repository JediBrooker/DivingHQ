<script setup>
// End-user functional preview of an upcoming fee. Fetches the resolved
// fee from `loadUrl` (the server makes it member/tier/discipline-aware)
// and renders the price with a DISABLED pay action + a ComingSoonBanner
// while payments are dormant (payments_enabled === false). When payments
// go live and a `checkoutUrl` is supplied, the button becomes a real
// "Pay" that hands off to Stripe. One card reused across membership,
// club affiliation, fines, spectator access, owed entry charges, etc.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({
  loadUrl: { type: String, required: true },     // GET -> { fee: {price,currency,is_member,tier}|null, payments_enabled }
  checkoutUrl: { type: String, default: '' },    // POST -> { url }; only used once payments are live
  checkoutBody: { type: Object, default: () => ({}) }, // extra POST body (e.g. {kind}, {tier})
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

// The buyer already holds this (paid / member / active accreditation) — show
// a confirmed state instead of an actionable Pay button. The flag name
// varies by endpoint, so accept any of them.
const owned = computed(() => !!(fee.value && (fee.value.already_paid || fee.value.already_member || fee.value.active)))
const ownedLabel = computed(() => {
  const until = fee.value?.period_end ? ` until ${String(fee.value.period_end).slice(0, 10)}` : ''
  if (fee.value?.already_member) return `✓ Member${until}`
  if (fee.value?.active) return `✓ Active${until}`
  return '✓ Purchased'
})

// The figure the payer is actually charged (server-computed; includes the
// platform fee when the org passes it to the payer). Shown whenever it
// differs from the base price so the quote always matches Stripe's total.
const payerTotal = computed(() => fee.value?.payer_total_cents ?? null)
const totalDiffers = computed(() =>
  payerTotal.value != null && fee.value?.price && payerTotal.value !== fee.value.price.amount_cents)

const refundNote = computed(() => {
  const rp = fee.value?.refund_policy
  if (rp === 'none') return 'No refunds.'
  if (rp === 'deadline' && fee.value?.refund_deadline) return `Refundable until ${String(fee.value.refund_deadline).slice(0, 10)}.`
  if (rp === 'full') return 'Refundable.'
  return ''
})

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
    const { url } = await auth.apiFetch(props.checkoutUrl, { method: 'POST', body: JSON.stringify(props.checkoutBody) })
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
      <p v-if="totalDiffers" class="fp-total">You pay {{ money(payerTotal, fee.currency) }} (incl. platform fee)</p>
      <p v-if="refundNote" class="fp-refund muted">{{ refundNote }}</p>
      <p v-if="owned" class="fp-owned">{{ ownedLabel }}</p>
      <template v-else>
        <button class="fp-pay" :disabled="!enabled || busy || !checkoutUrl" @click="pay">
          {{ !enabled ? 'Coming soon' : (busy ? 'Redirecting…' : 'Pay') }}
        </button>
        <ComingSoonBanner v-if="!enabled" :message="comingSoonMessage" />
      </template>
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
.fp-owned { align-self: flex-start; margin: 0; color: var(--green, #2a7); font-weight: 600; }
.fp-total { margin: 0; font-size: .85rem; color: var(--fg-2, #555); }
.fp-refund { margin: 0; font-size: .8rem; }
.muted { color: var(--muted, #777); }
</style>
