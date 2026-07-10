<script setup>
// Picks the shape of the stream overlay, and shows you what you picked.
//
// Two controls, one selection. The wireframe is the fast way in: click the
// block you want on air. The checkbox list underneath is the same thing in
// text, and it is what a keyboard or a screen reader actually uses, so the
// SVG is aria-hidden rather than pretending to be a control tree.
//
// The two legacy shapes (Full board, Lower third) are drawn but not editable.
// Their meaning is frozen: those URLs live inside OBS scene collections on
// machines we will never see.
import { computed } from 'vue'
import {
  OVERLAY_PARTS,
  PART_KEYS,
  PRESET_ORDER,
  PRESET_DISPLAY_PARTS,
  OVERLAY_PRESETS,
  isFrozenPreset,
} from '@/lib/overlayParts'

const props = defineProps({
  preset: { type: String, default: '1' },
  parts:  { type: Array,  default: () => [] },
})
const emit = defineEmits(['update:preset', 'update:parts'])

const frozen = computed(() => isFrozenPreset(props.preset))
const editable = computed(() => props.preset === 'custom')

// What the diagram should light up: the live selection when the operator is
// composing one, otherwise the canned shape they picked.
const active = computed(() => {
  if (editable.value) return new Set(props.parts)
  return new Set(PRESET_DISPLAY_PARTS[props.preset] || [])
})

function choosePreset(next) {
  emit('update:preset', next)
  // Stepping into Custom should carry the shape you were looking at, not dump
  // you on an empty frame.
  if (next === 'custom') {
    const seed = PRESET_DISPLAY_PARTS[props.preset] || OVERLAY_PRESETS.diver
    emit('update:parts', seed.slice())
  }
}

function toggle(key) {
  if (!editable.value) return
  const next = new Set(props.parts)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  // Preserve the canonical order so the URL is stable and diffable.
  emit('update:parts', PART_KEYS.filter((k) => next.has(k)))
}

function selectAll() { if (editable.value) emit('update:parts', PART_KEYS.slice()) }
function clearAll()  { if (editable.value) emit('update:parts', []) }

const count = computed(() => active.value.size)
const empty = computed(() => editable.value && props.parts.length === 0)

// Wireframe geometry. A block is on when it is in `active`.
const on = (key) => active.value.has(key)
const cls = (key) => ['wf-block', on(key) ? 'wf-on' : 'wf-off', editable.value ? 'wf-live' : '']
</script>

<template>
  <div class="opp">
    <div class="opp-presets" role="radiogroup" :aria-label="$t('control.modals.overlay_shape_label')">
      <button v-for="p in PRESET_ORDER"
              :key="p"
              type="button"
              role="radio"
              :aria-checked="preset === p"
              :class="['opp-preset', preset === p ? 'opp-preset-on' : '']"
              @click="choosePreset(p)">
        {{ $t(`control.modals.overlay_preset_${p === '1' ? 'full' : p}`) }}
      </button>
    </div>

    <div class="opp-main">
      <!-- Decorative twin of the checkbox list. Real semantics live below. -->
      <svg class="opp-wire" viewBox="0 0 260 150" aria-hidden="true" focusable="false">
        <!-- left: completed dives -->
        <rect :class="cls('history')" x="4" y="10" width="58" height="130" rx="4"
              @click="toggle('history')" />
        <text class="wf-tag" x="33" y="78" text-anchor="middle">DIVES</text>

        <!-- centre stack -->
        <rect :class="cls('round')" x="76" y="10" width="108" height="12" rx="6"
              @click="toggle('round')" />
        <rect :class="cls('diver')" x="76" y="27" width="108" height="22" rx="3"
              @click="toggle('diver')" />
        <rect :class="cls('dive')" x="76" y="53" width="108" height="12" rx="3"
              @click="toggle('dive')" />
        <g @click="toggle('judges')">
          <rect v-for="i in 5" :key="i" :class="cls('judges')"
                :x="76 + (i - 1) * 22" y="69" width="18" height="16" rx="3" />
        </g>
        <rect :class="cls('total')" x="76" y="89" width="52" height="10" rx="3"
              @click="toggle('total')" />
        <rect :class="cls('rank')" x="132" y="89" width="52" height="10" rx="3"
              @click="toggle('rank')" />
        <rect :class="cls('catchup')" x="76" y="103" width="108" height="14" rx="3"
              @click="toggle('catchup')" />
        <rect :class="cls('upnext')" x="76" y="121" width="108" height="19" rx="3"
              @click="toggle('upnext')" />

        <!-- right: standings -->
        <rect :class="cls('standings')" x="198" y="10" width="58" height="130" rx="4"
              @click="toggle('standings')" />
        <text class="wf-tag" x="227" y="78" text-anchor="middle">RANKS</text>
      </svg>

      <fieldset class="opp-list" :disabled="!editable">
        <legend class="opp-list-legend">{{ $t('control.modals.overlay_parts_label') }}</legend>
        <label v-for="part in OVERLAY_PARTS" :key="part.key" class="opp-check">
          <input type="checkbox"
                 :checked="on(part.key)"
                 @change="toggle(part.key)">
          <span>{{ $t(`control.modals.overlay_part_${part.key}`) }}</span>
        </label>
      </fieldset>
    </div>

    <p class="opp-foot">
      <span class="opp-count">
        {{ $t('control.modals.picker_selected_count', { selected: count, total: PART_KEYS.length }) }}
      </span>
      <template v-if="editable">
        <button type="button" class="opp-linkbtn" @click="selectAll">{{ $t('control.modals.overlay_parts_all') }}</button>
        <button type="button" class="opp-linkbtn" @click="clearAll">{{ $t('control.modals.overlay_parts_none') }}</button>
      </template>
      <span v-else-if="frozen" class="opp-note">{{ $t('control.modals.overlay_preset_locked') }}</span>
      <span v-else class="opp-note">{{ $t('control.modals.overlay_preset_fixed') }}</span>
    </p>

    <p v-if="empty" class="opp-warn" role="alert">{{ $t('control.modals.overlay_parts_empty') }}</p>
  </div>
</template>

<style scoped>
.opp { display: flex; flex-direction: column; gap: 0.6rem; }

.opp-presets { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.opp-preset {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 0.3rem 0.55rem; cursor: pointer;
  background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-3);
}
.opp-preset:hover { color: var(--text-2); border-color: var(--border-2); }
.opp-preset-on { background: var(--cyan-dim); border-color: var(--cyan); color: var(--cyan); }

.opp-main { display: flex; gap: 1rem; align-items: flex-start; }

.opp-wire { width: 260px; flex-shrink: 0; }
.wf-block { stroke-width: 1.5; transition: fill 0.12s, stroke 0.12s, opacity 0.12s; }
.wf-on  { fill: var(--cyan-dim); stroke: var(--cyan); }
.wf-off { fill: transparent; stroke: var(--border-2); stroke-dasharray: 3 2; opacity: 0.65; }
.wf-live { cursor: pointer; }
.wf-live:hover { stroke: var(--cyan); opacity: 1; }
.wf-tag {
  font-family: var(--font-mono); font-size: 7px; letter-spacing: 0.14em;
  fill: var(--text-3); pointer-events: none;
}

.opp-list { border: 0; margin: 0; padding: 0; min-width: 0; }
.opp-list[disabled] { opacity: 0.55; }
.opp-list-legend {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  padding: 0 0 0.35rem;
}
.opp-check { display: flex; align-items: center; gap: 0.4rem; font-size: 12px; color: var(--text-2); padding: 0.1rem 0; }
.opp-check input { cursor: pointer; }
.opp-list[disabled] .opp-check input { cursor: default; }

.opp-foot { display: flex; align-items: center; gap: 0.6rem; margin: 0; font-size: 11px; color: var(--text-3); flex-wrap: wrap; }
.opp-count { font-family: var(--font-mono); }
.opp-linkbtn {
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--cyan); font-size: 11px; text-decoration: underline;
}
.opp-note { font-style: italic; }
.opp-warn { margin: 0; font-size: 11px; color: var(--amber, #f59e0b); }

@media (max-width: 640px) {
  .opp-main { flex-direction: column; }
  .opp-wire { width: 100%; }
}
</style>
