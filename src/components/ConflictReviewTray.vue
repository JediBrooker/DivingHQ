<script setup>
/* Client-side conflict review tray.
 *
 * Surfaces outbox entries that landed in the 'conflict' state —
 * the server's idempotency layer or domain logic returned 409
 * because a parallel write already changed the target. The
 * operator picks 'discard' (drop the local entry) or 'retry'
 * (flip back to pending, hoping the conflict was transient).
 *
 * In P4 this is the local-side counterpart to the late-arrival
 * tray. Conflicts here aren't deadline-driven — they're
 * concurrency races (two operators editing the same dive list,
 * etc.). The accept_proposed / keep_existing path through
 * POST /api/conflicts/:id/resolve stays as a stub for now;
 * P5 builds the server side that knows how to apply a winner.
 *
 * Renders nothing when there are no conflict-state entries.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useOutbox } from '@/composables/useOutbox'

const outboxState = useOutbox()
const outbox = outboxState.outbox

const conflicts = ref([])

async function refresh() {
  if (!outbox) {
    conflicts.value = []
    return
  }
  conflicts.value = await outbox.list({ status: 'conflict' })
}

let unsubscribe = null
onMounted(() => {
  if (outbox) {
    unsubscribe = outbox.on('change', refresh)
    refresh()
  }
})
onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe()
})

async function decide(entry, choice) {
  // choice: 'discard' | 'retry'
  if (!outbox) return
  await outbox.resolveConflict(entry.idempotency_key, choice)
  refresh()
}

function summariseEntry(entry) {
  const { action_type, payload } = entry
  // submit_score has structured payload; HTTP entries have
  // { method, url, body }. We try to render whichever shape the
  // caller pushed.
  if (action_type === 'submit_score') {
    return `Score ${payload?.score} — round ${payload?.round_number}`
  }
  if (payload?.url) {
    return `${payload.method || 'POST'} ${payload.url}`
  }
  return action_type
}
</script>

<template>
  <section v-if="conflicts.length > 0" class="conf-tray">
    <header class="conf-tray-header">
      <span class="conf-tray-pulse" aria-hidden="true"></span>
      <strong>
        {{ conflicts.length === 1
          ? '1 conflict pending review'
          : `${conflicts.length} conflicts pending review` }}
      </strong>
      <span class="conf-tray-meta">
        — another device already wrote the same target. Pick discard or retry per entry.
      </span>
    </header>

    <ul class="conf-tray-list">
      <li v-for="entry in conflicts" :key="entry.idempotency_key" class="conf-tray-item">
        <div class="conf-tray-info">
          <div class="conf-tray-action">{{ summariseEntry(entry) }}</div>
          <div class="conf-tray-meta-line">
            <span v-if="entry.actor_local_time">
              Submitted: {{ new Date(entry.actor_local_time).toLocaleString() }}
            </span>
            <span v-if="entry.conflict_info?.error" class="conf-tray-reason">
              · {{ entry.conflict_info.error }}
            </span>
          </div>
        </div>
        <div class="conf-tray-actions">
          <button class="btn btn-primary btn-sm" @click="decide(entry, 'retry')">
            Retry
          </button>
          <button class="btn btn-danger btn-sm" @click="decide(entry, 'discard')">
            Discard
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.conf-tray {
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: var(--radius-md);
  padding: 0.75rem 1rem;
  margin: 0.5rem 0 1rem;
  font-family: var(--font-mono);
}

.conf-tray-header {
  display: flex; align-items: baseline; gap: 0.5rem;
  flex-wrap: wrap;
  font-size: 12.5px;
  margin-bottom: 0.65rem;
}
.conf-tray-header strong {
  font-family: var(--font-display);
  font-weight: 800; font-style: italic;
  color: var(--text);
  letter-spacing: 0.02em;
}
.conf-tray-meta {
  color: var(--text-3);
  font-size: 11.5px;
}
.conf-tray-pulse {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #ef4444;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
  animation: conf-pulse 1.5s ease-in-out infinite;
  flex: 0 0 auto;
  align-self: center;
}
@keyframes conf-pulse {
  0%, 100% { transform: scale(1);   opacity: 1;   }
  50%      { transform: scale(1.4); opacity: 0.4; }
}

.conf-tray-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.conf-tray-item {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.conf-tray-info { min-width: 0; flex: 1 1 auto; }
.conf-tray-action {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700; font-style: italic;
  color: var(--text);
}
.conf-tray-meta-line {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  font-size: 11px;
  color: var(--text-3);
  margin-top: 0.2rem;
}
.conf-tray-reason { color: #ef4444; }

.conf-tray-actions {
  display: flex; gap: 0.4rem;
  flex: 0 0 auto;
}

@media (prefers-reduced-motion: reduce) {
  .conf-tray-pulse { animation: none; }
}
</style>
