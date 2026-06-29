<script setup>
// Diver-facing "Pay & enter" control for an event. Mount it on the
// competitor view, e.g.:
//   <EntryCheckoutButton :event-id="event.id" />
// It shows the price the signed-in diver would pay (member-aware) and
// hands off to Stripe Checkout. The webhook records payment server-side.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'

const props = defineProps({ eventId: { type: String, required: true } })
const auth = useAuthStore()

const fee = ref(null)
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
    const r = await auth.apiFetch(`/api/events/${props.eventId}/fee`)
    fee.value = r.fee
  } catch (e) {
    showError(e.message || 'Could not load the entry fee')
  } finally {
    loading.value = false
  }
}

async function pay() {
  busy.value = true
  try {
    const { url } = await auth.apiFetch(`/api/events/${props.eventId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    window.location.href = url // hand off to Stripe Checkout
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="entry-checkout">
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="!fee || !fee.price" class="muted">No entry fee is required for this event.</p>
    <p v-else-if="fee.already_paid" class="paid">✓ Entry fee paid</p>
    <template v-else>
      <p class="price">
        Entry fee: <strong>{{ money(fee.price.amount_cents, fee.currency) }}</strong>
        <span v-if="fee.is_member" class="badge">member price</span>
      </p>
      <button class="btn-pay" :disabled="busy" @click="pay">
        {{ busy ? 'Redirecting…' : 'Pay & enter' }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.entry-checkout { display: flex; flex-direction: column; gap: .5rem; }
.price { margin: 0; }
.badge { margin-left: .5rem; font-size: .75rem; padding: .1rem .4rem; border-radius: .4rem; background: var(--accent-soft, #eef); }
.muted { color: var(--text-muted, #777); }
.paid { color: var(--success, #2a7); margin: 0; font-weight: 600; }
.btn-pay { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn-pay:disabled { opacity: .6; cursor: default; }
</style>
