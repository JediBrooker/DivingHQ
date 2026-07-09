<script setup>
/* Inline audit-history affordance for officials.
 *
 * Renders a tiny "history" pill inside a dive row. Clicking it
 * opens a popover with the per-dive audit rows pulled from
 * /api/events/:id/score-audit. Lazy-fetched on first open per
 * event, then cached on window so multiple buttons in the same
 * recap share one round trip.
 *
 * Visibility: org_admin, meet_manager, or referee. Spectators
 * never see this, the audit log isn't a public artefact.
 *
 * The popover is inline (not modal) so it doesn't disrupt the
 * recap. Click outside to close; Esc also closes.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { fmtDateTime } from '@/lib/format'

const props = defineProps({
  eventId:        { type: [String, Number], required: true },
  competitorId:   { type: [String, Number], required: true },
  roundNumber:    { type: [String, Number], required: true },
})

const auth = useAuthStore()

// The server's /api/events/:id/score-audit endpoint is gated by
// requireEventManager(): system_admin, org_admin in the same
// org, or per-event event_managers membership. We can't cheaply
// check event_managers membership client-side, so we surface
// the affordance to org_admin (a superset of typical event
// managers in a single-org deployment) and let the server
// reject anyone else with a 403 we render as the popover error.
const visibleToUser = computed(() =>
  auth.isLoggedIn && (auth.user?.is_system_admin || auth.hasRole('org_admin')),
)

const open    = ref(false)
const loading = ref(false)
const error   = ref('')
const rows    = ref([])

// One in-memory cache per page session, keyed by event id.
function getCache() {
  if (!window.__scoreAuditCache) window.__scoreAuditCache = new Map()
  return window.__scoreAuditCache
}

async function loadIfNeeded() {
  const cache = getCache()
  if (cache.has(props.eventId)) {
    rows.value = cache.get(props.eventId)
    return
  }
  loading.value = true
  error.value = ''
  try {
    const data = await auth.apiFetch(`/api/events/${props.eventId}/score-audit`)
    cache.set(props.eventId, data)
    rows.value = data
  } catch (err) {
    error.value = err.message || 'Failed to load history'
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  return (rows.value || []).filter(r =>
    String(r.competitor_id) === String(props.competitorId) &&
    Number(r.round_number)  === Number(props.roundNumber),
  )
})

// fmtDateTime imported from @/lib/format, single source of
// truth across views now. Used to be a local copy here.

async function toggle(e) {
  e.stopPropagation()
  if (open.value) { close(); return }
  open.value = true
  await loadIfNeeded()
}
function close() {
  open.value = false
  error.value = ''
}

// Outside-click + Esc handling. Each dive row mounts an instance,
// and the recap can have 30+ dives, so attaching the listeners
// unconditionally at script-setup top level would mean 30+
// document mousedown listeners firing on every click. Watch
// `open` so listeners are attached ONLY while a popover is
// actually open. The marker attribute carries the instance id
// so a click inside popover B doesn't close popover A, gotcha
// we ran into with the previous shared-marker approach.
const popoverId = `sha-${Math.random().toString(36).slice(2, 8)}`
function onDocClick(e) {
  if (!open.value) return
  const t = e.target
  if (t && t.closest && t.closest(`[data-score-history-popover="${popoverId}"]`)) return
  close()
}
function onKey(e) {
  if (e.key === 'Escape') close()
}
watch(open, (now) => {
  if (now) {
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('mousedown', onDocClick)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <span v-if="visibleToUser" class="score-history">
    <button
      type="button"
      class="score-history-btn"
      :aria-expanded="open"
      v-tip="'View edit history for this dive'"
      @click="toggle"
    >↻ history</button>

    <div
      v-if="open"
      :data-score-history-popover="popoverId"
      class="score-history-pop"
      role="dialog"
      aria-label="Score audit history"
    >
      <div class="score-history-pop-head">
        <strong>Score history · R{{ roundNumber }}</strong>
        <button class="score-history-close" @click="close" aria-label="Close">✕</button>
      </div>

      <div v-if="loading" class="score-history-msg">Loading…</div>
      <div v-else-if="error" class="score-history-msg score-history-err">{{ error }}</div>
      <div v-else-if="!filtered.length" class="score-history-msg">
        No edits — original judge submissions only.
      </div>
      <ul v-else class="score-history-list">
        <li v-for="r in filtered" :key="r.id" class="score-history-row">
          <div class="score-history-row-head">
            <span :class="['score-history-action', `act-${r.action}`]">{{ r.action }}</span>
            <span class="score-history-time">{{ fmtDateTime(r.created_at) }}</span>
          </div>
          <div class="score-history-row-body">
            <template v-if="r.action === 'update'">
              J{{ r.judge_number }}: <strong>{{ r.old_score }}</strong> → <strong>{{ r.new_score }}</strong>
            </template>
            <template v-else-if="r.action === 'insert'">
              J{{ r.judge_number }} submitted <strong>{{ r.new_score }}</strong>
            </template>
            <template v-else-if="r.action === 'delete'">
              J{{ r.judge_number }} score <strong>{{ r.old_score }}</strong> removed
            </template>
            <template v-else>
              {{ r.action }}
            </template>
          </div>
          <div class="score-history-row-meta">
            by {{ r.actor_name || 'system' }}<span v-if="r.reason"> — “{{ r.reason }}”</span>
          </div>
        </li>
      </ul>
    </div>
  </span>
</template>

<style scoped>
.score-history { position: relative; display: inline-block; }
.score-history-btn {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--text-3, #94a3b8);
  background: transparent;
  border: 1px solid var(--border, #334155);
  border-radius: 999px;
  padding: 1px 7px;
  cursor: pointer;
  margin-inline-start: 0.4rem;
  transition: color 0.1s, border-color 0.1s;
}
.score-history-btn:hover {
  color: var(--cyan, #06b6d4);
  border-color: var(--cyan, #06b6d4);
}

.score-history-pop {
  position: absolute;
  top: calc(100% + 6px);
  inset-inline-end: 0;
  background: var(--bg-2, #0f172a);
  border: 1px solid var(--border-2, #334155);
  border-radius: var(--radius, 6px);
  padding: 0.6rem 0.75rem;
  width: 280px;
  z-index: 200;
  box-shadow: 0 14px 30px rgba(0,0,0,0.4);
  text-align: start;
}
.score-history-pop-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 0.4rem;
  font-family: var(--font-display, sans-serif);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-2, #cbd5e1);
}
.score-history-close {
  background: transparent; border: 0;
  color: var(--text-3, #94a3b8);
  cursor: pointer; font-size: 14px;
  padding: 0 0.25rem;
}
.score-history-msg {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-3, #94a3b8);
  padding: 0.4rem 0;
}
.score-history-err { color: var(--red, #ef4444); }
.score-history-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.5rem;
  max-height: 240px; overflow-y: auto;
}
.score-history-row {
  border-inline-start: 2px solid var(--border, #334155);
  padding-inline-start: 0.55rem;
}
.score-history-row-head {
  display: flex; justify-content: space-between; gap: 0.5rem;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.score-history-action { font-weight: 700; color: var(--text-2, #cbd5e1); }
.act-insert { color: var(--green, #10b981); }
.act-update { color: var(--cyan,  #06b6d4); }
.act-delete { color: var(--red,   #ef4444); }
.score-history-time { color: var(--text-3, #94a3b8); }
.score-history-row-body {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text, #f8fafc);
  margin-top: 1px;
}
.score-history-row-body strong { color: var(--cyan, #06b6d4); font-weight: 700; }
.score-history-row-meta {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-3, #94a3b8);
  margin-top: 1px;
}
</style>
