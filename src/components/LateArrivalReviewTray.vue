<script setup>
/* Late-arrival review tray for meet managers and referees.
 *
 * Surfaces rows that lib/deadline-gate.js accepted "with review"
 * (DEC-04): the competitor or coach claims they submitted before
 * the entry deadline, but the server only saw the request after.
 * Operator decides whether to keep or roll back each entry.
 *
 * Polls /api/late-arrivals on mount and every 30s, refreshes after
 * a decision so the row drops out of the queue.
 *
 * Visibility: renders nothing when there are no pending rows, so a
 * quiet meet shows no chrome at all.
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  /** Scope the queue to a single event. Omit to show every flagged row in the operator's org. */
  eventId: { type: String, default: null },
})
const emit = defineEmits(['loaded'])

const auth = useAuthStore()
const rows = ref([])
const loading = ref(false)
const errMsg = ref('')

async function loadRows() {
  loading.value = true
  errMsg.value = ''
  try {
    const url = props.eventId
      ? `/api/late-arrivals?event_id=${encodeURIComponent(props.eventId)}`
      : '/api/late-arrivals'
    rows.value = await auth.apiFetch(url)
  } catch (err) {
    errMsg.value = err.message
    rows.value = []
  } finally {
    emit('loaded', {
      eventId: props.eventId,
      count: rows.value.length,
      rows: rows.value,
    })
    loading.value = false
  }
}

async function decide(row, decision) {
  try {
    await auth.apiFetch(`/api/late-arrivals/${row.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    // Drop the row locally so the UI feels responsive, then reload
    // to catch anything that landed concurrently in the meantime.
    rows.value = rows.value.filter((r) => r.id !== row.id)
    loadRows()
  } catch (err) {
    errMsg.value = `${decision} failed: ${err.message}`
  }
}

let pollTimer = null
onMounted(() => {
  loadRows()
  pollTimer = setInterval(loadRows, 30000)
})
watch(() => props.eventId, () => {
  loadRows()
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <section v-if="rows.length > 0" class="late-tray">
    <header class="late-tray-header">
      <span class="late-tray-pulse" aria-hidden="true"></span>
      <strong>
        {{ rows.length === 1
          ? '1 late submission pending referee review'
          : `${rows.length} late submissions pending referee review` }}
      </strong>
      <span class="late-tray-meta">
        — submitted before deadline but arrived after. Approve to keep, deny to roll back.
      </span>
    </header>

    <ul class="late-tray-list">
      <li v-for="row in rows" :key="row.id" class="late-tray-item">
        <div class="late-tray-item-info">
          <div class="late-tray-name">
            {{ row.competitor_name }}
            <span class="late-tray-event">— {{ row.event_name }}, Round {{ row.round_number }}</span>
          </div>
          <div class="late-tray-dive">
            <template v-if="row.dive_code">
              {{ row.dive_code }}{{ row.position }} <span class="late-tray-dd">DD {{ row.dd }}</span>
            </template>
            <template v-else>
              <em>No dive selected for this round</em>
            </template>
          </div>
          <div class="late-tray-times">
            <span v-if="row.actor_local_time">
              Claimed submitted: {{ new Date(row.actor_local_time).toLocaleString() }}
            </span>
            <span>
              Received: {{ new Date(row.created_at).toLocaleString() }}
            </span>
            <span v-if="row.entries_close_at" class="late-tray-deadline">
              Deadline: {{ new Date(row.entries_close_at).toLocaleString() }}
            </span>
          </div>
        </div>
        <div class="late-tray-actions">
          <button class="btn btn-primary btn-sm" @click="decide(row, 'allowed')">
            Approve
          </button>
          <button class="btn btn-danger btn-sm" @click="decide(row, 'denied')">
            Deny
          </button>
        </div>
      </li>
    </ul>

    <div v-if="errMsg" class="late-tray-error">{{ errMsg }}</div>
  </section>
</template>

<style scoped>
.late-tray {
  background: rgba(217, 70, 239, 0.08);
  border: 1px solid rgba(217, 70, 239, 0.35);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  margin: 0.5rem 0 1rem;
  font-family: var(--font-mono);
}

.late-tray-header {
  display: flex; align-items: baseline; gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 12.5px;
  margin-bottom: 0.65rem;
}
.late-tray-header strong {
  font-family: var(--font-display);
  font-weight: 800; font-style: italic;
  color: var(--text);
  letter-spacing: 0.02em;
}
.late-tray-meta {
  color: var(--text-3);
  font-size: 11.5px;
}
.late-tray-pulse {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #d946ef;
  box-shadow: 0 0 8px rgba(217, 70, 239, 0.6);
  animation: late-pulse 1.5s ease-in-out infinite;
  flex: 0 0 auto;
  align-self: center;
}
@keyframes late-pulse {
  0%, 100% { transform: scale(1);   opacity: 1;   }
  50%      { transform: scale(1.4); opacity: 0.4; }
}

.late-tray-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.late-tray-item {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.late-tray-item-info { min-width: 0; flex: 1 1 auto; }
.late-tray-name {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700; font-style: italic;
  color: var(--text);
}
.late-tray-event {
  color: var(--text-3);
  font-weight: 400; font-style: normal;
  font-size: 12px;
  margin-left: 0.25rem;
}
.late-tray-dive {
  font-size: 12px; color: var(--text-2);
  margin-top: 0.15rem;
}
.late-tray-dd {
  color: var(--cyan);
  font-weight: 700;
  margin-left: 0.4rem;
}
.late-tray-times {
  display: flex; flex-wrap: wrap; gap: 0.75rem;
  font-size: 11px;
  color: var(--text-3);
  margin-top: 0.2rem;
}
.late-tray-deadline { color: #f59e0b; }

.late-tray-actions {
  display: flex; gap: 0.4rem;
  flex: 0 0 auto;
}

.late-tray-error {
  font-size: 11.5px;
  color: #ef4444;
  margin-top: 0.5rem;
}

@media (prefers-reduced-motion: reduce) {
  .late-tray-pulse { animation: none; }
}
</style>
