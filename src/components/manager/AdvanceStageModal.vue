<script setup>
/* AdvanceStageModal — stage-progression dialog (prelim/semi →
 * next stage), extracted from ManagerView.vue. Opened from a
 * Completed prelim/semifinal row's "Advance to next stage →"
 * button; the operator picks top N + reserves + dive-order mode
 * with a live preview of the World Aquatics tie-break ranking
 * before seeding.
 *
 * Mount contract: the parent mounts this with v-if keyed on the
 * parent (feeder) event, so every open re-fetches the preview
 * (same as the old openAdvanceModal()). The body scroll lock
 * stays in the parent, keyed off the same open condition.
 *
 * State boundary: child/ranked/topN/reserves/diveOrder/loading/
 * error are OWNED here. A successful advance emits `advanced` —
 * the parent reloads its event list (statuses + rosters changed
 * server-side) — then `close`.
 */
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess } from '@/composables/useNotify'
import { RULE_REFERENCES } from '@/lib/ruleReferences'

const props = defineProps({
  // The FEEDER event (preliminary or semifinal) being advanced.
  event: { type: Object, required: true },
})
const emit = defineEmits(['close', 'advanced'])

const auth = useAuthStore()

const advanceChild     = ref(null)
const advanceRanked    = ref([])
const advanceTopN      = ref(props.event.advance_count || 12)
// Default 4 reserves — typical at WA-sanctioned events so the
// referee has a buffer if multiple primaries withdraw before
// the next stage begins. Operator can override per advance.
const advanceReserves  = ref(4)
// World Aquatics Article 4.1.8 (semi) + 4.1.10 (subsequent
// stages): both semi-final and final use REVERSE-RANK start
// order based on the previous stage's results. Default the
// dive_order picker to 'reverse' regardless of stage; the
// operator can still override to 'inherit' or 'random' for
// non-WA-sanctioned events.
const advanceDiveOrder = ref('reverse')   // 'inherit' | 'reverse' | 'random'
const advanceLoading   = ref(false)
const advanceErr       = ref('')

async function loadAdvancePreview() {
  advanceLoading.value = true
  try {
    const preview = await auth.apiFetch(`/api/events/${props.event.id}/advance/preview`)
    advanceChild.value  = preview.child
    advanceRanked.value = Array.isArray(preview.ranked) ? preview.ranked : []
    if (!advanceChild.value) {
      advanceErr.value = 'No downstream event linked. Create the next stage event first.'
    }
  } catch (err) {
    advanceErr.value = err.message || 'Failed to load preview'
  } finally {
    advanceLoading.value = false
  }
}
// Initial load on mount — same cadence as the old open handler.
loadAdvancePreview()

async function confirmAdvance() {
  advanceErr.value = ''
  const topN = parseInt(advanceTopN.value)
  const reserves = parseInt(advanceReserves.value) || 0
  if (!Number.isInteger(topN) || topN < 1) {
    advanceErr.value = 'Top N must be a positive integer'
    return
  }
  if (topN + reserves > advanceRanked.value.length) {
    advanceErr.value = `Only ${advanceRanked.value.length} divers were scored — top + reserves can't exceed that`
    return
  }
  advanceLoading.value = true
  try {
    const result = await auth.apiFetch(`/api/events/${props.event.id}/advance`, {
      method: 'POST',
      body: JSON.stringify({
        top_n: topN,
        reserves,
        dive_order: advanceDiveOrder.value,
      }),
    })
    const targetLabel = advanceChild.value?.format === 'final' ? 'final' : 'semi-final'
    showSuccess(
      `Advanced ${result.advanced} diver${result.advanced === 1 ? '' : 's'} to the ${targetLabel}` +
      (result.reserves ? ` (+${result.reserves} reserve${result.reserves === 1 ? '' : 's'})` : '') +
      '.'
    )
    emit('advanced')
    emit('close')
  } catch (err) {
    advanceErr.value = err.message || 'Failed to advance'
  } finally {
    advanceLoading.value = false
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal modal-advance" @click.stop style="max-width:640px" role="dialog" aria-modal="true" aria-labelledby="mgr-advance-title">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 id="mgr-advance-title" style="font-size:22px">{{ $t('manager.modals.advance_title') }}</h2>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.cancel_x') }}</button>
      </div>

      <p class="hint" style="margin-bottom:1rem">
        Seed
        <strong>{{
          advanceChild?.format === 'final' ? 'the final'
          : advanceChild?.format === 'semifinal' ? 'the semi-final'
          : 'the next stage'
        }}</strong>
        from <strong>"{{ event.name }}"</strong> based on the World Aquatics tie-break ranking.
        {{ RULE_REFERENCES.withdrawalAdvancement }}.
      </p>

      <div v-if="advanceErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ advanceErr }}</div>
      <div v-if="advanceLoading" class="hint" style="margin-bottom:0.75rem">Loading preview…</div>

      <div v-if="!advanceLoading && advanceChild" class="advance-form">
        <div class="advance-field-row">
          <label class="advance-field">
            <span class="label">Top N (primaries)</span>
            <input class="input" type="number" min="1" max="50" v-model="advanceTopN">
          </label>
          <label class="advance-field">
            <span class="label">Reserves</span>
            <input class="input" type="number" min="0" max="50" v-model="advanceReserves">
            <span class="hint" style="margin-top:0.25rem">
              Default 4 reserves (WA-typical buffer). Reserves carry forward
              but don't compete unless promoted from Control Room.
            </span>
          </label>
        </div>

        <div class="advance-field" style="margin-top:1rem">
          <span class="label">Dive order in {{ advanceChild.format === 'final' ? 'the final' : 'the next stage' }}</span>
          <label class="advance-radio">
            <input type="radio" value="inherit" v-model="advanceDiveOrder">
            <span><strong>Inherit</strong> — carry the parent's dive order forward, drop non-progressors. <em>Override for non-WA-sanctioned events.</em></span>
          </label>
          <label class="advance-radio">
            <input type="radio" value="reverse" v-model="advanceDiveOrder">
            <span><strong>Reverse</strong> — top diver dives last. <em>{{ RULE_REFERENCES.stageStartOrder }}.</em></span>
          </label>
          <label class="advance-radio">
            <input type="radio" value="random" v-model="advanceDiveOrder">
            <span><strong>Random</strong> — re-randomise primaries.</span>
          </label>
        </div>

        <!-- Preview ranking -->
        <div class="advance-preview" v-if="advanceRanked.length">
          <div class="advance-preview-head">
            Preview · {{ advanceRanked.length }} scored diver{{ advanceRanked.length === 1 ? '' : 's' }}
          </div>
          <div v-for="(d, i) in advanceRanked" :key="d.competitor_id"
               :class="['advance-preview-row',
                        i < parseInt(advanceTopN) ? 'primary'
                        : i < parseInt(advanceTopN) + parseInt(advanceReserves) ? 'reserve'
                        : 'cut']">
            <span class="advance-rank">{{ d.rnk }}</span>
            <span class="advance-name">{{ d.full_name }}</span>
            <span class="advance-total">{{ Number(d.total).toFixed(2) }}</span>
            <span class="advance-tag">
              {{ i < parseInt(advanceTopN) ? '' :
                 i < parseInt(advanceTopN) + parseInt(advanceReserves) ? `Reserve ${i - parseInt(advanceTopN) + 1}` :
                 'cut' }}
            </span>
          </div>
        </div>

        <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
          <button type="button" class="btn btn-ghost" @click="$emit('close')">{{ $t('manager.modals.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="advanceLoading"
                  @click="confirmAdvance">
            {{ advanceLoading ? $t('manager.modals.advance_loading') : $t('manager.modals.advance_submit') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Advance styles MOVED from ManagerView.css (exclusive to this
   modal — .modal-advance / .advance-field* / .advance-radio /
   .advance-preview*; NOT .advance-btn, which is the green
   event-row button and stays with the view). The .hint block is
   COPIED from ManagerView.css (shared with the rest of the
   manager page); .modal/.modal-backdrop are global (app.css). */

/* Advance to next stage — modal layout. The right side surfaces
   a live preview of the ranked divers split into Primaries /
   Reserves / Cut so the operator can see exactly who'll
   progress before clicking the button. */
.modal-advance .advance-form { display:flex; flex-direction:column; gap:0.75rem; }
.advance-field-row { display:flex; gap:0.75rem; }
.advance-field { display:flex; flex-direction:column; flex:1; }
.advance-field .label { margin-bottom:0.4rem; }
.advance-radio {
  display:flex; align-items:flex-start; gap:0.5rem;
  padding:0.5rem 0.6rem; border:1px solid var(--border); border-radius:var(--radius-sm);
  margin-top:0.4rem; cursor:pointer; font-size:13px;
}
.advance-radio:hover { border-color: var(--cyan); }
.advance-radio input { margin-top:3px; }
.advance-radio em { color:var(--text-3); font-style:italic; }

.advance-preview {
  margin-top:1rem;
  border:1px solid var(--border); border-radius:var(--radius-sm);
  max-height:280px; overflow-y:auto;
  background:var(--bg-3);
}
.advance-preview-head {
  padding:0.5rem 0.75rem;
  font-family:var(--font-display); font-size:11px; font-weight:700;
  letter-spacing:0.08em; text-transform:uppercase; color:var(--cyan);
  border-bottom:1px solid var(--border);
  position:sticky; top:0; background:var(--bg-3); z-index:1;
}
.advance-preview-row {
  display:grid; grid-template-columns: 38px 1fr 60px 80px;
  align-items:center; gap:0.5rem;
  padding:0.4rem 0.75rem;
  border-top:1px solid var(--border);
  font-family:var(--font-mono); font-size:12px;
}
.advance-preview-row:first-of-type { border-top:none; }
.advance-preview-row.primary { color:var(--text); }
.advance-preview-row.primary .advance-rank { color:var(--cyan); font-weight:bold; }
.advance-preview-row.reserve {
  color:var(--text-2);
  background:rgba(255, 200, 87, 0.04);
}
.advance-preview-row.reserve .advance-rank { color:#ffc857; }
.advance-preview-row.cut { color:var(--text-3); opacity:0.6; }
.advance-rank { text-align:center; }
.advance-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.advance-total { text-align: end; font-variant-numeric:tabular-nums; }
.advance-tag {
  text-align: end; font-size:10px; text-transform:uppercase;
  letter-spacing:0.06em; color:#ffc857;
}
.advance-preview-row.cut .advance-tag { color:var(--text-3); }

/* COPIED — hint block shared with the rest of the manager page
   (see ManagerView.css). */
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}

/* Phone — copied from ManagerView.css's 600px block. */
@media (max-width: 600px) {
  /* Advance preview rows — 38+60+80 = 178px of fixed cols is too
     greedy on 360px; let the name eat the row, rank pins to the
     left and tag/total wrap underneath. */
  .advance-preview-row {
    grid-template-columns: 32px 1fr auto;
    row-gap: 0.15rem;
    column-gap: 0.4rem;
    padding: 0.45rem 0.6rem;
  }
  .advance-preview { max-height: 220px; }

  .modal {
    max-width: 100%;
    width: 100%;
  }
}
</style>
