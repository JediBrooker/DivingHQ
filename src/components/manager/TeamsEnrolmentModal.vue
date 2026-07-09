<script setup>
/* TeamsEnrolmentModal handles enrolling/removing org teams on a
 * team-type event. Extracted from ManagerView.vue, opened from
 * the event-row "Teams" button (event_type === 'team' only).
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * target event, so every open re-fetches both the enrolled and
 * available team lists (same as the old openTeamsModal()).
 *
 * State boundary: enrolled / available / busy are OWNED here.
 * Enrolment doesnt surface anywhere on the parent's event rows,
 * so the only emit is `close`.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'

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
// Initial load on mount, same as the old open handler.
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
  <BaseModal max-width="560px" @close="$emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" :title="$t('manager.modals.teams_modal_in_event_prefix')" :subtitle="event?.name" @close="$emit('close')" />
      <div class="lb-body">
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
  </BaseModal>
</template>

<style scoped>
/* Enrolment-list styles COPIED from ManagerView.css, shared with
   ParticipatingOrgsModal.vue (keep the two in sync). The modal
   frame (pin/centre/size) now lives in BaseModal.vue. */
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
</style>
