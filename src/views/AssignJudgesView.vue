<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const { t } = useI18n()

const events = ref([])
const allJudges = ref([])
const selectedEventId = ref('')
const currentEvent = ref(null)
const panel = ref([]) // array of judge objects or null
const originalPanel = ref([]) // judge ids as loaded from the server
const judgeSearch = ref('')
const saveMsg = ref('')
const saveMsgType = ref('')
const reviewOpen = ref(false)
const savingPanel = ref(false)

const panelSize = computed(() => currentEvent.value?.number_of_judges || 5)

const assignedCount = computed(() => panel.value.filter(Boolean).length)

const inPanelIds = computed(() => new Set(panel.value.filter(Boolean).map(j => j.id)))

const filteredJudges = computed(() => {
  const term = judgeSearch.value.toLowerCase()
  if (!term) return allJudges.value
  // Match against full_name + org_name + country_code. Username
  // was removed from the /api/judges + /api/events/:id/eligible-
  // judges projections (security audit pass 1) so the prior
  // `j.username.toLowerCase()` would throw TypeError on the
  // first keypress against the new endpoint shape.
  return allJudges.value.filter(j => {
    const haystack = [
      j.full_name,
      j.org_name,
      j.country_code,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(term)
  })
})

const panelReviewRows = computed(() => {
  const rows = []
  for (let idx = 0; idx < panelSize.value; idx++) {
    const beforeId = originalPanel.value[idx] || null
    const afterJudge = panel.value[idx] || null
    const afterId = afterJudge?.id || null
    if (beforeId === afterId) continue
    const beforeJudge = allJudges.value.find(j => j.id === beforeId)
    rows.push({
      slot: idx + 1,
      before: beforeJudge?.full_name || 'Empty',
      after: afterJudge?.full_name || 'Empty',
      kind: beforeId && afterId ? 'change' : beforeId ? 'remove' : 'add',
    })
  }
  return rows
})

async function onEventChange() {
  saveMsg.value = ''
  if (!selectedEventId.value) {
    currentEvent.value = null
    panel.value = []
    return
  }
  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return

  panel.value = Array(panelSize.value).fill(null)
  originalPanel.value = Array(panelSize.value).fill(null)

  try {
    // Use the event-scoped picker so participating federations'
    // judges show up too. Falls back to the org-scoped /api/judges
    // (which the page initialised from) if the event endpoint
    // 4xxs, keeps domestic-only flows working unchanged.
    const [assigned, eligible] = await Promise.all([
      auth.apiFetch(`/api/events/${selectedEventId.value}/judges`),
      auth.apiFetch(`/api/events/${selectedEventId.value}/eligible-judges`).catch(() => null),
    ])
    if (Array.isArray(eligible) && eligible.length) {
      allJudges.value = eligible
    }
    assigned.forEach(a => {
      const judge = allJudges.value.find(j => j.id === a.judge_id)
      if (judge && a.judge_number >= 1 && a.judge_number <= panelSize.value) {
        panel.value[a.judge_number - 1] = judge
        originalPanel.value[a.judge_number - 1] = judge.id
      }
    })
  } catch {
    panel.value = Array(panelSize.value).fill(null)
    originalPanel.value = Array(panelSize.value).fill(null)
  }
}

function assignJudge(judge) {
  const emptyIdx = panel.value.findIndex(s => s === null)
  if (emptyIdx === -1) return
  panel.value[emptyIdx] = judge
}

function removeFromSlot(idx) {
  panel.value[idx] = null
}

function slotLabel(idx) {
  const j = panel.value[idx]
  return j ? j.full_name : null
}

function judgeSlotNum(judgeId) {
  return panel.value.findIndex(p => p?.id === judgeId)
}

function requestSavePanel() {
  saveMsg.value = ''
  const filled = panel.value.filter(Boolean).length
  if (filled !== panelSize.value) {
    saveMsg.value = `Panel requires exactly ${panelSize.value} judges. ${filled} assigned.`
    saveMsgType.value = 'error'
    return
  }
  reviewOpen.value = true
}

async function savePanel() {
  savingPanel.value = true
  try {
    await auth.apiFetch(`/api/events/${selectedEventId.value}/judges`, {
      method: 'POST',
      body: JSON.stringify({ judgeIds: panel.value.map(j => j.id) }),
    })
    originalPanel.value = panel.value.map(j => j?.id || null)
    reviewOpen.value = false
    saveMsg.value = `Panel saved. Judges numbered J1–J${panelSize.value}.`
    saveMsgType.value = 'success'
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (err) {
    saveMsg.value = err.message
    saveMsgType.value = 'error'
  } finally {
    savingPanel.value = false
  }
}

const loading = ref(true)

onMounted(async () => {
  try {
    const [evs, jdgs] = await Promise.all([
      auth.apiFetch('/api/events'),
      auth.apiFetch('/api/judges'),
    ])
    events.value = evs
    allJudges.value = jdgs
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="page-header">
    <h1 style="font-size:32px;font-style:italic">Assign Judges</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">{{ $t('common.dashboard') }}</RouterLink>
  </div>

  <div class="main">
    <div v-if="loading" class="empty-card">Loading events and judges…</div>

    <!-- Step 1: select event -->
    <div v-else class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">Step 1 — Select Event</label>
      <select class="select" v-model="selectedEventId" @change="onEventChange">
        <option value="">— Choose Event —</option>
        <option v-for="ev in events" :key="ev.id" :value="ev.id">{{ ev.name }}</option>
      </select>
      <p v-if="!events.length" class="hint" style="margin-top:0.6rem">
        No events have been created yet — head to <strong>Manager</strong> to set one up.
      </p>
    </div>

    <!-- Step 2: build panel -->
    <div v-if="currentEvent">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem">
          <div>
            <h2 style="font-size:20px;font-style:italic;margin-bottom:0.25rem">Step 2 — Build Panel</h2>
            <div style="font-family:var(--font-display);font-size:12px;font-weight:700;color:var(--text-3);letter-spacing:0.1em">
              <span style="color:var(--cyan)">{{ assignedCount }}</span> of {{ panelSize }} judges assigned
            </div>
          </div>
          <div style="display:flex;gap:0.75rem;align-items:center">
            <div v-if="saveMsg" :class="['msg', saveMsgType === 'success' ? 'msg-success' : 'msg-error']">{{ saveMsg }}</div>
            <button class="btn btn-primary" @click="requestSavePanel">Save Panel</button>
          </div>
        </div>

        <div class="assign-grid">
          <!-- Left: available judges -->
          <div>
            <div class="col-label">Available Judges</div>
            <div class="search-wrap">
              <input class="input" type="text" v-model="judgeSearch" placeholder="Search judges...">
            </div>
            <div class="judge-list">
              <div v-if="!filteredJudges.length" class="empty">No judges found</div>
              <div
                v-for="j in filteredJudges"
                :key="j.id"
                :class="['judge-item', inPanelIds.has(j.id) ? 'in-panel' : '']"
                @click="!inPanelIds.has(j.id) && assignJudge(j)"
              >
                <div>
                  <div class="judge-item-name">
                    {{ j.full_name }}
                    <!-- Country chip when the judge belongs to a
                         participating federation other than the
                         host. Spectators / operators see at a
                         glance which judges are international.
                         The chip is always rendered when the
                         judge has a country_code so a host's own
                         panel still gets the visual marker. -->
                    <span v-if="j.country_code" class="judge-item-country">
                      {{ j.country_code }}
                    </span>
                  </div>
                  <div v-if="j.org_name" class="judge-item-user">{{ j.org_name }}</div>
                </div>
                <span v-if="inPanelIds.has(j.id)" style="margin-inline-start:auto;font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:0.1em;color:var(--cyan)">
                  J{{ judgeSlotNum(j.id) + 1 }} ✓
                </span>
                <svg v-else class="add-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
              </div>
            </div>
          </div>

          <!-- Right: panel slots -->
          <div>
            <div class="col-label">Panel Slots — click a judge to assign</div>
            <div class="panel-slots">
              <div
                v-for="(judge, idx) in panel"
                :key="idx"
                :class="['slot', judge ? 'filled' : '']"
              >
                <div class="slot-num" :style="judge ? {} : { color: 'var(--border-2)' }">J{{ idx + 1 }}</div>
                <div v-if="judge" style="flex:1">
                  <div class="slot-label">Judge {{ idx + 1 }}</div>
                  <div class="slot-name">{{ judge.full_name }}</div>
                </div>
                <div v-else class="slot-empty">Empty — click a judge to assign to this slot</div>
                <button v-if="judge" class="slot-remove" @click="removeFromSlot(idx)">✕</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-if="reviewOpen" class="modal-backdrop" @click.self="reviewOpen = false">
    <div class="panel-review-modal" @click.stop>
      <div class="panel-review-head">
        <div>
          <div class="col-label">Panel Preview</div>
          <h2>Confirm judge assignment</h2>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="reviewOpen = false">Cancel ✕</button>
      </div>
      <p class="hint">
        Saving replaces the whole panel for {{ currentEvent?.name }} and renumbers judges J1–J{{ panelSize }} in slot order.
      </p>
      <div v-if="!panelReviewRows.length" class="panel-review-empty">
        No slot changes from the current saved panel.
      </div>
      <ul v-else class="panel-review-list">
        <li v-for="row in panelReviewRows" :key="row.slot" class="panel-review-row">
          <span class="panel-review-slot">J{{ row.slot }}</span>
          <span class="panel-review-before">{{ row.before }}</span>
          <span class="panel-review-arrow">→</span>
          <span class="panel-review-after">{{ row.after }}</span>
          <span :class="['panel-review-kind', row.kind]">{{ row.kind }}</span>
        </li>
      </ul>
      <div class="panel-review-actions">
        <button type="button" class="btn btn-ghost" @click="reviewOpen = false">Back</button>
        <button type="button" class="btn btn-primary" :disabled="savingPanel" @click="savePanel">
          {{ savingPanel ? 'Saving…' : 'Confirm save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.empty-card {
  background: var(--surface); border: 1px dashed var(--border);
  border-radius: var(--radius-lg); padding: 2rem;
  text-align: center; color: var(--text-3);
  font-family: var(--font-mono); font-size: 13px;
}
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--amber); border-radius: 3px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 2rem;
  border-bottom: 1px solid var(--border);
  max-width: 1100px;
  margin: 0 auto;
}
.main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.assign-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}
@media (max-width: 720px) {
  .assign-grid { grid-template-columns: 1fr; }
}

.col-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.75rem;
}

.judge-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 440px;
  overflow-y: auto;
}
.judge-item {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.judge-item:hover { border-color: var(--border-2); }
.judge-item.in-panel { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
.judge-item-name {
  font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text);
  display: inline-flex; align-items: center; gap: 0.5rem;
}
.judge-item-country {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.04em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
}
.judge-item-user { font-size: 11px; color: var(--text-3); }
.add-icon { margin-inline-start: auto; color: var(--cyan); flex-shrink: 0; opacity: 0.6; }
.judge-item:hover .add-icon { opacity: 1; }

.panel-slots { display: flex; flex-direction: column; gap: 0.5rem; }
.slot {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 58px;
  transition: border-color 0.15s;
}
.slot.filled { border-color: var(--cyan); background: var(--cyan-dim); }
.slot-num { font-family: var(--font-display); font-size: 20px; font-weight: 900; color: var(--text-3); width: 32px; text-align: center; flex-shrink: 0; }
.slot.filled .slot-num { color: var(--cyan); }
.slot-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-bottom: 0.1rem; }
.slot-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text); }
.slot-empty { font-size: 12px; color: var(--text-3); font-style: italic; }
.slot-remove { margin-inline-start: auto; background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 16px; padding: 0.25rem; line-height: 1; transition: color 0.1s; flex-shrink: 0; }
.slot-remove:hover { color: var(--red); }

.search-wrap { margin-bottom: 0.75rem; }
.empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 2rem; }

.panel-review-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 301;
  width: min(620px, calc(100vw - 2rem));
  max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem;
  box-shadow: var(--shadow-lg);
}
.panel-review-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; margin-bottom: 0.75rem;
}
.panel-review-head h2 {
  font-size: 20px; line-height: 1.15; color: var(--text);
}
.panel-review-empty {
  margin-top: 0.8rem; padding: 0.75rem;
  border: 1px dashed var(--border); border-radius: var(--radius-sm);
  color: var(--text-3); font-family: var(--font-mono); font-size: 12px;
}
.panel-review-list {
  list-style: none; padding: 0; margin: 0.9rem 0 0;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.panel-review-row {
  display: grid; grid-template-columns: 42px 1fr 20px 1fr auto;
  gap: 0.5rem; align-items: center;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.panel-review-slot {
  font-family: var(--font-display); font-weight: 900; color: var(--cyan);
}
.panel-review-before,
.panel-review-after {
  min-width: 0; font-family: var(--font-display); font-size: 12px;
  font-weight: 700; color: var(--text);
}
.panel-review-before { color: var(--text-3); }
.panel-review-arrow { color: var(--text-3); text-align: center; }
.panel-review-kind {
  padding: 0.12rem 0.35rem; border-radius: 999px;
  font-family: var(--font-display); font-size: 9px; font-weight: 800;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-3); background: var(--surface);
}
.panel-review-kind.add { color: var(--green); }
.panel-review-kind.remove { color: var(--red); }
.panel-review-kind.change { color: var(--amber); }
.panel-review-actions {
  display: flex; justify-content: flex-end; gap: 0.5rem;
  margin-top: 1rem;
}

@media (max-width: 560px) {
  .panel-review-row {
    grid-template-columns: 38px 1fr;
  }
  .panel-review-arrow,
  .panel-review-kind {
    grid-column: 2;
  }
}
</style>
