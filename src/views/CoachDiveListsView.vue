<script setup>
// Coach dive-list editor — Phase 2 of the coach feature bundle.
//
// One page, one event. Lists every diver in the coach's squad
// (linked via coach_diver_links) alongside their current dive
// list for the event; per-diver inline editor lets the coach
// pick a dive for each round and submit on the diver's behalf.
//
// Server validation lives in lib/dive-list-submit.js — same
// checks as the diver-self POST /api/competitor/submit-list path:
// dive_id is in the directory at the event's height, no duplicate
// rounds, prescribed-dive enforcement (migration 039), round-rules
// validation (migration 038), synchro partner eligibility.
// Violations come back as a 400 with `violations: string[]`.
//
// We deliberately don't build a fancy "search the directory"
// picker here — coaches typically know exactly what dives their
// athletes are doing. A flat dropdown of every directory entry
// at the event's height is enough; the alternative is to lift the
// big picker out of CompetitorView.vue, which is a separate
// refactor.

import { ref, computed, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'
import { showSuccess, showError } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'

const route = useRoute()
const auth = useAuthStore()

const eventId = computed(() => route.params.event_id)
const event = ref(null)
const divers = ref([])
const diveDirectory = ref([])
const loading = ref(false)
const error = ref('')

// Per-diver edit state. Keyed by diver_id; null when the row is
// view-only. When the coach clicks Edit on a row, we copy that
// diver's current dives into this map; Submit posts it; Cancel
// drops it.
const editing = ref({}) // diver_id → { dives: [dive_id|null × total_rounds], partner_id, submitting, errors: [] }

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [data, dirResult] = await Promise.all([
      auth.apiFetch(`/api/coach/dive-lists/${eventId.value}`),
      auth.cachedApiFetch('/api/dive-directory', {
        cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS, onUpdate: (fresh) => {
          if (Array.isArray(fresh)) diveDirectory.value = fresh
        } },
      }),
    ])
    event.value = data.event
    divers.value = data.divers
    diveDirectory.value = Array.isArray(dirResult.data) ? dirResult.data : []
  } catch (err) {
    error.value = err.message || 'Failed to load dive lists'
  } finally {
    loading.value = false
  }
}

// Filter the dive directory to entries valid at the event's
// height. Server enforces this too; the dropdown just stops the
// coach from picking something that'll fail.
const validDives = computed(() => {
  const h = event.value?.height ? Number(event.value.height) : null
  return diveDirectory.value
    .filter(d => !h || Number(d.height) === h)
    .sort((a, b) => a.dive_code.localeCompare(b.dive_code) ||
                    (a.position || '').localeCompare(b.position || ''))
})

// Per-event, the operator can pin a specific dive (or just a
// height) to a round. The coach should see that round as locked
// in the editor; the server will reject any other dive.
const prescribedByRound = computed(() => {
  const map = new Map()
  for (const p of (event.value?.prescribed_rounds || [])) {
    map.set(p.round_number, p)
  }
  return map
})

function diveLabel(d) {
  if (!d) return ''
  const code = `${d.dive_code}${d.position || ''}`
  const dd = d.dd ? ` (DD ${Number(d.dd).toFixed(1)})` : ''
  return `${code}${dd} — ${d.description || ''}`.slice(0, 90)
}

function startEdit(diver) {
  const rounds = event.value?.total_rounds || 6
  const initial = Array(rounds).fill(null)
  for (const dv of diver.dives || []) {
    if (dv.round_number >= 1 && dv.round_number <= rounds) {
      initial[dv.round_number - 1] = dv.dive_id
    }
  }
  // Apply prescribed dives that pin to a specific dive_id (the
  // ones that pin only height stay user-pickable).
  for (const [round, slot] of prescribedByRound.value) {
    if (slot.dive_id) initial[round - 1] = slot.dive_id
  }
  editing.value[diver.diver_id] = {
    dives: initial,
    partner_id: diver.partner_id || '',
    submitting: false,
    errors: [],
  }
}

function cancelEdit(diverId) {
  delete editing.value[diverId]
}

async function submitEdit(diver) {
  const state = editing.value[diver.diver_id]
  if (!state) return
  state.errors = []
  state.submitting = true

  // Compose body. Skip null rounds — the server requires every
  // submitted dive to have a dive_id, and the coach should ship
  // every round filled. If any are missing, surface a client-side
  // error.
  const missing = state.dives
    .map((id, idx) => (id ? null : idx + 1))
    .filter(Boolean)
  if (missing.length) {
    state.errors = [`Missing dives for round(s): ${missing.join(', ')}`]
    state.submitting = false
    return
  }
  const body = {
    dives: state.dives.map((dive_id, idx) => ({
      round_number: idx + 1,
      dive_id,
    })),
  }
  if (state.partner_id) body.partner_id = state.partner_id

  try {
    const res = await auth.apiFetch(
      `/api/coach/dive-lists/${eventId.value}/${diver.diver_id}`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    showSuccess(res.message || 'Dive list submitted')
    cancelEdit(diver.diver_id)
    await load() // re-render with the saved list
  } catch (err) {
    if (err.violations && Array.isArray(err.violations)) {
      state.errors = err.violations
    } else {
      state.errors = [err.message || 'Submission failed']
    }
    showError(state.errors[0])
  } finally {
    state.submitting = false
  }
}

function isPrescribedDiveLocked(round_number) {
  const slot = prescribedByRound.value.get(round_number)
  return slot && slot.dive_id
}

function isPrescribedHeight(round_number) {
  const slot = prescribedByRound.value.get(round_number)
  return slot && !slot.dive_id && slot.height != null
}

async function withdrawDiver(diver) {
  // Two-step confirm — withdrawing is a high-blast-radius action.
  // Operator AND diver both see the consequence (Control Room
  // queue + spectator scoreboard), so we want intentional clicks.
  const reason = window.prompt(
    `Withdraw ${diver.full_name} from ${event.value?.name || 'this event'}?\n\n` +
    `Optionally enter a reason (visible in the audit log + Control Room):`,
    '',
  )
  if (reason === null) return // cancelled
  const proceed = await confirmAction({
    title: `Withdraw ${diver.full_name}?`,
    body: `This marks every round in this event as withdrawn for ${diver.full_name}. ` +
          `The operator will see it in the Control Room and the spectator scoreboard will reflect the change. ` +
          `Reinstating requires the meet manager.`,
    confirmLabel: 'Withdraw',
    confirmKind: 'danger',
  })
  if (!proceed) return
  try {
    const res = await auth.apiFetch(
      `/api/coach/dive-lists/${eventId.value}/${diver.diver_id}/withdraw`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      },
    )
    showSuccess(res.message || `${diver.full_name} withdrawn`)
    await load()
  } catch (err) {
    showError(err.message || 'Withdraw failed')
  }
}

function prescribedHeightLabel(round_number) {
  const slot = prescribedByRound.value.get(round_number)
  return slot?.height
}

onMounted(load)
</script>

<template>
  <div class="coach-lists-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Coach → Dive Lists</div>
        <h1 class="page-title">{{ event ? event.name : 'Dive Lists' }}</h1>
        <div v-if="event" class="page-sub">
          <span v-if="event.height">{{ event.height }}m</span>
          <span v-if="event.event_type === 'synchro_pair'"> · Synchro</span>
          <span v-if="event.total_rounds"> · {{ event.total_rounds }} rounds</span>
          <span v-if="event.meet_name"> · {{ event.meet_name }}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost btn-sm" @click="load" :disabled="loading">
          {{ loading ? '↻ Refreshing' : '↻ Refresh' }}
        </button>
        <RouterLink to="/coach" class="btn btn-ghost btn-sm">← Coach</RouterLink>
      </div>
    </div>

    <div v-if="loading && !event" class="empty">Loading dive lists…</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>

    <template v-else-if="event">
      <!-- Deadline / lock banner -->
      <div v-if="event.entries_close_at" class="deadline-banner">
        <span class="deadline-label">Entries close</span>
        <span class="deadline-value">{{ new Date(event.entries_close_at).toLocaleString() }}</span>
      </div>

      <!-- Empty state — coach has no linked divers -->
      <div v-if="!divers.length" class="empty-state-card">
        <div class="empty-state-icon">🤝</div>
        <div class="empty-state-title">No linked divers</div>
        <div class="empty-state-body">
          You don't have any divers linked yet. Ask your org admin to add
          coach links in the User Manager.
        </div>
      </div>

      <!-- Per-diver rows -->
      <div v-else class="diver-list">
        <div v-for="diver in divers"
             :key="diver.diver_id"
             :class="['diver-row', { 'is-editing': editing[diver.diver_id] }]">
          <div class="diver-row-head">
            <div class="diver-meta">
              <span class="diver-name">{{ diver.full_name }}</span>
              <span v-if="diver.country_code" class="diver-ctry">{{ diver.country_code }}</span>
              <span v-if="diver.club_code || diver.club_name" class="diver-club">
                {{ diver.club_code || diver.club_name }}
              </span>
              <span v-if="diver.is_reserve" class="diver-reserve">RESERVE</span>
              <span v-if="diver.withdrawn_at" class="diver-withdrawn">WITHDRAWN</span>
            </div>
            <div class="diver-actions">
              <span v-if="diver.confirmed_at && !editing[diver.diver_id]" class="diver-status confirmed">
                ✓ Submitted {{ new Date(diver.confirmed_at).toLocaleDateString() }}
              </span>
              <span v-else-if="!diver.confirmed_at && !editing[diver.diver_id]" class="diver-status pending">
                Not submitted
              </span>
              <button v-if="!editing[diver.diver_id] && !diver.withdrawn_at"
                      class="btn btn-primary btn-sm"
                      @click="startEdit(diver)">
                {{ diver.confirmed_at ? 'Edit list' : 'Submit list' }}
              </button>
              <button v-if="!editing[diver.diver_id] && !diver.withdrawn_at && diver.dives.length"
                      class="btn btn-ghost btn-sm withdraw-btn"
                      @click="withdrawDiver(diver)"
                      v-tip="'Scratch this diver from the event'">
                Withdraw
              </button>
            </div>
          </div>

          <!-- View mode — show their current dive list compactly -->
          <div v-if="!editing[diver.diver_id] && diver.dives.length" class="diver-dives">
            <div v-for="dv in diver.dives" :key="dv.round_number" class="dive-line">
              <span class="dive-round">R{{ dv.round_number }}</span>
              <span class="dive-code">{{ dv.dive_code }}{{ dv.position }}</span>
              <span v-if="dv.dd" class="dive-dd">DD {{ Number(dv.dd).toFixed(1) }}</span>
              <span v-if="dv.description" class="dive-desc">{{ dv.description }}</span>
            </div>
          </div>
          <div v-else-if="!editing[diver.diver_id]" class="diver-empty">
            <em>No dive list submitted yet.</em>
          </div>

          <!-- Edit mode — one dropdown per round -->
          <div v-if="editing[diver.diver_id]" class="diver-editor">
            <div v-for="(_, idx) in event.total_rounds || 6"
                 :key="idx"
                 class="edit-row">
              <span class="edit-round">R{{ idx + 1 }}</span>
              <select class="select edit-select"
                      v-model="editing[diver.diver_id].dives[idx]"
                      :disabled="isPrescribedDiveLocked(idx + 1)">
                <option :value="null">— Pick a dive —</option>
                <option v-for="d in validDives"
                        :key="d.id"
                        :value="d.id"
                        :disabled="isPrescribedHeight(idx + 1) && Number(d.height) !== prescribedHeightLabel(idx + 1)">
                  {{ diveLabel(d) }}
                </option>
              </select>
              <span v-if="isPrescribedDiveLocked(idx + 1)" class="edit-lock-note">prescribed</span>
              <span v-else-if="isPrescribedHeight(idx + 1)" class="edit-lock-note">
                must be {{ prescribedHeightLabel(idx + 1) }}m
              </span>
            </div>

            <!-- Synchro partner picker — only when event is a pair.
                 For now we accept a partner_id paste; full picker
                 would need the org_divers fetch from CompetitorView. -->
            <div v-if="event.event_type === 'synchro_pair'" class="edit-row">
              <span class="edit-round">Partner</span>
              <input class="input"
                     type="text"
                     v-model="editing[diver.diver_id].partner_id"
                     placeholder="Partner user ID (UUID)">
            </div>

            <div v-if="editing[diver.diver_id].errors.length" class="msg msg-error">
              <strong>Validation errors:</strong>
              <ul class="error-list">
                <li v-for="e in editing[diver.diver_id].errors" :key="e">{{ e }}</li>
              </ul>
            </div>

            <div class="edit-actions">
              <button class="btn btn-ghost btn-sm"
                      :disabled="editing[diver.diver_id].submitting"
                      @click="cancelEdit(diver.diver_id)">
                Cancel
              </button>
              <button class="btn btn-primary btn-sm"
                      :disabled="editing[diver.diver_id].submitting"
                      @click="submitEdit(diver)">
                {{ editing[diver.diver_id].submitting ? 'Submitting…' : 'Save list' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.coach-lists-wrap { max-width: 1000px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 32px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; }
.header-actions { display: flex; gap: 0.5rem; }

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.deadline-banner {
  display: flex; align-items: baseline; gap: 0.75rem;
  padding: 0.65rem 1rem;
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: var(--radius-sm); margin-bottom: 1rem;
}
.deadline-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.deadline-value {
  font-family: var(--font-mono); font-size: 12px; color: var(--cyan); font-weight: 700;
}

.diver-list { display: flex; flex-direction: column; gap: 0.85rem; }
.diver-row {
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface); padding: 1rem 1.1rem;
  transition: border-color 0.15s;
}
.diver-row.is-editing { border-color: var(--cyan); }

.diver-row-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 0.75rem; flex-wrap: wrap;
}
.diver-meta { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.diver-name {
  font-family: var(--font-display); font-size: 17px; font-weight: 800;
  font-style: italic; color: var(--text);
}
.diver-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}
.diver-club {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-2);
}
.diver-reserve {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: #f59e0b;
  border: 1px solid rgba(245,158,11,0.4); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.diver-withdrawn {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: #ef4444;
  border: 1px solid rgba(239,68,68,0.4); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}

.diver-actions { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.withdraw-btn { color: #ef4444; border-color: rgba(239,68,68,0.4); }
.withdraw-btn:hover { background: rgba(239,68,68,0.06); border-color: #ef4444; }
.diver-status {
  font-family: var(--font-mono); font-size: 11px;
}
.diver-status.confirmed { color: #22c55e; }
.diver-status.pending  { color: #f59e0b; }

.diver-dives {
  margin-top: 0.65rem; padding-top: 0.65rem;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 0.3rem;
}
.dive-line {
  display: grid;
  grid-template-columns: 36px 60px 70px 1fr;
  align-items: baseline; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
}
.dive-round { color: var(--cyan); font-weight: 700; }
.dive-code  { color: var(--text); font-weight: 700; }
.dive-dd    { color: var(--cyan); font-size: 11px; }
.dive-desc  {
  color: var(--text-3); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}

.diver-empty {
  margin-top: 0.55rem; padding-top: 0.55rem;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
}

.diver-editor {
  margin-top: 0.85rem; padding-top: 0.85rem;
  border-top: 1px solid var(--cyan);
  display: flex; flex-direction: column; gap: 0.5rem;
}
.edit-row {
  display: grid;
  grid-template-columns: 60px 1fr auto;
  align-items: center;
  gap: 0.6rem;
}
.edit-round {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--cyan);
}
.edit-select { width: 100%; }
.edit-lock-note {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  font-style: italic;
}

.error-list { margin: 0.4rem 0 0; padding-inline-start: 1.2rem; }
.error-list li { font-family: var(--font-mono); font-size: 11px; }

.edit-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  margin-top: 0.5rem; padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

@media (max-width: 720px) {
  .coach-lists-wrap { padding: 1rem; }
  .dive-line {
    grid-template-columns: 32px 60px 1fr;
  }
  .dive-line .dive-dd { grid-column: 2; }
  .dive-line .dive-desc { grid-column: 1 / -1; padding-inline-start: 38px; }
  .edit-row {
    grid-template-columns: 1fr auto;
  }
  .edit-round { grid-column: 1; }
  .edit-select { grid-column: 1 / -1; order: 2; }
  .edit-lock-note { grid-column: 1 / -1; order: 3; }
}
</style>
