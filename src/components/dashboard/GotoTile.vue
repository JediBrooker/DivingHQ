<script setup>
// One "Go to" tile, the destination card repeated across every
// role panel's GO TO grid. Styling is the global .goto-tile /
// .goto-icon / tile-<tone> rules in src/styles/app.css, this
// component just reproduces the markup so the seven panels can
// stop hand-rolling it (and stop threading raw SVG strings through
// v-html, which was kinda gross).
//
// `icon` is a Lucide component (e.g. Calendar), not an SVG string,
// it's rendered through <component :is>. Size 20 matches the old
// inline SVGs that the .goto-icon box was tuned around.
import { RouterLink } from 'vue-router'

defineProps({
  to:    { type: [String, Object], required: true },
  tone:  { type: String, default: 'cyan' }, // amber | cyan | green | purple | red
  icon:  { type: [Object, Function], required: true },
  title: { type: String, required: true },
  desc:  { type: String, required: true },
})
</script>

<template>
  <RouterLink :to="to" :class="['goto-tile', `tile-${tone}`]">
    <div class="goto-icon"><component :is="icon" :size="20" /></div>
    <div class="goto-title">{{ title }}</div>
    <div class="goto-desc">{{ desc }}</div>
  </RouterLink>
</template>
