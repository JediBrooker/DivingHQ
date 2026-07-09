<script setup>
// "What I owe" page (/charges) for any signed-in user. Lists outstanding
// scratch / no-show penalty charges (divers) and disciplinary fines, each
// with a Pay action and the contextual "coming soon" preview. Fines can
// also be appealed here. Reads GET /api/me/charges + GET /api/me/fines.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { useI18n } from 'vue-i18n'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()
const { t } = useI18n()

const charges = ref([])
const fines = ref([])
const enabled = ref(true)
const loading = ref(true)
const payingId = ref('')
const payingFineId = ref('')
const appealingId = ref('')
const appealReason = ref('')

function kindLabel(kind) {
  const labels = { scratch: t('payments.charges_view.kind_scratch'), no_show: t('payments.charges_view.kind_no_show') }
  return labels[kind] || kind
}

// /api/me/fines now returns EVERY fine (so appeal outcomes are visible),
// so we split live debts from resolved history here.
const openFines = computed(() => fines.value.filter((f) => ['owed', 'appealed'].includes(f.status)))
const resolvedFines = computed(() => fines.value.filter((f) => !['owed', 'appealed'].includes(f.status)))
function fineOutcome(f) {
  if (f.status === 'waived' && f.appeal_status === 'upheld') return t('payments.charges_view.outcome_waived_upheld')
  if (f.status === 'waived') return t('payments.charges_view.outcome_waived')
  if (f.status === 'paid') return t('payments.charges_view.outcome_paid')
  return f.status
}
function fineNote(f) {
  if (f.status === 'owed' && f.appeal_status === 'dismissed') return t('payments.charges_view.note_appeal_dismissed')
  return ''
}

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
    showError(e.message || t('payments.charges_view.error_load'))
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
    showError(e.message || t('payments.charges_view.error_checkout'))
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
    showError(e.message || t('payments.charges_view.error_checkout'))
    payingFineId.value = ''
  }
}

function startAppeal(f) { appealingId.value = f.id; appealReason.value = '' }

async function submitAppeal(f) {
  if (!appealReason.value.trim()) { showError(t('payments.charges_view.error_appeal_reason')); return }
  try {
    await auth.apiFetch(`/api/fines/${f.id}/appeal`, { method: 'POST', body: JSON.stringify({ reason: appealReason.value.trim() }) })
    showSuccess(t('payments.charges_view.success_appeal'))
    appealingId.value = ''
    await load()
  } catch (e) {
    showError(e.message || t('payments.charges_view.error_appeal'))
  }
}

onMounted(load)
</script>

<template>
  <section class="charges-view">
    <h1>{{ t('payments.charges_view.title') }}</h1>
    <p class="lede">{{ t('payments.charges_view.subtitle') }}</p>
    <ComingSoonBanner
      v-if="!enabled"
      :message="t('payments.charges_view.coming_soon_banner')"
    />
    <p v-if="loading" class="muted">{{ t('payments.charges_view.loading') }}</p>
    <template v-else>
      <!-- Penalty charges (scratch / no-show) -->
      <div v-if="charges.length" class="charge-list">
        <h2 class="section-h">{{ t('payments.charges_view.section_penalties') }}</h2>
        <div v-for="c in charges" :key="c.id" class="charge-card">
          <div class="charge-main">
            <div class="charge-title">{{ kindLabel(c.kind) }}</div>
            <div class="charge-event">{{ c.event_name }}</div>
          </div>
          <div class="charge-amount">{{ money(c.amount_cents, c.currency) }}</div>
          <button class="btn-pay" :disabled="!enabled || payingId === c.id" @click="pay(c)">
            {{ !enabled ? t('payments.charges_view.btn_coming_soon') : (payingId === c.id ? t('payments.charges_view.btn_redirecting') : t('payments.charges_view.btn_pay')) }}
          </button>
        </div>
      </div>

      <!-- Disciplinary fines -->
      <div v-if="openFines.length" class="charge-list">
        <h2 class="section-h">{{ t('payments.charges_view.section_fines') }}</h2>
        <div v-for="f in openFines" :key="f.id" class="fine-wrap">
          <div class="charge-card">
            <div class="charge-main">
              <div class="charge-title">{{ t('payments.charges_view.label_fine') }}</div>
              <div class="charge-event">{{ f.reason }}</div>
              <div v-if="f.status === 'appealed'" class="appeal-tag">{{ t('payments.charges_view.status_under_appeal') }}</div>
              <div v-if="fineNote(f)" class="appeal-tag dismissed">{{ fineNote(f) }}</div>
            </div>
            <div class="charge-amount">{{ money(f.amount_cents, f.currency) }}</div>
            <div v-if="f.status === 'owed'" class="fine-actions">
              <button class="btn-pay" :disabled="!enabled || payingFineId === f.id" @click="payFine(f)">
                {{ !enabled ? t('payments.charges_view.btn_coming_soon') : (payingFineId === f.id ? t('payments.charges_view.btn_redirecting') : t('payments.charges_view.btn_pay')) }}
              </button>
              <button class="btn-appeal" :disabled="appealingId === f.id" @click="startAppeal(f)">{{ t('payments.charges_view.btn_appeal') }}</button>
            </div>
          </div>
          <div v-if="appealingId === f.id" class="appeal-form">
            <textarea v-model="appealReason" rows="2" :placeholder="t('payments.charges_view.appeal_placeholder')"></textarea>
            <div class="appeal-btns">
              <button class="btn-appeal" @click="appealingId = ''">{{ t('payments.charges_view.btn_cancel') }}</button>
              <button class="btn-pay" @click="submitAppeal(f)">{{ t('payments.charges_view.btn_submit_appeal') }}</button>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!charges.length && !openFines.length" class="muted">{{ t('payments.charges_view.empty') }}</p>

      <!-- Resolved fines: the outcome of every appeal/payment stays visible -->
      <div v-if="resolvedFines.length" class="charge-list">
        <h2 class="section-h">{{ t('payments.charges_view.section_resolved') }}</h2>
        <div v-for="f in resolvedFines" :key="f.id" class="charge-card resolved">
          <div class="charge-main">
            <div class="charge-title">{{ t('payments.charges_view.label_fine') }}</div>
            <div class="charge-event">{{ f.reason }}</div>
          </div>
          <div class="charge-amount muted">{{ money(f.amount_cents, f.currency) }}</div>
          <span class="outcome-pill" :class="f.status">{{ fineOutcome(f) }}</span>
        </div>
      </div>
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
.appeal-tag.dismissed { color: var(--amber, #b70); }
.charge-card.resolved { opacity: .85; }
.outcome-pill { padding: .15rem .6rem; border-radius: 999px; font-size: .78rem; background: var(--bg-2, #eee); color: var(--fg-2, #555); white-space: nowrap; }
.outcome-pill.paid { background: var(--accent-soft, #dfe); color: var(--green, #2a7); }
.outcome-pill.waived { background: var(--accent-soft, #eef); color: var(--accent, #3b6); }
.fine-actions { display: flex; gap: .5rem; }
.btn-appeal { padding: .5rem 1rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg-2, #555); cursor: pointer; }
.btn-appeal:disabled { opacity: .6; cursor: default; }
.appeal-form { display: flex; flex-direction: column; gap: .5rem; padding: 0 .85rem; }
.appeal-form textarea { width: 100%; padding: .5rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; resize: vertical; }
.appeal-btns { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
