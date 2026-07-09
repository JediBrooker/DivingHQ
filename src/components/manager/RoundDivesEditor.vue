<script setup>
/* RoundDivesEditor: one row per round of an event, with an inline
 * dive-picker autocomplete. Extracted from ManagerView.vue, where
 * the same editor used to live twice (Create Event modal + Edit
 * Event modal) with parallel state, gross.
 *
 * State boundary:
 *   * `modelValue` (v-model) is the round-dives array, each slot
 *     is { dive_id|null, height|null, _label, _meta }. The parent
 *     owns this ref; we mutate slot fields in place (height select,
 *     dive_id flip) and only emit `update:modelValue` for add/remove
 *     so the parent's reference identity stays stable across edits.
 *   * `height` / `mixedHeight` come in as props, they shape the
 *     picker filter (mixed-board events let any height through;
 *     single-board events only surface dives at that height).
 *   * `diveDirectory` comes in as a prop, the parent already loads
 *     it once on mount and reuses it across modals.
 *   * Dive-picker dropdown state (open idx, query, results computed)
 *     is owned here. Nothing outside needs it.
 *
 * The "Add a new dive" sub-modal stays in ManagerView (it's shared
 * with the dive-directory page). We surface the request via
 * `request-new-dive` ({ rowIdx }); the parent opens the sub-modal
 * and, on success, calls `applyDiveAtRow(rowIdx, dive)` where `dive`
 * is the freshly-created dive-directory row, so the caller doesn't
 * need to know our internal label format.
 */
import { ref, computed } from 'vue'

const props = defineProps({
  modelValue:    { type: Array,   required: true },  // round_dives array
  height:        { type: String,  default: '' },     // event's fixed height ('' = unset)
  mixedHeight:   { type: Boolean, default: false },  // event spans multiple boards
  diveDirectory: { type: Array,   default: () => [] },
})

const emit = defineEmits(['update:modelValue', 'request-new-dive'])

// Dive-picker dropdown state. `pickerOpenIdx` is the row whose
// search popover is visible (-1 = none). We deliberately keep just
// one index since only one popover can be open at a time anyway.
const pickerOpenIdx = ref(-1)
const pickerQuery   = ref('')

function openDivePicker(idx) {
  pickerOpenIdx.value = idx
  pickerQuery.value   = ''
}
function closeDivePicker() {
  pickerOpenIdx.value = -1
}

// Delayed close for @blur on the search input, gives a click on a
// result row time to fire its @mousedown.prevent first (just in
// case the blur wins the race).
function onPickerBlur(idx) {
  setTimeout(() => {
    if (pickerOpenIdx.value === idx) closeDivePicker()
  }, 150)
}

// Filter the dive directory to rows matching the picker's query,
// and, when the event has a fixed height, that height too. For
// mixed-board events with a per-slot height override, only dives
// at that height appear. Cap results at 25, a sanity limit so the
// dropdown stays usable.
const divePickerResults = computed(() => {
  const q = pickerQuery.value.toLowerCase().trim()
  const slot = props.modelValue[pickerOpenIdx.value]
  const slotHeight = slot && slot.height != null && slot.height !== ''
    ? Number(slot.height)
    : null
  const heightMatch = (d) => {
    if (slotHeight != null) return Number(d.height) === slotHeight
    if (props.mixedHeight)  return true
    if (!props.height)      return true
    const fh = parseFloat(props.height)
    return Number(d.height) === fh
  }
  return props.diveDirectory
    .filter((d) => {
      if (!heightMatch(d)) return false
      if (!q) return true
      const combined = (d.dive_code + (d.position || '')).toLowerCase()
      return combined.includes(q)
        || (d.description || '').toLowerCase().includes(q)
    })
    .slice(0, 25)
})

function selectDiveForRow(dive) {
  const idx = pickerOpenIdx.value
  if (idx < 0) return
  applyDiveAtRow(idx, dive)
  closeDivePicker()
}

function clearDiveForRow(idx) {
  const slot = props.modelValue[idx]
  if (!slot) return
  slot.dive_id = null
  slot._label  = ''
  slot._meta   = null
}

function addRoundDive() {
  // Emit a new array reference for v-model so the parent's ref updates
  // even when the binding is shallow-watched.
  emit('update:modelValue', [
    ...props.modelValue,
    { dive_id: null, height: null, _label: '', _meta: null },
  ])
}
function removeRoundDive(idx) {
  const next = props.modelValue.slice()
  next.splice(idx, 1)
  emit('update:modelValue', next)
}

function requestNewDive(rowIdx) {
  emit('request-new-dive', { rowIdx })
}

// Caller invokes this after the Create-Dive sub-modal returns the
// newly-created dive-directory row. We flip the row's dive_id and
// metadata over to the new dive, then close the picker so the
// operator sees the success state.
function applyDiveAtRow(rowIdx, dive) {
  const slot = props.modelValue[rowIdx]
  if (!slot || !dive) return
  slot.dive_id = dive.id
  slot._label  = `${dive.dive_code}${dive.position || ''} · DD ${dive.dd}`
  slot._meta   = {
    dive_code:   dive.dive_code,
    position:    dive.position,
    dd:          dive.dd,
    height:      Number(dive.height),
    description: dive.description,
  }
  closeDivePicker()
}

defineExpose({ applyDiveAtRow })
</script>

<template>
  <div class="field rd-editor">
    <label class="label rd-header">
      <span>Round dives</span>
      <span class="rd-total">{{ modelValue.length }} round{{ modelValue.length === 1 ? '' : 's' }}</span>
    </label>
    <p class="hint rd-empty-hint" v-if="!modelValue.length">
      Click <strong>+ Add Dive</strong> for each round. Pin a specific
      dive (operator-prescribed), or leave it blank for the diver
      to pick.
    </p>

    <div v-for="(slot, idx) in modelValue" :key="idx" class="rd-row">
      <div class="rd-row-num">R{{ idx + 1 }}</div>
      <div class="rd-row-pick">
        <input v-if="pickerOpenIdx !== idx"
               class="input rd-pick-input"
               :value="slot._label || (slot.dive_id ? '(loading…)' : '')"
               :placeholder="slot.dive_id ? '' : 'Diver picks · click to pin a dive'"
               readonly
               @click="openDivePicker(idx)">
        <input v-else
               class="input rd-pick-input"
               v-model="pickerQuery"
               placeholder="Search dive code, position, or description…"
               autofocus
               @blur="onPickerBlur(idx)">

        <div v-if="pickerOpenIdx === idx" class="rd-pick-popover">
          <div v-if="!divePickerResults.length" class="rd-pick-empty">
            No dives match. Adjust the search or
            <button type="button" class="rd-pick-create-link"
                    @mousedown.prevent="requestNewDive(idx)">
              add a new dive →
            </button>
          </div>
          <div v-for="d in divePickerResults" :key="d.id"
               class="rd-pick-result"
               @mousedown.prevent="selectDiveForRow(d)">
            <span class="rd-pick-code">{{ d.dive_code }}{{ d.position }}</span>
            <span class="rd-pick-meta">{{ d.height }}m · DD {{ d.dd }}</span>
            <span class="rd-pick-desc">{{ d.description }}</span>
          </div>
          <div v-if="divePickerResults.length" class="rd-pick-footer">
            <button type="button" class="rd-pick-create-link"
                    @mousedown.prevent="requestNewDive(idx)">
              + Add a new dive…
            </button>
          </div>
        </div>
      </div>

      <!-- Mixed-board events expose a per-slot height selector so an
           operator can leave the dive free but pin the round to a
           particular board. Hidden when the event uses a single
           fixed height. -->
      <select v-if="mixedHeight" class="select rd-row-height" v-model="slot.height">
        <option :value="null">— Any board —</option>
        <option value="0">0m</option>
        <option value="1">1m</option>
        <option value="3">3m</option>
        <option value="5">5m</option>
        <option value="7.5">7.5m</option>
        <option value="10">10m</option>
      </select>

      <button type="button" class="btn btn-ghost btn-sm rd-row-clear"
              v-if="slot.dive_id"
              @click="clearDiveForRow(idx)"
              v-tip="'Unpin this dive (slot becomes free)'">↺</button>
      <button type="button" class="btn btn-ghost btn-sm rd-row-remove"
              @click="removeRoundDive(idx)" v-tip="'Remove this round'">✕</button>
    </div>

    <div class="rd-actions">
      <button type="button" class="btn btn-primary btn-sm" @click="addRoundDive">
        + Add Dive
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Round-dives editor (migration 039): one row per round, with a
   click-to-search dive picker, optional per-slot height for
   mixed-board events, and quick-clear / remove buttons. Lifted
   verbatim from ManagerView.css when the editor got extracted
   into this component. */
.rd-editor { display:flex; flex-direction:column; gap:0.5rem; }
.rd-header { display:flex; align-items:center; justify-content:space-between; gap:0.5rem; }
.rd-empty-hint { margin:0 0 0.5rem; }
.rd-total {
  font-size:11px; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--text-2);
  background:rgba(0, 224, 255, 0.08); padding:0.2rem 0.6rem; border-radius:999px;
}
.rd-row {
  display:grid;
  grid-template-columns: 38px 1fr auto auto auto;
  align-items:center; gap:0.5rem;
  padding:0.4rem; border:1px solid var(--border); border-radius:var(--radius);
  background:rgba(255,255,255,0.02);
}
.rd-row-num {
  font-family:var(--font-mono); font-weight:bold; color:var(--cyan);
  text-align:center;
  background:rgba(0,224,255,0.06); border-radius:6px; padding:0.4rem 0;
}
.rd-row-pick { position:relative; min-width:0; }
.rd-pick-input { font-size:13px; padding:0.5rem 0.75rem; }
.rd-pick-popover {
  position:absolute; top:calc(100% + 4px); inset-inline-start:0; inset-inline-end:0; z-index:10;
  background:var(--bg-2); border:1px solid var(--border); border-radius:var(--radius);
  max-height:280px; overflow-y:auto;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.rd-pick-empty {
  padding:0.75rem; font-size:13px; color:var(--text-2);
  display:flex; flex-direction:column; gap:0.5rem;
}
.rd-pick-result {
  padding:0.5rem 0.75rem; font-size:13px;
  border-top:1px solid var(--border); cursor:pointer;
  display:grid; grid-template-columns: 60px 90px 1fr; gap:0.5rem; align-items:center;
}
.rd-pick-result:first-child { border-top:none; }
.rd-pick-result:hover { background:rgba(0, 224, 255, 0.06); }
.rd-pick-code { font-family:var(--font-mono); font-weight:bold; color:var(--cyan); }
.rd-pick-meta { font-family:var(--font-mono); color:var(--text-2); font-size:12px; }
.rd-pick-desc { color:var(--text-2); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rd-pick-footer {
  border-top:1px solid var(--border); padding:0.4rem 0.75rem;
}
.rd-pick-create-link {
  background:none; border:none; padding:0;
  color:var(--cyan); font-size:12px; cursor:pointer; font-family:var(--font-mono);
}
.rd-pick-create-link:hover { text-decoration:underline; }
.rd-row-height { max-width:120px; font-size:13px; padding:0.5rem 0.75rem; }
.rd-row-clear, .rd-row-remove { padding:0.3rem 0.55rem; }
.rd-actions {
  display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-top:0.4rem;
}

/* Mobile: the 5-column row pinches at 360-414px because the picker
   input + dropdown can't shrink past their content. Re-flow with
   grid-template-areas: round number pins to the left, the picker
   spans the full width, and the height select + action buttons sit
   on a second line beside it. The popover stays
   position:absolute + inset-inline-start:0/right:0, it's its own
   internal 3-col grid (code, meta, desc) that needs to wrap. */
@media (max-width: 600px) {
  .rd-row {
    grid-template-columns: 38px 1fr auto auto;
    grid-template-areas:
      "num pick   pick   pick"
      "num height clear  remove";
    row-gap: 0.35rem;
    column-gap: 0.4rem;
    padding: 0.5rem;
  }
  .rd-row-num    { grid-area: num; align-self: stretch;
                   display: flex; align-items: center; justify-content: center;
                   padding: 0; }
  .rd-row-pick   { grid-area: pick; }
  .rd-row-height { grid-area: height; max-width: none; width: 100%; }
  .rd-row-clear  { grid-area: clear;  justify-self: end; }
  .rd-row-remove { grid-area: remove; justify-self: end; }

  /* Picker result row: code + meta on one line, desc wraps under. */
  .rd-pick-result {
    grid-template-columns: auto 1fr;
    row-gap: 0.1rem;
  }
  .rd-pick-desc {
    grid-column: 1 / -1;
    white-space: normal;
  }

  /* iOS Safari auto-zooms whenever an <input> with font-size <
     16px receives focus. The dive-code picker and height input
     are the coachs primary editing surface, so getting zoomed
     every time they tap would be unworkable. */
  .rd-pick-input,
  .rd-row-height { font-size: 16px; }
}
</style>
