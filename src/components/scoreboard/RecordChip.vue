<script setup>
// The one small chip a record-setting dive wears on the scoreboard and
// the recap. It names the biggest book the dive got into ("NSW record",
// "AUS record"), amber when that book is official and muted while its
// region or country hasn't been claimed. Every book the dive made, and
// what each one beat, goes in the tooltip. No toast, no animation: the
// standings are what people came to see.
//
// It's a button, not a span, because most spectators are on a phone. The
// plain v-tip bubble only shows on hover where hover exists, or on keyboard
// focus, and a span takes neither, so on a phone the details (the club
// record, the mark it beat, "Unofficial") could never be opened. The fixed
// bubble opens on hover and focus, the click opens it for a tap, and Tab
// reaches it. An unofficial book also says so on the chip itself, so the
// word doesn't depend on the bubble at all.
//
// `marks` comes from marksForDive() in src/lib/recordMarks.js, already
// sorted biggest book first.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { continentName } from '@/lib/continents'
import { showFixedTip } from '@/directives/tip'

const props = defineProps({
  marks: { type: Array, required: true },
})

const { t, locale } = useI18n()

function label(m) {
  // Continental marks carry the continent key, named in the viewer's
  // language like the records page does.
  const name = m.scope === 'continental' ? continentName(m.scope_code, locale.value) : m.scope_code
  return t('records.chip', { name })
}

const top = computed(() => props.marks[0] || null)

const chipText = computed(() => {
  if (!top.value) return ''
  return top.value.official ? label(top.value) : `${label(top.value)} · ${t('records.unofficial')}`
})

const tip = computed(() => {
  const lines = props.marks.map((m) => {
    const parts = [label(m), t('records.chip_prev', { score: Number(m.prev_score).toFixed(2) })]
    if (!m.official) parts.push(t('records.unofficial'))
    return parts.join(' · ')
  })
  if (props.marks.some((m) => !m.official)) lines.push(t('records.unofficial_tip'))
  return lines.join('\n')
})

// A screen reader gets the details with the name, the same way JargonTip
// does it: the bubble is a body-level node it would never find.
const spoken = computed(() => [chipText.value, ...tip.value.split('\n')].join('. '))
</script>

<template>
  <button v-if="top"
          type="button"
          :class="['badge', top.official ? 'badge-amber' : 'badge-muted', 'record-chip']"
          data-testid="record-chip"
          :aria-label="spoken"
          v-tip.fixed="tip"
          @click="showFixedTip($event.currentTarget)">{{ chipText }}</button>
</template>

<style scoped>
.record-chip {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: inherit;
  padding: 0.1rem 0.45rem;
  /* a button with a badge's looks, nothing of the browser's own */
  appearance: none;
  margin: 0;
  cursor: help;
}
.record-chip:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
</style>
