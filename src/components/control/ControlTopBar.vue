<script setup>
// Top control bar (replaces the left stage rail). Holds everything the
// operator drives the meet with:
//   * the focused event + every other LIVE event as one-tap chips (the
//     ones you switch between mid-meet),
//   * an "All events" dropdown for the rest (upcoming / completed),
//   * the action set: History + Standings drawer toggles, Recovery, Tools.
// The focused event's NAME lives here and nowhere else (the old center
// heading is gone). Awareness markers reuse the shared useAttention
// selector so a chip flags 'live' or 'needs action' like the old rail row.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { attentionMarker } from '@/composables/useAttention'
import { orderWorkflowStateFor, liveEventsInOrder } from '@/composables/useControlStage'

const props = defineProps({
  events: { type: Array, default: () => [] },
  selectedId: { type: [String, Number], default: '' },
  historyOpen: { type: Boolean, default: false },
  standingsOpen: { type: Boolean, default: false },
  recoveryOpen: { type: Boolean, default: false },
})
const emit = defineEmits(['select', 'toggle-history', 'toggle-standings', 'toggle-recovery', 'open-tools'])

const allMenuOpen = ref(false)
const rootEl = ref(null)

const focusedEvent = computed(
  () => props.events.find((e) => String(e.id) === String(props.selectedId)) || null,
)

// Chips = every Live event in canonical order (oldest first), so chip N
// lines up with grid card N and the "N" focus hotkey. The focused chip is
// highlighted in place -- never reordered to the front. A focused event
// that ISN'T Live (Upcoming/Completed) isn't in that list, so we surface
// it first purely so its name stays visible.
const chips = computed(() => {
  const live = liveEventsInOrder(props.events)
  const f = focusedEvent.value
  if (f && f.status !== 'Live') return [f, ...live]
  return live
})

function isFocused(ev) {
  return !!ev && String(ev.id) === String(props.selectedId)
}
function dotClass(ev) {
  if (ev.status === 'Live') return 'dot-live'
  if (ev.status === 'Completed') return 'dot-done'
  return 'dot-up'
}
function statusLabel(ev) {
  if (ev.status === 'Live') return 'live'
  if (ev.status === 'Completed') return 'done'
  return 'upcoming'
}
// At-most-one marker, stage-derived (same rule the old StageRow used).
function needsAction(ev) {
  const stage = orderWorkflowStateFor(ev)
  const m = attentionMarker([], [], {
    live: ev.status === 'Live',
    nextAction: ev.status === 'Upcoming' && !!stage && stage !== 'live',
  })
  return m && m.kind === 'next-action'
}

function pick(id) {
  allMenuOpen.value = false
  emit('select', id)
}
function onDocClick(e) {
  if (allMenuOpen.value && rootEl.value && !rootEl.value.contains(e.target)) allMenuOpen.value = false
}
function onKey(e) {
  if (e.key === 'Escape') allMenuOpen.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <header ref="rootEl" class="cv2-topbar" aria-label="Meet controls">
    <div class="cv2-topbar-events">
      <button
        v-for="ev in chips"
        :key="ev.id"
        type="button"
        class="cv2-chip"
        :class="{ 'is-focused': isFocused(ev) }"
        :data-event-id="ev.id"
        :aria-current="isFocused(ev) ? 'true' : undefined"
        @click="emit('select', ev.id)"
      >
        <span class="cv2-chip-dot" :class="dotClass(ev)" aria-hidden="true"></span>
        <span class="cv2-chip-name">{{ ev.name }}</span>
        <span v-if="needsAction(ev)" class="cv2-chip-mark" aria-label="Needs action">→</span>
      </button>

      <div class="cv2-all">
        <button
          type="button"
          class="cv2-allbtn"
          :aria-expanded="allMenuOpen"
          @click.stop="allMenuOpen = !allMenuOpen"
        >All events <span aria-hidden="true">▾</span></button>
        <ul v-if="allMenuOpen" class="cv2-allmenu" role="listbox" aria-label="All events">
          <li v-for="ev in events" :key="ev.id" role="option" :aria-selected="isFocused(ev)">
            <button
              type="button"
              class="cv2-allitem"
              :class="{ 'is-focused': isFocused(ev) }"
              :data-event-id="ev.id"
              @click="pick(ev.id)"
            >
              <span class="cv2-chip-dot" :class="dotClass(ev)" aria-hidden="true"></span>
              <span class="cv2-allitem-name">{{ ev.name }}</span>
              <span class="cv2-allitem-status">{{ statusLabel(ev) }}</span>
            </button>
          </li>
          <li v-if="!events.length" class="cv2-allempty">No events.</li>
        </ul>
      </div>
    </div>

    <span class="cv2-topbar-sp"></span>

    <div class="cv2-topbar-actions">
      <button type="button" class="cv2-act" :class="{ 'is-active': historyOpen }" :aria-pressed="historyOpen" @click="emit('toggle-history')">History</button>
      <button type="button" class="cv2-act" :class="{ 'is-active': standingsOpen }" :aria-pressed="standingsOpen" @click="emit('toggle-standings')">Standings</button>
      <button type="button" class="cv2-act cv2-act-recovery" :class="{ 'is-active': recoveryOpen }" :aria-pressed="recoveryOpen" @click="emit('toggle-recovery')">Recovery</button>
      <button type="button" class="cv2-act" @click="emit('open-tools')">Tools</button>
    </div>
  </header>
</template>

<style scoped>
.cv2-topbar {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface);
}
.cv2-topbar-events { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; min-width: 0; }
.cv2-topbar-sp { flex: 1; }
.cv2-topbar-actions { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }

.cv2-chip {
  display: inline-flex; align-items: center; gap: 0.45rem;
  padding: 0.4rem 0.75rem; border: 1px solid var(--border-2); border-radius: var(--radius-md);
  background: var(--bg-2); color: var(--text-2); cursor: pointer;
  font-family: var(--font-display); font-weight: 600; font-size: 13px; max-width: 220px;
}
.cv2-chip:hover { color: var(--fg); }
.cv2-chip.is-focused { border-color: var(--cyan); background: var(--bg-3); color: var(--fg); }
.cv2-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv2-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot-live { background: var(--red); }
.dot-up { background: var(--amber); }
.dot-done { background: var(--text-3); }
.cv2-chip-mark { color: var(--cyan); font-size: 12px; flex: none; }

.cv2-all { position: relative; }
.cv2-allbtn {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.4rem 0.7rem; border: 1px solid var(--border-2); border-radius: var(--radius-md);
  background: transparent; color: var(--text-2); cursor: pointer; font: inherit; font-size: 13px;
}
.cv2-allbtn:hover { color: var(--fg); }
.cv2-allmenu {
  position: absolute; top: calc(100% + 4px); inset-inline-start: 0; z-index: 30;
  min-width: 250px; margin: 0; padding: 0.3rem; list-style: none;
  background: var(--bg-2); border: 1px solid var(--border-2); border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.cv2-allitem {
  display: flex; align-items: center; gap: 0.5rem; width: 100%;
  padding: 0.5rem 0.6rem; border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--text-2); cursor: pointer; font: inherit; font-size: 13px; text-align: start;
}
.cv2-allitem:hover { background: var(--bg-3); color: var(--fg); }
.cv2-allitem.is-focused { color: var(--cyan); }
.cv2-allitem-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv2-allitem-status { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.cv2-allempty { padding: 0.6rem; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }

.cv2-act {
  padding: 0.45rem 0.75rem; border: 1px solid var(--border-2); border-radius: var(--radius-sm);
  background: transparent; color: var(--text-2); cursor: pointer;
  font-family: var(--font-display); font-weight: 700; font-size: 11px; letter-spacing: 0.04em;
}
.cv2-act:hover { color: var(--fg); border-color: var(--cyan); }
.cv2-act.is-active { border-color: var(--cyan); color: var(--cyan); }
.cv2-act-recovery.is-active { border-color: var(--amber); color: var(--amber); }
</style>
