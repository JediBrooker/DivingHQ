<script setup>
// Reusable fee-config editor. Drives both event entry fees and the
// federation membership fee — pass a load URL (full-config GET) and a
// save URL (PUT). Amounts are entered in major units and sent as
// tax-inclusive minor units. The backend stores variants; the cheapest
// one a buyer is eligible for at checkout time wins.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  loadUrl: { type: String, required: true },
  saveUrl: { type: String, required: true },
  title: { type: String, default: 'Fee' },
  showMembershipPeriod: { type: Boolean, default: false },
})
const emit = defineEmits(['saved'])
const auth = useAuthStore()

const loading = ref(true)
const busy = ref(false)
const comingSoon = ref(false)
const currency = ref('GBP')
const feePayer = ref('absorb')
const refundPolicy = ref('full')
const membershipPeriod = ref('annual')
const prices = ref([])

const AUDIENCES = [
  { value: 'all', label: 'Everyone' },
  { value: 'member', label: 'Members only' },
  { value: 'non_member', label: 'Non-members only' },
]

function blankPrice() {
  return { label: 'standard', amount: '', audience: 'all', starts_at: '', ends_at: '' }
}
function addPrice() { prices.value.push(blankPrice()) }
function removePrice(i) { prices.value.splice(i, 1) }

async function load() {
  loading.value = true
  try {
    const r = await auth.apiFetch(props.loadUrl)
    comingSoon.value = r.payments_enabled === false
    const fee = r.fee
    if (fee) {
      currency.value = fee.currency || 'GBP'
      feePayer.value = fee.fee_payer || 'absorb'
      refundPolicy.value = fee.refund_policy || 'full'
      membershipPeriod.value = fee.membership_period || 'annual'
      prices.value = (fee.prices || []).map(p => ({
        label: p.label,
        amount: (p.amount_cents / 100).toString(),
        audience: p.audience,
        starts_at: p.starts_at ? p.starts_at.slice(0, 10) : '',
        ends_at: p.ends_at ? p.ends_at.slice(0, 10) : '',
      }))
    }
    if (!prices.value.length) prices.value = [blankPrice()]
  } catch (e) {
    showError(e.message || 'Could not load the fee')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (comingSoon.value) return
  busy.value = true
  try {
    const payload = {
      currency: currency.value.toUpperCase(),
      fee_payer: feePayer.value,
      refund_policy: refundPolicy.value,
      ...(props.showMembershipPeriod ? { membership_period: membershipPeriod.value } : {}),
      prices: prices.value.map(p => ({
        label: p.label || 'standard',
        amount_cents: Math.round(parseFloat(p.amount || '0') * 100),
        audience: p.audience,
        starts_at: p.starts_at || null,
        ends_at: p.ends_at || null,
      })),
    }
    await auth.apiFetch(props.saveUrl, { method: 'PUT', body: JSON.stringify(payload) })
    showSuccess(`${props.title} saved`)
    emit('saved')
  } catch (e) {
    showError(e.message || 'Could not save the fee')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <form class="fee-editor" @submit.prevent="save">
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <p v-if="comingSoon" class="coming-soon">🚧 Coming soon — preview the setup here; it goes live once online payments are switched on.</p>
      <div class="row">
        <label>Currency
          <input v-model="currency" maxlength="3" class="cur" />
        </label>
        <label>Who pays the fees
          <select v-model="feePayer">
            <option value="absorb">Federation absorbs (one price)</option>
            <option value="pass_to_payer">Add DivingHQ's fee on top</option>
          </select>
        </label>
        <label>Refunds
          <select v-model="refundPolicy">
            <option value="full">Refundable</option>
            <option value="none">Non-refundable</option>
            <option value="deadline">Refundable until a deadline</option>
          </select>
        </label>
        <label v-if="showMembershipPeriod">Period
          <select v-model="membershipPeriod">
            <option value="annual">Annual</option>
            <option value="seasonal">Seasonal</option>
          </select>
        </label>
      </div>

      <table class="prices">
        <thead>
          <tr><th>Label</th><th>Amount</th><th>Who</th><th>From</th><th>Until</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in prices" :key="i">
            <td><input v-model="p.label" placeholder="standard" /></td>
            <td><input v-model="p.amount" type="number" min="0" step="0.01" placeholder="0.00" /></td>
            <td>
              <select v-model="p.audience">
                <option v-for="a in AUDIENCES" :key="a.value" :value="a.value">{{ a.label }}</option>
              </select>
            </td>
            <td><input v-model="p.starts_at" type="date" /></td>
            <td><input v-model="p.ends_at" type="date" /></td>
            <td>
              <button type="button" class="link" :disabled="prices.length === 1" @click="removePrice(i)">Remove</button>
            </td>
          </tr>
        </tbody>
      </table>
      <button type="button" class="link" @click="addPrice">+ Add a price variant</button>

      <div class="actions">
        <button type="submit" class="btn" :disabled="busy || comingSoon">{{ busy ? 'Saving…' : (comingSoon ? 'Coming soon' : 'Save') }}</button>
      </div>
      <p class="hint">
        Amounts are tax-inclusive. At checkout the cheapest variant the buyer is
        eligible for applies; a “Members only” variant needs an active membership.
      </p>
    </template>
  </form>
</template>

<style scoped>
.fee-editor { display: flex; flex-direction: column; gap: .75rem; }
.row { display: flex; flex-wrap: wrap; gap: 1rem; }
.row label { display: flex; flex-direction: column; font-size: .85rem; gap: .25rem; }
.cur { width: 4rem; text-transform: uppercase; }
.prices { width: 100%; border-collapse: collapse; }
.prices th, .prices td { text-align: left; padding: .25rem .4rem; }
.prices input, .prices select, .row select, .row input { padding: .3rem; }
.btn { padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .6; }
.link { background: none; border: 0; color: var(--accent, #3b6); cursor: pointer; padding: .2rem; }
.link:disabled { opacity: .5; cursor: default; }
.muted { color: var(--text-muted, #777); }
.coming-soon { margin: 0; padding: .5rem .75rem; border-radius: .5rem; background: var(--accent-soft, #eef); color: var(--accent, #3b6); font-weight: 600; font-size: .85rem; }
.hint { font-size: .8rem; color: var(--text-muted, #777); margin: 0; }
</style>
