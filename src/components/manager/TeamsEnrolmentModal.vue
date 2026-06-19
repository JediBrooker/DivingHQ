<script setup>
/* TeamsEnrolmentModal — enrol/remove org teams on a team-type
 * event, extracted from ManagerView.vue. Opened from the
 * event-row "Teams" button (event_type === 'team' only).
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * target event, so every open re-fetches both the enrolled and
 * available team lists (same as the old openTeamsModal()).
 *
 * State boundary: enrolled / available / busy are OWNED here.
 * Enrolment doesn't surface anywhere on the parent's event rows,
 * so the only emit is `close`.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  event: { type: Object, required: true },
})
defineEmits(['close'])

const auth = useAuthStore()

const teamsInEvent = ref([])
const orgTeams = ref([])
const teamToAdd = ref('')
const teamsBusy = ref(false)

async function loadTeams() {
  teamsBusy.value = true
  try {
    const [entered, available] = await Promise.all([
      auth.apiFetch(`/api/events/${props.event.id}/teams`),
      auth.apiFetch(`/api/orgs/${props.event.org_id || auth.user?.org_id}/teams`),
    ])
    teamsInEvent.value = entered
    orgTeams.value = available
  } catch (err) {
    teamsInEvent.value = []
    orgTeams.value = []
  } finally {
    teamsBusy.value = false
  }
}
// Initial load on mount — same cadence as the old open handler.
loadTeams()

const addableTeams = computed(() => {
  const have = new Set(teamsInEvent.value.map(t => t.id))
  return orgTeams.value.filter(t => !have.has(t.id))
})

async function addTeamToEvent() {
  if (!teamToAdd.value) return
  teamsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/teams`, {
      method: 'POST',
      body: JSON.stringify({ team_id: teamToAdd.value }),
    })
    teamsInEvent.value = await auth.apiFetch(`/api/events/${props.event.id}/teams`)
    teamToAdd.value = ''
  } catch (err) {
    showError(err.message)
  } finally {
    teamsBusy.value = false
  }
}

async function removeTeamFromEvent(team) {
  if (!await confirmAction({
    title: `Remove "${team.name}" from this event?`,
    body:  'Unlinks the team from the event roster.',
    consequences: [
      'Existing dive list rows lose their team attribution',
      'Per-dive scores and history stay intact — only the team grouping is removed',
    ],
    confirmLabel: 'Remove team',
    confirmKind:  'danger',
  })) return
  teamsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/teams/${team.id}`, {
      method: 'DELETE',
    })
    teamsInEvent.value = teamsInEvent.value.filter(t => t.id !== team.id)
    showSuccess(`Removed "${team.name}" from event`)
  } catch (err) {
    showError(err.message)
  } finally {
    teamsBusy.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @click="$emit('close')"></div>
  <div class="modal teams-modal" @click.stop role="dialog" aria-modal="true" aria-labelledby="mgr-teams-title">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
      <h2 id="mgr-teams-title" style="font-size:20px">
        {{ $t('manager.modals.teams_modal_in_event_prefix') }} <span style="color:var(--cyan)">{{ event?.name }}</span>
      </h2>
      <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.close_x') }}</button>
    </div>

    <div class="teams-section-label">Currently enrolled ({{ teamsInEvent.length }})</div>
    <ul v-if="teamsInEvent.length" class="enrolled-list">
      <li v-for="t in teamsInEvent" :key="t.id" class="enrolled-row">
        <span class="enrolled-name">
          {{ t.name }}<span v-if="t.short_code" class="enrolled-code">{{ t.short_code }}</span>
        </span>
        <button class="btn btn-danger btn-sm" :disabled="teamsBusy"
                @click="removeTeamFromEvent(t)">Remove</button>
      </li>
    </ul>
    <div v-else class="enrolled-empty">No teams enrolled yet.</div>

    <div class="teams-section-label" style="margin-top:1.25rem">Add a team</div>
    <div class="add-team-row">
      <select class="select" v-model="teamToAdd">
        <option value="">— Select a team —</option>
        <option v-for="t in addableTeams" :key="t.id" :value="t.id">
          {{ t.name }}{{ t.short_code ? ' (' + t.short_code + ')' : '' }}{{ t.member_count != null ? ' · ' + t.member_count + ' members' : '' }}
        </option>
      </select>
      <button class="btn btn-primary btn-sm"
              :disabled="!teamToAdd || teamsBusy"
              @click="addTeamToEvent">Add</button>
    </div>
    <p v-if="!addableTeams.length && !teamsBusy" class="hint-line">
      No more teams available — every team in the org is already enrolled, or the org has no teams. Create teams from
      <RouterLink to="/teams" style="color:var(--cyan)">/teams</RouterLink>.
    </p>
  </div>
</template>

<style scoped>
/* Modal frame + enrolment-list styles COPIED from ManagerView.css
   — shared with ParticipatingOrgsModal.vue (keep the two in
   sync). The .modal.teams-modal viewport pin exists because the
   modal renders as a sibling of an EMPTY .modal-backdrop, so the
   global .modal (position: static) would drop to the bottom of
   the long events page instead of centring. */
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
.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.5rem; }

/* Phone full-bleed — copied from ManagerView.css's 600px block. */
@media (max-width: 600px) {
  .modal,
  .teams-modal {
    max-width: 100%;
    width: 100%;
  }
}
</style>
