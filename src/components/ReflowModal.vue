<script setup>
// ReflowModal, Phase 4 of the session scheduler.
//
// docs/session-scheduler.md §6: when the operator marks an event
// Complete, the event-status endpoint returns a `reflow` proposal
// listing every downstream block in that session plus the
// proposed new start time (old + delta). Control Room mounts
// this modal so the operator can pick which blocks actually shift,
// defaulting all checked, nothing checked if they hit Skip.
//
// Live re-flow never shifts earlier (see §6 closing): the parent
// only ever opens this with delta_seconds > 0, so there's no
// "negative delta" UI branch to worry about here.
//
// On Confirm we POST /api/blocks/reflow and emit `saved` with the
// payload so Control Room can pop a success toast. On Skip we just
// emit `close` and the proposal gets discarded, the operator can
// always edit blocks manually in the scheduler view later anyway.

import { ref, computed, watch, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const props = defineProps({
  open: { type: Boolean, required: true },
  // The reflow proposal that PUT /api/events/:id/status returns.
  // Shape (see lib/schedule-reflow.js):
  //   { completed_block_id, meet_id, session_id, delta_seconds,
  //     candidates: [{ block_id, label, block_type,
  //       old_starts_at, new_starts_at,
  //       old_ends_at, new_ends_at }] }
  proposal: { type: Object, default: null },
  // The event the operator just finalised, used for the heading.
  // Optional, falls back to a generic phrasing when there's no
  // event name to show.
  eventName: { type: String, default: '' },
})

const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()
const { t } = useI18n()

// Lock background scroll while open. Otherwise iOS Safari lets
// the operator drag the underlying Control surface around while
// they're reviewing the candidate list.
useBodyScrollLock().lockWhile(toRef(props, 'open'))

// Per-block selection. Resets to all-checked every time the
// modal re-opens with a new proposal, the design doc explicitly
// wants every candidate checked by default, and a stale ref from
// a prior open would stomp on that.
const selected = ref(new Set())
const reason = ref('')
const saving = ref(false)
const errorMsg = ref('')

watch(
  () => [props.open, props.proposal?.completed_block_id],
  ([open]) => {
    if (open && props.proposal?.candidates) {
      selected.value = new Set(
        props.proposal.candidates.map((c) => c.block_id),
      )
      reason.value = ''
      errorMsg.value = ''
    }
  },
  { immediate: true },
)

const candidates = computed(() => props.proposal?.candidates || [])

const deltaMinutes = computed(() => {
  const s = props.proposal?.delta_seconds || 0
  return Math.round(s / 60)
})

const headingText = computed(() => {
  if (props.eventName) {
    return t('scheduler.reflow.heading', {
      event: props.eventName,
      minutes: deltaMinutes.value,
    })
  }
  return t('scheduler.reflow.heading_no_event', {
    minutes: deltaMinutes.value,
  })
})

const blurbText = computed(() =>
  t('scheduler.reflow.blurb', { minutes: deltaMinutes.value }),
)

function toggle(blockId) {
  const next = new Set(selected.value)
  if (next.has(blockId)) next.delete(blockId)
  else next.add(blockId)
  selected.value = next
}

function selectAll() {
  selected.value = new Set(candidates.value.map((c) => c.block_id))
}
function selectNone() {
  selected.value = new Set()
}

function formatTime(d) {
  if (!d) return ''
  return new Date(d).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function onConfirm() {
  if (!props.proposal) return
  const blockIds = Array.from(selected.value)
  // Skip has its own button, but if the operator unchecks every
  // row and hits Confirm anyway, just treat it as a skip. Saves a
  // confused round-trip.
  if (!blockIds.length) {
    emit('close')
    return
  }
  saving.value = true
  errorMsg.value = ''
  try {
    const result = await auth.apiFetch('/api/blocks/reflow', {
      method: 'POST',
      body: JSON.stringify({
        meet_id: props.proposal.meet_id,
        delta_seconds: props.proposal.delta_seconds,
        block_ids: blockIds,
        reason: reason.value.trim() || undefined,
      }),
    })
    emit('saved', { ...result, count: blockIds.length })
  } catch (err) {
    // Endpoint returns a 409 with conflicting_block_id when a
    // candidate already started while the modal was sitting open.
    // We map that to its own message so the operator knows to
    // refresh instead of just getting a generic "try again."
    if (err && /already started/i.test(err.message || '')) {
      errorMsg.value = t('scheduler.reflow.conflict_refresh')
    } else {
      errorMsg.value = err.message || t('scheduler.reflow.save_failed')
    }
  } finally {
    saving.value = false
  }
}

function onSkip() {
  if (saving.value) return
  emit('close')
}
</script>

<template>
  <!-- Teleport defensively, this modal mounts inside ControlView
       whose layout has a lot of nested wrappers. Any future
       transform on one of them would break our position:fixed. -->
  <Teleport to="body">
    <Transition name="reflow-modal">
      <div
        v-if="open && proposal"
        class="reflow-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reflow-title"
        @mousedown.self="onSkip"
      >
      <div class="reflow-modal">
        <div id="reflow-title" class="reflow-title">
          {{ t('scheduler.reflow.title') }}
        </div>
        <p class="reflow-heading">{{ headingText }}</p>
        <p v-if="candidates.length" class="reflow-blurb">{{ blurbText }}</p>

        <div v-if="!candidates.length" class="reflow-empty">
          {{ t('scheduler.reflow.no_candidates') }}
        </div>

        <template v-else>
          <div class="reflow-toolbar">
            <button type="button" class="reflow-link" @click="selectAll">
              {{ t('scheduler.reflow.select_all') }}
            </button>
            <span class="reflow-toolbar-sep">·</span>
            <button type="button" class="reflow-link" @click="selectNone">
              {{ t('scheduler.reflow.select_none') }}
            </button>
          </div>

          <table class="reflow-table">
            <thead>
              <tr>
                <th scope="col" class="reflow-col-select">
                  {{ t('scheduler.reflow.col_select') }}
                </th>
                <th scope="col">{{ t('scheduler.reflow.col_label') }}</th>
                <th scope="col">{{ t('scheduler.reflow.col_window') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in candidates"
                :key="c.block_id"
                :class="{ 'reflow-row-checked': selected.has(c.block_id) }"
              >
                <td class="reflow-col-select">
                  <input
                    :id="`reflow-${c.block_id}`"
                    type="checkbox"
                    :checked="selected.has(c.block_id)"
                    :disabled="saving"
                    @change="toggle(c.block_id)"
                  />
                </td>
                <td>
                  <label :for="`reflow-${c.block_id}`" class="reflow-label">
                    {{ c.label }}
                  </label>
                </td>
                <td class="reflow-window">
                  <span class="reflow-time-old">{{ formatTime(c.old_starts_at) }}</span>
                  <span class="reflow-time-arrow">→</span>
                  <span class="reflow-time-new">{{ formatTime(c.new_starts_at) }}</span>
                </td>
              </tr>
            </tbody>
          </table>

          <label class="reflow-reason-label" for="reflow-reason">
            {{ t('scheduler.reflow.reason_label') }}
          </label>
          <input
            id="reflow-reason"
            v-model="reason"
            type="text"
            class="reflow-reason"
            :placeholder="t('scheduler.reflow.reason_placeholder')"
            :disabled="saving"
            maxlength="1000"
          />
        </template>

        <p v-if="errorMsg" class="reflow-error" role="alert">{{ errorMsg }}</p>

        <div class="reflow-actions">
          <button
            type="button"
            class="reflow-btn reflow-btn-cancel"
            :disabled="saving"
            @click="onSkip"
          >{{ t('scheduler.reflow.skip') }}</button>
          <button
            type="button"
            class="reflow-btn reflow-btn-primary"
            :disabled="saving || !candidates.length"
            @click="onConfirm"
          >
            {{ saving ? t('scheduler.reflow.saving') : t('scheduler.reflow.confirm') }}
          </button>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reflow-backdrop {
  position: fixed; inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
}
.reflow-modal {
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-top: 4px solid var(--amber);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  width: 100%; max-width: 560px;
  padding: 1.4rem 1.6rem 1.15rem;
  /* Long-session days can produce a dozen-plus candidates, so
     let the modal scroll its own body instead of spilling off
     screen on a phone in the Control Room.

     dvh, not vh: heads up, iOS Safari's collapsing URL bar makes
     100vh equal the *large* viewport (bar collapsed). With the
     bar expanded, a 100vh-sized modal extends below the visible
     area and the Apply/Cancel buttons end up trapped in the
     modal's overflow-y:auto scroll with no way to reach them
     (the toolbar can't collapse while a modal is open).
     vh fallback stays here for browsers older than ~Q4-2022. */
  max-height: calc(100vh - 3rem);
  max-height: calc(100dvh - 3rem);
  overflow-y: auto;
}
.reflow-title {
  font-family: var(--font-display);
  font-size: 16px; font-weight: 800; font-style: italic;
  letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--text);
  margin-bottom: 0.55rem;
}
.reflow-heading {
  font-family: var(--font-mono);
  font-size: 14px; font-weight: 700;
  color: var(--text);
  margin: 0 0 0.5rem;
}
.reflow-blurb {
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.55;
  color: var(--text-2);
  margin: 0 0 0.85rem;
}
.reflow-toolbar {
  display: flex; align-items: center; gap: 0.45rem;
  font-family: var(--font-mono);
  font-size: 11px;
  margin-bottom: 0.5rem;
}
.reflow-toolbar-sep { color: var(--text-3); }
.reflow-link {
  background: transparent; border: 0;
  color: var(--cyan);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.reflow-link:hover { filter: brightness(1.1); }
.reflow-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 0.85rem;
}
.reflow-table th,
.reflow-table td {
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: start;
  padding: 0.4rem 0.55rem;
  border-bottom: 1px solid var(--border-2);
}
.reflow-table th {
  color: var(--text-3);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 10.5px;
}
.reflow-row-checked { background: rgba(0, 0, 0, 0.08); }
.reflow-col-select { width: 2.4rem; text-align: center; }
.reflow-label {
  cursor: pointer;
  color: var(--text);
}
.reflow-window {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.reflow-time-old {
  color: var(--text-3);
  text-decoration: line-through;
}
.reflow-time-arrow {
  color: var(--text-3);
  margin: 0 0.35rem;
}
.reflow-time-new {
  color: var(--amber);
  font-weight: 700;
}
.reflow-reason-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 0.3rem;
}
.reflow-reason {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.4rem 0.55rem;
  box-sizing: border-box;
}
.reflow-reason:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 1px;
}
.reflow-empty {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  padding: 0.6rem 0;
}
.reflow-error {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--red);
  margin: 0.6rem 0 0;
}
.reflow-actions {
  display: flex; justify-content: flex-end; gap: 0.55rem;
  margin-top: 0.8rem;
}
.reflow-btn {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  padding: 0.55rem 1.1rem;
  border-radius: var(--radius-sm);
  border: 1px solid;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.reflow-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.reflow-btn-cancel {
  background: transparent;
  color: var(--text-2);
  border-color: var(--border-2);
}
.reflow-btn-cancel:hover:not(:disabled) {
  background: var(--bg-3);
  color: var(--text);
}
.reflow-btn-primary {
  background: var(--amber);
  color: var(--bg);
  border-color: var(--amber);
}
.reflow-btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.reflow-btn:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}

.reflow-modal-enter-active,
.reflow-modal-leave-active { transition: opacity 0.18s; }
.reflow-modal-enter-active .reflow-modal,
.reflow-modal-leave-active .reflow-modal {
  transition: transform 0.18s, opacity 0.18s;
}
.reflow-modal-enter-from,
.reflow-modal-leave-to { opacity: 0; }
.reflow-modal-enter-from .reflow-modal {
  transform: translateY(8px) scale(0.98); opacity: 0;
}
.reflow-modal-leave-to .reflow-modal {
  transform: translateY(0) scale(0.98); opacity: 0;
}
</style>
