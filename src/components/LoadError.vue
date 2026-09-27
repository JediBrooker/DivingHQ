<script setup>
// "Couldn't load this" plus a retry button. For lists where a failed
// fetch used to fall through to the empty state, or to a permission
// message, and so told the reader something false ("no claims", "your
// federation appoints these admins") when really we just don't know yet.
// Not an EmptyState on purpose: nothing here is known to be empty.
defineProps({
  // Defaults to the generic common.load_failed wording.
  message: { type: String, default: '' },
  busy:    { type: Boolean, default: false },
})
defineEmits(['retry'])
</script>

<template>
  <div class="load-error" role="alert">
    <p class="load-error-msg">{{ message || $t('common.load_failed') }}</p>
    <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="$emit('retry')">
      {{ $t('common.retry') }}
    </button>
  </div>
</template>

<style scoped>
.load-error {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--danger-solid);
  border-radius: var(--radius-lg);
  background: var(--danger-bg);
}
.load-error-msg { margin: 0; color: var(--danger-fg); font-size: var(--text-sm); }
</style>
