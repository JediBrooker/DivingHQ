<script setup>
// Dedicated Payments section for a federation (org_admin). Tabs:
//   Overview        — at-a-glance balance / payout / auto-withdraw + how it works
//   Account details — payout bank details (where we send your money)
//   Withdrawals     — balance, withdraw now, automatic withdrawals, history
//   Fees & pricing  — membership / club / accreditation / donation editors
// DivingHQ is the merchant of record: it collects, keeps 15%, and pays out
// the rest. Recipients never onboard with Stripe — they just add bank details.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import MembershipFeeEditor from '@/components/payments/MembershipFeeEditor.vue'
import ClubFeesEditor from '@/components/payments/ClubFeesEditor.vue'
import OfficialFeesEditor from '@/components/payments/OfficialFeesEditor.vue'
import DonationEditor from '@/components/payments/DonationEditor.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'account', label: 'Account details' },
  { key: 'withdrawals', label: 'Withdrawals' },
  { key: 'fees', label: 'Fees & pricing' },
]
const tab = ref('overview')

const status = ref(null)
const loading = ref(true)
const savingPayout = ref(false)
const savingAuto = ref(false)
const withdrawing = ref(false)
const payoutForm = ref({ account_name: '', account_details: '' })
const autoForm = ref({ enabled: false, threshold: '' })
const withdrawAmount = ref('')
const withdrawals = ref([])

const comingSoon = computed(() => status.value && status.value.enabled === false)
const currency = computed(() => (status.value && status.value.currency) || 'GBP')
const balanceCents = computed(() => (status.value && status.value.balance_cents) || 0)
const payoutSet = computed(() => !!(status.value && status.value.payout_details_set))
const autoThresholdOk = computed(() => Number(autoForm.value.threshold) >= 1)

function money(cents, cur) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || currency.value }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur || currency.value}`.trim()
  }
}

function fmtDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(ts).slice(0, 10)
  }
}

async function loadStatus() {
  if (!orgId.value) return
  loading.value = true
  try {
    status.value = await auth.apiFetch(`/api/orgs/${orgId.value}/payments/status`)
    payoutForm.value.account_name = status.value.account_name || ''
    autoForm.value.enabled = !!status.value.auto_withdraw_enabled
    autoForm.value.threshold = status.value.auto_withdraw_min_cents != null
      ? (status.value.auto_withdraw_min_cents / 100).toString()
      : ''
  } catch (e) {
    showError(e.message || 'Could not load payment status')
  } finally {
    loading.value = false
  }
}

async function loadWithdrawals() {
  if (!orgId.value) return
  try {
    withdrawals.value = await auth.apiFetch(`/api/orgs/${orgId.value}/withdrawals`)
  } catch {
    withdrawals.value = []
  }
}

async function savePayout() {
  savingPayout.value = true
  try {
    await auth.apiFetch(`/api/orgs/${orgId.value}/payout-details`, {
      method: 'PUT',
      body: JSON.stringify(payoutForm.value),
    })
    showSuccess('Payout details saved')
    payoutForm.value.account_details = ''
    await loadStatus()
  } catch (e) {
    showError(e.message || 'Could not save payout details')
  } finally {
    savingPayout.value = false
  }
}

async function saveAuto() {
  savingAuto.value = true
  try {
    const body = { auto_withdraw_enabled: autoForm.value.enabled }
    if (autoForm.value.enabled) body.auto_withdraw_min_cents = Math.round(Number(autoForm.value.threshold) * 100)
    await auth.apiFetch(`/api/orgs/${orgId.value}/withdrawal-settings`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    showSuccess('Automatic withdrawals updated')
    await loadStatus()
  } catch (e) {
    showError(e.message || 'Could not save withdrawal settings')
  } finally {
    savingAuto.value = false
  }
}

async function requestWithdrawal() {
  withdrawing.value = true
  try {
    const body = {}
    if (withdrawAmount.value) body.amount_cents = Math.round(Number(withdrawAmount.value) * 100)
    await auth.apiFetch(`/api/orgs/${orgId.value}/withdrawals`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    showSuccess('Withdrawal requested')
    withdrawAmount.value = ''
    await Promise.all([loadStatus(), loadWithdrawals()])
  } catch (e) {
    showError(e.message || 'Could not request withdrawal')
  } finally {
    withdrawing.value = false
  }
}

onMounted(async () => {
  await loadStatus()
  await loadWithdrawals()
})
</script>

<template>
  <section class="payments-admin">
    <header class="ph-head">
      <h1>Payments</h1>
      <p class="muted">Collect entry fees, memberships, donations and more. DivingHQ keeps 15% and pays the rest to you — no Stripe account needed.</p>
    </header>

    <p v-if="comingSoon" class="coming-soon">🚧 Payments are coming soon. Set everything up now — your payout details and automatic withdrawals — and we'll start paying out the moment it's switched on.</p>

    <nav class="tabs">
      <button v-for="tt in TABS" :key="tt.key" type="button" :class="['tab', { active: tab === tt.key }]" @click="tab = tt.key">{{ tt.label }}</button>
    </nav>

    <p v-if="loading" class="muted">Loading…</p>

    <template v-else>
      <!-- OVERVIEW -->
      <div v-show="tab === 'overview'" class="panel">
        <div class="grid">
          <div class="stat">
            <span class="stat-label">Balance owed to you</span>
            <span class="stat-value">{{ comingSoon ? '—' : money(balanceCents) }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Payout details</span>
            <span class="stat-value" :class="payoutSet ? 'ok' : 'warn'">{{ payoutSet ? 'On file' : 'Not set' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">Automatic withdrawals</span>
            <span class="stat-value">{{ status && status.auto_withdraw_enabled ? `On · over ${money(status.auto_withdraw_min_cents)}` : 'Off' }}</span>
          </div>
        </div>
        <div class="card">
          <h2>How it works</h2>
          <ol class="how-list">
            <li>Add your <button type="button" class="link" @click="tab = 'account'">payout bank details</button> — where we send your money.</li>
            <li>Set your fees &amp; pricing (memberships, entries, donations and more) in the <button type="button" class="link" @click="tab = 'fees'">Fees &amp; pricing</button> tab.</li>
            <li>We collect payments, keep a 15% platform fee, and pay you the rest.</li>
            <li>Withdraw your balance any time — or turn on automatic withdrawals to get paid the moment your balance passes a threshold.</li>
          </ol>
        </div>
      </div>

      <!-- ACCOUNT DETAILS -->
      <div v-show="tab === 'account'" class="panel">
        <div class="card">
          <h2>Payout bank details</h2>
          <p class="muted">Where DivingHQ sends your share. No Stripe account needed.</p>
          <p v-if="payoutSet" class="ok">✓ On file{{ status.account_name ? ` — ${status.account_name}` : '' }}.</p>
          <p v-else class="warn">Not set yet — add your details so we can pay you.</p>
          <div class="field">
            <label>Account name</label>
            <input class="in" v-model="payoutForm.account_name" placeholder="e.g. Sydney Diving Club" />
          </div>
          <div class="field">
            <label>Bank details (IBAN, or sort code + account number)</label>
            <input class="in" v-model="payoutForm.account_details" placeholder="GB00 XXXX 0000 0000 0000 00" />
          </div>
          <button class="btn" :disabled="savingPayout || !payoutForm.account_name || !payoutForm.account_details" @click="savePayout">
            {{ savingPayout ? 'Saving…' : 'Save payout details' }}
          </button>
        </div>
      </div>

      <!-- WITHDRAWALS -->
      <div v-show="tab === 'withdrawals'" class="panel">
        <div class="card">
          <h2>Balance &amp; withdrawals</h2>
          <p class="balance-line">Balance owed to you: <strong>{{ comingSoon ? '—' : money(balanceCents) }}</strong></p>
          <p v-if="comingSoon" class="muted">Withdrawals open when payments go live. You can set up automatic withdrawals below now.</p>
          <template v-else>
            <div class="field">
              <label>Amount to withdraw (leave blank for the full balance)</label>
              <input class="in" type="number" min="0" step="0.01" v-model="withdrawAmount" :placeholder="money(balanceCents)" />
            </div>
            <button class="btn" :disabled="withdrawing || balanceCents <= 0 || !payoutSet" @click="requestWithdrawal">
              {{ withdrawing ? 'Requesting…' : 'Withdraw now' }}
            </button>
            <p v-if="!payoutSet" class="warn small">Add your payout details first (Account details tab).</p>
          </template>
        </div>

        <div class="card">
          <h2>Automatic withdrawals</h2>
          <p class="muted">Get paid automatically when your balance passes a threshold — no need to click Withdraw.</p>
          <label class="check">
            <input type="checkbox" v-model="autoForm.enabled" />
            <span>Withdraw automatically</span>
          </label>
          <div class="field" v-if="autoForm.enabled">
            <label>Withdraw when my balance reaches ({{ currency }})</label>
            <input class="in" type="number" min="1" step="0.01" v-model="autoForm.threshold" placeholder="e.g. 100.00" />
            <p v-if="!autoThresholdOk" class="warn small">Enter a threshold of at least 1.00.</p>
          </div>
          <button class="btn" :disabled="savingAuto || (autoForm.enabled && !autoThresholdOk)" @click="saveAuto">
            {{ savingAuto ? 'Saving…' : 'Save automatic withdrawals' }}
          </button>
        </div>

        <div class="card">
          <h2>Withdrawal history</h2>
          <p v-if="!withdrawals.length" class="muted">No withdrawals yet.</p>
          <table v-else class="wtable">
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              <tr v-for="w in withdrawals" :key="w.id">
                <td>{{ fmtDate(w.created_at) }}</td>
                <td>{{ money(w.amount_cents, w.currency) }}</td>
                <td><span :class="['pill', w.status]">{{ w.status }}</span></td>
                <td>{{ w.note || '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- FEES & PRICING -->
      <div v-show="tab === 'fees'" class="panel">
        <div class="card">
          <h2>Membership fee</h2>
          <p class="muted">Members get any “Members only” entry prices. Membership isn't required to enter competitions.</p>
          <MembershipFeeEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>Club fees</h2>
          <p class="muted">Affiliation and accreditation fees your clubs pay you each year. Track who's paid in the Clubs list.</p>
          <ClubFeesEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>Accreditation fees</h2>
          <p class="muted">Annual accreditation fees for officials and coaches, per role. They pay from their own Accreditation page.</p>
          <OfficialFeesEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>Donations</h2>
          <p class="muted">Accept fundraising donations from supporters, with suggested amounts.</p>
          <DonationEditor v-if="orgId" :org-id="orgId" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.payments-admin { display: flex; flex-direction: column; gap: 1.25rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.ph-head h1 { margin: 0 0 .25rem; }
.ph-head .muted { margin: 0; max-width: 46rem; }
.tabs { display: flex; flex-wrap: wrap; gap: .25rem; border-bottom: 1px solid var(--border, #ddd); }
.tab { appearance: none; border: 0; background: transparent; padding: .55rem .9rem; cursor: pointer; color: var(--fg-2, #555); font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover { color: var(--fg, #222); }
.tab.active { color: var(--accent, #3b6); border-bottom-color: var(--accent, #3b6); font-weight: 600; }
.panel { display: flex; flex-direction: column; gap: 1.25rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .75rem; }
.stat { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: .85rem 1rem; display: flex; flex-direction: column; gap: .25rem; background: var(--surface, transparent); }
.stat-label { font-size: .78rem; color: var(--muted, #777); text-transform: uppercase; letter-spacing: .03em; }
.stat-value { font-size: 1.15rem; font-weight: 700; color: var(--fg, #222); }
.stat-value.ok { color: var(--green, #2a7); }
.stat-value.warn { color: var(--amber, #b70); }
.card { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .6rem; }
.card h2 { margin: 0; font-size: 1.05rem; }
.how-list { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .4rem; color: var(--fg-2, #555); }
.link { appearance: none; border: 0; background: transparent; padding: 0; cursor: pointer; color: var(--accent, #3b6); font: inherit; text-decoration: underline; }
.btn { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .55; cursor: default; }
.ok { color: var(--green, #2a7); margin: 0; }
.warn { color: var(--amber, #b70); margin: 0; }
.warn.small { font-size: .82rem; }
.muted { color: var(--muted, #777); }
.balance-line { margin: 0; }
.balance-line strong { font-size: 1.15rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: var(--fg-2, #555); }
.in { padding: .4rem .6rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg, #222); }
.check { display: inline-flex; align-items: center; gap: .5rem; cursor: pointer; color: var(--fg, #222); }
.coming-soon { margin: 0; padding: .6rem .85rem; border-radius: .5rem; background: var(--accent-soft, #eef); color: var(--accent, #3b6); font-weight: 600; font-size: .9rem; }
.wtable { width: 100%; border-collapse: collapse; font-size: .88rem; }
.wtable th, .wtable td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--border, #eee); }
.wtable th { color: var(--muted, #777); font-weight: 600; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
.pill { padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; text-transform: capitalize; background: var(--bg-2, #eee); color: var(--fg-2, #555); }
.pill.paid { background: var(--accent-soft, #dfe); color: var(--green, #2a7); }
.pill.failed { background: var(--amber-dim, #fee); color: var(--danger, #c33); }
</style>
