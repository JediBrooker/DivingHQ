<script setup>
// Landing page for every Stripe Checkout return (/payments/return).
// All checkout success/cancel URLs point here with ?status=paid|canceled
// and ?flow=<what was being paid> so the payer always gets an explicit
// confirmation (previously the return URLs pointed at pages that ignored
// the query — or didn't exist at all — so paying ended on a blank page).
//
// "Paid" is Stripe's redirect, not our webhook: the payment can still be
// settling for a few moments, so the copy says so instead of promising a
// processed state we haven't recorded yet.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()

const paid = computed(() => route.query.status === 'paid')

// Where "Continue" goes, by what the payer was buying. Every target is a
// real SPA route (that's the point of this page).
const CONTINUE_BY_FLOW = {
  class: '/classes',
  charges: '/charges',
  fine: '/charges',
  donation: '/donate',
  membership: '/membership',
  accreditation: '/accreditation',
  club: '/clubs',
  entry: '/competitor',
  meet: '/scoreboard',
}
const continueTo = computed(() => CONTINUE_BY_FLOW[route.query.flow] || '/payment-history')
</script>

<template>
  <section class="payment-return">
    <div class="card" :class="paid ? 'is-paid' : 'is-canceled'">
      <div class="icon" aria-hidden="true">{{ paid ? '✓' : '✕' }}</div>
      <h1>{{ paid ? t('payments.return_paid_title') : t('payments.return_canceled_title') }}</h1>
      <p>{{ paid ? t('payments.return_paid_body') : t('payments.return_canceled_body') }}</p>
      <div class="actions">
        <RouterLink class="btn primary" :to="continueTo">{{ t('payments.return_continue') }}</RouterLink>
        <RouterLink class="btn" to="/payment-history">{{ t('payments.return_history') }}</RouterLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.payment-return { display: flex; justify-content: center; padding: 2rem 1rem; }
.card { display: flex; flex-direction: column; align-items: center; gap: .75rem; text-align: center; max-width: 28rem; padding: 2rem 1.5rem; border: 1px solid var(--border, #ddd); border-radius: .75rem; }
.icon { display: flex; align-items: center; justify-content: center; width: 3rem; height: 3rem; border-radius: 50%; font-size: 1.5rem; font-weight: 700; color: #fff; }
.is-paid .icon { background: var(--accent, #3b6); }
.is-canceled .icon { background: var(--muted, #777); }
h1 { margin: 0; font-size: 1.4rem; }
p { margin: 0; color: var(--fg-2, #555); }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .5rem; margin-top: .75rem; }
.btn { padding: .5rem 1.1rem; border: 1px solid var(--accent, #3b6); border-radius: .5rem; color: var(--accent, #3b6); text-decoration: none; font-weight: 600; }
.btn.primary { background: var(--accent, #3b6); color: #fff; }
</style>
