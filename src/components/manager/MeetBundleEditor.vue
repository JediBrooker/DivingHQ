<script setup>
// Manager editor for a meet's discounted bundle: pick which of the meet's
// events the bundle covers + set one flat price. Backed by
// /api/meets/:id/bundle(/config). On purchase the server expands the bundle
// into a paid entry for each selected event.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({ meetId: { type: String, required: true } })
const auth = useAuthStore()

const events = ref([])
const selected = ref(new Set())
const amount = ref('')
const currency = ref('GBP')
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)

function toggle(id) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  selected.value = next
}

async function load() {
  loading.value = true
  try {
    const [cfg, meet] = await Promise.all([
      auth.apiFetch(`/api/meets/${props.meetId}/bundle/config`),
      auth.apiFetch(`/api/meets/${props.meetId}`),
    ])
    events.value = Array.isArray(meet.events) ? meet.events : []
    enabled.value = cfg.payments_enabled !== false
    selected.value = new Set(cfg.event_ids || [])
    const price = cfg.fee && cfg.fee.prices && cfg.fee.prices[0]
    amount.value = price ? (price.amount_cents / 100).toString() : ''
    currency.value = (cfg.fee && cfg.fee.currency) || 'GBP'
  } catch (e) {
    showError(e.message || 'Could not load the bundle')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!enabled.value) return
  if (!selected.value.size) { showError('Select at least one event for the bundle'); return }
  busy.value = true
  try {
    await auth.apiFetch(`/api/meets/${props.meetId}/bundle`, {
      method: 'PUT',
      body: JSON.stringify({
        currency: currency.value.toUpperCase(),
        event_ids: [...selected.value],
        prices: [{ label: 'bundle', amount_cents: Math.round(parseFloat(amount.value || '0') * 100), audience: 'all' }],
      }),
    })
    showSuccess('Bundle saved')
  } catch (e) {
    showError(e.message || 'Could not save the bundle')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="bundle-editor">
    <p class="hint">Offer a discounted price to enter a chosen set of this meet's events in one purchase.</p>
    <ComingSoonBanner
      v-if="!enabled"
      message="Meet bundles are coming soon. Set it up here; it goes live once online payments are switched on."
    />
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <p v-if="!events.length" class="muted">Add events to this meet first, then bundle them here.</p>
      <template v-else>
        <div class="events">
          <label v-for="e in events" :key="e.id" class="ev">
            <input type="checkbox" :checked="selected.has(e.id)" :disabled="!enabled" @change="toggle(e.id)" />
            <span>{{ e.name }}</span>
          </label>
        </div>
        <div class="price-row">
          <label class="pl">Bundle price
            <span class="amt">
              <span class="cur">{{ currency }}</span>
              <input v-model="amount" type="number" min="0" step="0.01" placeholder="0.00" :disabled="!enabled" />
            </span>
          </label>
          <button type="button" class="btn" :disabled="busy || !enabled" @click="save">{{ busy ? 'Saving…' : 'Save bundle' }}</button>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.bundle-editor { display: flex; flex-direction: column; gap: .6rem; }
.hint { font-size: .8rem; color: var(--muted, #777); margin: 0; }
.muted { color: var(--muted, #777); font-size: .85rem; }
.events { display: flex; flex-direction: column; gap: .3rem; max-height: 12rem; overflow: auto; }
.ev { display: flex; align-items: center; gap: .5rem; font-size: .9rem; }
.price-row { display: flex; align-items: flex-end; gap: 1rem; flex-wrap: wrap; }
.pl { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: var(--fg-2, #555); }
.amt { display: inline-flex; align-items: center; gap: .3rem; }
.cur { color: var(--muted, #777); font-size: .85rem; }
.amt input { padding: .3rem; width: 7rem; }
.btn { padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn:disabled { opacity: .6; cursor: default; }
</style>
