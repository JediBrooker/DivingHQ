<script setup>
// Referee / org_admin fines desk (/fines). Issue a disciplinary fine against
// a person, see the org's fines, waive them, and (org_admin) adjudicate
// appeals. The fined person pays or appeals from their own Charges page.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)
const isAdmin = computed(() => (auth.user?.org_roles || []).includes('org_admin'))

const fines = ref([])
const people = ref([])
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)
const form = ref({ liable_user_id: '', amount: '', reason: '' })

const STATUS_LABELS = { owed: 'Owed', appealed: 'Under appeal', paid: 'Paid', waived: 'Waived' }

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
    showError(e.message || 'Could not load fines')
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
    showSuccess('Fine issued')
    form.value = { liable_user_id: '', amount: '', reason: '' }
    await loadFines()
  } catch (e) {
    showError(e.message || 'Could not issue the fine')
  } finally {
    busy.value = false
  }
}

async function waive(f) {
  busy.value = true
  try {
    await auth.apiFetch(`/api/fines/${f.id}/waive`, { method: 'POST', body: JSON.stringify({}) })
    showSuccess('Fine waived')
    await loadFines()
  } catch (e) {
    showError(e.message || 'Could not waive the fine')
  } finally {
    busy.value = false
  }
}

async function review(f, decision) {
  busy.value = true
  try {
    await auth.apiFetch(`/api/fines/${f.id}/appeal/review`, { method: 'POST', body: JSON.stringify({ decision }) })
    showSuccess(decision === 'upheld' ? 'Appeal upheld — fine waived' : 'Appeal dismissed')
    await loadFines()
  } catch (e) {
    showError(e.message || 'Could not review the appeal')
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
    <h1>Fines</h1>
    <p class="lede">Issue disciplinary fines. The person pays or appeals from their Charges page; appeals come here for an org admin to decide.</p>
    <ComingSoonBanner v-if="!enabled" message="Fines are coming soon. You can set them up here; they go live once online payments are switched on." />
    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <div class="issue">
        <select v-model="form.liable_user_id" class="ctl" :disabled="!enabled" aria-label="Who is being fined">
          <option value="">Who is being fined…</option>
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.full_name }}</option>
        </select>
        <label class="ctl-label">Amount
          <input v-model="form.amount" type="number" min="1" step="0.01" placeholder="50.00" class="ctl amt" :disabled="!enabled" />
        </label>
        <label class="ctl-label reason-label">Reason
          <input v-model="form.reason" type="text" placeholder="e.g. unsportsmanlike conduct" class="ctl reason" :disabled="!enabled" />
        </label>
        <button type="button" class="btn" :disabled="!canIssue" @click="issue">Issue fine</button>
      </div>

      <div class="table-scroll">
      <table v-if="fines.length" class="fines">
        <thead>
          <tr><th>Person</th><th>Amount</th><th>Reason</th><th>Status</th><th class="act"></th></tr>
        </thead>
        <tbody>
          <tr v-for="f in fines" :key="f.id">
            <td>{{ f.liable_name }}</td>
            <td>{{ money(f.amount_cents, f.currency) }}</td>
            <td class="reason-cell">{{ f.reason }}<span v-if="f.appeal_reason" class="appeal-note"> — appeal: “{{ f.appeal_reason }}”</span></td>
            <td><span :class="['status', f.status]">{{ STATUS_LABELS[f.status] || f.status }}</span></td>
            <td class="act">
              <template v-if="isAdmin && f.status === 'appealed'">
                <button type="button" class="link" :disabled="busy" @click="review(f, 'upheld')">Uphold</button>
                <button type="button" class="link" :disabled="busy" @click="review(f, 'dismissed')">Dismiss</button>
              </template>
              <button v-if="['owed', 'appealed'].includes(f.status)" type="button" class="link danger" :disabled="busy" @click="waive(f)">Waive</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-if="!fines.length" class="muted">No fines issued yet.</p>
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
