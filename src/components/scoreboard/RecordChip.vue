<script setup>
// The one small chip a record-setting dive wears on the scoreboard and
// the recap. It names the biggest book the dive got into ("NSW record",
// "AUS record"), amber when that book is official and muted while its
// region or country hasn't been claimed. Every book the dive made, and
// what each one beat, goes in the tooltip. No toast, no animation: the
// standings are what people came to see.
//
// `marks` comes from marksForDive() in src/lib/recordMarks.js, already
// sorted biggest book first.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { continentName } from '@/lib/continents'

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

const tip = computed(() => {
  const lines = props.marks.map((m) => {
    const parts = [label(m), t('records.chip_prev', { score: Number(m.prev_score).toFixed(2) })]
    if (!m.official) parts.push(t('records.unofficial'))
    return parts.join(' · ')
  })
  if (props.marks.some((m) => !m.official)) lines.push(t('records.unofficial_tip'))
  return lines.join('\n')
})
</script>

<template>
  <span v-if="top"
        :class="['badge', top.official ? 'badge-amber' : 'badge-muted', 'record-chip']"
        data-testid="record-chip"
        v-tip="tip">{{ label(top) }}</span>
</template>

<style scoped>
.record-chip {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10.5px;
  padding: 0.1rem 0.45rem;
}
</style>
