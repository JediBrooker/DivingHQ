<script setup>
/* MeetReadinessModal — per-meet readiness report (blockers, hard
 * conflicts, late-arrival / synchro pendings, per-federation
 * splits), extracted from ManagerView.vue. Opened from a meet
 * section's "Readiness" button; read-only apart from the CSV
 * export.
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * target meet, so every open re-fetches the report (same as the
 * old openMeetReadinessReport()). The body scroll lock stays in
 * the parent, keyed off the same open condition.
 *
 * State boundary: report / loading / csv-busy / error are OWNED
 * here. Nothing in the parent needs patching afterwards, so the
 * only emit is `close`.
 */
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  meet: { type: Object, required: true },
})
defineEmits(['close'])

const auth = useAuthStore()

const readinessReport = ref(null)
const readinessLoading = ref(false)
const readinessCsvBusy = ref(false)
const readinessErr = ref('')

async function loadReadinessReport() {
  readinessLoading.value = true
  try {
    readinessReport.value = await auth.apiFetch(`/api/meets/${props.meet.id}/readiness-report`)
  } catch (err) {
    readinessErr.value = err.message || 'Failed to load readiness report'
  } finally {
    readinessLoading.value = false
  }
}
// Initial load on mount — same cadence as the old open handler.
loadReadinessReport()

async function downloadMeetReadinessCsv() {
  readinessCsvBusy.value = true
  try {
    const res = await fetch(
      `/api/meets/${props.meet.id}/readiness-report?format=csv`,
      { headers: auth.getHeaders() },
    )
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || res.statusText)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `meet-readiness-${props.meet.id}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    showSuccess('Readiness CSV downloaded')
  } catch (err) {
    showError(err.message || 'Failed to download readiness CSV')
  } finally {
    readinessCsvBusy.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')"></div>
  <div class="modal readiness-modal" @click.stop role="dialog" aria-modal="true" aria-labelledby="mgr-readiness-title">
    <div class="readiness-head">
      <div>
        <div class="teams-section-label">Meet Readiness</div>
        <h2 id="mgr-readiness-title" class="readiness-title">{{ meet?.name }}</h2>
      </div>
      <div class="readiness-actions">
        <button class="btn btn-ghost btn-sm"
                :disabled="readinessCsvBusy || !readinessReport"
                @click="downloadMeetReadinessCsv">
          {{ readinessCsvBusy ? 'Exporting…' : 'Export CSV' }}
        </button>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.close_x') }}</button>
      </div>
    </div>

    <div v-if="readinessErr" class="msg msg-error">{{ readinessErr }}</div>
    <div v-if="readinessLoading" class="hint">Loading readiness report…</div>

    <template v-if="readinessReport && !readinessLoading">
      <div class="readiness-summary">
        <div class="readiness-stat">
          <span>{{ readinessReport.summary.ready_count }}/{{ readinessReport.summary.event_count }}</span>
          <strong>ready</strong>
        </div>
        <div class="readiness-stat">
          <span>{{ readinessReport.summary.blocker_count }}</span>
          <strong>blockers</strong>
        </div>
        <div class="readiness-stat">
          <span>{{ readinessReport.summary.hard_conflict_count }}</span>
          <strong>hard conflicts</strong>
        </div>
        <div class="readiness-stat">
          <span>{{ readinessReport.summary.late_arrival_pending_count }}</span>
          <strong>late reviews</strong>
        </div>
        <div class="readiness-stat">
          <span>{{ readinessReport.summary.synchro_pending_count }}</span>
          <strong>synchro pending</strong>
        </div>
      </div>

      <div v-if="readinessReport.summary.soft_conflict_count" class="hint readiness-note">
        {{ readinessReport.summary.soft_conflict_count }} soft schedule warning{{ readinessReport.summary.soft_conflict_count === 1 ? '' : 's' }} also detected.
      </div>

      <div v-if="!readinessReport.events.length" class="enrolled-empty">
        This meet has no events yet.
      </div>
      <ul v-else class="readiness-event-list">
        <li v-for="event in readinessReport.events" :key="event.event_id"
            :class="['readiness-event-row', event.ready ? 'ready' : 'blocked']">
          <div class="readiness-event-main">
            <div>
              <div class="readiness-event-name">{{ event.event_name }}</div>
              <div class="readiness-event-meta">
                {{ event.active_diver_count }} active ·
                {{ event.judge_count }}/{{ event.required_judges }} judges ·
                {{ event.federations.length || 1 }} federation{{ (event.federations.length || 1) === 1 ? '' : 's' }}
              </div>
            </div>
            <span :class="['readiness-state-chip', event.ready ? 'ok' : 'warn']">
              {{ event.ready ? 'Ready' : `${event.blockers.length} blocker${event.blockers.length === 1 ? '' : 's'}` }}
            </span>
          </div>

          <div v-if="event.blockers.length" class="readiness-blockers">
            <span v-for="blocker in event.blockers" :key="blocker.key" class="readiness-blocker">
              {{ blocker.label }}
            </span>
          </div>

          <div v-if="event.late_arrival_pending_count || event.synchro_pending_count" class="readiness-blockers secondary">
            <span v-if="event.late_arrival_pending_count" class="readiness-blocker">
              {{ event.late_arrival_pending_count }} late arrival{{ event.late_arrival_pending_count === 1 ? '' : 's' }}
            </span>
            <span v-if="event.synchro_pending_count" class="readiness-blocker">
              {{ event.synchro_pending_count }} synchro partner{{ event.synchro_pending_count === 1 ? '' : 's' }} missing
            </span>
          </div>

          <div v-if="event.federations.length > 1" class="readiness-feds">
            <span v-for="fed in event.federations" :key="fed.org_id" class="readiness-fed">
              {{ fed.country_code || fed.org_name }}
              <strong>{{ fed.active_diver_count }}</strong>
              <em v-if="fed.incomplete_diver_count">{{ fed.incomplete_diver_count }} incomplete</em>
            </span>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* Readiness styles MOVED from ManagerView.css (exclusive to this
   modal — .readiness-* and the .modal.readiness-modal viewport
   pin). .teams-section-label, .enrolled-empty, and .hint are
   COPIED from ManagerView.css (shared with the teams /
   federations modals and the rest of the manager page). */

/* The modal renders as a sibling of an EMPTY .modal-backdrop (not
   nested inside it), so the global .modal (position: static) would
   drop to the bottom of the long events page instead of centring.
   Pin to the viewport centre, above the backdrop; scrolls
   internally if tall. */
.modal.readiness-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  max-height: 90vh;
  overflow-y: auto;
}
.readiness-modal { max-width: 860px; }
.readiness-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; margin-bottom: 1rem;
}
.readiness-title {
  font-size: 22px; line-height: 1.15; color: var(--text);
}
.readiness-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.readiness-summary {
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.55rem; margin: 0.85rem 0 1rem;
}
.readiness-stat {
  min-width: 0; padding: 0.65rem 0.75rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.readiness-stat span {
  display: block; font-family: var(--font-display); font-size: 18px;
  font-weight: 800; color: var(--text);
}
.readiness-stat strong {
  display: block; margin-top: 0.15rem;
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--text-3);
}
.readiness-note {
  padding: 0.55rem 0.75rem; border-inline-start: 3px solid var(--amber);
  background: rgba(245, 158, 11, 0.08); border-radius: 4px;
}
.readiness-event-list {
  list-style: none; padding: 0; margin: 0.85rem 0 0;
  display: flex; flex-direction: column; gap: 0.55rem;
}
.readiness-event-row {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0.75rem; background: var(--surface);
}
.readiness-event-row.ready { border-color: rgba(16, 185, 129, 0.35); }
.readiness-event-row.blocked { border-color: rgba(245, 158, 11, 0.35); }
.readiness-event-main {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.8rem;
}
.readiness-event-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 800;
  color: var(--text);
}
.readiness-event-meta {
  margin-top: 0.2rem; font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
}
.readiness-state-chip {
  flex-shrink: 0; padding: 0.2rem 0.45rem; border-radius: 999px;
  font-family: var(--font-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.12em; text-transform: uppercase;
}
.readiness-state-chip.ok {
  color: var(--green); background: rgba(16, 185, 129, 0.12);
}
.readiness-state-chip.warn {
  color: var(--amber); background: rgba(245, 158, 11, 0.12);
}
.readiness-blockers,
.readiness-feds {
  display: flex; flex-wrap: wrap; gap: 0.35rem;
  margin-top: 0.55rem;
}
.readiness-blockers.secondary { opacity: 0.9; }
.readiness-blocker,
.readiness-fed {
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.22rem 0.45rem; border: 1px solid var(--border);
  border-radius: 999px; background: var(--bg-3);
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-2);
}
.readiness-fed strong { color: var(--cyan); }
.readiness-fed em {
  font-style: normal; color: var(--amber);
}

/* COPIED — section label / hint / empty-line styles shared with
   the other manager modals (see ManagerView.css). */
.teams-section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.6rem;
}
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}
.enrolled-empty { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.4rem 0; font-style: italic; }

/* Phone — copied from ManagerView.css's 600px block. */
@media (max-width: 600px) {
  .modal,
  .readiness-modal {
    max-width: 100%;
    width: 100%;
  }
  .readiness-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .readiness-event-main {
    flex-direction: column;
  }
}
</style>
