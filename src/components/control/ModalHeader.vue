<script setup>
// Standardised modal header (P2). One eyebrow `.lb-title` + `.lb-event`
// subtitle + ONE ghost close button, replacing the drifting
// 'Close' / 'Close (X icon)' / 'Cancel' variants across the control modals.
// Wires `titleId` (from BaseModal's slot scope) onto the title element
// so the dialog's aria-labelledby resolves.
defineProps({
  titleId: { type: String, default: '' },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
})
defineEmits(['close'])
</script>

<template>
  <div class="lb-header">
    <div>
      <div class="lb-title" :id="titleId || null"><slot name="title">{{ title }}</slot></div>
      <div v-if="subtitle || $slots.default" class="lb-event">{{ subtitle }}<slot /></div>
    </div>
    <button class="btn btn-ghost btn-sm" type="button" aria-label="Close" @click="$emit('close')">
      Close ✕
    </button>
  </div>
</template>
