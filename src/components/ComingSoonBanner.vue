<script setup>
// Standardized "feature incoming" notice, shown on any payments surface
// while it's dormant (the backend reports payments_enabled === false).
// Presentational only — replaces the hand-rolled .coming-soon paragraphs.
defineProps({
  message: { type: String, required: true },
  title: { type: String, default: '' },
  icon: { type: String, default: '🚧' },
})
</script>

<template>
  <p class="coming-soon">
    <span class="cs-icon" aria-hidden="true">{{ icon }}</span>
    <span><strong v-if="title">{{ title }}</strong> {{ message }}</span>
  </p>
</template>

<style scoped>
.coming-soon {
  display: flex;
  gap: .5rem;
  align-items: flex-start;
  margin: 0;
  padding: .55rem .8rem;
  border-radius: .5rem;
  background: var(--accent-soft, #eef);
  color: var(--accent, #3b6);
  font-weight: 600;
  font-size: .85rem;
  line-height: 1.4;
}
.cs-icon { flex: none; }
</style>
