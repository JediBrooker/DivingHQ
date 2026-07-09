<script setup>
/* LateEntryModal, the "Add Late Diver" form, extracted from
 * ControlView.vue. One autocomplete input per round (the diver
 * competes every round), validated against the dive directory at
 * the event's height. Synchro events add a partner picker, team
 * events a team picker.
 *
 * Mount contract: the parent keeps this ALWAYS mounted and drives
 * visibility via the `open` prop. That preserves the
 * pre-extraction once-per-session caches: org divers, the dive
 * directory, and the event's teams are lazy-loaded on first open
 * and reused on every later open (a v-if mount would refetch them).
 *
 * State boundary: the whole form is OWNED here. A successful
 * submit emits `added` with the freshly fetched roster, and the
 * parent assigns it and runs its audit/conflict refreshes.
 */
import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'
import { diveDescription } from '@/composables/useDiveLabel'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'

const props = defineProps({
  open:  { type: Boolean, default: false },
  event: { type: Object,  default: null },
})
const emit = defineEmits(['close', 'added'])

const auth = useAuthStore()
const { queueAction } = useHttpOutbox()

const lateBusy = ref(false)
const lateErr = ref('')
const lateDivers  = ref([])          // candidate divers in the org
const lateDiveDir = ref([])          // full dive directory (filtered to height in lateDiveOptions)
const latePartnerId = ref('')        // synchro-pair only
const lateTeamId    = ref('')        // team events only
const lateTeams     = ref([])        // teams enrolled in the event

// One slot per round. Each slot holds the typed input string
// (`text`) and the resolved dive directory entry (`dive`, may be
// null until the input matches a known code+position).
const lateRounds = ref([])
const lateActiveSlot = ref(-1)        // which slot's autocomplete dropdown is open

// The diver shown in the picker. Stored at the form level rather
// than per-round since all rounds belong to the same diver.
// Deliberately NOT reset on reopen, same stickiness the inline
// version had.
const lateCompetitorId = ref('')

// Per-open init, basically the body of the old openLateEntry()
// minus the open flag (the parent owns that now). Pre-flush
// watch so the reset lands before the modal paints.
watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  lateErr.value = ''
  lateBusy.value = false
  latePartnerId.value = ''
  lateTeamId.value = ''
  lateActiveSlot.value = -1
  // Build N empty slots based on the event's total_rounds. Default
  // to 6 if the event metadata hasnt loaded yet (rare).
  const totalRounds = Number(props.event?.total_rounds) || 6
  lateRounds.value = Array.from({ length: totalRounds }, () => ({ text: '', dive: null, competitorId: '' }))
  // Lazy-load org divers + dive directory once per session
  if (!lateDivers.value.length) {
    try {
      lateDivers.value = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/divers`)
    } catch { lateDivers.value = [] }
  }
  if (!lateDiveDir.value.length) {
    try {
      // Cached read: first open of the late-add modal in a session
      // hits the network, subsequent opens (same or different meets)
      // serve from IDB instantly.
      const result = await auth.cachedApiFetch('/api/dive-directory', {
        cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS },
      })
      lateDiveDir.value = Array.isArray(result.data) ? result.data : []
    } catch { lateDiveDir.value = [] }
  }
  // Teams enrolled in this event, only used when event_type === 'team'
  if (props.event?.event_type === 'team' && !lateTeams.value.length) {
    try {
      lateTeams.value = await auth.apiFetch(`/api/events/${props.event.id}/teams`)
    } catch { lateTeams.value = [] }
  }
})

// Dive directory filtered to the event's height. Re-used by every
// round's autocomplete; matching is on `dive_code + position` so
// "5132D" finds the dive even when the user hasn't typed a space.
const lateDiveOptions = computed(() => {
  const eventHeight = props.event?.height
  const heightNumeric = eventHeight ? parseFloat(eventHeight) : null
  return lateDiveDir.value.filter(d =>
    heightNumeric === null || parseFloat(d.height) === heightNumeric,
  )
})

// Autocomplete results for a single round's input. Caps at 8 so
// the dropdown never overflows the modal. Empty input = empty list.
function lateMatchesFor(idx) {
  const term = (lateRounds.value[idx]?.text || '').toLowerCase().trim()
  if (!term) return []
  return lateDiveOptions.value.filter(d => {
    const combined = (d.dive_code + d.position).toLowerCase()
    return combined.includes(term) || (d.description || '').toLowerCase().includes(term)
  }).slice(0, 8)
}

// Try to resolve the typed text directly against the directory
// (no dropdown needed). Used when the user tabs out, if they
// typed exactly "5132D" we silently lock it in. Returns the dive
// or null.
function resolveTypedDive(text) {
  if (!text) return null
  const norm = text.toUpperCase().trim()
  // Match against (dive_code + position) concatenated, OR just
  // dive_code if position is empty (rare for diving).
  return lateDiveOptions.value.find(d =>
    (d.dive_code + d.position).toUpperCase() === norm,
  ) || null
}

function lateOnInput(idx) {
  // Open this row's dropdown; close any other.
  lateActiveSlot.value = idx
  // If the typed text matches an entry exactly, lock it in. The
  // dropdown still shows in case the operator wants to pick a
  // similar one, but submit will already work.
  const slot = lateRounds.value[idx]
  slot.dive = resolveTypedDive(slot.text)
}

function latePickDive(idx, dive) {
  lateRounds.value[idx].dive = dive
  lateRounds.value[idx].text = `${dive.dive_code}${dive.position}`
  lateActiveSlot.value = -1
  // Move focus to the next empty round if there is one, keeps the
  // entry workflow fast for an operator typing through a list.
  const nextIdx = lateRounds.value.findIndex((s, i) => i > idx && !s.dive)
  if (nextIdx >= 0) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`#late-round-${nextIdx}`)
      if (el) el.focus()
    })
  }
}

function lateCloseDropdown(idx) {
  // setTimeout so a click on a result registers before blur tears
  // down the dropdown.
  setTimeout(() => {
    if (lateActiveSlot.value === idx) lateActiveSlot.value = -1
  }, 150)
}

const lateAllFilled = computed(() =>
  lateRounds.value.length > 0 && lateRounds.value.every(s => !!s.dive),
)
const lateTotalDD = computed(() =>
  lateRounds.value.reduce((sum, s) => sum + (s.dive ? Number(s.dive.dd) : 0), 0).toFixed(1),
)

async function submitLateEntry() {
  lateErr.value = ''
  if (!lateCompetitorId.value) { lateErr.value = 'Pick a diver'; return }

  // Re-resolve any rows where the operator typed but didn't click
  // a result, gives them one last chance before we error out.
  for (const slot of lateRounds.value) {
    if (!slot.dive && slot.text) slot.dive = resolveTypedDive(slot.text)
  }
  const missing = lateRounds.value
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.dive)
  if (missing.length) {
    lateErr.value = `Missing dive for round${missing.length > 1 ? 's' : ''} ` +
      missing.map(m => m.i + 1).join(', ')
    return
  }
  // Synchro events need a partner; team events need a team.
  if (props.event?.event_type === 'synchro_pair' && !latePartnerId.value) {
    lateErr.value = 'Synchronised events need a partner.'
    return
  }
  if (props.event?.event_type === 'team' && !lateTeamId.value) {
    lateErr.value = 'Team events need a team.'
    return
  }

  lateBusy.value = true
  try {
    // POST one row per round. The endpoint upserts on
    // (event_id, competitor_id, round_number) so a re-run after
    // a partial failure is safe, the operator just clicks Add
    // again and we backfill whatever's missing.
    for (let i = 0; i < lateRounds.value.length; i++) {
      const slot = lateRounds.value[i]
      await queueAction({
        method: 'POST',
        url: `/api/events/${props.event.id}/roster`,
        body: {
          competitor_id: lateCompetitorId.value,
          dive_id:       slot.dive.id,
          round_number:  i + 1,
          partner_id:    latePartnerId.value || null,
          team_id:       lateTeamId.value    || null,
        },
        actionType: 'roster_late_add',
      })
    }
    // Re-pull roster so the new rows appear in the queue with
    // their dive_list_ids and display order. The parent assigns
    // it + runs the audit/conflict refreshes.
    const fresh = await auth.apiFetch(`/api/events/${props.event.id}/roster`)
    emit('added', fresh)
    emit('close')
  } catch (err) {
    lateErr.value = err.message
  } finally {
    lateBusy.value = false
  }
}
</script>

<template>
  <BaseModal :open="open" max-width="600px" @close="$emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" title="Add Late Diver" :subtitle="event?.name" @close="$emit('close')" />
    <div class="lb-body">
      <div class="field">
        <label class="label">Diver</label>
        <select class="select" v-model="lateCompetitorId">
          <option value="">— Pick a diver —</option>
          <option v-for="d in lateDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
        </select>
      </div>

      <!-- Synchro pair partner picker, only shown for synchro_pair events. -->
      <div v-if="event?.event_type === 'synchro_pair'" class="field">
        <label class="label">Partner</label>
        <select class="select" v-model="latePartnerId">
          <option value="">— Pick partner —</option>
          <option v-for="d in lateDivers"
                  :key="d.id"
                  :value="d.id"
                  :disabled="d.id === lateCompetitorId">
            {{ d.full_name }}
          </option>
        </select>
      </div>

      <!-- Team picker, only shown for team events. -->
      <div v-if="event?.event_type === 'team'" class="field">
        <label class="label">Team</label>
        <select class="select" v-model="lateTeamId">
          <option value="">— Pick team —</option>
          <option v-for="t in lateTeams" :key="t.id" :value="t.id">
            {{ t.name }}<span v-if="t.short_code"> ({{ t.short_code }})</span>
          </option>
        </select>
      </div>

      <div class="late-rounds">
        <div class="late-rounds-head">
          <span class="late-rounds-label">
            {{ lateRounds.length }}-round dive list
            <span v-if="event?.height" class="late-rounds-height">{{ event.height }} board</span>
          </span>
          <span class="late-rounds-dd">Total DD <strong>{{ lateTotalDD }}</strong></span>
        </div>
        <div
          v-for="(slot, idx) in lateRounds"
          :key="idx"
          class="late-row"
        >
          <span class="late-row-num">{{ idx + 1 }}</span>
          <div class="late-row-input-wrap">
            <input
              class="input"
              type="text"
              :id="`late-round-${idx}`"
              v-model="slot.text"
              :placeholder="`e.g. 5132D`"
              autocomplete="off"
              maxlength="8"
              @input="lateOnInput(idx)"
              @focus="lateActiveSlot = idx"
              @blur="lateCloseDropdown(idx)"
            >
            <span v-if="slot.dive" class="late-row-resolved" v-tip="'Dive matched in directory'">✓</span>
            <ul v-if="lateActiveSlot === idx && lateMatchesFor(idx).length"
                class="late-autocomplete">
              <li v-for="d in lateMatchesFor(idx)"
                  :key="d.id"
                  class="late-autocomplete-item"
                  @mousedown.prevent="latePickDive(idx, d)">
                <span class="late-ac-code">{{ d.dive_code }}<span class="late-ac-pos">{{ d.position }}</span></span>
                <span class="late-ac-desc">{{ diveDescription(d) }}</span>
                <span class="late-ac-dd">DD {{ d.dd }}</span>
              </li>
            </ul>
          </div>
          <span class="late-row-meta">
            <template v-if="slot.dive">
              <span class="late-row-desc">{{ diveDescription(slot.dive) }}</span>
              <span class="late-row-dd">DD {{ slot.dive.dd }}</span>
            </template>
            <template v-else>
              <span class="dim">—</span>
            </template>
          </span>
        </div>
      </div>

      <p class="hint" v-if="lateDiveOptions.length">
        {{ lateDiveOptions.length }} dives available at {{ event?.height }}. Type a dive code + position (e.g. <strong>5132D</strong>) and pick from the list, or hit ✓ when an exact match auto-resolves.
      </p>
      <div v-if="lateErr" class="msg msg-error">{{ lateErr }}</div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm"
                :disabled="lateBusy || !lateAllFilled || !lateCompetitorId"
                v-tip="!lateCompetitorId ? 'Pick a diver from the list above first'
                  : (!lateAllFilled ? 'Fill in a dive for every round before submitting' : '')"
                @click="submitLateEntry">
          {{ lateBusy ? 'Adding…' : `Add ${lateRounds.length}-round list` }}
        </button>
      </div>
    </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* Late-entry styles MOVED from ControlView.css (exclusive to
   this modal). The lb-* frame now lives in BaseModal + the global
   lb-* in ControlView.css (max-width passed via BaseModal). */
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.5rem 0.7rem; margin-top: 0.4rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}
.hint strong { color: var(--cyan); font-family: var(--font-mono); }

/* Per-round dive list inside the late-entry modal. One row per
   round of the event; each row has a number gutter, an autocomplete
   text input, and a resolved-dive description on the right. */
.late-rounds {
  display: flex; flex-direction: column; gap: 0.4rem;
  margin-top: 0.75rem;
}
.late-rounds-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 0.4rem;
}
.late-rounds-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--text-3);
}
.late-rounds-height {
  font-family: var(--font-mono); font-size: 10px; font-weight: 400;
  letter-spacing: 0.05em; color: var(--cyan); margin-inline-start: 0.5rem;
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.05rem 0.4rem; vertical-align: middle;
}
.late-rounds-dd {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.late-rounds-dd strong { color: var(--cyan); font-weight: 700; margin-inline-start: 0.25rem; }

.late-row {
  display: grid; grid-template-columns: 28px 140px 1fr;
  align-items: center; gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.late-row-num {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--cyan); text-align: center;
}
.late-row-input-wrap { position: relative; }
.late-row-input-wrap > .input {
  font-family: var(--font-mono); font-size: 13px; padding-inline-end: 1.6rem;
  text-transform: uppercase;
}
.late-row-resolved {
  position: absolute; inset-inline-end: 0.6rem; top: 50%; transform: translateY(-50%);
  color: var(--cyan); font-weight: 700; font-size: 12px; pointer-events: none;
}
.late-row-meta {
  display: flex; align-items: baseline; gap: 0.5rem; min-width: 0;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
}
.late-row-desc {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.late-row-dd { color: var(--cyan); flex-shrink: 0; }

.late-autocomplete {
  position: absolute; top: 100%; inset-inline-start: 0; inset-inline-end: 0; z-index: 5;
  margin: 0.3rem 0 0; padding: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 12px 28px rgba(0,0,0,0.5);
  max-height: 240px; overflow-y: auto; list-style: none;
}
.late-autocomplete-item {
  display: grid; grid-template-columns: 70px 1fr auto;
  align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 12px;
}
.late-autocomplete-item:last-child { border-bottom: none; }
.late-autocomplete-item:hover { background: var(--bg-3); }
.late-ac-code { font-weight: 700; color: var(--text); }
.late-ac-pos  { color: var(--cyan); margin-inline-start: 0.1rem; }
.late-ac-desc { color: var(--text-2);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.late-ac-dd   { color: var(--cyan); font-weight: 700; }

@media (max-width: 720px) {
  .late-row { grid-template-columns: 24px 1fr; }
  .late-row-meta {
    grid-column: 1 / -1; padding-inline-start: 30px;
    font-size: 11px;
  }
}

/* The lb-* modal frame now lives in BaseModal.vue (frame) + the global
   lb-header/lb-title/lb-event/lb-body in ControlView.css (P2). */
</style>
