<script setup>
// "What I owe" page (/charges) for any signed-in user. Lists outstanding
// scratch / no-show penalty charges (divers) AND disciplinary fines, each
// with a Pay action and the contextual "coming soon" preview. Fines can also
// be appealed here. Reads GET /api/me/charges + GET /api/me/fines.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()

const charges = ref([])
const fines = ref([])
const enabled = ref(true)
const loading = ref(true)
const payingId = ref('')
const payingFineId = ref('')
const appealingId = ref('')
const appealReason = ref('')

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
    const [c, fr] = await Promise.all([
      auth.apiFetch('/api/me/charges'),
      auth.apiFetch('/api/me/fines'),
    ])
    charges.value = c.charges || []
    fines.value = fr.fines || []
    enabled.value = c.payments_enabled !== false
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

async function payFine(f) {
  if (!enabled.value) return
  payingFineId.value = f.id
  try {
    const { url } = await auth.apiFetch(`/api/fines/${f.id}/checkout`, { method: 'POST', body: JSON.stringify({}) })
    window.location.href = url
  } catch (e) {
    showError(e.message || 'Could not start checkout')
    payingFineId.value = ''
  }
}

function startAppeal(f) { appealingId.value = f.id; appealReason.value = '' }

async function submitAppeal(f) {
  if (!appealReason.value.trim()) { showError('Please enter a reason for your appeal'); return }
  try {
    await auth.apiFetch(`/api/fines/${f.id}/appeal`, { method: 'POST', body: JSON.stringify({ reason: appealReason.value.trim() }) })
    showSuccess('Appeal submitted')
    appealingId.value = ''
    await load()
  } catch (e) {
    showError(e.message || 'Could not submit the appeal')
  }
}

onMounted(load)
</script>

<template>
  <section class="charges-view">
    <h1>Charges</h1>
    <p class="lede">Outstanding penalties and fines from your federation.</p>
    <ComingSoonBanner
      v-if="!enabled"
      message="Online payment of penalties is coming soon — here's what you currently owe."
    />
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <!-- Penalty charges (scratch / no-show) -->
      <div v-if="charges.length" class="charge-list">
        <h2 class="section-h">Penalties</h2>
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

      <!-- Disciplinary fines -->
      <div v-if="fines.length" class="charge-list">
        <h2 class="section-h">Fines</h2>
        <div v-for="f in fines" :key="f.id" class="fine-wrap">
          <div class="charge-card">
            <div class="charge-main">
              <div class="charge-title">Fine</div>
              <div class="charge-event">{{ f.reason }}</div>
              <div v-if="f.status === 'appealed'" class="appeal-tag">Under appeal — awaiting a decision</div>
            </div>
            <div class="charge-amount">{{ money(f.amount_cents, f.currency) }}</div>
            <div v-if="f.status === 'owed'" class="fine-actions">
              <button class="btn-pay" :disabled="!enabled || payingFineId === f.id" @click="payFine(f)">
                {{ !enabled ? 'Coming soon' : (payingFineId === f.id ? 'Redirecting…' : 'Pay') }}
              </button>
              <button class="btn-appeal" :disabled="appealingId === f.id" @click="startAppeal(f)">Appeal</button>
            </div>
          </div>
          <div v-if="appealingId === f.id" class="appeal-form">
            <textarea v-model="appealReason" rows="2" placeholder="Why are you appealing this fine?"></textarea>
            <div class="appeal-btns">
              <button class="btn-appeal" @click="appealingId = ''">Cancel</button>
              <button class="btn-pay" @click="submitAppeal(f)">Submit appeal</button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!charges.length && !fines.length" class="muted">You're all clear — no outstanding charges. 🎉</p>
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
.section-h { font-size: 1rem; margin: .5rem 0 .25rem; }
.fine-wrap { display: flex; flex-direction: column; gap: .5rem; }
.appeal-tag { color: var(--accent, #3b6); font-size: .8rem; margin-top: .2rem; }
.fine-actions { display: flex; gap: .5rem; }
.btn-appeal { padding: .5rem 1rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg-2, #555); cursor: pointer; }
.btn-appeal:disabled { opacity: .6; cursor: default; }
.appeal-form { display: flex; flex-direction: column; gap: .5rem; padding: 0 .85rem; }
.appeal-form textarea { width: 100%; padding: .5rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; resize: vertical; }
.appeal-btns { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
