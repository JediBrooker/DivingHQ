<script setup>
// Diver: their OWN enrolments (never anyone else's), plus browsing +
// self-enrolling into their own club's active classes. Backed by
// /api/me/classes and /api/me/available-classes, both scoped
// server-side to the caller.
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { Waves } from '@lucide/vue'

const auth = useAuthStore()
const { t, locale } = useI18n()

const loading = ref(true)
const mine = ref([])
const available = ref([])
const enrolling = ref(null)
const chosenPrice = ref({})
const payingId = ref(null)

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(locale.value, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function load() {
  loading.value = true
  try {
    const [m, a] = await Promise.all([
      auth.apiFetch('/api/me/classes'),
      auth.apiFetch('/api/me/available-classes'),
    ])
    mine.value = m
    available.value = a
    // Pre-select each class's first price option so the dropdown always
    // shows the price that enrolling will use. Gotcha we fixed: it used
    // to render blank and silently enrol at the first option anyway.
    for (const cls of a) {
      if (cls.price_options && cls.price_options.length && !chosenPrice.value[cls.id]) {
        chosenPrice.value[cls.id] = cls.price_options[0].id
      }
    }
  } catch (e) {
    showError(e.message || t('classes.error_load'))
  } finally {
    loading.value = false
  }
}

async function payNow(e) {
  payingId.value = e.id
  try {
    const res = await auth.apiFetch(`/api/me/class-enrolments/${e.id}/checkout`, { method: 'POST' })
    if (res.url) {
      // Keep the button disabled while the browser navigates to Stripe.
      // A finally-reset here re-enabled it mid-redirect, which invited a
      // second click and a confusing second request.
      window.location.href = res.url
      return
    }
    // Fully covered by a discount, so it's activated directly, no Stripe redirect.
    showSuccess(t('classes.enrolled'))
    await load()
    payingId.value = null
  } catch (err) {
    showError(err.message || t('classes.error_checkout'))
    payingId.value = null
  }
}

async function enrol(cls) {
  enrolling.value = cls.id
  try {
    const priceId = chosenPrice.value[cls.id] || (cls.price_options[0] && cls.price_options[0].id) || null
    const res = await auth.apiFetch(`/api/me/classes/${cls.id}/enrol`, {
      method: 'POST',
      body: JSON.stringify({ price_option_id: priceId }),
    })
    showSuccess(res.status === 'pending' ? t('classes.enrol_pending') : t('classes.enrolled'))
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_enrol'))
  } finally {
    enrolling.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="my-classes">
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

    <template v-else>
      <section class="section">
        <h2>{{ t('classes.my_classes') }}</h2>
        <p v-if="!mine.length" class="muted empty">
          <Waves class="empty-ic" />
          {{ t('classes.diver_no_classes') }}
        </p>
        <div v-else class="class-list">
          <div v-for="e in mine" :key="e.id" class="class-card">
            <div class="class-name">{{ e.class_name }}</div>
            <div class="class-meta">
              <span>{{ e.club_name }}</span>
              <span v-if="e.level">{{ e.level }}</span>
              <span v-if="e.schedule">{{ e.schedule }}</span>
            </div>
            <div class="class-foot">
              <span class="pill" :class="e.status">{{ t(`classes.status_${e.status}`) }}</span>
              <span v-if="e.price_label" class="muted small">{{ e.price_label }}: {{ money(e.amount_cents, e.currency) }}</span>
              <button v-if="e.status === 'pending'" class="btn pay-btn" type="button" :disabled="payingId === e.id" @click="payNow(e)">
                {{ payingId === e.id ? t('common.loading') : t('classes.pay_now') }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="section">
        <h2>{{ t('classes.available_classes') }}</h2>
        <p v-if="!available.length" class="muted">{{ t('classes.no_available_classes') }}</p>
        <div v-else class="class-list">
          <div v-for="cls in available" :key="cls.id" class="class-card">
            <div class="class-name">{{ cls.name }}</div>
            <div class="class-meta">
              <span v-if="cls.level">{{ cls.level }}</span>
              <span v-if="cls.schedule">{{ cls.schedule }}</span>
              <span>{{ t('classes.enrolled_count', { n: cls.enrolled, cap: cls.capacity || '∞' }) }}</span>
            </div>
            <template v-if="cls.already_enrolled">
              <p class="muted small already">{{ t('classes.already_enrolled') }}</p>
            </template>
            <template v-else>
              <div v-if="cls.price_options && cls.price_options.length" class="price-pick">
                <select class="in" v-model="chosenPrice[cls.id]">
                  <option v-for="p in cls.price_options" :key="p.id" :value="p.id">{{ p.label }}: {{ money(p.amount_cents, p.currency) }}</option>
                </select>
              </div>
              <button class="btn" type="button" :disabled="enrolling === cls.id" @click="enrol(cls)">
                {{ enrolling === cls.id ? t('common.saving') : t('classes.enrol') }}
              </button>
            </template>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.my-classes { display: flex; flex-direction: column; gap: 1.5rem; }
.section { display: flex; flex-direction: column; gap: .6rem; }
.section h2 { font-size: 1.02rem; margin: 0; }
.muted { color: var(--muted, #777); margin: 0; }
.muted.small, .small { font-size: .82rem; }
.empty { display: flex; align-items: center; gap: .5rem; padding: 1rem 0; }
.empty-ic { width: 20px; height: 20px; }
.class-list { display: flex; flex-direction: column; gap: .6rem; }
.class-card { border: 1px solid var(--border, #ddd); border-radius: var(--radius-lg, .75rem); padding: .85rem 1rem; display: flex; flex-direction: column; gap: .4rem; }
.class-name { font-weight: 600; }
.class-meta { display: flex; gap: .75rem; flex-wrap: wrap; font-size: .82rem; color: var(--muted, #777); }
.class-foot { display: flex; align-items: center; gap: .6rem; }
.pill { padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; text-transform: capitalize; background: var(--bg-2, #eee); color: var(--fg-2, #555); }
.pill.active { background: var(--accent-soft, #dfe); color: var(--green, #2a7); }
.pill.pending { color: var(--amber, #b70); }
.already { font-style: italic; }
.price-pick .in { padding: .35rem .5rem; border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem); background: transparent; color: var(--fg, #222); font: inherit; }
.btn { align-self: flex-start; padding: .45rem .9rem; border: 0; border-radius: var(--radius, .5rem); background: var(--accent, #3b6); color: #fff; cursor: pointer; font: inherit; }
.btn:disabled { opacity: .55; cursor: default; }
.pay-btn { padding: .2rem .6rem; font-size: .78rem; margin-left: auto; }
</style>
