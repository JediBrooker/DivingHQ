<script setup>
// Admin panel (event edit modal) to ISSUE and manage scratch / no-show
// charges against an event's entrants. Lists existing charges with a waive
// action, and a small form to issue a new one. Entrant list comes from
// the roster. Settlement (the entrant paying) happens on thier own Charges
// page; here an admin only issues + waives.
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import ComingSoonBanner from '@/components/ComingSoonBanner.vue'

const props = defineProps({ eventId: { type: String, required: true } })
const auth = useAuthStore()

const charges = ref([])
const entrants = ref([])
const enabled = ref(true)
const loading = ref(true)
const busy = ref(false)
const loadError = ref(false)
const entrantsError = ref(false)
const form = ref({ entrant_user_id: '', kind: 'scratch' })

const KIND_LABELS = { scratch: 'Scratch', no_show: 'No-show' }

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

const canIssue = computed(() => enabled.value && form.value.entrant_user_id && !busy.value)

async function loadCharges() {
  loadError.value = false
  try {
    const r = await auth.apiFetch(`/api/events/${props.eventId}/entry-charges`)
    charges.value = r.charges || []
    enabled.value = r.payments_enabled !== false
  } catch (e) {
    loadError.value = true
    showError(e.message || 'Could not load charges')
  }
}

async function loadEntrants() {
  try {
    const rows = await auth.apiFetch(`/api/events/${props.eventId}/roster`)
    // Heads up: roster has one row per dive-list entry (rounds), so dedupe to divers.
    const seen = new Map()
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (r.competitor_id && !seen.has(r.competitor_id)) {
        seen.set(r.competitor_id, { id: r.competitor_id, name: r.full_name })
      }
    }
    entrants.value = [...seen.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  } catch {
    entrants.value = []
    entrantsError.value = true
  }
}

async function issue() {
  if (!canIssue.value) return
  busy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.eventId}/entry-charges`, {
      method: 'POST',
      body: JSON.stringify({ entrant_user_id: form.value.entrant_user_id, kind: form.value.kind }),
    })
    showSuccess('Charge issued')
    form.value.entrant_user_id = ''
    await loadCharges()
  } catch (e) {
    showError(e.message || 'Could not issue the charge')
  } finally {
    busy.value = false
  }
}

async function waive(charge) {
  busy.value = true
  try {
    await auth.apiFetch(`/api/entry-charges/${charge.id}/waive`, { method: 'POST', body: JSON.stringify({}) })
    showSuccess('Charge waived')
    await loadCharges()
  } catch (e) {
    showError(e.message || 'Could not waive the charge')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  loading.value = true
  await Promise.all([loadCharges(), loadEntrants()])
  loading.value = false
})
</script>

<template>
  <section class="penalties-panel">
    <h3>Issued penalties</h3>
    <ComingSoonBanner
      v-if="!enabled"
      message="Penalty charges are coming soon. Set the prices above, then you'll be able to issue them here."
    />
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="loadError" class="err">Couldn't load charges. Close and reopen this event to retry.</p>
    <template v-else>
      <!-- Issue a new charge -->
      <div class="issue-row">
        <select v-model="form.entrant_user_id" class="ctl" :disabled="!enabled">
          <option value="">Select an entrant…</option>
          <option v-for="e in entrants" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <select v-model="form.kind" class="ctl" :disabled="!enabled">
          <option value="scratch">Scratch</option>
          <option value="no_show">No-show</option>
        </select>
        <button type="button" class="btn" :disabled="!canIssue" @click="issue">Issue charge</button>
      </div>
      <p v-if="entrantsError" class="err">Couldn't load the entrant list — you may not have roster access for this event.</p>

      <!-- Existing charges -->
      <table v-if="charges.length" class="charges">
        <thead>
          <tr><th>Entrant</th><th>Kind</th><th>Amount</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="c in charges" :key="c.id">
            <td>{{ c.entrant_name }}</td>
            <td>{{ KIND_LABELS[c.kind] || c.kind }}</td>
            <td>{{ money(c.amount_cents, c.currency) }}</td>
            <td><span :class="['status', c.status]">{{ c.status }}</span></td>
            <td>
              <button v-if="c.status === 'owed'" type="button" class="link" :disabled="busy" @click="waive(c)">Waive</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">No charges issued for this event.</p>
    </template>
  </section>
</template>

<style scoped>
.penalties-panel { display: flex; flex-direction: column; gap: .5rem; }
.muted { color: var(--muted, #777); font-size: .85rem; }
.err { color: var(--danger, #c33); font-size: .85rem; margin: 0; }
.issue-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.ctl { padding: .35rem .6rem; border: 1px solid var(--border, #ddd); border-radius: .5rem; background: transparent; color: var(--fg, #222); font-size: .85rem; }
.btn { padding: .4rem .8rem; border: 0; border-radius: .5rem; background: var(--accent, #3b6); color: #fff; cursor: pointer; font-size: .85rem; }
.btn:disabled { opacity: .6; cursor: default; }
.charges { width: 100%; border-collapse: collapse; font-size: .85rem; }
.charges th, .charges td { text-align: left; padding: .3rem .4rem; border-bottom: 1px solid var(--border, #eee); }
.link { background: none; border: 0; color: var(--accent, #3b6); cursor: pointer; padding: .2rem; }
.link:disabled { opacity: .5; }
.status { text-transform: capitalize; font-weight: 600; }
.status.owed { color: var(--amber, #b70); }
.status.paid { color: var(--green, #2a7); }
.status.waived { color: var(--muted, #777); }
</style>
