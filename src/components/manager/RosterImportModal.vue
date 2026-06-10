<script setup>
/* RosterImportModal — per-event roster CSV import, extracted from
 * ManagerView.vue. Manager pastes a CSV; backend parses, looks up
 * each diver by username, validates dives in the directory, and
 * bulk-creates dive list rows. Per-row errors are reported without
 * failing the whole import.
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * target event, so every open starts from a blank CSV (same as
 * the old openRosterImport() reset).
 *
 * State boundary: csv / busy / preview / result / error are OWNED
 * here. Import preview-then-confirm both hit the same endpoint
 * (preview: true flag); nothing in the parent's event list needs
 * patching afterwards, so the only emit is `close`.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  event: { type: Object, required: true },
})
defineEmits(['close'])

const auth = useAuthStore()

const rosterCsv = ref('')
const rosterBusy = ref(false)
const rosterResult = ref(null)   // { added, skipped, errors }
const rosterPreview = ref(null)
const rosterPreviewSource = ref('')
const rosterErr = ref('')
const rosterPreviewReady = computed(() =>
  !!rosterPreview.value && rosterPreviewSource.value === rosterCsv.value,
)

async function previewRosterImport() {
  if (!rosterCsv.value.trim()) {
    rosterErr.value = 'Paste a CSV first'
    return
  }
  rosterBusy.value = true
  rosterErr.value = ''
  rosterResult.value = null
  rosterPreview.value = null
  try {
    rosterPreview.value = await auth.apiFetch(
      `/api/events/${props.event.id}/roster/import`,
      { method: 'POST', body: JSON.stringify({ csv: rosterCsv.value, preview: true }) },
    )
    rosterPreviewSource.value = rosterCsv.value
  } catch (err) {
    rosterErr.value = err.message
  } finally {
    rosterBusy.value = false
  }
}

async function submitRosterImport() {
  if (!rosterPreviewReady.value) {
    rosterErr.value = 'Preview the current CSV before importing'
    return
  }
  rosterBusy.value = true
  rosterErr.value = ''
  rosterResult.value = null
  try {
    rosterResult.value = await auth.apiFetch(
      `/api/events/${props.event.id}/roster/import`,
      { method: 'POST', body: JSON.stringify({ csv: rosterCsv.value }) },
    )
    rosterPreview.value = null
    rosterPreviewSource.value = ''
  } catch (err) {
    rosterErr.value = err.message
  } finally {
    rosterBusy.value = false
  }
}

// Build a sample CSV header that matches the event's round count
// so the manager has a starting template.
function rosterTemplateHeader(ev) {
  if (!ev) return ''
  const rounds = ev.total_rounds || 6
  const cols = ['username']
  if (ev.event_type === 'synchro_pair') cols.push('partner_username')
  for (let n = 1; n <= rounds; n++) {
    cols.push(`round_${n}_code`, `round_${n}_pos`)
  }
  return cols.join(',')
}
</script>

<template>
  <div class="modal-backdrop" @click="$emit('close')"></div>
  <div class="modal roster-modal" @click.stop>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <div>
        <div class="teams-section-label">{{ $t('manager.modals.roster_import_section_label') }}</div>
        <h2 style="font-size:20px;line-height:1">{{ event?.name }}</h2>
      </div>
      <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.close') }}</button>
    </div>

    <p class="hint" style="margin-bottom:0.75rem">
      Paste a CSV with one diver per row. First row must be a header.
      Required columns: <code>username</code>,
      <code>round_1_code</code>, <code>round_1_pos</code>, …
      <span v-if="event?.event_type === 'synchro_pair'">
        Synchro events also accept <code>partner_username</code>.
      </span>
      Existing dive list rows for the same diver + round are
      overwritten (idempotent re-runs).
    </p>

    <div class="field">
      <label class="label">Template header for this event</label>
      <input class="input mono"
             type="text"
             :value="rosterTemplateHeader(event)"
             readonly
             style="font-size:11px"
             v-tip="'Click to select; copy as the first row of your CSV'">
    </div>

    <div class="field">
      <label class="label">CSV</label>
      <textarea
        class="input mono"
        v-model="rosterCsv"
        rows="10"
        style="font-size:12px"
        placeholder="username,round_1_code,round_1_pos,round_2_code,round_2_pos&#10;phoenix.patel,5132,D,107,B&#10;..."
      ></textarea>
    </div>

    <div v-if="rosterErr" class="msg msg-error">{{ rosterErr }}</div>

    <div v-if="rosterPreview" class="roster-result roster-preview">
      <div class="msg msg-warn" v-if="!rosterPreviewReady">
        CSV changed after preview — preview again before importing.
      </div>
      <div class="msg msg-success" v-else>
        Preview ready:
        <strong>{{ rosterPreview.added }}</strong>
        diver{{ rosterPreview.added === 1 ? '' : 's' }},
        <strong>{{ rosterPreview.rounds_written }}</strong>
        round{{ rosterPreview.rounds_written === 1 ? '' : 's' }} to write<span v-if="rosterPreview.skipped">, skipped {{ rosterPreview.skipped }}</span>.
      </div>
      <div v-if="rosterPreview.rows?.length" class="roster-preview-list">
        <div v-for="(row, i) in rosterPreview.rows.slice(0, 8)" :key="`${row.username}-${i}`" class="roster-preview-row">
          <span class="roster-preview-name">
            {{ row.full_name || row.username }}
            <em v-if="row.partner_name">with {{ row.partner_name }}</em>
          </span>
          <span class="roster-preview-actions">
            {{ row.rounds.filter(r => r.action === 'insert').length }} new ·
            {{ row.rounds.filter(r => r.action === 'update').length }} update
          </span>
        </div>
        <div v-if="rosterPreview.rows.length > 8" class="hint">
          Showing first 8 of {{ rosterPreview.rows.length }} rows.
        </div>
      </div>
      <div v-if="rosterPreview.errors?.length" class="roster-errors">
        <div class="teams-section-label" style="margin-top:0.6rem">{{ rosterPreview.errors.length }} preview error(s)</div>
        <ul class="roster-error-list">
          <li v-for="(e, i) in rosterPreview.errors" :key="i">
            <strong>{{ e.username }}</strong>: {{ e.error }}
          </li>
        </ul>
      </div>
    </div>

    <div v-if="rosterResult" class="roster-result">
      <div class="msg msg-success">
        Added / updated rosters for <strong>{{ rosterResult.added }}</strong>
        diver{{ rosterResult.added === 1 ? '' : 's' }}
        and <strong>{{ rosterResult.rounds_written }}</strong>
        round{{ rosterResult.rounds_written === 1 ? '' : 's' }}<span v-if="rosterResult.skipped">, skipped {{ rosterResult.skipped }}</span>.
      </div>
      <div v-if="rosterResult.errors?.length" class="roster-errors">
        <div class="teams-section-label" style="margin-top:0.6rem">{{ rosterResult.errors.length }} row error(s)</div>
        <ul class="roster-error-list">
          <li v-for="(e, i) in rosterResult.errors" :key="i">
            <strong>{{ e.username }}</strong>: {{ e.error }}
          </li>
        </ul>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
      <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.done') }}</button>
      <button class="btn btn-ghost btn-sm"
              :disabled="rosterBusy || !rosterCsv.trim()"
              @click="previewRosterImport">
        {{ rosterBusy ? 'Checking…' : 'Preview changes' }}
      </button>
      <button class="btn btn-primary btn-sm"
              :disabled="rosterBusy || !rosterPreviewReady"
              @click="submitRosterImport">
        {{ rosterBusy ? $t('manager.modals.roster_importing') : 'Confirm import' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Roster styles MOVED from ManagerView.css (exclusive to this
   modal — .roster-* and the .modal.roster-modal viewport pin).
   .teams-section-label and .hint are COPIED from ManagerView.css
   (shared with the teams / federations / readiness modals and the
   rest of the manager page). */

/* The modal renders as a sibling of an EMPTY .modal-backdrop (not
   nested inside it), so the global .modal (position: static) would
   drop to the bottom of the long events page instead of centring.
   Pin to the viewport centre, above the backdrop; scrolls
   internally if tall. */
.modal.roster-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 201;
  max-height: 90vh;
  overflow-y: auto;
}
.roster-modal { max-width: 720px; }
.roster-modal .mono { font-family: var(--font-mono); }
.roster-modal textarea { resize: vertical; min-height: 180px; }
.roster-modal .hint code {
  font-family: var(--font-mono); font-size: 10.5px;
  background: var(--bg-2); border: 1px solid var(--border);
  padding: 0.05rem 0.3rem; border-radius: 3px;
  color: var(--cyan);
}

.roster-result { margin-top: 0.75rem; }
.roster-preview-list {
  display: flex; flex-direction: column; gap: 0.35rem;
  margin-top: 0.55rem;
}
.roster-preview-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; padding: 0.4rem 0.55rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.roster-preview-name {
  min-width: 0; font-family: var(--font-display); font-size: 12px;
  font-weight: 700; color: var(--text);
}
.roster-preview-name em {
  display: block; margin-top: 0.1rem;
  font-family: var(--font-mono); font-size: 10.5px;
  font-style: normal; color: var(--text-3);
}
.roster-preview-actions {
  flex-shrink: 0; font-family: var(--font-mono); font-size: 10.5px;
  color: var(--cyan);
}
.roster-errors {
  margin-top: 0.4rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-inline-start: 3px solid var(--amber); border-radius: 3px;
  padding: 0.6rem 0.8rem;
}
.roster-error-list {
  list-style: disc; padding-inline-start: 1.25rem; margin: 0;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
  max-height: 200px; overflow-y: auto;
}
.roster-error-list li { margin: 0.15rem 0; }

/* COPIED — section label + hint blocks shared with the other
   manager modals (see ManagerView.css). */
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

/* Phone full-bleed — copied from ManagerView.css's 600px block. */
@media (max-width: 600px) {
  .modal,
  .roster-modal {
    max-width: 100%;
    width: 100%;
  }
}
</style>
