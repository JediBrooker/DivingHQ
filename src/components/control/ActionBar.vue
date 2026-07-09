<script setup>
// Standardised modal footer (P2). Right-aligned ghost-cancel button plus a
// busy-aware primary, replaces the inline-styled `.lb-footer` blocks each
// control modal used to hand-roll. Optional `lead` slot for a hint line.
defineProps({
  primaryLabel: { type: String, default: '' },
  cancelLabel: { type: String, default: 'Cancel' },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  primaryKind: { type: String, default: 'primary' },
})
defineEmits(['primary', 'cancel'])
</script>

<template>
  <div class="lb-footer ab-footer">
    <div v-if="$slots.lead" class="ab-lead"><slot name="lead" /></div>
    <div class="ab-actions">
      <button type="button" class="btn btn-ghost btn-sm" @click="$emit('cancel')">{{ cancelLabel }}</button>
      <button
        v-if="primaryLabel || $slots.default"
        type="button"
        :class="['btn', 'btn-sm', `btn-${primaryKind}`]"
        :disabled="busy || disabled"
        @click="$emit('primary')"
      ><slot>{{ primaryLabel }}</slot></button>
    </div>
  </div>
</template>

<style scoped>
.ab-footer { display: flex; align-items: center; gap: 1rem; }
.ab-lead { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.ab-actions { display: flex; gap: 0.55rem; margin-inline-start: auto; }
</style>
