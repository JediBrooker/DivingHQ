<script setup>
/* Inline acronym/jargon tooltip.
 *
 * Wraps any short term in a dotted-underline span; hovering /
 * focusing it shows a definition tooltip. The glossary lives in
 * @/lib/glossary.js, so a known-term miss is fine (component falls
 * back to whatever was passed via the `define` prop, or just
 * shows the term verbatim with no tooltip if neither is given).
 *
 * Usage:
 *
 *   <JargonTip term="DD" />
 *   <JargonTip term="ROC">round of competition</JargonTip>
 *   <JargonTip term="balk" define="A diver starts the takeoff but stops…" />
 *
 * The slot, if any, becomes the visible label; otherwise the
 * term itself gets rendered. Tooltip text comes from `define` or
 * the glossary lookup.
 */
import { computed, ref } from 'vue'
import { lookupTerm } from '@/lib/glossary'

const props = defineProps({
  term:   { type: String, required: true },
  define: { type: String, default: null },
})

const definition = computed(() => props.define || lookupTerm(props.term) || '')
const showTip    = ref(false)

function toggle() { showTip.value = !showTip.value }
function open()   { showTip.value = true }
function close()  { showTip.value = false }
</script>

<template>
  <span
    class="jargon"
    :class="{ 'has-def': !!definition }"
    tabindex="0"
    role="button"
    :aria-label="definition ? `${term} — ${definition}` : term"
    :aria-expanded="showTip"
    @mouseenter="open"
    @mouseleave="close"
    @focus="open"
    @blur="close"
    @click="toggle"
  >
    <slot>{{ term }}</slot>
    <span v-if="showTip && definition" class="jargon-tip" role="tooltip">
      <strong class="jargon-tip-term">{{ term }}</strong>
      <span class="jargon-tip-def">{{ definition }}</span>
    </span>
  </span>
</template>

<style scoped>
.jargon {
  display: inline;
  position: relative;
  cursor: default;
}
.jargon.has-def {
  /* Dotted underline + a small "?" superscript so the
     affordance is discoverable without hover. The underline
     alone vanishes against cyan text in some themes. */
  text-decoration: underline dotted;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  text-decoration-color: currentColor;
  opacity: 0.85;
  cursor: help;
}
.jargon.has-def::after {
  content: 'ⓘ';
  font-size: 0.75em;
  margin-inline-start: 0.18em;
  opacity: 0.7;
  vertical-align: super;
  line-height: 0;
}
.jargon.has-def:hover, .jargon.has-def:focus-visible {
  opacity: 1;
  outline: none;
}
.jargon.has-def:hover::after, .jargon.has-def:focus-visible::after { opacity: 1; }
.jargon-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  inset-inline-start: 50%;
  transform: translateX(-50%);
  background: var(--bg-2, #0f172a);
  color: var(--text, #f8fafc);
  border: 1px solid var(--border-2, #334155);
  border-radius: var(--radius, 6px);
  padding: 0.55rem 0.75rem;
  width: max-content;
  max-width: 280px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  z-index: 200;
  white-space: normal;
  display: flex; flex-direction: column; gap: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 12px; line-height: 1.4;
  pointer-events: none;
}
.jargon-tip-term {
  font-family: var(--font-display, sans-serif);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
}
.jargon-tip-def { color: var(--text-2, #cbd5e1); }
</style>
