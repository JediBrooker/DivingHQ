<script setup>
// Club admin: payout bank details, balance, automatic-withdrawal settings,
// and withdrawal history for THIS club's class-enrolment revenue. Talks to
// /api/clubs/:clubId/payments/status|payout-details|withdrawal-settings|
// withdrawals — all club-private (requireClubAdminOnly on the server).
// DivingHQ keeps its 15% platform fee; the rest is owed to the club, not
// the federation.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'

const props = defineProps({ clubId: { type: String, required: true } })
const auth = useAuthStore()
const { t, locale } = useI18n()

const loading = ref(true)
const status = ref(null)
const savingPayout = ref(false)
const savingAuto = ref(false)
const withdrawing = ref(false)
const payoutForm = ref({ account_name: '', account_details: '' })
const autoForm = ref({ enabled: false, threshold: '' })
const withdrawals = ref([])

const comingSoon = computed(() => status.value && status.value.enabled === false)
const balances = computed(() => (status.value && status.value.balances) || [])
const hasBalance = computed(() => balances.value.length > 0)
const payoutSet = computed(() => !!(status.value && status.value.payout_details_set))
const autoThresholdOk = computed(() => Number(autoForm.value.threshold) >= 1)

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}
const balanceLabel = computed(() =>
  balances.value.length ? balances.value.map((b) => money(b.cents, b.currency)).join('  +  ') : money(0),
)

function fmtDate(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleDateString(locale.value, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return String(ts).slice(0, 10)
  }
}

async function loadStatus() {
  loading.value = true
  try {
    status.value = await auth.apiFetch(`/api/clubs/${props.clubId}/payments/status`)
    payoutForm.value.account_name = status.value.account_name || ''
    autoForm.value.enabled = !!status.value.auto_withdraw_enabled
    autoForm.value.threshold = status.value.auto_withdraw_min_cents != null
      ? (status.value.auto_withdraw_min_cents / 100).toString() : ''
  } catch (e) {
    showError(e.message || t('classes.payouts.error_load'))
  } finally {
    loading.value = false
  }
}

async function loadWithdrawals() {
  try {
    withdrawals.value = await auth.apiFetch(`/api/clubs/${props.clubId}/withdrawals`)
  } catch {
    withdrawals.value = []
  }
}

async function savePayout() {
  savingPayout.value = true
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/payout-details`, { method: 'PUT', body: JSON.stringify(payoutForm.value) })
    showSuccess(t('classes.payouts.saved'))
    payoutForm.value.account_details = ''
    await loadStatus()
  } catch (e) {
    showError(e.message || t('classes.payouts.error_save'))
  } finally {
    savingPayout.value = false
  }
}

async function saveAuto() {
  savingAuto.value = true
  try {
    const body = { auto_withdraw_enabled: autoForm.value.enabled }
    if (autoForm.value.enabled) body.auto_withdraw_min_cents = Math.round(Number(autoForm.value.threshold) * 100)
    await auth.apiFetch(`/api/clubs/${props.clubId}/withdrawal-settings`, { method: 'PUT', body: JSON.stringify(body) })
    showSuccess(t('classes.payouts.saved'))
    await loadStatus()
  } catch (e) {
    showError(e.message || t('classes.payouts.error_save'))
  } finally {
    savingAuto.value = false
  }
}

async function requestWithdrawal() {
  withdrawing.value = true
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/withdrawals`, { method: 'POST', body: JSON.stringify({}) })
    showSuccess(t('classes.payouts.withdrawal_requested'))
    await Promise.all([loadStatus(), loadWithdrawals()])
  } catch (e) {
    showError(e.message || t('classes.payouts.error_withdraw'))
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
  <div class="cpp">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <template v-else>
      <p v-if="comingSoon" class="coming-soon">{{ t('classes.payouts.dormant_note') }}</p>

      <div class="card">
        <h2>{{ t('classes.payouts.account_details') }}</h2>
        <p class="muted">{{ t('classes.payouts.account_details_hint') }}</p>
        <p v-if="payoutSet" class="ok">{{ t('classes.payouts.details_on_file', { name: status.account_name || '' }) }}</p>
        <p v-else class="warn">{{ t('classes.payouts.details_missing') }}</p>
        <div class="field">
          <label>{{ t('classes.payouts.field_account_name') }}</label>
          <input class="in" v-model="payoutForm.account_name" />
        </div>
        <div class="field">
          <label>{{ t('classes.payouts.field_account_details') }}</label>
          <input class="in" v-model="payoutForm.account_details" placeholder="GB00 XXXX 0000 0000 0000 00" />
        </div>
        <button class="btn" :disabled="savingPayout || !payoutForm.account_name || !payoutForm.account_details" @click="savePayout">
          {{ savingPayout ? t('common.saving') : t('common.save') }}
        </button>
      </div>

      <div class="card">
        <h2>{{ t('classes.payouts.balance') }}</h2>
        <p class="balance-line">{{ t('classes.payouts.balance_owed') }}: <strong>{{ comingSoon ? '—' : balanceLabel }}</strong></p>
        <button v-if="!comingSoon" class="btn" :disabled="withdrawing || !hasBalance || !payoutSet" @click="requestWithdrawal">
          {{ withdrawing ? t('common.saving') : t('classes.payouts.withdraw_now') }}
        </button>
        <p v-if="!comingSoon && !payoutSet" class="warn small">{{ t('classes.payouts.details_missing') }}</p>
      </div>

      <div class="card">
        <h2>{{ t('classes.payouts.auto_withdraw') }}</h2>
        <p class="muted">{{ t('classes.payouts.auto_withdraw_hint') }}</p>
        <label class="check"><input type="checkbox" v-model="autoForm.enabled" /><span>{{ t('classes.payouts.auto_withdraw_enable') }}</span></label>
        <div class="field" v-if="autoForm.enabled">
          <label>{{ t('classes.payouts.field_threshold') }}</label>
          <input class="in" type="number" min="1" step="0.01" v-model="autoForm.threshold" />
          <p v-if="!autoThresholdOk" class="warn small">{{ t('classes.payouts.threshold_invalid') }}</p>
        </div>
        <button class="btn" :disabled="savingAuto || (autoForm.enabled && !autoThresholdOk)" @click="saveAuto">
          {{ savingAuto ? t('common.saving') : t('common.save') }}
        </button>
      </div>

      <div class="card">
        <h2>{{ t('classes.payouts.history') }}</h2>
        <p v-if="!withdrawals.length" class="muted">{{ t('classes.payouts.history_empty') }}</p>
        <table v-else class="wtable">
          <thead><tr><th>{{ t('classes.col_date') }}</th><th>{{ t('classes.col_amount') }}</th><th>{{ t('classes.col_status') }}</th></tr></thead>
          <tbody>
            <tr v-for="w in withdrawals" :key="w.id">
              <td>{{ fmtDate(w.created_at) }}</td>
              <td>{{ money(w.amount_cents, w.currency) }}</td>
              <td><span class="pill" :class="w.status">{{ w.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cpp { display: flex; flex-direction: column; gap: 1rem; }
.card { border: 1px solid var(--border, #ddd); border-radius: var(--radius-lg, .75rem); padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .6rem; }
.card h2 { margin: 0; font-size: 1.02rem; }
.muted { color: var(--muted, #777); margin: 0; }
.muted.small, .small { font-size: .82rem; }
.ok { color: var(--green, #2a7); margin: 0; }
.warn { color: var(--amber, #b70); margin: 0; }
.warn.small { font-size: .82rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: var(--fg-2, #555); }
.in { padding: .4rem .6rem; border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem); background: transparent; color: var(--fg, #222); font: inherit; }
.check { display: inline-flex; align-items: center; gap: .5rem; cursor: pointer; color: var(--fg, #222); }
.btn { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: var(--radius, .5rem); background: var(--accent, #3b6); color: #fff; cursor: pointer; font: inherit; }
.btn:disabled { opacity: .55; cursor: default; }
.balance-line { margin: 0; }
.balance-line strong { font-size: 1.1rem; }
.coming-soon { margin: 0; padding: .6rem .85rem; border-radius: var(--radius, .5rem); background: var(--accent-soft, #eef); color: var(--accent, #3b6); font-weight: 600; font-size: .9rem; }
.wtable { width: 100%; border-collapse: collapse; font-size: .88rem; }
.wtable th, .wtable td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--border, #eee); }
.wtable th { color: var(--muted, #777); font-weight: 600; font-size: .74rem; text-transform: uppercase; }
.pill { padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; text-transform: capitalize; background: var(--bg-2, #eee); color: var(--fg-2, #555); }
.pill.paid { background: var(--accent-soft, #dfe); color: var(--green, #2a7); }
</style>
