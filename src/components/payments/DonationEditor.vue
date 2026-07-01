<script setup>
// Federation editor for fundraising donations: a currency + a set of suggested
// preset amounts supporters can pick from (they can also enter a custom
// amount). Backed by /api/orgs/:orgId/donation. Amounts are entered in major
// units and stored as minor units.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({ orgId: { type: String, required: true } })
const auth = useAuthStore()

const currency = ref('GBP')
const presets = ref([])          // array of major-unit strings
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)

function addPreset() { presets.value.push('') }
function removePreset(i) { presets.value.splice(i, 1) }

async function load() {
  loading.value = true
  try {
    const r = await auth.apiFetch(`/api/orgs/${props.orgId}/donation`)
    enabled.value = r.payments_enabled !== false
    if (r.donation) {
      currency.value = r.donation.currency || 'GBP'
      presets.value = (r.donation.suggested_amounts || []).map(c => (c / 100).toString())
    }
    if (!presets.value.length) presets.value = ['']
  } catch (e) {
    showError(e.message || 'Could not load donation settings')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!enabled.value) return
  busy.value = true
  try {
    const suggested = presets.value
      .map(p => Math.round(parseFloat(p || '0') * 100))
      .filter(c => Number.isInteger(c) && c >= 100)
    await auth.apiFetch(`/api/orgs/${props.orgId}/donation`, {
      method: 'PUT',
      body: JSON.stringify({ currency: currency.value.toUpperCase(), suggested_amounts: suggested }),
    })
    showSuccess('Donation settings saved')
  } catch (e) {
    showError(e.message || 'Could not save donation settings')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="donation-editor">
    <p class="hint">Accept fundraising donations. Set suggested amounts supporters can pick from — they can also enter their own.</p>
    <ComingSoonBanner v-if="!enabled" message="Preview the setup here; donations go live once online payments are switched on." />
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <div class="row">
        <label>Currency
          <input v-model="currency" maxlength="3" class="cur" :disabled="!enabled" />
        </label>
      </div>
      <div class="presets">
        <span class="presets-label">Suggested amounts</span>
        <div v-for="(p, i) in presets" :key="i" class="preset">
          <span class="cur-sym">{{ currency }}</span>
          <input v-model="presets[i]" type="number" min="1" step="0.01" placeholder="0.00" :disabled="!enabled" />
          <button type="button" class="link" :disabled="presets.length === 1" @click="removePreset(i)">Remove</button>
        </div>
        <button type="button" class="link" :disabled="!enabled" @click="addPreset">+ Add an amount</button>
      </div>
      <button type="button" class="btn" :disabled="busy || !enabled" @click="save">{{ busy ? 'Saving…' : 'Save donation settings' }}</button>
    </template>
  </div>
</template>

<style scoped>
.donation-editor { display: flex; flex-direction: column; gap: .6rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.muted { color: var(--muted, #777); font-size: .85rem; }
.row label { display: flex; flex-direction: column; font-size: .85rem; gap: .25rem; }
.cur { width: 4rem; text-transform: uppercase; padding: .3rem; }
.presets { display: flex; flex-direction: column; gap: .35rem; }
.presets-label { font-size: .85rem; color: var(--fg-2, #555); }
.preset { display: flex; align-items: center; gap: .4rem; }
.cur-sym { color: var(--muted, #777); font-size: .85rem; }
.preset input { padding: .3rem; width: 7rem; }
.btn { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .6; cursor: default; }
.link { background: none; border: 0; color: var(--accent, #3b6); cursor: pointer; padding: .2rem; }
.link:disabled { opacity: .5; cursor: default; }
</style>
