<script setup>
// Referee / org_admin fines desk (/fines). Lets you issue a disciplinary
// fine against a person, view the org's fines, waive them, and (as
// org_admin) adjudicate appeals. The fined person pays or appeals from
// their own Charges page.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import { useI18n } from 'vue-i18n'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()
const { t } = useI18n()
const orgId = computed(() => auth.user?.org_id)
const isAdmin = computed(() => (auth.user?.org_roles || []).includes('org_admin'))

const fines = ref([])
const people = ref([])
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)
const form = ref({ liable_user_id: '', amount: '', reason: '' })

function statusLabel(status) {
  const labels = {
    owed: t('payments.fines_view.status_owed'),
    appealed: t('payments.fines_view.status_appealed'),
    paid: t('payments.fines_view.status_paid'),
    waived: t('payments.fines_view.status_waived'),
  }
  return labels[status] || status
}

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

const canIssue = computed(() =>
  enabled.value && form.value.liable_user_id && form.value.amount && form.value.reason.trim() && !busy.value)

async function loadFines() {
  try {
    const r = await auth.apiFetch('/api/fines')
    fines.value = r.fines || []
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    showError(e.message || t('payments.fines_view.error_load'))
  }
}
async function loadPeople() {
  try {
    people.value = await auth.apiFetch(`/api/orgs/${orgId.value}/members`)
  } catch {
    people.value = []
  }
}

async function issue() {
  if (!canIssue.value) return
  busy.value = true
  try {
    await auth.apiFetch('/api/fines', {
      method: 'POST',
      body: JSON.stringify({
        liable_user_id: form.value.liable_user_id,
        amount_cents: Math.round(parseFloat(form.value.amount || '0') * 100),
        reason: form.value.reason.trim(),
      }),
    })
    showSuccess(t('payments.fines_view.success_issued'))
    form.value = { liable_user_id: '', amount: '', reason: '' }
    await loadFines()
  } catch (e) {
    showError(e.message || t('payments.fines_view.error_issue'))
  } finally {
    busy.value = false
  }
}

async function waive(f) {
  busy.value = true
  try {
    await auth.apiFetch(`/api/fines/${f.id}/waive`, { method: 'POST', body: JSON.stringify({}) })
    showSuccess(t('payments.fines_view.success_waived'))
    await loadFines()
  } catch (e) {
    showError(e.message || t('payments.fines_view.error_waive'))
  } finally {
    busy.value = false
  }
}

async function review(f, decision) {
  busy.value = true
  try {
    await auth.apiFetch(`/api/fines/${f.id}/appeal/review`, { method: 'POST', body: JSON.stringify({ decision }) })
    showSuccess(decision === 'upheld' ? t('payments.fines_view.success_appeal_upheld') : t('payments.fines_view.success_appeal_dismissed'))
    await loadFines()
  } catch (e) {
    showError(e.message || t('payments.fines_view.error_review'))
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  loading.value = true
  await Promise.all([loadFines(), loadPeople()])
  loading.value = false
})
</script>

<template>
  <section class="fines-view">
    <h1>{{ t('payments.fines_view.title') }}</h1>
    <p class="lede">{{ t('payments.fines_view.subtitle') }}</p>
    <ComingSoonBanner v-if="!enabled" :message="t('payments.fines_view.coming_soon_banner')" />
    <p v-if="loading" class="muted">{{ t('payments.fines_view.loading') }}</p>
    <template v-else>
      <div class="issue">
        <select v-model="form.liable_user_id" class="ctl" :disabled="!enabled" :aria-label="t('payments.fines_view.label_who')">
          <option value="">{{ t('payments.fines_view.placeholder_who') }}</option>
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.full_name }}</option>
        </select>
        <label class="ctl-label">{{ t('payments.fines_view.label_amount') }}
          <input v-model="form.amount" type="number" min="1" step="0.01" placeholder="50.00" class="ctl amt" :disabled="!enabled" />
        </label>
        <label class="ctl-label reason-label">{{ t('payments.fines_view.label_reason') }}
          <input v-model="form.reason" type="text" :placeholder="t('payments.fines_view.placeholder_reason')" class="ctl reason" :disabled="!enabled" />
        </label>
        <button type="button" class="btn" :disabled="!canIssue" @click="issue">{{ t('payments.fines_view.btn_issue') }}</button>
      </div>

      <div class="table-scroll">
      <table v-if="fines.length" class="fines">
        <thead>
          <tr><th>{{ t('payments.fines_view.th_person') }}</th><th>{{ t('payments.fines_view.th_amount') }}</th><th>{{ t('payments.fines_view.th_reason') }}</th><th>{{ t('payments.fines_view.th_status') }}</th><th class="act"></th></tr>
        </thead>
        <tbody>
          <tr v-for="f in fines" :key="f.id">
            <td>{{ f.liable_name }}</td>
            <td>{{ money(f.amount_cents, f.currency) }}</td>
            <td class="reason-cell">{{ f.reason }}<span v-if="f.appeal_reason" class="appeal-note">{{ t('payments.fines_view.appeal_note', { reason: f.appeal_reason }) }}</span></td>
            <td><span :class="['status', f.status]">{{ statusLabel(f.status) }}</span></td>
            <td class="act">
              <template v-if="isAdmin && f.status === 'appealed'">
                <button type="button" class="link" :disabled="busy" @click="review(f, 'upheld')">{{ t('payments.fines_view.btn_uphold') }}</button>
                <button type="button" class="link" :disabled="busy" @click="review(f, 'dismissed')">{{ t('payments.fines_view.btn_dismiss') }}</button>
              </template>
              <button v-if="['owed', 'appealed'].includes(f.status)" type="button" class="link danger" :disabled="busy" @click="waive(f)">{{ t('payments.fines_view.btn_waive') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-if="!fines.length" class="muted">{{ t('payments.fines_view.empty') }}</p>
    </template>
  </section>
</template>

<style scoped>
.fines-view { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.lede { color: var(--muted, #777); margin: 0; }
.muted { color: var(--muted, #777); }
.issue { display: flex; flex-wrap: wrap; gap: .5rem; align-items: flex-end; }
.ctl-label { display: flex; flex-direction: column; gap: .2rem; font-size: .78rem; color: var(--fg-2, #555); }
.ctl-label.reason-label { flex: 1; min-width: 12rem; }
.table-scroll { overflow-x: auto; }
.ctl { padding: .4rem .6rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg, #222); font-size: .85rem; }
.ctl.amt { width: 7rem; }
.ctl.reason { flex: 1; min-width: 12rem; }
.btn { padding: .45rem .9rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; font-size: .85rem; }
.btn:disabled { opacity: .6; cursor: default; }
.fines { width: 100%; border-collapse: collapse; font-size: .85rem; }
.fines th, .fines td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--border, #eee); vertical-align: top; }
.reason-cell { max-width: 20rem; }
.appeal-note { color: var(--muted, #777); font-style: italic; }
.act { text-align: right; white-space: nowrap; }
.act .link + .link { margin-left: .4rem; }
.link { background: none; border: 0; color: var(--accent, #3b6); cursor: pointer; padding: .2rem; }
.link.danger { color: var(--danger, #c33); }
.link:disabled { opacity: .5; cursor: default; }
.status { font-weight: 600; }
.status.owed { color: var(--amber, #b70); }
.status.appealed { color: var(--accent, #3b6); }
.status.paid { color: var(--green, #2a7); }
.status.waived { color: var(--muted, #777); }
</style>
