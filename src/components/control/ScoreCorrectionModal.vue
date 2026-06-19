<script setup>
/* ScoreCorrectionModal — manager-amend on a finalised dive,
 * extracted from ControlView.vue. Judge picker + new-score input
 * with a live trim-sum / dive-points preview; the PUT routes
 * through the HTTP outbox so a network blip can't lose the edit.
 *
 * Mount contract: the parent mounts this with v-if per open, so
 * the draft fields initialise from the clicked card exactly like
 * the old openCorrection() reset did (J1 preselected, its score
 * prefilled).
 *
 * State boundary: draft fields + preview are OWNED here. On save
 * the clicked history card (the `card` prop) is mutated in place
 * — same object the parent's history list renders — and `saved`
 * tells the parent to refresh its audit strip.
 */
import { ref, computed } from 'vue'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { trimCount } from '@/composables/useScoreCategories'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'

const props = defineProps({
  card:  { type: Object, required: true },  // historyCard the operator clicked
  event: { type: Object, default: null },
})
const emit = defineEmits(['close', 'saved'])

const { queueAction } = useHttpOutbox()

const correctJudgeIdx = ref(0)
const correctNewScore = ref(props.card.scores?.[0]?.toFixed?.(1) || '')
const correctReason = ref('')
const correctBusy = ref(false)
const correctErr = ref('')

// Live preview for the correction modal — recomputes the trim
// sum + dive points the moment the operator types a new score
// so they see the impact before clicking Save.
//
// The trim follows the same rule the live scoring uses
// (trimCount(numJudges)), and synchro pairs multiply by the WA
// 0.6 factor. Returns null when the input is invalid so the
// preview block hides cleanly until a usable score is in.
const correctPreview = computed(() => {
  const card = props.card
  if (!card || !Array.isArray(card.scores) || !card.scores.length) return null
  const newVal = parseFloat(correctNewScore.value)
  if (Number.isNaN(newVal) || newVal < 0 || newVal > 10 || ((newVal * 2) % 1) !== 0) {
    return null
  }
  const idx = correctJudgeIdx.value
  const oldScores = card.scores.map(s => parseFloat(s))
  if (idx < 0 || idx >= oldScores.length) return null
  const newScores = oldScores.slice()
  newScores[idx] = newVal

  const ev = props.event
  const numJudges = parseInt(ev?.number_of_judges) || oldScores.length
  const k = trimCount(numJudges)
  const factor = ev?.event_type === 'synchro_pair' ? 0.6 : 1
  const dd = parseFloat(card.dd) || 0

  function trimSum(scores) {
    const sorted = [...scores].sort((a, b) => a - b)
    const kept = k > 0 && sorted.length > k * 2
      ? sorted.slice(k, sorted.length - k)
      : sorted
    return kept.reduce((a, b) => a + b, 0)
  }

  const oldTrim   = trimSum(oldScores)
  const newTrim   = trimSum(newScores)
  const oldPoints = oldTrim * dd * factor
  const newPoints = newTrim * dd * factor
  const delta     = newPoints - oldPoints

  // Flag when the edit changes which judge gets dropped — e.g.,
  // pulling a 9.0 down to 5.0 means a different score is now
  // trimmed at the top end. Useful so the operator understands
  // why the trim sum moved more than they'd expect.
  const dropChanged = (() => {
    if (k <= 0) return false
    const oldSorted = [...oldScores].map((s, i) => ({ s, i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
    const newSorted = [...newScores].map((s, i) => ({ s, i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
    const oldDropped = new Set([
      ...oldSorted.slice(0, k).map(r => r.i),
      ...oldSorted.slice(-k).map(r => r.i),
    ])
    const newDropped = new Set([
      ...newSorted.slice(0, k).map(r => r.i),
      ...newSorted.slice(-k).map(r => r.i),
    ])
    if (oldDropped.size !== newDropped.size) return true
    for (const i of oldDropped) if (!newDropped.has(i)) return true
    return false
  })()

  return {
    judgeIdx: idx,
    oldScore: oldScores[idx],
    newScore: newVal,
    oldTrim, newTrim,
    oldPoints, newPoints,
    delta,
    dropChanged,
    dd,
    unchanged: oldScores[idx] === newVal,
  }
})

async function submitCorrection() {
  correctErr.value = ''
  const newVal = parseFloat(correctNewScore.value)
  if (Number.isNaN(newVal) || newVal < 0 || newVal > 10 || ((newVal * 2) % 1) !== 0) {
    correctErr.value = 'Score must be 0–10 in 0.5 increments'
    return
  }
  if (!props.card?.score_ids?.[correctJudgeIdx.value]) {
    correctErr.value = 'Score id missing — refresh and try again'
    return
  }
  correctBusy.value = true
  try {
    // Route through the outbox so a network blip during the
    // correction doesn't lose the operator's edit. Server-side
    // idempotency (P4-2) makes a retry safe; the new schema
    // columns (P4-1 + migration 054) record both clocks.
    await queueAction({
      method: 'PUT',
      url: `/api/scores/${props.card.score_ids[correctJudgeIdx.value]}`,
      body: { score: newVal, reason: correctReason.value || null },
      actionType: 'score_correction',
    })
    // Optimistic local update — the audit row + broadcast will
    // catch up when drain() succeeds.
    props.card.scores[correctJudgeIdx.value] = newVal
    props.card.total = props.card.scores
      .reduce((a, b) => a + b, 0).toFixed(1)
    emit('close')
    emit('saved')
  } catch (err) {
    correctErr.value = err.message
  } finally {
    correctBusy.value = false
  }
}
</script>

<template>
  <BaseModal max-width="520px" @close="$emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" title="Amend Score" @close="$emit('close')">
        {{ card.name }} · Round {{ card.round }} · {{ card.dive_code }}{{ card.position }}
      </ModalHeader>
    <div class="lb-body">
      <div class="field">
        <label class="label">Judge</label>
        <select class="select" v-model="correctJudgeIdx">
          <option v-for="(s, i) in card.scores" :key="i" :value="i">
            J{{ i + 1 }} — currently {{ s.toFixed(1) }}
          </option>
        </select>
      </div>
      <div class="field">
        <label class="label">New score (0–10, 0.5 increments)</label>
        <input class="input" type="number" min="0" max="10" step="0.5"
               v-model="correctNewScore"
               @keyup.enter="submitCorrection">
      </div>
      <!-- Live preview of the correction's impact. Recomputes
           on every keystroke so the operator sees how the edit
           moves the trim sum + dive points BEFORE clicking
           Save. -->
      <div v-if="correctPreview" class="correct-preview"
           :class="{ 'correct-preview-noop': correctPreview.unchanged }">
        <div class="correct-preview-row">
          <span class="correct-preview-label">Judge {{ correctPreview.judgeIdx + 1 }}</span>
          <span class="correct-preview-old">{{ correctPreview.oldScore.toFixed(1) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newScore.toFixed(1) }}</span>
        </div>
        <div class="correct-preview-row">
          <span class="correct-preview-label">Trim sum</span>
          <span class="correct-preview-old">{{ correctPreview.oldTrim.toFixed(1) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newTrim.toFixed(1) }}</span>
        </div>
        <div class="correct-preview-row preview-points">
          <span class="correct-preview-label">Dive points <span class="correct-preview-dd">× DD {{ correctPreview.dd.toFixed(1) }}</span></span>
          <span class="correct-preview-old">{{ correctPreview.oldPoints.toFixed(2) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newPoints.toFixed(2) }}</span>
          <span v-if="!correctPreview.unchanged"
                :class="['correct-preview-delta',
                         correctPreview.delta > 0 ? 'pos'
                       : correctPreview.delta < 0 ? 'neg' : '']">
            {{ correctPreview.delta > 0 ? '+' : '' }}{{ correctPreview.delta.toFixed(2) }}
          </span>
        </div>
        <div v-if="correctPreview.dropChanged" class="correct-preview-note">
          ↻ The trim selection changes — a different judge's score is now dropped.
        </div>
        <div v-if="correctPreview.unchanged" class="correct-preview-note">
          No change — score matches the existing value.
        </div>
      </div>

      <div class="field">
        <label class="label">Reason (logged in audit trail)</label>
        <input class="input" type="text" v-model="correctReason"
               placeholder='e.g. "Judge typo — verified with video"'>
      </div>
      <div v-if="correctErr" class="msg msg-error">{{ correctErr }}</div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="correctBusy" @click="submitCorrection">
          {{ correctBusy ? 'Saving…' : 'Save correction' }}
        </button>
      </div>
    </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* Correction styles MOVED from ControlView.css (exclusive to
   this modal). The modal's 520px max-width now rides the
   BaseModal max-width prop (was .correct-modal). */

/* Score-correction live preview — refreshes on every keystroke
   so the operator can see the impact of the edit (trim-sum
   shift, dive-points delta) before clicking Save. */
.correct-preview {
  margin-top: 0.85rem;
  padding: 0.85rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-inline-start: 3px solid var(--cyan);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}
.correct-preview-noop {
  border-inline-start-color: var(--text-3);
  opacity: 0.75;
}
.correct-preview-row {
  display: grid;
  grid-template-columns: 1fr auto auto auto auto;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.25rem 0;
}
.correct-preview-row.preview-points {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700;
  color: var(--text);
  border-top: 1px dashed var(--border);
  margin-top: 0.3rem;
  padding-top: 0.5rem;
}
.correct-preview-label {
  color: var(--text-3);
  font-family: var(--font-display);
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.correct-preview-dd {
  color: var(--text-3);
  font-weight: 500; letter-spacing: 0.04em;
  text-transform: none;
  font-size: 10px;
  margin-inline-start: 0.3rem;
}
.correct-preview-old { color: var(--text-3); }
.correct-preview-arrow { color: var(--text-3); }
.correct-preview-new { color: var(--text); font-weight: 700; }
.correct-preview-delta {
  display: inline-block;
  min-width: 56px;
  text-align: end;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.1rem 0.45rem;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.correct-preview-delta.pos { color: var(--green); background: var(--green-dim); }
.correct-preview-delta.neg { color: var(--red);   background: var(--red-dim); }
.correct-preview-note {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px dashed var(--border);
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
}

/* The lb-* modal frame (.lb-backdrop/.lb-modal/.lb-header/.lb-title/.lb-event/.lb-body
   + their 720px counterparts) now lives in BaseModal.vue (frame) + the global
   lb-header/lb-title/lb-event/lb-body in ControlView.css. */
</style>
