<script setup>
/* Operator's manual score entry for the manual-fallback path (P5).
 *
 * During an extended outage the operator types each judge's score
 * from the Control Room, reading the value off the judge's phone
 * (which the judge displays via BigScoreDisplay). One row per
 * panel member; each row independently POSTs to
 * /api/scores/manual-entry so a single judge's already-synced
 * digital submission doesn't block the rest of the panel.
 *
 * Props:
 *   eventId         — current event the operator is driving
 *   competitorId    — current diver
 *   roundNumber     — current round (so the operator's typed
 *                     value lands on the right row of the dive list)
 *   panel           — [{ judge_id, judge_number, judge_name }]
 *
 * Emits:
 *   close           — operator dismissed the form (saved or cancelled)
 *   saved(judgeId)  — single judge's score successfully landed;
 *                     parent can mark the panel tile as scored
 *
 * Per-row state machine: idle → submitting → ok|error. Conflict
 * (409 because the judge's digital sync already landed) shows the
 * existing score so the operator knows to use score-correction
 * instead.
 */
import { ref, reactive, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  eventId:      { type: String, required: true },
  competitorId: { type: String, required: true },
  roundNumber:  { type: Number, required: true },
  // Optional pre-fetched panel. If omitted, the component fetches
  // /api/events/:id/judges itself on mount. Useful when the parent
  // already has the data (saves a round trip); for the simple
  // ControlView mount we let the component own the fetch.
  panel: {
    type: Array,
    default: null,
  },
})
const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()

const loadedPanel = ref([])
const panelLoading = ref(false)
const panelError = ref('')

async function ensurePanel() {
  if (Array.isArray(props.panel) && props.panel.length) {
    loadedPanel.value = props.panel
    return
  }
  panelLoading.value = true
  panelError.value = ''
  try {
    const rows = await auth.apiFetch(`/api/events/${props.eventId}/judges`)
    loadedPanel.value = (Array.isArray(rows) ? rows : []).map((r) => ({
      judge_id:     r.judge_id,
      judge_number: r.judge_number,
      judge_name:   r.full_name || null,
    }))
  } catch (err) {
    panelError.value = err.message
    loadedPanel.value = []
  } finally {
    panelLoading.value = false
  }
}

onMounted(ensurePanel)

// One row of UI state per judge. Keyed by judge_id so panel
// re-orderings don't shuffle state.
const rowState = reactive({})
function getState(judgeId) {
  if (!rowState[judgeId]) {
    rowState[judgeId] = {
      score: '',
      status: 'idle',  // 'idle' | 'submitting' | 'ok' | 'error' | 'conflict'
      message: '',
      existingScore: null,
    }
  }
  return rowState[judgeId]
}

// Validate the typed score against the same 0.0-10.0 / 0.5-step
// constraint the server enforces. Returns the parsed number or
// null. Empty string is a special-case "skip this judge" — the
// operator may want to enter only some panel members in one batch.
function parseScore(raw) {
  if (raw === '' || raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 10) return NaN
  if (((n * 2) % 1) !== 0) return NaN
  return n
}

async function submitOne(judge) {
  const st = getState(judge.judge_id)
  const score = parseScore(st.score)
  if (score === null) return  // skipped
  if (Number.isNaN(score)) {
    st.status = 'error'
    st.message = 'Score must be 0.0–10.0 in 0.5 steps'
    return
  }
  st.status = 'submitting'
  st.message = ''
  try {
    const res = await fetch('/api/scores/manual-entry', {
      method: 'POST',
      credentials: 'same-origin',  // sends the httpOnly session cookie
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_id:      props.eventId,
        competitor_id: props.competitorId,
        round_number:  props.roundNumber,
        judge_id:      judge.judge_id,
        score,
        reason:        'manual entry (P5 fallback)',
        actor_local_time: new Date().toISOString(),
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      st.status = 'ok'
      st.message = `Saved (${score.toFixed(1)})`
      emit('saved', judge.judge_id)
      return
    }
    if (res.status === 409) {
      st.status = 'conflict'
      st.existingScore = body.existing_score ?? null
      st.message = body.error || 'Judge has already scored — use score-correction to amend'
      return
    }
    st.status = 'error'
    st.message = body.error || `HTTP ${res.status}`
  } catch (err) {
    st.status = 'error'
    st.message = err.message
  }
}

// Bulk-submit every populated row in panel order. Stops on per-
// row failures (each row carries its own status) but doesn't
// short-circuit — the operator sees every result.
async function submitAll() {
  for (const judge of loadedPanel.value) {
    await submitOne(judge)
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <div class="manual-entry-overlay" @click.self="close" role="dialog" aria-modal="true">
    <div class="manual-entry-modal">
      <header class="manual-entry-header">
        <div>
          <div class="manual-entry-eyebrow">Manual score entry (fallback)</div>
          <div class="manual-entry-title">
            Round {{ roundNumber }} — type each judge's score
          </div>
          <div class="manual-entry-sub">
            Use when judges are showing scores on their phones and the
            digital broadcast isn't reaching the Control Room.
            Digital sync reconciles automatically when they reconnect.
          </div>
        </div>
        <button type="button" class="manual-entry-close" @click="close"
                aria-label="Close manual entry">✕</button>
      </header>

      <div v-if="panelLoading" class="manual-entry-loading">Loading panel…</div>
      <div v-else-if="panelError" class="manual-entry-error">{{ panelError }}</div>
      <ul v-else class="manual-entry-list">
        <li v-for="judge in loadedPanel" :key="judge.judge_id" class="manual-entry-row">
          <div class="manual-entry-row-info">
            <span class="manual-entry-jn">J{{ judge.judge_number }}</span>
            <span class="manual-entry-jname">{{ judge.judge_name || '—' }}</span>
          </div>
          <input
            class="manual-entry-input"
            type="number"
            inputmode="decimal"
            step="0.5"
            min="0"
            max="10"
            placeholder="—"
            v-model="getState(judge.judge_id).score"
            :disabled="getState(judge.judge_id).status === 'submitting'
                       || getState(judge.judge_id).status === 'ok'"
            @keyup.enter="submitOne(judge)"
          />
          <button
            class="manual-entry-row-submit"
            type="button"
            :disabled="!getState(judge.judge_id).score
                       || getState(judge.judge_id).status === 'submitting'
                       || getState(judge.judge_id).status === 'ok'"
            @click="submitOne(judge)"
          >
            {{ getState(judge.judge_id).status === 'submitting' ? '…'
              : getState(judge.judge_id).status === 'ok' ? '✓'
              : 'Save' }}
          </button>
          <span :class="['manual-entry-status', `manual-entry-status--${getState(judge.judge_id).status}`]">
            {{ getState(judge.judge_id).message }}
          </span>
        </li>
      </ul>

      <footer class="manual-entry-footer">
        <button type="button" class="btn btn-ghost btn-sm" @click="close">Close</button>
        <button type="button" class="btn btn-primary btn-sm" @click="submitAll">
          Save all populated rows
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.manual-entry-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 2rem 1rem;
  z-index: 500;
}
.manual-entry-modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 100%; max-width: 540px;
  padding: 1rem 1.25rem 1.25rem;
  font-family: var(--font-mono);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
}

.manual-entry-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.manual-entry-eyebrow {
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--cyan);
}
.manual-entry-title {
  font-family: var(--font-display);
  font-size: 16px; font-weight: 800; font-style: italic;
  color: var(--text);
  margin: 0.2rem 0 0.3rem;
}
.manual-entry-sub {
  font-size: 11.5px; line-height: 1.5;
  color: var(--text-3);
}
.manual-entry-close {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-2);
  width: 28px; height: 28px;
  border-radius: 6px;
  font-size: 14px; line-height: 1;
  cursor: pointer;
  flex: 0 0 auto;
}
.manual-entry-close:hover { color: var(--text); border-color: var(--text-3); }

.manual-entry-list {
  list-style: none; padding: 0; margin: 0 0 1rem;
  display: flex; flex-direction: column; gap: 0.45rem;
}
.manual-entry-loading,
.manual-entry-error {
  padding: 0.75rem;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 1rem;
}
.manual-entry-error { color: #ef4444; }
.manual-entry-row {
  display: grid;
  grid-template-columns: 1fr 96px 80px;
  gap: 0.6rem;
  align-items: center;
  padding: 0.4rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.manual-entry-row-info {
  display: flex; gap: 0.5rem; align-items: baseline;
  min-width: 0;
}
.manual-entry-jn {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 800; font-style: italic;
  color: var(--cyan);
}
.manual-entry-jname {
  font-size: 12.5px;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.manual-entry-input {
  width: 100%;
  font-family: var(--font-display);
  font-size: 16px; font-weight: 800;
  text-align: center;
  padding: 0.4rem 0.45rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
}
.manual-entry-input:focus {
  outline: 2px solid var(--cyan);
  outline-offset: -2px;
}

.manual-entry-row-submit {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.45rem 0.5rem;
  background: var(--cyan);
  color: var(--bg);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.manual-entry-row-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.manual-entry-status {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
  margin-top: 0.2rem;
}
.manual-entry-status--ok       { color: #22c55e; }
.manual-entry-status--error    { color: #ef4444; }
.manual-entry-status--conflict { color: #d946ef; }
.manual-entry-status--submitting { color: var(--cyan); }

.manual-entry-footer {
  display: flex; justify-content: flex-end; gap: 0.5rem;
}
</style>
