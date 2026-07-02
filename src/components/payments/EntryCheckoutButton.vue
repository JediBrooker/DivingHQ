<script setup>
// Diver-facing "Pay & enter" control for an event. Mount it on the
// competitor view, e.g.:
//   <EntryCheckoutButton :event-id="event.id" />
// It shows the price the signed-in diver would pay (member-aware) and
// hands off to Stripe Checkout. The webhook records payment server-side.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'

const props = defineProps({ eventId: { type: String, required: true } })
const auth = useAuthStore()

const fee = ref(null)
const comingSoon = ref(false)
const loading = ref(true)
const busy = ref(false)

// Human label for the late-fee trigger, used in the badge + early-pay nudge.
const lateBadge = computed(() =>
  fee.value?.late_fee?.trigger === 'dive_list_locks_at' ? 'dive list locked' : 'entries closed')
const lateWhen = computed(() =>
  fee.value?.late_fee?.trigger === 'dive_list_locks_at' ? 'once the dive list locks' : 'once entries close')

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
    comingSoon.value = r.payments_enabled === false
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
    <p v-else-if="comingSoon" class="coming-soon">💳 Online entry-fee payments are coming soon.</p>
    <!-- fee === null: no fee configured (genuinely free). fee set but no
         resolved price: every price window has closed — different message,
         or divers think a paid event is free. -->
    <p v-else-if="!fee" class="muted">No entry fee is required for this event.</p>
    <p v-else-if="!fee.price" class="muted">Entry purchase isn't open right now — contact the organisers.</p>
    <p v-else-if="fee.already_paid" class="paid">✓ Entry fee paid</p>
    <template v-else>
      <p class="price">
        Entry fee: <strong>{{ money(fee.price.amount_cents, fee.currency) }}</strong>
        <span v-if="fee.is_member" class="badge">member price</span>
      </p>
      <!-- Server-computed figure the card is actually charged (includes the
           platform fee when the federation passes it on) — the quote must
           always match Stripe's total. -->
      <p v-if="fee.payer_total_cents != null && fee.payer_total_cents !== fee.total_cents" class="uplift">
        You pay {{ money(fee.payer_total_cents, fee.currency) }} (incl. platform fee)
      </p>
      <template v-if="fee.late_fee && fee.late_fee.applies">
        <p class="late">
          + Late entry fee: <strong>{{ money(fee.late_fee.surcharge_cents, fee.currency) }}</strong>
          <span class="badge late-badge">{{ lateBadge }}</span>
        </p>
        <p class="total">Total now: <strong>{{ money(fee.total_cents, fee.currency) }}</strong></p>
      </template>
      <p v-else-if="fee.late_fee" class="late-warn">
        ⏰ Pay now to avoid a {{ money(fee.late_fee.surcharge_cents, fee.currency) }} late fee {{ lateWhen }}.
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
.late { margin: 0; color: var(--amber, #b70); }
.total { margin: 0; }
.late-warn { margin: 0; font-size: .85rem; color: var(--amber, #b70); }
.uplift { margin: 0; font-size: .85rem; color: var(--fg-2, #555); }
.badge { margin-left: .5rem; font-size: .75rem; padding: .1rem .4rem; border-radius: .4rem; background: var(--accent-soft, #eef); }
.late-badge { background: var(--amber-dim, #fdf0d5); color: var(--amber, #b70); }
.muted { color: var(--muted, #777); }
.coming-soon { margin: 0; color: var(--accent, #3b6); font-weight: 600; }
.paid { color: var(--green, #2a7); margin: 0; font-weight: 600; }
.btn-pay { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn-pay:disabled { opacity: .6; cursor: default; }
</style>
