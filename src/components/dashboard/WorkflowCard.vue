<script setup>
// One "workflow card" row — the title/meta/count action row shared
// by the Meet Manager, Org Admin, Coach and Referee panels. Global
// styling: .workflow-card (+ -ready / -live state modifiers) and
// .workflow-mini-pill in src/styles/app.css.
//
// `pill` is the optional inline badge after the title (e.g.
// "Rehearsal"); omit for the common case. `meta` callers compose
// any "label · hint" string themselves so this stays a dumb row.
import { RouterLink } from 'vue-router'

defineProps({
  to:    { type: [String, Object], required: true },
  title: { type: String, required: true },
  meta:  { type: String, default: '' },
  count: { type: String, default: '' },
  ready: { type: Boolean, default: false },
  live:  { type: Boolean, default: false },
  pill:  { type: String, default: '' },
})
</script>

<template>
  <RouterLink
    :to="to"
    :class="['workflow-card', ready ? 'workflow-card-ready' : '', live ? 'workflow-card-live' : '']"
  >
    <span class="workflow-card-main">
      <span class="workflow-card-title">
        {{ title }}
        <span v-if="pill" class="workflow-mini-pill">{{ pill }}</span>
      </span>
      <span v-if="meta" class="workflow-card-meta">{{ meta }}</span>
    </span>
    <span class="workflow-card-count">{{ count }}</span>
  </RouterLink>
</template>
