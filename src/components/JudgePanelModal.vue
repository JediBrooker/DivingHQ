<script setup>
// Inline judge-panel picker for the Control Room readiness checklist.
// Same data model and endpoints as AssignJudgesView, just framed as
// a modal so the operator can seat the panel without leaving Control.
//
// Opens when the parent flips `open` to true, emits `saved` after a
// successful POST so the parent can refresh its judgePanel ref and
// the readiness check ticks green.

import { ref, computed, watch, toRef } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const props = defineProps({
  open:      { type: Boolean, required: true },
  eventId:   { type: [Number, String], default: null },
  panelSize: { type: Number, default: 5 },
  eventName: { type: String, default: '' },
  // Phase 2: when provided, the modal queries the meet's
  // conflict report after save and shows a non-blocking warning
  // for any conflict involving this event's panel. Optional so
  // callers in older surfaces (legacy AssignJudgesView) keep
  // working without modification.
  meetId:    { type: [Number, String], default: null },
})

const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()
const router = useRouter()
const { t } = useI18n()

// Lock background scroll while open. iOS Safari otherwise lets
// the operator drag the page underneath this modal mid-roster-
// build and lose their place in the control surface.
useBodyScrollLock().lockWhile(toRef(props, 'open'))

// Phase 2: post-save conflict warnings. Populated by the
// optional check after a successful POST /api/events/:id/judges.
// Always non-blocking, the save has already gone through by the
// time the operator sees these; they're informational.
const conflictWarnings = ref([])  // Conflict[] involving this event

const allJudges = ref([])       // eligible judges (event-scoped if available)
const panel     = ref([])       // length = panelSize, slots are judge objects or null
const judgeSearch = ref('')
const loading   = ref(false)
const saving    = ref(false)
const errorMsg  = ref('')

// Phase 3: schedule-aware availability hints. Map of judge_id →
// { status: 'available' | 'busy', busy_until?: iso,
//   conflicting_event_label?: string }. Populated by an opt-in
// call to /api/meets/:meetId/judges/availability when both
// meetId and eventScheduledAt are known. Non-blocking: a missing
// or busy judge can still be picked (matches Phase 2's posture).
const availability = ref(new Map())
const availabilityLoading = ref(false)
// Reactive timestamp this panel is being assigned for. Resolved
// off the event's schedule block (or events.scheduled_at as a
// fallback), declared as a ref so loadAvailability can re-run
// without a closure refactor.
const eventScheduledAt = ref(null)

const assignedCount = computed(() => panel.value.filter(Boolean).length)
const inPanelIds    = computed(() => new Set(panel.value.filter(Boolean).map(j => j.id)))
const canSave       = computed(() => assignedCount.value === props.panelSize && !saving.value)

const filteredJudges = computed(() => {
  const term = judgeSearch.value.trim().toLowerCase()
  if (!term) return allJudges.value
  return allJudges.value.filter(j => {
    const hay = [j.full_name, j.org_name, j.country_code].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(term)
  })
})

async function loadData() {
  if (!props.eventId) return
  loading.value = true
  errorMsg.value = ''
  panel.value = Array(props.panelSize).fill(null)
  try {
    // Org-scoped judges first as the always-available baseline; the
    // event-scoped eligible list (which adds participating-federation
    // judges on international meets) replaces it if it succeeds.
    const orgJudges = await auth.apiFetch('/api/judges').catch(() => [])
    allJudges.value = Array.isArray(orgJudges) ? orgJudges : []
    const eligible = await auth.apiFetch(`/api/events/${props.eventId}/eligible-judges`).catch(() => null)
    if (Array.isArray(eligible) && eligible.length) {
      allJudges.value = eligible
    }
    const assigned = await auth.apiFetch(`/api/events/${props.eventId}/judges`).catch(() => [])
    if (Array.isArray(assigned)) {
      assigned.forEach(a => {
        const judge = allJudges.value.find(j => j.id === a.judge_id)
        if (judge && a.judge_number >= 1 && a.judge_number <= props.panelSize) {
          panel.value[a.judge_number - 1] = judge
        }
      })
    }

    // Phase 3: schedule-aware availability. Two preconditions:
    // a meetId on the modal (passed by Phase 2 callers) and a
    // scheduled_at on the event. Heads up: without either we
    // silently skip the call, the picker still works, judges just
    // don't show a badge. Reading scheduled_at via the existing
    // event endpoint avoids adding a second round-trip to /sessions.
    if (props.meetId) {
      try {
        const ev = await auth.apiFetch(`/api/events/${props.eventId}`)
        const at = ev?.scheduled_at || null
        eventScheduledAt.value = at
        if (at) await loadAvailability(at)
      } catch { /* availability's informational, don't fail the load over it */ }
    }
  } catch (err) {
    errorMsg.value = err.message || 'Failed to load judges.'
  } finally {
    loading.value = false
  }
}

async function loadAvailability(atIso) {
  if (!props.meetId || !atIso) return
  availabilityLoading.value = true
  try {
    const body = await auth.apiFetch(
      `/api/meets/${props.meetId}/judges/availability?at=${encodeURIComponent(atIso)}`
    )
    const map = new Map()
    for (const row of (body?.judges || [])) {
      map.set(row.judge_id, row)
    }
    availability.value = map
  } catch {
    availability.value = new Map()
  } finally {
    availabilityLoading.value = false
  }
}

function judgeAvailability(judgeId) {
  // Default to "available" when we either don't have data yet or
  // the API didn't return a busy row for this judge. Matches the
  // server contract: only busy judges come back in the payload.
  const row = availability.value.get(judgeId)
  if (!row) return { status: 'available' }
  return row
}

function formatAvailabilityTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Re-fetch each time the modal opens so a panel change made
// elsewhere (e.g. AssignJudgesView in another tab) is picked up.
watch(() => props.open, async (now) => {
  if (now) {
    judgeSearch.value = ''
    await loadData()
  }
})

function assignJudge(judge) {
  if (inPanelIds.value.has(judge.id)) return
  const emptyIdx = panel.value.findIndex(s => s === null)
  if (emptyIdx === -1) return
  panel.value[emptyIdx] = judge
}

function removeFromSlot(idx) {
  panel.value[idx] = null
}

function judgeSlotNum(judgeId) {
  return panel.value.findIndex(p => p?.id === judgeId)
}

function close() {
  if (saving.value) return
  emit('close')
}

async function save() {
  if (!canSave.value || !props.eventId) return
  saving.value = true
  errorMsg.value = ''
  conflictWarnings.value = []
  try {
    await auth.apiFetch(`/api/events/${props.eventId}/judges`, {
      method: 'POST',
      body:   JSON.stringify({ judgeIds: panel.value.map(j => j.id) }),
    })
    emit('saved')

    // Phase 2: non-blocking conflict surfacing. We refetch the
    // meet's conflict report after the save, filter to entries
    // involving this event's panel, and if any are active
    // (non-dismissed) keep the modal open with a warning banner.
    // The user can dismiss the warning or jump to the scheduler,
    // the panel save itself has already succeeded.
    if (props.meetId) {
      try {
        const body = await auth.apiFetch(`/api/meets/${props.meetId}/conflicts`)
        const list = Array.isArray(body?.conflicts) ? body.conflicts : []
        // Match by event_id: for judge conflicts, both blocks
        // are event_start blocks and at least one points to the
        // event we just saved.
        const eventId = String(props.eventId)
        conflictWarnings.value = list.filter((c) => {
          if (c.dismissed) return false
          if (c.resource_kind !== 'judge') return false
          return (
            String(c.block_a.event_id || '') === eventId ||
            String(c.block_b.event_id || '') === eventId
          )
        })
      } catch { /* informational only, never fail the save */ }
    }

    if (!conflictWarnings.value.length) {
      emit('close')
    }
  } catch (err) {
    errorMsg.value = err.message || 'Failed to save panel.'
  } finally {
    saving.value = false
  }
}

function dismissWarning() {
  conflictWarnings.value = []
  emit('close')
}

function viewInScheduler() {
  conflictWarnings.value = []
  emit('close')
  if (props.meetId) {
    router.push(`/meet/${props.meetId}/schedule`)
  }
}

function formatBlockTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function warningNames(c) {
  return (c.resource_labels || []).filter((s) => s && s.trim()).join(', ') || '—'
}
</script>

<template>
  <!-- Teleport to body so this modal's fixed positioning isn't
       broken by any ancestor with transform/filter/perspective/
       contain:paint. Defensive: today's mount point is fine,
       but ControlView's wrapper layouts shift frequently and
       a transform someday would silently break us. -->
  <Teleport to="body">
  <div v-if="open" class="modal-backdrop" @mousedown.self="close">
    <div class="modal judge-panel-modal" @mousedown.stop>
      <div class="jpm-header">
        <div>
          <h2 class="jpm-title">Seat the judge panel</h2>
          <div class="jpm-subtitle">
            <span v-if="eventName">{{ eventName }} — </span>
            <span :class="assignedCount === panelSize ? 'jpm-count-ok' : 'jpm-count-warn'">
              {{ assignedCount }}
            </span>
            of {{ panelSize }} seats filled
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="close" :disabled="saving">
          Cancel ✕
        </button>
      </div>

      <div v-if="errorMsg" class="msg msg-error jpm-error">{{ errorMsg }}</div>

      <!-- Phase 2: post-save conflict warning. The panel save
           has already succeeded by the time this shows, we keep
           the modal open just long enough for the operator to
           jump to the scheduler or dismiss. -->
      <div v-if="conflictWarnings.length" class="msg msg-warn jpm-conflict-warn">
        <div class="jpm-conflict-heading">
          {{ t('scheduler.conflicts.judge_modal_heading') }}
        </div>
        <div class="jpm-conflict-blurb">
          {{ t('scheduler.conflicts.judge_modal_blurb') }}
        </div>
        <ul class="jpm-conflict-list">
          <li v-for="c in conflictWarnings" :key="`${c.block_a.id}|${c.block_b.id}`">
            <strong>{{ warningNames(c) }}</strong>
            —
            {{ c.block_a.label || c.block_a.event_name }}
            ({{ formatBlockTime(c.block_a.starts_at) }})
            ↔
            {{ c.block_b.label || c.block_b.event_name }}
            ({{ formatBlockTime(c.block_b.starts_at) }})
          </li>
        </ul>
        <div class="jpm-conflict-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="dismissWarning">
            {{ t('scheduler.conflicts.judge_modal_dismiss') }}
          </button>
          <button
            v-if="meetId"
            type="button"
            class="btn btn-primary btn-sm"
            @click="viewInScheduler"
          >
            {{ t('scheduler.conflicts.judge_modal_view') }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="jpm-loading">Loading judges…</div>

      <div v-else class="jpm-grid">
        <!-- Left: available judges -->
        <div>
          <div class="jpm-col-label">Available judges</div>
          <input
            class="input jpm-search"
            type="text"
            v-model="judgeSearch"
            placeholder="Search judges…"
          >
          <div class="jpm-judge-list">
            <div v-if="!filteredJudges.length" class="jpm-empty">No judges found</div>
            <div
              v-for="j in filteredJudges"
              :key="j.id"
              :class="['jpm-judge-item', inPanelIds.has(j.id) ? 'in-panel' : '']"
              @click="assignJudge(j)"
            >
              <div class="jpm-judge-info">
                <div class="jpm-judge-name">
                  {{ j.full_name }}
                  <span v-if="j.country_code" class="jpm-judge-country">{{ j.country_code }}</span>
                  <!-- Phase 3 availability badge, only rendered
                       when the parent passed a meetId and the event
                       has a scheduled_at. The picker treats it as a
                       non-blocking hint; busy judges remain pickable
                       to keep parity with Phase 2's "warning, no
                       veto" posture. -->
                  <span
                    v-if="meetId && eventScheduledAt"
                    :class="['jpm-availability', judgeAvailability(j.id).status === 'available' ? 'is-available' : 'is-busy']"
                    v-tip="judgeAvailability(j.id).conflicting_event_label || ''"
                  >
                    <template v-if="judgeAvailability(j.id).status === 'available'">
                      {{ t('scheduler.availability.available') }}
                    </template>
                    <template v-else>
                      {{ t('scheduler.availability.busy', { time: formatAvailabilityTime(judgeAvailability(j.id).busy_until) }) }}
                    </template>
                  </span>
                </div>
                <div v-if="j.org_name" class="jpm-judge-org">{{ j.org_name }}</div>
              </div>
              <span v-if="inPanelIds.has(j.id)" class="jpm-seated">
                J{{ judgeSlotNum(j.id) + 1 }} ✓
              </span>
              <span v-else class="jpm-add-hint">＋</span>
            </div>
          </div>
        </div>

        <!-- Right: panel slots -->
        <div>
          <div class="jpm-col-label">Panel — click to assign in order</div>
          <div class="jpm-slots">
            <div
              v-for="(judge, idx) in panel"
              :key="idx"
              :class="['jpm-slot', judge ? 'filled' : '']"
            >
              <div class="jpm-slot-num">J{{ idx + 1 }}</div>
              <div v-if="judge" class="jpm-slot-body">
                <div class="jpm-slot-label">Judge {{ idx + 1 }}</div>
                <div class="jpm-slot-name">{{ judge.full_name }}</div>
              </div>
              <div v-else class="jpm-slot-empty">Empty</div>
              <button
                v-if="judge"
                type="button"
                class="jpm-slot-remove"
                @click="removeFromSlot(idx)"
                aria-label="Remove judge"
              >✕</button>
            </div>
          </div>
        </div>
      </div>

      <div class="jpm-actions">
        <button type="button" class="btn btn-ghost" @click="close" :disabled="saving">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!canSave"
          @click="save"
        >
          {{ saving ? 'Saving…' : `Save panel (${assignedCount}/${panelSize})` }}
        </button>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.judge-panel-modal {
  max-width: 880px;
  padding: 1.75rem;
}

.jpm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}
.jpm-title {
  font-size: 22px;
  font-style: italic;
  margin: 0;
}
.jpm-subtitle {
  margin-top: 0.25rem;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-3);
  text-transform: uppercase;
}
.jpm-count-ok   { color: var(--green, #10b981); }
.jpm-count-warn { color: var(--cyan); }

.jpm-error   { margin-bottom: 1rem; }
.jpm-loading { color: var(--text-3); padding: 2rem 0; text-align: center; }

.jpm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
@media (max-width: 720px) {
  .jpm-grid { grid-template-columns: 1fr; }
}

.jpm-col-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.6rem;
}

.jpm-search { margin-bottom: 0.6rem; width: 100%; }

.jpm-judge-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 360px;
  overflow-y: auto;
  padding-inline-end: 0.25rem;
}
.jpm-judge-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.jpm-judge-item:hover { border-color: var(--cyan); }
.jpm-judge-item.in-panel {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.jpm-judge-info { flex: 1; min-width: 0; }
.jpm-judge-name {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.jpm-judge-country {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.05rem 0.35rem;
}
.jpm-judge-org { font-size: 11px; color: var(--text-3); margin-top: 0.15rem; }
.jpm-seated {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--cyan);
  flex-shrink: 0;
}
.jpm-add-hint {
  color: var(--cyan);
  font-size: 18px;
  font-weight: 700;
  opacity: 0.6;
  flex-shrink: 0;
}
.jpm-judge-item:hover .jpm-add-hint { opacity: 1; }
.jpm-empty {
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
  padding: 1.5rem;
}

.jpm-slots {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 360px;
  overflow-y: auto;
  padding-inline-end: 0.25rem;
}
.jpm-slot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 54px;
  transition: border-color 0.15s, background 0.15s;
}
.jpm-slot.filled {
  border-color: var(--cyan);
  background: var(--cyan-dim, rgba(6,182,212,0.08));
}
.jpm-slot-num {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  color: var(--text-3);
  width: 30px;
  text-align: center;
  flex-shrink: 0;
}
.jpm-slot.filled .jpm-slot-num { color: var(--cyan); }
.jpm-slot-body { flex: 1; min-width: 0; }
.jpm-slot-label {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
}
.jpm-slot-name {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-top: 0.05rem;
}
.jpm-slot-empty { color: var(--text-3); font-size: 12px; font-style: italic; }
.jpm-slot-remove {
  margin-inline-start: auto;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  /* WCAG 2.5.5: 44×44 minimum. This button unseats a judge, so
     mis-tapping it during roster build is a destructive gotcha.
     The ✕ glyph still sits centred inside the larger hit area. */
  min-width: 44px; min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  line-height: 1;
  transition: color 0.1s;
  flex-shrink: 0;
}
.jpm-slot-remove:hover { color: var(--red); }

.jpm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.jpm-conflict-warn {
  margin-bottom: 1rem;
  border-inline-start: 3px solid var(--amber, #d90);
}
.jpm-conflict-heading {
  font-weight: 700;
  margin-bottom: 0.25rem;
}
.jpm-conflict-blurb {
  font-size: 12px;
  color: var(--text-2, #ccc);
  margin-bottom: 0.5rem;
}
.jpm-conflict-list {
  margin: 0 0 0.5rem;
  padding-inline-start: 1.25rem;
  font-size: 12px;
}
.jpm-conflict-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.jpm-availability {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.jpm-availability.is-available {
  color: var(--green, #10b981);
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.08);
}
.jpm-availability.is-busy {
  color: var(--amber, #d90);
  border-color: rgba(221, 153, 0, 0.4);
  background: rgba(221, 153, 0, 0.08);
}
</style>
