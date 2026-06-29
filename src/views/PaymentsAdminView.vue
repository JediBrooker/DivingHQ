<script setup>
// Federation payments admin (org_admin). Two jobs:
//   1. Stripe Connect onboarding — get the federation payout-ready.
//   2. Set the membership fee (members unlock "Members only" entry prices).
// Entry fees are set per event on the event-management page via
// <EntryFeeEditor :event-id="…" />.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import FeeEditor from '@/components/payments/FeeEditor.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)

const status = ref(null)
const loading = ref(true)
const busy = ref(false)

async function loadStatus() {
  if (!orgId.value) return
  loading.value = true
  try {
    status.value = await auth.apiFetch(`/api/orgs/${orgId.value}/payments/status`)
  } catch (e) {
    showError(e.message || 'Could not load payment status')
  } finally {
    loading.value = false
  }
}

async function onboard() {
  busy.value = true
  try {
    const { url } = await auth.apiFetch(`/api/orgs/${orgId.value}/payments/onboard`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start onboarding')
    busy.value = false
  }
}

onMounted(loadStatus)
</script>

<template>
  <section class="payments-admin">
    <h1>Payments</h1>

    <div class="card">
      <h2>Payouts</h2>
      <p v-if="loading" class="muted">Checking…</p>
      <template v-else>
        <p v-if="status && status.charges_enabled" class="ok">
          ✓ Connected — you can take entry fees and receive payouts.
        </p>
        <p v-else class="warn">Not ready to take payments yet — finish onboarding to start.</p>
        <button class="btn" :disabled="busy" @click="onboard">
          {{ busy ? 'Opening…' : (status && status.onboarded ? 'Continue Stripe onboarding' : 'Set up payouts with Stripe') }}
        </button>
      </template>
    </div>

    <div class="card">
      <h2>Membership fee</h2>
      <p class="muted">
        Members get any “Members only” entry prices. Membership is not required to enter competitions.
      </p>
      <FeeEditor
        v-if="orgId"
        title="Membership"
        :show-membership-period="true"
        :load-url="`/api/orgs/${orgId}/membership-fee`"
        :save-url="`/api/orgs/${orgId}/membership-fee`"
      />
    </div>
  </section>
</template>

<style scoped>
.payments-admin { display: flex; flex-direction: column; gap: 1.5rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.card { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .5rem; }
.btn { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .6; }
.ok { color: var(--success, #2a7); margin: 0; }
.warn { color: var(--warning, #b70); margin: 0; }
.muted { color: var(--text-muted, #777); }
</style>
