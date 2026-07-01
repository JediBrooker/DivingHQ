<script setup>
// Buyer-facing meet-bundle card on the public meet page. Shows the discounted
// price + which events it covers, with a coming-soon Buy action until online
// payments are switched on. Hidden entirely until a federation sets a bundle.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({ meetId: { type: String, required: true } })
const auth = useAuthStore()

const bundle = ref(null)
const enabled = ref(true)
const busy = ref(false)

const owned = computed(() => !!(bundle.value && bundle.value.already_paid))
const eventNames = computed(() => (bundle.value && bundle.value.events || []).map(e => e.name).join(', '))

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function load() {
  try {
    const r = await auth.apiFetch(`/api/meets/${props.meetId}/bundle`)
    bundle.value = r.fee
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    showError(e.message || 'Could not load the bundle')
  }
}

async function pay() {
  if (!enabled.value) return
  busy.value = true
  try {
    const { url } = await auth.apiFetch(`/api/meets/${props.meetId}/bundle/checkout`, { method: 'POST', body: JSON.stringify({}) })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="bundle && bundle.price" class="bundle-card">
    <div class="bc-head">
      <strong>Full meet bundle</strong>
      <span class="bc-price">{{ money(bundle.price.amount_cents, bundle.currency) }}</span>
    </div>
    <p v-if="bundle.events && bundle.events.length" class="bc-events">
      Enter {{ bundle.events.length }} event<span v-if="bundle.events.length !== 1">s</span> in one purchase: {{ eventNames }}
    </p>
    <p v-if="owned" class="bc-owned">✓ Purchased</p>
    <template v-else>
      <button class="bc-pay" :disabled="!enabled || busy" @click="pay">
        {{ !enabled ? 'Coming soon' : (busy ? 'Redirecting…' : 'Buy bundle') }}
      </button>
      <ComingSoonBanner v-if="!enabled" message="Online sales are coming soon." />
    </template>
  </div>
</template>

<style scoped>
.bundle-card { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; }
.bc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.bc-price { font-weight: 700; }
.bc-events { margin: 0; color: var(--muted, #777); font-size: .85rem; }
.bc-owned { margin: 0; color: var(--green, #2a7); font-weight: 600; }
.bc-pay { align-self: flex-start; padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.bc-pay:disabled { opacity: .6; cursor: default; }
</style>
