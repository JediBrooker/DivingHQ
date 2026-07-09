<script setup>
// Dedicated Payments section for a federation (org_admin). Tabs:
//   Overview        : at-a-glance balance / payout / auto-withdraw + how it works
//   Account details : Stripe payout onboarding (where we send your money)
//   Withdrawals     : balance, withdraw now, automatic withdrawals, history
//   Fees & pricing  : membership / club / accreditation / donation editors
// DivingHQ is the merchant of record, it collects, keeps 15%, and pays out
// the rest, transferring to each recipient's Stripe-connected bank account.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { showError, showSuccess } from '@/composables/useNotify'
import MembershipFeeEditor from '@/components/payments/MembershipFeeEditor.vue'
import ClubFeesEditor from '@/components/payments/ClubFeesEditor.vue'
import OfficialFeesEditor from '@/components/payments/OfficialFeesEditor.vue'
import DonationEditor from '@/components/payments/DonationEditor.vue'

const auth = useAuthStore()
const { t } = useI18n()
const orgId = computed(() => auth.user?.org_id)

const isSysAdmin = computed(() => !!auth.user?.is_system_admin)
const TABS = computed(() => [
  { key: 'overview', label: t('payments.admin.tab_overview') },
  { key: 'account', label: t('payments.admin.tab_account') },
  { key: 'withdrawals', label: t('payments.admin.tab_withdrawals') },
  { key: 'fees', label: t('payments.admin.tab_fees') },
  // Platform operator only, the fulfilment queue for EVERY org/club payout.
  ...(isSysAdmin.value ? [{ key: 'queue', label: t('payments.admin.tab_queue') }] : []),
])
const tab = ref('overview')

const status = ref(null)
const loading = ref(true)
const onboarding = ref(false)
const savingAuto = ref(false)
const withdrawing = ref(false)
const autoForm = ref({ enabled: false, threshold: '' })
const withdrawals = ref([])

const comingSoon = computed(() => status.value && status.value.enabled === false)
const currency = computed(() => (status.value && status.value.currency) || 'GBP')
const balances = computed(() => (status.value && status.value.balances) || [])
const hasBalance = computed(() => balances.value.length > 0)
const balanceLabel = computed(() =>
  balances.value.length ? balances.value.map((b) => money(b.cents, b.currency)).join('  +  ') : money(0),
)
const connected = computed(() => !!(status.value && status.value.connected))
const payoutsReady = computed(() => !!(status.value && status.value.payouts_ready))
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
    autoForm.value.enabled = !!status.value.auto_withdraw_enabled
    autoForm.value.threshold = status.value.auto_withdraw_min_cents != null
      ? (status.value.auto_withdraw_min_cents / 100).toString()
      : ''
  } catch (e) {
    showError(e.message || t('payments.admin.error_load_status'))
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

async function startOnboarding() {
  onboarding.value = true
  try {
    const { url } = await auth.apiFetch(`/api/orgs/${orgId.value}/connect/onboard`, { method: 'POST', body: JSON.stringify({}) })
    window.location.href = url // hand off to Stripe-hosted onboarding
  } catch (e) {
    showError(e.message || t('payments.admin.error_start_onboarding'))
    onboarding.value = false
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
    showSuccess(t('payments.admin.success_auto_saved'))
    await loadStatus()
  } catch (e) {
    showError(e.message || t('payments.admin.error_save_auto'))
  } finally {
    savingAuto.value = false
  }
}

async function requestWithdrawal() {
  withdrawing.value = true
  try {
    const settled = await auth.apiFetch(`/api/orgs/${orgId.value}/withdrawals`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const anyFailed = Array.isArray(settled) && settled.some((p) => p.status === 'failed')
    if (anyFailed) showError(t('payments.admin.error_transfer_failed'))
    else showSuccess(t('payments.admin.success_withdrawal_sent'))
    await Promise.all([loadStatus(), loadWithdrawals()])
  } catch (e) {
    showError(e.message || t('payments.admin.error_request_withdrawal'))
  } finally {
    withdrawing.value = false
  }
}

// ---- payout monitoring (platform operator / sysadmin) -------------
// Read-only: transfers auto-settle, so there's no manual action here,
// this is just the operator's window onto the flow (paid / failed).
const queue = ref([])
const queueLoading = ref(false)
const queueStatus = ref('paid')

async function loadQueue() {
  if (!isSysAdmin.value) return
  queueLoading.value = true
  try {
    const r = await auth.apiFetch(`/api/admin/payouts?status=${queueStatus.value}`)
    queue.value = r.payouts || []
  } catch (e) {
    showError(e.message || t('payments.admin.error_load_queue'))
  } finally {
    queueLoading.value = false
  }
}

onMounted(async () => {
  await loadStatus()
  await loadWithdrawals()
  await loadQueue()
})
</script>

<template>
  <section class="payments-admin">
    <header class="ph-head">
      <h1>{{ t('payments.admin.title') }}</h1>
      <p class="muted">{{ t('payments.admin.subtitle') }}</p>
    </header>

    <p v-if="comingSoon" class="coming-soon">{{ t('payments.admin.coming_soon') }}</p>

    <nav class="tabs">
      <button v-for="tt in TABS" :key="tt.key" type="button" :class="['tab', { active: tab === tt.key }]" @click="tab = tt.key">{{ tt.label }}</button>
    </nav>

    <p v-if="loading" class="muted">{{ t('payments.admin.loading') }}</p>

    <template v-else>
      <!-- OVERVIEW -->
      <div v-show="tab === 'overview'" class="panel">
        <div class="grid">
          <div class="stat">
            <span class="stat-label">{{ t('payments.admin.stat_balance_owed') }}</span>
            <span class="stat-value">{{ comingSoon ? '—' : balanceLabel }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{{ t('payments.admin.stat_payouts') }}</span>
            <span class="stat-value" :class="payoutsReady ? 'ok' : 'warn'">{{ payoutsReady ? t('payments.admin.stat_payouts_ready') : t('payments.admin.stat_payouts_not_set_up') }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">{{ t('payments.admin.stat_auto_withdrawals') }}</span>
            <span class="stat-value">{{ status && status.auto_withdraw_enabled ? t('payments.admin.stat_auto_on', { amount: money(status.auto_withdraw_min_cents) }) : t('payments.admin.stat_auto_off') }}</span>
          </div>
        </div>
        <div class="card">
          <h2>{{ t('payments.admin.section_how_it_works') }}</h2>
          <ol class="how-list">
            <li>{{ t('payments.admin.how_step_1_pre') }} <button type="button" class="link" @click="tab = 'account'">{{ t('payments.admin.tab_account') }}</button> {{ t('payments.admin.how_step_1_post') }}</li>
            <li>{{ t('payments.admin.how_step_2_pre') }} <button type="button" class="link" @click="tab = 'fees'">{{ t('payments.admin.tab_fees') }}</button> {{ t('payments.admin.how_step_2_post') }}</li>
            <li>{{ t('payments.admin.how_step_3') }}</li>
            <li>{{ t('payments.admin.how_step_4') }}</li>
          </ol>
        </div>
      </div>

      <!-- ACCOUNT DETAILS -->
      <div v-show="tab === 'account'" class="panel">
        <div class="card">
          <h2>{{ t('payments.admin.section_payout_setup') }}</h2>
          <p class="muted">{{ t('payments.admin.payout_setup_desc') }}</p>
          <p v-if="payoutsReady" class="ok">{{ t('payments.admin.payout_ready') }}</p>
          <p v-else-if="connected" class="warn">{{ t('payments.admin.payout_incomplete') }}</p>
          <p v-else class="warn">{{ t('payments.admin.payout_not_connected') }}</p>
          <button v-if="!comingSoon && !payoutsReady" class="btn" :disabled="onboarding" @click="startOnboarding">
            {{ onboarding ? t('payments.admin.btn_opening_stripe') : (connected ? t('payments.admin.btn_finish_payout_setup') : t('payments.admin.btn_set_up_payouts')) }}
          </button>
          <p v-if="comingSoon" class="muted small">{{ t('payments.admin.payout_setup_coming_soon') }}</p>
        </div>
      </div>

      <!-- WITHDRAWALS -->
      <div v-show="tab === 'withdrawals'" class="panel">
        <div class="card">
          <h2>{{ t('payments.admin.section_balance_withdrawals') }}</h2>
          <p class="balance-line">{{ t('payments.admin.balance_owed_label') }} <strong>{{ comingSoon ? '—' : balanceLabel }}</strong></p>
          <p v-if="comingSoon" class="muted">{{ t('payments.admin.withdrawals_coming_soon') }}</p>
          <template v-else>
            <p class="muted">{{ t('payments.admin.withdraw_desc') }}</p>
            <button class="btn" :disabled="withdrawing || !hasBalance || !payoutsReady" @click="requestWithdrawal">
              {{ withdrawing ? t('payments.admin.btn_sending') : t('payments.admin.btn_withdraw_now') }}
            </button>
            <p v-if="!payoutsReady" class="warn small">{{ t('payments.admin.warn_setup_payouts_first') }}</p>
          </template>
        </div>

        <div class="card">
          <h2>{{ t('payments.admin.section_auto_withdrawals') }}</h2>
          <p class="muted">{{ t('payments.admin.auto_desc') }}</p>
          <label class="check">
            <input type="checkbox" v-model="autoForm.enabled" />
            <span>{{ t('payments.admin.auto_checkbox_label') }}</span>
          </label>
          <div class="field" v-if="autoForm.enabled">
            <label>{{ t('payments.admin.auto_threshold_label', { currency }) }}</label>
            <input class="in" type="number" min="1" step="0.01" v-model="autoForm.threshold" :placeholder="t('payments.admin.auto_threshold_placeholder')" />
            <p v-if="!autoThresholdOk" class="warn small">{{ t('payments.admin.auto_threshold_warn') }}</p>
          </div>
          <button class="btn" :disabled="savingAuto || (autoForm.enabled && !autoThresholdOk)" @click="saveAuto">
            {{ savingAuto ? t('payments.admin.btn_saving') : t('payments.admin.btn_save_auto') }}
          </button>
        </div>

        <div class="card">
          <h2>{{ t('payments.admin.section_withdrawal_history') }}</h2>
          <p v-if="!withdrawals.length" class="muted">{{ t('payments.admin.no_withdrawals') }}</p>
          <table v-else class="wtable">
            <thead><tr><th>{{ t('payments.admin.th_date') }}</th><th>{{ t('payments.admin.th_amount') }}</th><th>{{ t('payments.admin.th_status') }}</th><th>{{ t('payments.admin.th_note') }}</th></tr></thead>
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

      <!-- PAYOUT MONITORING (sysadmin) -->
      <div v-if="isSysAdmin" v-show="tab === 'queue'" class="panel">
        <div class="card">
          <div class="queue-head">
            <h2>{{ t('payments.admin.section_payout_queue') }}</h2>
            <select class="in queue-filter" v-model="queueStatus" @change="loadQueue">
              <option value="paid">{{ t('payments.admin.filter_paid') }}</option>
              <option value="failed">{{ t('payments.admin.filter_failed') }}</option>
              <option value="pending">{{ t('payments.admin.filter_pending') }}</option>
            </select>
          </div>
          <p class="muted">{{ t('payments.admin.queue_desc_pre') }} <strong>{{ t('payments.admin.queue_desc_failed') }}</strong> {{ t('payments.admin.queue_desc_post') }}</p>
          <p v-if="queueLoading" class="muted">{{ t('payments.admin.loading') }}</p>
          <p v-else-if="!queue.length" class="muted">{{ t('payments.admin.no_payouts', { status: queueStatus }) }}</p>
          <div v-else class="queue-scroll">
            <table class="wtable">
              <thead><tr><th>{{ t('payments.admin.th_date') }}</th><th>{{ t('payments.admin.th_recipient') }}</th><th>{{ t('payments.admin.th_amount') }}</th><th>{{ t('payments.admin.th_status') }}</th><th>{{ t('payments.admin.th_stripe_transfer') }}</th><th>{{ t('payments.admin.th_note') }}</th></tr></thead>
              <tbody>
                <tr v-for="p in queue" :key="p.id">
                  <td>{{ fmtDate(p.created_at) }}</td>
                  <td>{{ p.recipient_name }} <span class="pill">{{ p.recipient_type }}</span></td>
                  <td><strong>{{ money(p.amount_cents, p.currency) }}</strong></td>
                  <td><span :class="['pill', p.status]">{{ p.status }}</span></td>
                  <td class="muted small mono">{{ p.stripe_transfer_id || '—' }}</td>
                  <td>{{ p.note || '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- FEES & PRICING -->
      <div v-show="tab === 'fees'" class="panel">
        <div class="card">
          <h2>{{ t('payments.admin.section_membership_fee') }}</h2>
          <p class="muted">{{ t('payments.admin.membership_fee_desc') }}</p>
          <MembershipFeeEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>{{ t('payments.admin.section_club_fees') }}</h2>
          <p class="muted">{{ t('payments.admin.club_fees_desc') }}</p>
          <ClubFeesEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>{{ t('payments.admin.section_accreditation_fees') }}</h2>
          <p class="muted">{{ t('payments.admin.accreditation_fees_desc') }}</p>
          <OfficialFeesEditor v-if="orgId" :org-id="orgId" />
        </div>
        <div class="card">
          <h2>{{ t('payments.admin.section_donations') }}</h2>
          <p class="muted">{{ t('payments.admin.donations_desc') }}</p>
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
.queue-scroll { overflow-x: auto; }
.bank .small { font-size: .78rem; }
.queue-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
.queue-filter { width: auto; padding: .3rem .5rem; }
.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
.btn.sm { padding: .3rem .7rem; font-size: .8rem; }
.btn.ghost-danger { background: transparent; border: 1px solid var(--danger, #c33); color: var(--danger, #c33); }
</style>
