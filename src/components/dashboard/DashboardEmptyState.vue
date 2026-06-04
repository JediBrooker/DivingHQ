<script setup>
defineProps({
  icon:  { type: [Object, Function], required: true },
  title: { type: String, required: true },
  body:  { type: String, default: '' },
})
</script>

<template>
  <div class="dashboard-panel-empty">
    <div class="empty-state-icon" aria-hidden="true">
      <component :is="icon" />
    </div>
    <div class="empty-state-title">{{ title }}</div>
    <div class="empty-state-body">{{ body }}</div>
  </div>
</template>
