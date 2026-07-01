<script setup>
// Supporter-facing donation page (/donate). Shows the federation's suggested
// amounts (or a custom amount) with a contextual "coming soon" preview until
// online payments are switched on. Reads GET /api/orgs/:orgId/donation.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)

const donation = ref(null)
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)
const amount = ref('')

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
    const r = await auth.apiFetch(`/api/orgs/${orgId.value}/donation`)
    donation.value = r.donation
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    showError(e.message || 'Could not load donations')
  } finally {
    loading.value = false
  }
}

function pick(cents) { amount.value = (cents / 100).toString() }

async function donate() {
  if (!enabled.value) return
  const cents = Math.round(parseFloat(amount.value || '0') * 100)
  const min = (donation.value && donation.value.min_amount_cents) || 100
  if (!Number.isInteger(cents) || cents < min) {
    showError('Please enter a valid amount')
    return
  }
  busy.value = true
  try {
    const { url } = await auth.apiFetch(`/api/orgs/${orgId.value}/donate/checkout`, {
      method: 'POST', body: JSON.stringify({ amount_cents: cents }),
    })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="donate-view">
    <h1>Donate</h1>
    <p class="lede">Support your federation with a one-off donation.</p>
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else-if="donation">
      <ComingSoonBanner v-if="!enabled" message="Online donations are coming soon — here's what you'll be able to give." />
      <div v-if="donation.suggested_amounts && donation.suggested_amounts.length" class="presets">
        <button v-for="c in donation.suggested_amounts" :key="c" type="button" class="preset" @click="pick(c)">
          {{ money(c, donation.currency) }}
        </button>
      </div>
      <label class="custom">Amount
        <span class="amt">
          <span class="cur">{{ donation.currency }}</span>
          <input v-model="amount" type="number" min="1" step="0.01" placeholder="0.00" />
        </span>
      </label>
      <button class="btn-donate" :disabled="!enabled || busy" @click="donate">
        {{ !enabled ? 'Coming soon' : (busy ? 'Redirecting…' : 'Donate') }}
      </button>
    </template>
    <p v-else class="muted">This federation isn't accepting donations right now.</p>
  </section>
</template>

<style scoped>
.donate-view { display: flex; flex-direction: column; gap: 1rem; max-width: 40rem; margin: 0 auto; padding: 1rem; }
.lede { color: var(--muted, #777); margin: 0; }
.muted { color: var(--muted, #777); }
.presets { display: flex; flex-wrap: wrap; gap: .5rem; }
.preset { padding: .5rem 1rem; border: 1px solid var(--accent, #3b6); border-radius: .5rem; background: transparent; color: var(--accent, #3b6); cursor: pointer; font-weight: 600; }
.custom { display: flex; flex-direction: column; gap: .25rem; font-size: .9rem; color: var(--fg-2, #555); }
.amt { display: inline-flex; align-items: center; gap: .4rem; }
.cur { color: var(--muted, #777); }
.amt input { padding: .4rem; width: 9rem; }
.btn-donate { align-self: flex-start; padding: .5rem 1.25rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn-donate:disabled { opacity: .6; cursor: default; }
</style>
