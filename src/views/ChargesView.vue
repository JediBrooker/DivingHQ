<script setup>
// Diver-facing "what I owe" page (/charges). Lists outstanding scratch /
// no-show penalty charges across the diver's events, with a Pay action per
// charge and the contextual "coming soon" preview until online payments are
// switched on. Reads GET /api/me/charges.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()

const charges = ref([])
const enabled = ref(true)
const loading = ref(true)
const payingId = ref('')

const KIND_LABELS = { scratch: 'Scratch (withdrawal)', no_show: 'No-show (DNS)' }

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function load() {
  loading.value = true
  try {
    const r = await auth.apiFetch('/api/me/charges')
    charges.value = r.charges || []
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    showError(e.message || 'Could not load your charges')
  } finally {
    loading.value = false
  }
}

async function pay(charge) {
  if (!enabled.value) return
  payingId.value = charge.id
  try {
    const { url } = await auth.apiFetch(`/api/entry-charges/${charge.id}/checkout`, {
      method: 'POST', body: JSON.stringify({}),
    })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    payingId.value = ''
  }
}

onMounted(load)
</script>

<template>
  <section class="charges-view">
    <h1>Charges</h1>
    <p class="lede">Outstanding scratch and no-show penalties from your federation.</p>
    <ComingSoonBanner
      v-if="!enabled"
      message="Online payment of penalties is coming soon — here's what you currently owe."
    />
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <div v-if="charges.length" class="charge-list">
        <div v-for="c in charges" :key="c.id" class="charge-card">
          <div class="charge-main">
            <div class="charge-title">{{ KIND_LABELS[c.kind] || c.kind }}</div>
            <div class="charge-event">{{ c.event_name }}</div>
          </div>
          <div class="charge-amount">{{ money(c.amount_cents, c.currency) }}</div>
          <button class="btn-pay" :disabled="!enabled || payingId === c.id" @click="pay(c)">
            {{ !enabled ? 'Coming soon' : (payingId === c.id ? 'Redirecting…' : 'Pay') }}
          </button>
        </div>
      </div>
      <p v-else class="muted">You're all clear — no outstanding charges. 🎉</p>
    </template>
  </section>
</template>

<style scoped>
.charges-view { display: flex; flex-direction: column; gap: 1rem; max-width: 50rem; margin: 0 auto; padding: 1rem; }
.lede { color: var(--muted, #777); margin: 0; }
.muted { color: var(--muted, #777); }
.charge-list { display: flex; flex-direction: column; gap: .75rem; }
.charge-card {
  display: flex; align-items: center; gap: 1rem;
  border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: .85rem 1rem;
}
.charge-main { flex: 1; min-width: 0; }
.charge-title { font-weight: 600; }
.charge-event { color: var(--muted, #777); font-size: .85rem; }
.charge-amount { font-weight: 700; }
.btn-pay { padding: .5rem 1rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; }
.btn-pay:disabled { opacity: .6; cursor: default; }
</style>
