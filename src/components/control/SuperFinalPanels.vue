<script setup>
/* SuperFinalPanels — Super Final operator surfaces extracted from
 * ControlView.vue: the synchro reserve-pool panel + modal
 * (Appendix 3 §5.1), the dive-offs panel + modal (Appendix 3 §6),
 * and the tied-pairs quick-pick. Self-gating: renders nothing
 * unless the current event is a super_final_h2h / super_final_semi
 * format, so ControlView mounts it unconditionally in the right
 * column.
 *
 * State boundary: dive-off rows, the reserve pool, and both modal
 * forms are OWNED here. ControlView calls reload() from
 * onEventChange so the load cadence is identical to the
 * pre-extraction code (loaders are no-ops on other formats).
 * Mutations that change the roster/bracket emit `refresh` so the
 * parent re-runs its event load; nothing here writes parent state
 * directly.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  event: { type: Object, default: null },
})
const emit = defineEmits(['refresh'])

const auth = useAuthStore()

// Super Final dive-offs (Appendix 3 §6). Visible on
// super_final_h2h or super_final_semi events. The operator
// creates a tie-break record when two divers are tied at the
// end of the stage; once both pick a previously-performed dive
// and re-do it, the operator records the scores + winner.
const diveOffs           = ref([])
const diveOffModalOpen   = ref(false)
const diveOffEditing     = ref(null)   // existing row OR null = create
const diveOffForm        = ref({
  competitor_a_id: '',
  competitor_b_id: '',
  dive_a_id:       '',
  dive_b_id:       '',
  score_a:         '',
  score_b:         '',
  winner_id:       '',
  notes:           '',
  confirm_tied:    false,
})
const diveOffBusy        = ref(false)
const diveOffErr         = ref('')

const isSuperFinalH2hOrSemi = computed(() => {
  const fmt = props.event?.event_format
  return fmt === 'super_final_h2h' || fmt === 'super_final_semi'
})

async function loadDiveOffs() {
  if (!props.event || !isSuperFinalH2hOrSemi.value) {
    diveOffs.value = []
    return
  }
  try {
    const r = await auth.apiFetch(`/api/events/${props.event.id}/dive-offs`)
    diveOffs.value = Array.isArray(r.dive_offs) ? r.dive_offs : []
  } catch {
    diveOffs.value = []
  }
}

function openCreateDiveOff() {
  diveOffEditing.value = null
  diveOffForm.value = {
    competitor_a_id: '',
    competitor_b_id: '',
    dive_a_id:       '',
    dive_b_id:       '',
    score_a:         '',
    score_b:         '',
    winner_id:       '',
    notes:           '',
    confirm_tied:    false,
  }
  diveOffErr.value = ''
  diveOffModalOpen.value = true
}

function openEditDiveOff(row) {
  diveOffEditing.value = row
  diveOffForm.value = {
    competitor_a_id: row.competitor_a_id,
    competitor_b_id: row.competitor_b_id,
    dive_a_id:       row.dive_a_id || '',
    dive_b_id:       row.dive_b_id || '',
    score_a:         row.score_a == null ? '' : String(row.score_a),
    score_b:         row.score_b == null ? '' : String(row.score_b),
    winner_id:       row.winner_id || '',
    notes:           row.notes || '',
    confirm_tied:    true,
  }
  diveOffErr.value = ''
  diveOffModalOpen.value = true
}

function closeDiveOffModal() {
  diveOffModalOpen.value = false
  diveOffEditing.value = null
  diveOffErr.value = ''
}

async function saveDiveOff() {
  if (!props.event) return
  diveOffBusy.value = true
  diveOffErr.value = ''
  try {
    const f = diveOffForm.value
    // Auto-fill winner_id from scores if both are present and
    // operator hasn't picked one explicitly.
    let winnerId = f.winner_id
    if (!winnerId && f.score_a !== '' && f.score_b !== '') {
      const sa = Number(f.score_a), sb = Number(f.score_b)
      if (sa > sb) winnerId = f.competitor_a_id
      else if (sb > sa) winnerId = f.competitor_b_id
    }
    const body = {
      competitor_a_id: f.competitor_a_id || null,
      competitor_b_id: f.competitor_b_id || null,
      dive_a_id:       f.dive_a_id || null,
      dive_b_id:       f.dive_b_id || null,
      score_a:         f.score_a === '' ? null : Number(f.score_a),
      score_b:         f.score_b === '' ? null : Number(f.score_b),
      winner_id:       winnerId || null,
      notes:           f.notes || null,
      confirm_tied:    !!f.confirm_tied,
    }
    if (diveOffEditing.value) {
      // PATCH — drop competitors from body (they're immutable).
      delete body.competitor_a_id
      delete body.competitor_b_id
      delete body.confirm_tied
      await auth.apiFetch(
        `/api/events/${props.event.id}/dive-offs/${diveOffEditing.value.id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      )
      showSuccess('Dive-off updated.')
    } else {
      await auth.apiFetch(`/api/events/${props.event.id}/dive-offs`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      showSuccess('Dive-off created.')
    }
    closeDiveOffModal()
    await loadDiveOffs()
  } catch (err) {
    diveOffErr.value = err.message || 'Failed to save dive-off'
  } finally {
    diveOffBusy.value = false
  }
}

// Synchro reserve replacement (Appendix 3 §5.1). Visible on
// Upcoming super_final_h2h events. Loads /synchro-reserve-pool
// and lets the operator swap a Top-12 diver for a synchro
// reserve, keeping the same display_order slot so the bracket
// stays intact.
const synchroPoolModalOpen = ref(false)
const synchroPool          = ref(null)
const synchroPoolErr       = ref('')
const synchroSwapForm      = ref({
  withdraw_competitor_id:    '',
  replacement_competitor_id: '',
})
const synchroSwapBusy      = ref(false)

const isH2hUpcoming = computed(() => {
  const ev = props.event
  return ev?.event_format === 'super_final_h2h' && ev.status === 'Upcoming'
})

async function openSynchroPoolModal() {
  synchroPool.value = null
  synchroPoolErr.value = ''
  synchroSwapForm.value = { withdraw_competitor_id: '', replacement_competitor_id: '' }
  synchroPoolModalOpen.value = true
  if (!props.event) return
  try {
    synchroPool.value = await auth.apiFetch(
      `/api/events/${props.event.id}/synchro-reserve-pool`)
  } catch (err) {
    synchroPoolErr.value = err.message || 'Failed to load synchro pool'
  }
}
function closeSynchroPoolModal() {
  synchroPoolModalOpen.value = false
  synchroPool.value = null
}

async function confirmSynchroReplacement() {
  if (!props.event) return
  synchroSwapBusy.value = true
  synchroPoolErr.value = ''
  try {
    await auth.apiFetch(`/api/events/${props.event.id}/replace-from-synchro`, {
      method: 'POST',
      body: JSON.stringify(synchroSwapForm.value),
    })
    showSuccess('Synchro replacement complete.')
    closeSynchroPoolModal()
    emit('refresh')
  } catch (err) {
    synchroPoolErr.value = err.message || 'Failed to replace from synchro pool'
  } finally {
    synchroSwapBusy.value = false
  }
}

// Suggest tied pairs for a quick-pick dropdown. For H2H, the
// h2h-results endpoint already flags tied=true; for SF we surface
// the within-group standings so the operator can pick.
const tiedPairsSuggestion = ref([])
async function loadTiedSuggestion() {
  tiedPairsSuggestion.value = []
  if (!props.event) return
  if (props.event.event_format === 'super_final_h2h') {
    try {
      const r = await auth.apiFetch(`/api/events/${props.event.id}/super-final/h2h-results`)
      tiedPairsSuggestion.value = (r.pairs || []).filter(p => p.tied).map(p => ({
        competitor_a_id: p.competitor_a_id,
        competitor_b_id: p.competitor_b_id,
        full_name_a:     p.full_name_a,
        full_name_b:     p.full_name_b,
      }))
    } catch { /* swallow — best-effort */ }
  }
}

// Called by ControlView's onEventChange — same call sites the
// pre-extraction loadDiveOffs() / loadTiedSuggestion() had, so
// the reload cadence (including after a reserve promote or
// dive edit) is unchanged.
function reload() {
  loadDiveOffs()
  loadTiedSuggestion()
}
defineExpose({ reload })
</script>

<template>
  <!-- Super Final — Synchro reserve replacement (Appendix 3
       §5.1). Visible only on Upcoming H2H events — once
       the event goes Live, the bracket is locked and
       withdrawals route through the standard reserve flow. -->
  <div v-if="isH2hUpcoming" class="reserves-panel">
    <div class="reserves-head" style="cursor:default">
      <span class="reserves-head-label">🔄 Synchro reserve pool</span>
      <button class="btn btn-primary btn-sm"
              style="margin-inline-start:auto"
              @click="openSynchroPoolModal"
              v-tip="'Replace a Top-12 individual who withdrew with a synchro reserve from the same meet (Appendix 3 §5.1)'">
        Replace from synchro pool
      </button>
    </div>
  </div>

  <!-- Super Final — Dive-offs panel (Appendix 3 §6).
       Visible on H2H + SF stages. Lists existing dive-offs
       with status (pending / resolved) and a "Create
       dive-off" button that opens the modal. -->
  <div v-if="isSuperFinalH2hOrSemi" class="reserves-panel">
    <div class="reserves-head" style="cursor:default">
      <span class="reserves-head-label">🥊 Dive-offs</span>
      <span class="reserves-head-count">{{ diveOffs.length }}</span>
      <button class="btn btn-primary btn-sm"
              style="margin-inline-start:auto"
              @click="openCreateDiveOff"
              v-tip="'Record a tie-break dive-off (Appendix 3 §6)'">
        + Create
      </button>
    </div>
    <div v-if="tiedPairsSuggestion.length" class="hint" style="padding:0.5rem 0.75rem;color:var(--cyan)">
      Tied pairs flagged by H2H results: {{ tiedPairsSuggestion.length }} — resolve before seeding SF.
    </div>
    <div class="reserves-list">
      <div v-for="d in diveOffs" :key="d.id" class="reserves-row">
        <div class="reserves-row-head">
          <span class="reserves-row-pos" :style="{ background: d.resolved_at ? 'var(--green, #16a34a)' : 'var(--amber, #f59e0b)', color: '#fff' }">
            {{ d.resolved_at ? '✓' : '…' }}
          </span>
          <span class="reserves-row-name">
            {{ d.competitor_a_name }} vs {{ d.competitor_b_name }}
            <span v-if="d.score_a != null && d.score_b != null" class="hint">
              · {{ Number(d.score_a).toFixed(2) }} : {{ Number(d.score_b).toFixed(2) }}
            </span>
            <span v-if="d.winner_name" class="hint" style="color:var(--cyan)">
              · winner: {{ d.winner_name }}
            </span>
          </span>
        </div>
        <div class="reserves-row-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="openEditDiveOff(d)">
            {{ d.resolved_at ? 'View / edit' : 'Record result' }}
          </button>
        </div>
      </div>
      <div v-if="!diveOffs.length" class="hint" style="padding:0.5rem 0.75rem">
        No dive-offs yet. Create one when two divers tie at the end of the stage.
      </div>
    </div>
  </div>

  <!-- Super Final — Synchro reserve replacement modal
       (Appendix 3 §5.1). Lists eligible federations + their
       synchro divers; the operator picks one to swap into a
       Top-12 slot. -->
  <div v-if="synchroPoolModalOpen" class="lb-backdrop" @click.self="closeSynchroPoolModal">
    <div class="lb-modal" style="max-width:680px">
      <div class="lb-head">
        <div>
          <div class="lb-title">🔄 Synchro reserve replacement</div>
          <div class="lb-event">Appendix 3 §5.1 — pre-H2H replacement only.</div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="closeSynchroPoolModal">Close ✕</button>
      </div>
      <div class="lb-body">
        <div v-if="synchroPoolErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ synchroPoolErr }}</div>

        <div v-if="synchroPool && synchroPool.reserve_pool" style="display:grid;gap:0.5rem;margin-bottom:1rem">
          <p class="hint" style="margin:0">
            Eligible reserve federations (best synchro rank first;
            already-2-individuals federations excluded):
          </p>
          <div v-for="entry in synchroPool.reserve_pool" :key="entry.org_id"
               style="border:1px solid var(--border, #333); padding:0.5rem 0.75rem; border-radius:6px">
            <div style="display:flex;align-items:center;gap:0.5rem">
              <strong>#{{ entry.synchro_rank }}</strong>
              <span style="flex:1">
                {{ entry.org_name }}
                <span v-if="entry.country_code" class="hint">· {{ entry.country_code }}</span>
              </span>
              <span class="hint">currently {{ entry.current_individual_count }} individual{{ entry.current_individual_count === 1 ? '' : 's' }}</span>
            </div>
            <div v-for="d in entry.eligible_divers" :key="d.competitor_id"
                 style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0">
              <input type="radio" :value="d.competitor_id" v-model="synchroSwapForm.replacement_competitor_id">
              <span>{{ d.full_name }}</span>
            </div>
          </div>
          <div v-if="!synchroPool.reserve_pool.length" class="hint">
            No eligible synchro reserves at this meet.
          </div>
        </div>

        <label style="display:block;margin-bottom:0.75rem">
          <span class="hint">Withdraw competitor (UUID of the Top-12 diver to remove)</span>
          <input class="input" type="text" v-model="synchroSwapForm.withdraw_competitor_id">
        </label>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button class="btn btn-ghost btn-sm" @click="closeSynchroPoolModal">Cancel</button>
          <button class="btn btn-primary btn-sm"
                  :disabled="synchroSwapBusy
                             || !synchroSwapForm.withdraw_competitor_id
                             || !synchroSwapForm.replacement_competitor_id"
                  @click="confirmSynchroReplacement">
            {{ synchroSwapBusy ? 'Swapping…' : 'Confirm swap' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Super Final — Dive-off modal (Appendix 3 §6).
       Operator records a tie-break dive-off after two divers
       picked their previously-performed dives + re-dove them. -->
  <div v-if="diveOffModalOpen" class="lb-backdrop" @click.self="closeDiveOffModal">
    <div class="lb-modal" style="max-width:560px">
      <div class="lb-head">
        <div>
          <div class="lb-title">{{ diveOffEditing ? 'Dive-off — record result' : 'Create dive-off' }}</div>
          <div class="lb-event">Tie-break (Appendix 3 §6) — doesn't affect official scores.</div>
        </div>
        <button class="btn btn-ghost btn-sm" @click="closeDiveOffModal">Close ✕</button>
      </div>
      <div class="lb-body">
        <div v-if="diveOffErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ diveOffErr }}</div>

        <!-- Suggest tied pairs from H2H. -->
        <div v-if="!diveOffEditing && tiedPairsSuggestion.length"
             class="hint" style="margin-bottom:0.5rem">
          Tied H2H pairs:
          <button v-for="(p, i) in tiedPairsSuggestion" :key="i"
                  type="button"
                  class="btn btn-ghost btn-sm"
                  style="margin-block:0 0.25rem;margin-inline:0 0.25rem"
                  @click="diveOffForm.competitor_a_id = p.competitor_a_id;
                          diveOffForm.competitor_b_id = p.competitor_b_id">
            {{ p.full_name_a }} vs {{ p.full_name_b }}
          </button>
        </div>

        <div v-if="!diveOffEditing" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem">
          <label>
            <span class="hint">Diver A (lower seed)</span>
            <input class="input" type="text" v-model="diveOffForm.competitor_a_id"
                   placeholder="competitor_id (UUID)">
          </label>
          <label>
            <span class="hint">Diver B (higher seed)</span>
            <input class="input" type="text" v-model="diveOffForm.competitor_b_id"
                   placeholder="competitor_id (UUID)">
          </label>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem">
          <label>
            <span class="hint">Dive A id (optional)</span>
            <input class="input" type="text" v-model="diveOffForm.dive_a_id">
          </label>
          <label>
            <span class="hint">Dive B id (optional)</span>
            <input class="input" type="text" v-model="diveOffForm.dive_b_id">
          </label>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem">
          <label>
            <span class="hint">Score A</span>
            <input class="input" type="number" step="0.01" v-model="diveOffForm.score_a">
          </label>
          <label>
            <span class="hint">Score B</span>
            <input class="input" type="number" step="0.01" v-model="diveOffForm.score_b">
          </label>
        </div>

        <label style="display:block;margin-bottom:0.75rem">
          <span class="hint">Winner — defaults to higher score if blank</span>
          <select class="select" v-model="diveOffForm.winner_id">
            <option value="">— Auto from scores —</option>
            <option :value="diveOffForm.competitor_a_id">A wins</option>
            <option :value="diveOffForm.competitor_b_id">B wins</option>
          </select>
        </label>

        <label style="display:block;margin-bottom:0.75rem">
          <span class="hint">Notes</span>
          <textarea class="input" rows="2" v-model="diveOffForm.notes"
                    placeholder="Referee notes — chosen dive, witness, etc."></textarea>
        </label>

        <label v-if="!diveOffEditing" style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
          <input type="checkbox" v-model="diveOffForm.confirm_tied">
          <span class="hint">
            Confirm these divers are tied (server otherwise refuses
            if computed totals differ — useful when a corrective
            re-score has just landed but the operator wants to
            create the record anyway).
          </span>
        </label>

        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button class="btn btn-ghost btn-sm" @click="closeDiveOffModal">Cancel</button>
          <button class="btn btn-primary btn-sm"
                  :disabled="diveOffBusy"
                  @click="saveDiveOff">
            {{ diveOffBusy ? 'Saving…' : (diveOffEditing ? 'Save' : 'Create') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Panel chrome — copied from ControlView.css (the .reserves-*
   family is shared with the Reserves panel that stays in the
   view, so the source rules remain there; scoped styles don't
   cross the component boundary). */
.reserves-panel {
  display: flex; flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 200, 87, 0.04);
  flex-shrink: 0;
}
.reserves-head {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.85rem;
  background: transparent; border: none; cursor: pointer;
  font: inherit; text-align: start; color: #ffc857;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.reserves-head:hover { background: rgba(255, 200, 87, 0.08); }
.reserves-head-label { flex: 1; }
.reserves-head-count {
  font-family: var(--font-mono); font-size: 10px; font-weight: normal;
  letter-spacing: 0; color: #ffc857;
  background: rgba(255, 200, 87, 0.12);
  padding: 0.1rem 0.45rem; border-radius: 999px;
}
.reserves-list {
  display: flex; flex-direction: column; gap: 0.4rem;
  padding: 0 0.6rem 0.6rem;
}
.reserves-row {
  border: 1px solid rgba(255, 200, 87, 0.25);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.6rem;
  background: var(--bg-3);
}
.reserves-row-head {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.4rem;
  font-family: var(--font-mono); font-size: 12px;
}
.reserves-row-pos {
  color: #ffc857;
  font-weight: bold;
  background: rgba(255, 200, 87, 0.12);
  padding: 0.1rem 0.4rem; border-radius: 4px;
  font-size: 11px;
}
.reserves-row-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reserves-row-actions {
  display: flex; gap: 0.4rem; align-items: center;
}

/* Modal frame — copied from ControlView.css. The .lb-* pattern
   (fixed backdrop + sibling fixed modal, see AGENTS.md "Modal CSS
   pattern") is shared by every Control Room modal; the source
   rules stay in ControlView.css for the modals that remain there. */
.lb-backdrop { position: fixed; inset: 0; background: rgba(3,7,18,0.95); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); z-index: 300; }
.lb-modal {
  position: fixed; top: 50%; inset-inline-start: 50%; transform: translate(-50%, -50%);
  z-index: 301;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 28px;
  width: calc(100% - 3rem); max-width: 560px;
  max-height: 90vh;
  max-height: 90dvh;
  overflow-y: auto; animation: fadeUp 0.3s ease;
  overflow-x: clip;
  box-shadow: 0 30px 60px rgba(0,0,0,0.55);
}
.lb-title { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.4rem; }
.lb-event { font-family: var(--font-sans); font-size: 22px; font-weight: 600; font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.1; }
.lb-body { padding: 1.5rem 2rem 2rem; }
@media (max-width: 720px) {
  .lb-modal {
    max-height: calc(100vh - 1.5rem);   /* fallback */
    max-height: calc(100dvh - 1.5rem);  /* preferred */
    border-radius: var(--radius-lg);
  }
  .lb-body { padding: 1rem 1.25rem 1.5rem; }
}
</style>
