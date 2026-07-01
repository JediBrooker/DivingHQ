<script setup>
// Federation payments admin (org_admin). Two jobs:
//   1. Stripe Connect onboarding — get the federation payout-ready.
//   2. Set the membership fee (members unlock "Members only" entry prices).
// Entry fees are set per event on the event-management page via
// <EntryFeeEditor :event-id="…" />.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import MembershipFeeEditor from '@/components/payments/MembershipFeeEditor.vue'
import ClubFeesEditor from '@/components/payments/ClubFeesEditor.vue'
import OfficialFeesEditor from '@/components/payments/OfficialFeesEditor.vue'
import DonationEditor from '@/components/payments/DonationEditor.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)

const status = ref(null)
const loading = ref(true)
const busy = ref(false)
const form = ref({ account_name: '', account_details: '' })
const comingSoon = computed(() => status.value && status.value.enabled === false)

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function loadStatus() {
  if (!orgId.value) return
  loading.value = true
  try {
    status.value = await auth.apiFetch(`/api/orgs/${orgId.value}/payments/status`)
    form.value.account_name = status.value.account_name || ''
  } catch (e) {
    showError(e.message || 'Could not load payout status')
  } finally {
    loading.value = false
  }
}

async function savePayout() {
  busy.value = true
  try {
    await auth.apiFetch(`/api/orgs/${orgId.value}/payout-details`, {
      method: 'PUT',
      body: JSON.stringify(form.value),
    })
    showSuccess('Payout details saved')
    form.value.account_details = ''
    await loadStatus()
  } catch (e) {
    showError(e.message || 'Could not save payout details')
  } finally {
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
      <p class="muted">
        DivingHQ collects payments and pays out your share (we keep 15%). No Stripe
        account needed — just add the bank details we should send your money to.
      </p>
      <p v-if="loading" class="muted">Checking…</p>
      <template v-else>
        <p v-if="comingSoon" class="coming-soon">🚧 Payments are coming soon. Add your payout bank details here now — we'll pay out your share the moment it's switched on.</p>
        <p v-else-if="status && status.payout_details_set" class="ok">
          ✓ Payout details on file{{ status.account_name ? ` — ${status.account_name}` : '' }}.
        </p>
        <p v-else class="warn">Add your payout bank details so we can pay you.</p>
        <p v-if="!comingSoon" class="muted">Balance owed to you: <strong>{{ money(status && status.balance_cents, status && status.currency) }}</strong></p>
        <div class="field">
          <label>Account name</label>
          <input class="in" v-model="form.account_name" placeholder="e.g. Sydney Diving Club" />
        </div>
        <div class="field">
          <label>Bank details (IBAN, or sort code + account number)</label>
          <input class="in" v-model="form.account_details" placeholder="GB00 XXXX 0000 0000 0000 00" />
        </div>
        <button class="btn" :disabled="busy || !form.account_name || !form.account_details" @click="savePayout">
          {{ busy ? 'Saving…' : 'Save payout details' }}
        </button>
      </template>
    </div>

    <div class="card">
      <h2>Membership fee</h2>
      <p class="muted">
        Members get any “Members only” entry prices. Membership is not required to enter competitions.
      </p>
      <MembershipFeeEditor v-if="orgId" :org-id="orgId" />
    </div>

    <div class="card">
      <h2>Club fees</h2>
      <p class="muted">
        Affiliation and accreditation fees your clubs pay you each year.
        Set them here; track who's paid in the Clubs list.
      </p>
      <ClubFeesEditor v-if="orgId" :org-id="orgId" />
    </div>

    <div class="card">
      <h2>Accreditation fees</h2>
      <p class="muted">
        Annual accreditation fees for officials and coaches, per role.
        They pay from their own Accreditation page.
      </p>
      <OfficialFeesEditor v-if="orgId" :org-id="orgId" />
    </div>

    <div class="card">
      <h2>Donations</h2>
      <p class="muted">
        Accept fundraising donations from supporters, with suggested amounts.
      </p>
      <DonationEditor v-if="orgId" :org-id="orgId" />
    </div>
  </section>
</template>

<style scoped>
.payments-admin { display: flex; flex-direction: column; gap: 1.5rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.card { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .5rem; }
.btn { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .6; }
.ok { color: var(--green, #2a7); margin: 0; }
.warn { color: var(--amber, #b70); margin: 0; }
.muted { color: var(--muted, #777); }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: var(--fg-2, #555); }
.in { padding: .4rem .6rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg, #222); }
.coming-soon { margin: 0; padding: .5rem .75rem; border-radius: .5rem; background: var(--accent-soft, #eef); color: var(--accent, #3b6); font-weight: 600; font-size: .9rem; }
</style>
