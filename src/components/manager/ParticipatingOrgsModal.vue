<script setup>
/* ParticipatingOrgsModal — invite OTHER federations' divers to
 * enter an event (international event support, migration 036),
 * extracted from ManagerView.vue. Lists current participants,
 * pending/answered invitations, and the invite picker. Empty
 * participant list = domestic-only. Endpoints in routes/events.js.
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * target event, so every open re-fetches the three lists (same as
 * the old openPartOrgsModal()).
 *
 * State boundary: invited / requests / available / busy are OWNED
 * here. The parent's event row shows a "🌐 International (N)"
 * chip driven by participating_orgs_count — accept/remove emit
 * `count-changed` with the new count and the parent patches that
 * one row (no full loadEvents() refetch), exactly like the old
 * bumpParticipatingCount path.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  event: { type: Object, required: true },
})
const emit = defineEmits(['close', 'count-changed'])

const auth = useAuthStore()

const partOrgsInEvent    = ref([])    // currently invited
const partOrgRequests    = ref([])    // pending / accepted / declined workflow rows
const partOrgsAvailable  = ref([])    // active orgs not yet invited (excl. host)
const partOrgsToAdd      = ref('')
const partOrgsBusy       = ref(false)
const partOrgPendingRequests = computed(() =>
  partOrgRequests.value.filter(r => r.status === 'pending'),
)
const partOrgPastRequests = computed(() =>
  partOrgRequests.value.filter(r => r.status !== 'pending'),
)

async function loadPartOrgs() {
  partOrgsBusy.value = true
  try {
    const [invited, requests, allOrgs] = await Promise.all([
      auth.apiFetch(`/api/events/${props.event.id}/participating-orgs`),
      auth.apiFetch(`/api/events/${props.event.id}/participation-requests`).catch(() => []),
      auth.apiFetch(`/api/orgs/active`),
    ])
    partOrgsInEvent.value = invited
    partOrgRequests.value = Array.isArray(requests) ? requests : []
    // Available = every active org except the host and any
    // already invited or currently pending.
    const invitedSet = new Set(invited.map(o => o.org_id))
    const pendingSet = new Set(partOrgRequests.value
      .filter(r => r.status === 'pending')
      .map(r => r.org_id))
    partOrgsAvailable.value = (Array.isArray(allOrgs) ? allOrgs : [])
      .filter(o => o.id !== props.event.org_id && !invitedSet.has(o.id) && !pendingSet.has(o.id))
  } catch (err) {
    showError(err.message)
    partOrgsInEvent.value = []
    partOrgRequests.value = []
    partOrgsAvailable.value = []
  } finally {
    partOrgsBusy.value = false
  }
}
// Initial load on mount — same cadence as the old open handler.
loadPartOrgs()

async function addPartOrg() {
  if (!partOrgsToAdd.value) return
  partOrgsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/participation-requests`, {
      method: 'POST',
      body: JSON.stringify({ org_id: partOrgsToAdd.value }),
    })
    partOrgRequests.value = await auth.apiFetch(`/api/events/${props.event.id}/participation-requests`)
    const pendingSet = new Set(partOrgRequests.value
      .filter(r => r.status === 'pending')
      .map(r => r.org_id))
    partOrgsAvailable.value = partOrgsAvailable.value.filter(o => !pendingSet.has(o.id))
    partOrgsToAdd.value = ''
    showSuccess('Invite sent — waiting for the federation to accept')
  } catch (err) {
    showError(err.message)
  } finally {
    partOrgsBusy.value = false
  }
}

async function respondPartOrgRequest(request, decision) {
  partOrgsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/participation-requests/${request.id}/respond`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    const [invited, requests] = await Promise.all([
      auth.apiFetch(`/api/events/${props.event.id}/participating-orgs`),
      auth.apiFetch(`/api/events/${props.event.id}/participation-requests`),
    ])
    partOrgsInEvent.value = invited
    partOrgRequests.value = requests
    emit('count-changed', partOrgsInEvent.value.length)
    showSuccess(decision === 'accepted' ? 'Participation accepted' : 'Participation declined')
  } catch (err) {
    showError(err.message)
  } finally {
    partOrgsBusy.value = false
  }
}

async function removePartOrg(org) {
  if (!await confirmAction({
    title: `Remove ${org.org_name} from this event?`,
    body:  `Divers from ${org.country_code || org.org_name} can no longer self-enter. Existing dive list rows from their divers stay intact.`,
    consequences: [
      'Their divers stay on the roster if already entered',
      'New entries from this federation will be rejected after removal',
    ],
    confirmLabel: 'Remove federation',
    confirmKind:  'danger',
  })) return
  partOrgsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/participating-orgs/${org.org_id}`, {
      method: 'DELETE',
    })
    partOrgsInEvent.value = partOrgsInEvent.value.filter(o => o.org_id !== org.org_id)
    // Make the org re-selectable in the dropdown.
    partOrgsAvailable.value = [
      ...partOrgsAvailable.value,
      { id: org.org_id, name: org.org_name, country_code: org.country_code },
    ].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    emit('count-changed', partOrgsInEvent.value.length)
    showSuccess(`Removed ${org.org_name}`)
  } catch (err) {
    showError(err.message)
  } finally {
    partOrgsBusy.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @click="$emit('close')"></div>
  <div class="modal teams-modal" @click.stop role="dialog" aria-modal="true" aria-labelledby="mgr-orgs-title">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <div>
        <div class="teams-section-label">Participating Federations</div>
        <h2 id="mgr-orgs-title" style="font-size:20px;line-height:1.1">
          {{ event?.name }}
        </h2>
      </div>
      <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.close_x') }}</button>
    </div>
    <p class="hint" style="margin-bottom:1rem;line-height:1.5">
      Accepted federations can self-enter divers without a shadow account. Their results count toward <strong>their home federation's</strong> records, not yours. The host federation ({{ event?.org_name || 'this org' }}) is implicit — don't add it.
    </p>

    <div class="teams-section-label">Currently participating ({{ partOrgsInEvent.length }})</div>
    <ul v-if="partOrgsInEvent.length" class="enrolled-list">
      <li v-for="o in partOrgsInEvent" :key="o.org_id" class="enrolled-row">
        <span class="enrolled-name">
          {{ o.org_name }}
          <span v-if="o.country_code" class="enrolled-code">{{ o.country_code }}</span>
        </span>
        <button class="btn btn-danger btn-sm" :disabled="partOrgsBusy"
                @click="removePartOrg(o)">Remove</button>
      </li>
    </ul>
    <div v-else class="enrolled-empty">
      Domestic-only event — only {{ event?.org_name || 'host' }} divers can enter.
    </div>

    <div class="teams-section-label" style="margin-top:1.25rem">Pending invitations ({{ partOrgPendingRequests.length }})</div>
    <ul v-if="partOrgPendingRequests.length" class="enrolled-list">
      <li v-for="req in partOrgPendingRequests" :key="req.id" class="enrolled-row pending-invite-row">
        <span class="enrolled-name">
          {{ req.org_name }}
          <span v-if="req.country_code" class="enrolled-code">{{ req.country_code }}</span>
          <span class="invite-status-chip">waiting</span>
        </span>
        <span v-if="req.org_id !== auth.user?.org_id" class="hint-line">Sent {{ req.requested_at ? new Date(req.requested_at).toLocaleDateString() : '' }}</span>
        <span v-else class="invite-response-actions">
          <button class="btn btn-primary btn-sm" :disabled="partOrgsBusy"
                  @click="respondPartOrgRequest(req, 'accepted')">Accept</button>
          <button class="btn btn-ghost btn-sm" :disabled="partOrgsBusy"
                  @click="respondPartOrgRequest(req, 'declined')">Decline</button>
        </span>
      </li>
    </ul>
    <div v-else class="enrolled-empty">No pending federation invitations.</div>

    <div v-if="partOrgPastRequests.length" class="teams-section-label" style="margin-top:1.25rem">Recent responses</div>
    <ul v-if="partOrgPastRequests.length" class="enrolled-list">
      <li v-for="req in partOrgPastRequests.slice(0, 4)" :key="req.id" class="enrolled-row">
        <span class="enrolled-name">
          {{ req.org_name }}
          <span v-if="req.country_code" class="enrolled-code">{{ req.country_code }}</span>
          <span :class="['invite-status-chip', req.status]">{{ req.status }}</span>
        </span>
        <span class="hint-line">{{ req.responded_at ? new Date(req.responded_at).toLocaleDateString() : '' }}</span>
      </li>
    </ul>

    <div class="teams-section-label" style="margin-top:1.25rem">Invite a federation</div>
    <div class="add-team-row">
      <select class="select" v-model="partOrgsToAdd" :disabled="partOrgsBusy">
        <option value="">— Select a federation —</option>
        <option v-for="o in partOrgsAvailable" :key="o.id" :value="o.id">
          {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }}
        </option>
      </select>
      <button class="btn btn-primary btn-sm"
              :disabled="!partOrgsToAdd || partOrgsBusy"
              @click="addPartOrg">Send invite</button>
    </div>
    <p v-if="!partOrgsAvailable.length && !partOrgsBusy" class="hint-line">
      Every active federation is already participating, pending a response, or there are no other federations on this server.
    </p>
  </div>
</template>

<style scoped>
/* Invite-workflow styles MOVED from ManagerView.css (exclusive to
   this modal — .pending-invite-row / .invite-status-chip /
   .invite-response-actions). The .teams-modal frame, .enrolled-*
   list, .add-team-row, section label, and hint blocks are COPIED
   — shared with TeamsEnrolmentModal.vue (keep the two in sync).
   The .modal.teams-modal viewport pin exists because the modal
   renders as a sibling of an EMPTY .modal-backdrop, so the global
   .modal (position: static) would drop to the bottom of the long
   events page instead of centring. */
.modal.teams-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  max-height: 90vh;
  overflow-y: auto;
}
.teams-modal { max-width: 560px; }
.teams-section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.6rem;
}
.enrolled-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.enrolled-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.enrolled-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); }
.enrolled-code {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-inline-start: 0.5rem;
}
.enrolled-empty { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.4rem 0; font-style: italic; }
.add-team-row { display: flex; gap: 0.5rem; align-items: center; }
.add-team-row .select { flex: 1; }
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}
.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.5rem; }

/* MOVED — invitation workflow chips/rows (this modal was their
   only user). */
.pending-invite-row { align-items: flex-start; }
.invite-status-chip {
  display: inline-flex; align-items: center;
  margin-inline-start: 0.45rem; padding: 0.1rem 0.4rem;
  border-radius: 999px; background: rgba(245, 158, 11, 0.12);
  color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3);
  font-family: var(--font-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.1em; text-transform: uppercase;
}
.invite-status-chip.accepted {
  color: var(--green); border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.12);
}
.invite-status-chip.declined,
.invite-status-chip.cancelled {
  color: var(--red); border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.1);
}
.invite-response-actions {
  display: flex; gap: 0.35rem; flex-wrap: wrap; justify-content: flex-end;
}

/* Phone full-bleed — copied from ManagerView.css's 600px block. */
@media (max-width: 600px) {
  .modal,
  .teams-modal {
    max-width: 100%;
    width: 100%;
  }
}
</style>
