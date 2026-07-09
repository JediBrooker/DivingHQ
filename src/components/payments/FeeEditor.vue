<script setup>
// Reusable fee-config editor. Drives both event entry fees and the
// federation membership fee, just pass a load URL (full-config GET) and
// a save URL (PUT). Amounts are entered in major units and sent as
// tax-inclusive minor units. The backend stores variants, and the
// cheapest one a buyer's eligible for at checkout time wins.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({
  loadUrl: { type: String, required: true },
  saveUrl: { type: String, required: true },
  title: { type: String, default: 'Fee' },
  showMembershipPeriod: { type: Boolean, default: false },
  // Extra fields merged into the PUT body, so wrappers can send the fee's
  // identity qualifiers, e.g. { tier: 'junior' } or { discipline: '3m' }.
  extraPayload: { type: Object, default: () => ({}) },
  // Flat mode: one amount, audience 'all', no time windows. Used for
  // late-entry surcharges where timing comes from a trigger, not from
  // audience tiers / price windows (those would silently suppress them).
  flat: { type: Boolean, default: false },
})
const emit = defineEmits(['saved'])
const auth = useAuthStore()
const { t } = useI18n()

const loading = ref(true)
const busy = ref(false)
const comingSoon = ref(false)
const currency = ref('GBP')
const feePayer = ref('absorb')
const refundPolicy = ref('full')
const membershipPeriod = ref('annual')
const prices = ref([])

const AUDIENCES = computed(() => [
  { value: 'all', label: t('payments.fee_editor.opt_everyone') },
  { value: 'member', label: t('payments.fee_editor.opt_members_only') },
  { value: 'non_member', label: t('payments.fee_editor.opt_non_members_only') },
])

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
    if (props.flat) prices.value = prices.value.slice(0, 1)
  } catch (e) {
    showError(e.message || t('payments.fee_editor.error_load'))
  } finally {
    loading.value = false
  }
}

async function save() {
  if (comingSoon.value) return
  // Blank rows are dropped, not saved as 0.00. A silently-parsed £0 variant
  // would win "cheapest applicable price" for every buyer, so watch out.
  // Server also refuses amounts under 1.00 (free = no fee configured at all).
  const usable = (props.flat ? prices.value.slice(0, 1) : prices.value)
    .filter(p => String(p.amount ?? '').trim() !== '')
  if (!usable.length) {
    showError(t('payments.fee_editor.error_min_price'))
    return
  }
  if (usable.some(p => !(parseFloat(p.amount) >= 1))) {
    showError(t('payments.fee_editor.error_min_amount'))
    return
  }
  busy.value = true
  try {
    const payload = {
      ...props.extraPayload,
      currency: currency.value.toUpperCase(),
      fee_payer: feePayer.value,
      refund_policy: refundPolicy.value,
      ...(props.showMembershipPeriod ? { membership_period: membershipPeriod.value } : {}),
      prices: usable.map(p => ({
        label: p.label || 'standard',
        amount_cents: Math.round(parseFloat(p.amount) * 100),
        audience: props.flat ? 'all' : p.audience,
        starts_at: props.flat ? null : (p.starts_at || null),
        ends_at: props.flat ? null : (p.ends_at || null),
      })),
    }
    await auth.apiFetch(props.saveUrl, { method: 'PUT', body: JSON.stringify(payload) })
    showSuccess(t('payments.fee_editor.success_saved', { title: props.title }))
    emit('saved')
  } catch (e) {
    showError(e.message || t('payments.fee_editor.error_save'))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <form class="fee-editor" @submit.prevent="save">
    <p v-if="loading" class="muted">{{ t('payments.fee_editor.loading') }}</p>
    <template v-else>
      <ComingSoonBanner v-if="comingSoon" :message="t('payments.fee_editor.coming_soon_preview')" />
      <div class="row">
        <label>{{ t('payments.fee_editor.label_currency') }}
          <input v-model="currency" maxlength="3" class="cur" />
        </label>
        <label>{{ t('payments.fee_editor.label_fee_payer') }}
          <select v-model="feePayer">
            <option value="absorb">{{ t('payments.fee_editor.opt_absorb') }}</option>
            <option value="pass_to_payer">{{ t('payments.fee_editor.opt_pass_to_payer') }}</option>
          </select>
        </label>
        <label>{{ t('payments.fee_editor.label_refunds') }}
          <select v-model="refundPolicy">
            <option value="full">{{ t('payments.fee_editor.opt_refundable') }}</option>
            <option value="none">{{ t('payments.fee_editor.opt_non_refundable') }}</option>
            <option value="deadline">{{ t('payments.fee_editor.opt_refundable_deadline') }}</option>
          </select>
        </label>
        <label v-if="showMembershipPeriod">{{ t('payments.fee_editor.label_period') }}
          <select v-model="membershipPeriod">
            <option value="annual">{{ t('payments.fee_editor.opt_annual') }}</option>
            <option value="seasonal">{{ t('payments.fee_editor.opt_seasonal') }}</option>
          </select>
        </label>
      </div>

      <table class="prices">
        <thead>
          <tr>
            <th>{{ t('payments.fee_editor.th_label') }}</th><th>{{ t('payments.fee_editor.th_amount') }}</th>
            <th v-if="!flat">{{ t('payments.fee_editor.th_who') }}</th><th v-if="!flat">{{ t('payments.fee_editor.th_from') }}</th><th v-if="!flat">{{ t('payments.fee_editor.th_until') }}</th><th v-if="!flat"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in prices" :key="i">
            <td><input v-model="p.label" :placeholder="t('payments.fee_editor.placeholder_label')" /></td>
            <td><input v-model="p.amount" type="number" min="1" step="0.01" placeholder="10.00" /></td>
            <td v-if="!flat">
              <select v-model="p.audience">
                <option v-for="a in AUDIENCES" :key="a.value" :value="a.value">{{ a.label }}</option>
              </select>
            </td>
            <td v-if="!flat"><input v-model="p.starts_at" type="date" /></td>
            <td v-if="!flat"><input v-model="p.ends_at" type="date" /></td>
            <td v-if="!flat">
              <button type="button" class="link" :disabled="prices.length === 1" @click="removePrice(i)">{{ t('payments.fee_editor.btn_remove') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <button v-if="!flat" type="button" class="link" @click="addPrice">{{ t('payments.fee_editor.btn_add_variant') }}</button>

      <div class="actions">
        <button type="submit" class="btn" :disabled="busy || comingSoon">{{ busy ? t('payments.fee_editor.btn_saving') : (comingSoon ? t('payments.fee_editor.btn_coming_soon') : t('payments.fee_editor.btn_save')) }}</button>
      </div>
      <p class="hint">
        <template v-if="flat">{{ t('payments.fee_editor.hint_flat') }}</template>
        <template v-else>{{ t('payments.fee_editor.hint_variants') }}</template>
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
.muted { color: var(--muted, #777); }
.coming-soon { margin: 0; padding: .5rem .75rem; border-radius: .5rem; background: var(--accent-soft, #eef); color: var(--accent, #3b6); font-weight: 600; font-size: .85rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
</style>
