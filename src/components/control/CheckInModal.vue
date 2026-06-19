<script setup>
/* CheckInModal — pre-meet door-pass list, extracted from
 * ControlView.vue (#2 from the feature roadmap). Each unique
 * diver gets a Present / Late / DNS chip; when the pre-meet
 * workflow is still on state 1 the footer carries the
 * "Check-in Complete — Continue" confirm that stamps
 * check_in_done_at and advances the workflow.
 *
 * Mount contract: the parent mounts this with v-if, so every
 * open re-fetches attendance (same as the old openCheckIn()).
 *
 * State boundary: rows / loading / error are OWNED here. The
 * confirm step emits `confirmed` with the optimistic
 * check_in_done_at patch — the parent applies it via
 * patchCurrentEvent, exactly like the inline version did.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { showError } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'

const props = defineProps({
  event:         { type: Object, required: true },
  // orderWorkflowState from the parent — gates the confirm footer
  // to pre-meet state 1 only.
  workflowState: { type: String, default: '' },
})
const emit = defineEmits(['close', 'confirmed'])

const auth = useAuthStore()
const { queueAction } = useHttpOutbox()

const checkInRows = ref([])
const checkInLoading = ref(false)
const checkInErr = ref('')
const busy = ref(false)

async function refreshCheckIn() {
  if (!props.event) return
  checkInLoading.value = true
  checkInErr.value = ''
  try {
    checkInRows.value = await auth.apiFetch(
      `/api/events/${props.event.id}/attendance`,
    )
  } catch (err) {
    checkInErr.value = err.message
    checkInRows.value = []
  } finally {
    checkInLoading.value = false
  }
}
// Initial load on mount — same cadence as the old openCheckIn().
refreshCheckIn()

// Set a diver's status. Optimistic — we update the local row
// then fire the PUT; on failure we revert and surface the error.
async function setAttendance(row, status) {
  const prev = row.status
  // Toggle: clicking the same chip twice clears the status.
  const next = prev === status ? null : status
  row.status = next
  try {
    const r = await auth.apiFetch(
      `/api/events/${props.event.id}/attendance/${row.competitor_id}`,
      { method: 'PUT', body: JSON.stringify({ status: next }) },
    )
    row.status = r.status   // server is source of truth
    row.set_at = r.set_at
  } catch (err) {
    row.status = prev
    checkInErr.value = err.message
  }
}

const checkInCounts = computed(() => {
  const out = { present: 0, late: 0, absent: 0, pending: 0 }
  for (const r of checkInRows.value) {
    if (r.status === 'present')      out.present++
    else if (r.status === 'late')    out.late++
    else if (r.status === 'absent')  out.absent++
    else                              out.pending++
  }
  return out
})

async function confirmCheckInComplete() {
  if (!props.event) return
  // Friendly nudge if no diver has been ticked off yet — the
  // operator can still proceed, but they're advancing on an
  // empty list which is usually a mistake.
  const anyMarked = (checkInRows.value || []).some(r => r.status)
  if (!anyMarked && !await confirmAction({
    title: 'Confirm check-in complete?',
    body:
      `No divers have been marked yet for "${props.event.name}". ` +
      `Confirm check-in complete anyway?`,
    confirmLabel: 'Confirm anyway',
    cancelLabel: 'Go back',
    confirmKind: 'warn',
  })) return
  busy.value = true
  try {
    await queueAction({
      method: 'POST',
      url: `/api/events/${props.event.id}/check-in/confirm`,
      actionType: 'check_in_confirm',
    })
    // Optimistic check_in_done_at — the canonical value lands
    // via the next event refresh; the parent sets it client-side
    // now so the UI advances out of the check-in step immediately.
    emit('confirmed', { check_in_done_at: new Date().toISOString() })
    emit('close')
  } catch (err) {
    showError('Failed to advance workflow: ' + err.message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal max-width="720px" @close="$emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" title="Check-in" :subtitle="event?.name" @close="$emit('close')">
        <span class="checkin-tally">
          <span class="tally-present">✓ {{ checkInCounts.present }}</span>
          <span class="tally-late">⏱ {{ checkInCounts.late }}</span>
          <span class="tally-absent">✕ {{ checkInCounts.absent }}</span>
          <span class="tally-pending">— {{ checkInCounts.pending }}</span>
        </span>
      </ModalHeader>
      <div class="lb-body">
        <p class="hint" style="margin-bottom: 0.6rem">
          Tap a chip to set the diver's status. Clicking the same chip again clears it
          (back to pending). Updates persist instantly and broadcast to other operators.
        </p>
        <div v-if="checkInLoading" class="empty-mini">Loading…</div>
        <div v-else-if="!checkInRows.length" class="empty-mini">
          No divers entered for this event yet.
        </div>
        <div v-else class="checkin-list">
          <div v-for="row in checkInRows" :key="row.competitor_id"
               :class="['checkin-row', `checkin-${row.status || 'pending'}`]">
            <div class="checkin-name">
              {{ row.full_name }}
              <span v-if="row.country_code" class="checkin-country">{{ row.country_code }}</span>
              <div v-if="row.club_name" class="checkin-club">
                {{ row.club_name }}<span v-if="row.club_code" class="checkin-club-code">{{ row.club_code }}</span>
              </div>
            </div>
            <div class="checkin-chips">
              <button :class="['chip', 'chip-present', row.status === 'present' ? 'is-active' : '']"
                      @click="setAttendance(row, 'present')"
                      v-tip="'Mark present'">✓ Present</button>
              <button :class="['chip', 'chip-late', row.status === 'late' ? 'is-active' : '']"
                      @click="setAttendance(row, 'late')"
                      v-tip="'Mark late'">⏱ Late</button>
              <button :class="['chip', 'chip-absent', row.status === 'absent' ? 'is-active' : '']"
                      @click="setAttendance(row, 'absent')"
                      v-tip="'Mark absent / DNS'">✕ DNS</button>
            </div>
          </div>
        </div>
        <div v-if="checkInErr" class="msg msg-error">{{ checkInErr }}</div>
      </div>
      <!-- Footer: confirm-and-advance button when the workflow is
           on state 1 (no check_in_done_at stamp yet). After confirm
           the modal closes and the workflow button flips to orange
           "Randomise". When the operator reopens the modal mid-meet
           to adjust attendance, this footer is hidden because the
           workflow has already moved past check-in. -->
      <div v-if="workflowState === 'check-in'" class="lb-footer">
        <span class="checkin-footer-hint">
          Mark each diver, then confirm to advance the workflow.
        </span>
        <button class="btn btn-sm wf-btn wf-btn-red"
                :disabled="busy || checkInLoading"
                @click="confirmCheckInComplete"
                v-tip="'Stamp check-in complete and advance to Randomise.'">
          ✓ Check-in Complete — Continue
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* Check-in styles MOVED from ControlView.css (exclusive to this
   modal — .lb-footer included; this was its only user). The
   .wf-btn rules and the .lb-* modal frame are COPIED from
   ControlView.css (shared with the pre-meet workflow buttons /
   remaining modals there). */
/* =========================================================
   Check-in modal — pre-meet door pass list. Each row has the
   diver's name + chip group. The chip colour leans on the
   status semantics (cyan = present, amber = late, red = DNS).
   ========================================================= */
.lb-footer {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 1rem 2rem; border-top: 1px solid var(--border);
  background: var(--surface); position: sticky; bottom: 0;
}
.checkin-footer-hint { font-size: 12px; color: var(--text-3); }
.checkin-tally {
  display: inline-flex; gap: 0.6rem; margin-inline-start: 0.8rem;
  font-family: var(--font-mono); font-size: 11px; font-weight: 400;
  vertical-align: middle;
}
.checkin-tally .tally-present { color: #06b6d4; }
.checkin-tally .tally-late    { color: #f59e0b; }
.checkin-tally .tally-absent  { color: #ef4444; }
.checkin-tally .tally-pending { color: var(--text-3); }

.checkin-list {
  display: flex; flex-direction: column; gap: 0.4rem;
  max-height: 60vh; overflow-y: auto;
}
.checkin-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.6rem; padding: 0.55rem 0.7rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.checkin-row.checkin-present { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.05); }
.checkin-row.checkin-late    { border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.05); }
.checkin-row.checkin-absent  { border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.05); opacity: 0.75; }
.checkin-name {
  font-family: var(--font-display); font-weight: 700; color: var(--text);
  font-size: 13px; min-width: 0;
}
.checkin-country {
  font-family: var(--font-mono); font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-inline-start: 0.4rem;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.35rem;
  vertical-align: middle;
}
.checkin-club {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  font-weight: 400; margin-top: 0.15rem;
}
.checkin-club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.3rem; margin-inline-start: 0.3rem;
}
.checkin-chips { display: flex; gap: 0.3rem; flex-shrink: 0; }
.checkin-chips .chip {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  padding: 0.3rem 0.55rem;
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text-3); border-radius: var(--radius-sm);
  cursor: pointer; transition: all 0.1s;
}
.checkin-chips .chip:hover { border-color: var(--text-2); color: var(--text-2); }
.checkin-chips .chip.chip-present.is-active {
  background: rgba(6,182,212,0.15); border-color: rgba(6,182,212,0.5); color: #06b6d4;
}
.checkin-chips .chip.chip-late.is-active {
  background: rgba(245,158,11,0.15); border-color: rgba(245,158,11,0.5); color: #f59e0b;
}
.checkin-chips .chip.chip-absent.is-active {
  background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.5); color: #ef4444;
}

@media (max-width: 720px) {
  .checkin-row { flex-direction: column; align-items: stretch; }
  .checkin-chips { justify-content: space-between; }
}

/* COPIED — footer confirm button reuses the workflow-button
   look (see ControlView.css .wf-btn). */
.wf-btn {
  font-family: var(--font-sans); font-weight: 600; font-style: normal;
  letter-spacing: 0; text-transform: none;
  border-radius: 4px; padding: 0.35rem 0.85rem;
  border: 1px solid; color: var(--bg);
  cursor: pointer; transition: filter 0.15s ease;
}
.wf-btn:hover:not(:disabled) { filter: brightness(1.08); }
.wf-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.wf-btn-red    { background: var(--red);   border-color: var(--red); }

/* The lb-* modal frame now lives in BaseModal.vue (frame) + the global
   lb-header/lb-title/lb-event/lb-body in ControlView.css (P2). */
</style>
