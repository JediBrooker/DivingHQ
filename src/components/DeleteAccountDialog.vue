<script setup>
// DeleteAccountDialog: self-service account deletion modal
// (Migration 053). Mounted by DiverProfileView's danger zone.
//
// Flow:
//   1. Modal explains what gets deleted vs. kept (mirrors the
//      privacy-policy §7 contract verbatim).
//   2. User types their current password to confirm.
//   3. POST /api/users/me/delete; on success we emit 'deleted'
//      and the parent clears the auth store + redirects.
//
// The password gate is the same defence as the email / password
// change flows, since a hijacked session can't silently destroy
// the account without proving the password.

import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const { t } = useI18n()
const auth = useAuthStore()

// Component is mounted only while open, so lock for its lifetime
// and rely on the composable's onUnmounted to release.
useBodyScrollLock().lock()

const emit = defineEmits(['close', 'deleted'])

const password = ref('')
const submitting = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  if (!password.value) {
    error.value = t('profile.delete.dialog_password_label')
    return
  }
  submitting.value = true
  try {
    await auth.apiFetch('/api/users/me/delete', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    })
    emit('deleted')
  } catch (err) {
    // Heads up: server returns a generic "Password incorrect" for
    // wrong-password (401). Anything else is a server-side wobble or
    // a rate-limit trip, so just surface the message verbatim,
    // that way the user knows what happened.
    error.value = err?.message || t('profile.delete.password_wrong')
    submitting.value = false
  }
}
</script>

<template>
  <!-- Teleport defensively (see notes in ConfirmModal). -->
  <Teleport to="body">
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal delete-modal">
      <div class="modal-head">
        <div class="modal-title">{{ t('profile.delete.dialog_title') }}</div>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">Close ✕</button>
      </div>
      <div class="modal-body">
        <p class="modal-hint">{{ t('profile.delete.body') }}</p>

        <div class="impact-block">
          <div class="impact-section">
            <div class="impact-label removed">{{ t('profile.delete.dialog_what_goes') }}</div>
            <p class="impact-text">{{ t('profile.delete.dialog_what_goes_items') }}</p>
          </div>
          <div class="impact-section">
            <div class="impact-label kept">{{ t('profile.delete.dialog_what_stays') }}</div>
            <p class="impact-text">{{ t('profile.delete.dialog_what_stays_items') }}</p>
          </div>
        </div>

        <div class="field">
          <label class="label">{{ t('profile.delete.dialog_password_label') }}</label>
          <input
            class="input"
            type="password"
            autocomplete="current-password"
            :placeholder="t('profile.delete.dialog_password_placeholder')"
            v-model="password"
            @keyup.enter="submit"
          >
        </div>

        <div v-if="error" class="msg msg-error">{{ error }}</div>

        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" :disabled="submitting" @click="$emit('close')">
            {{ t('profile.delete.dialog_cancel') }}
          </button>
          <button
            class="btn btn-danger btn-sm"
            :disabled="submitting || !password"
            @click="submit"
          >
            {{ submitting ? t('profile.delete.deleting') : t('profile.delete.dialog_confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.delete-modal {
  max-width: 480px;
}
.impact-block {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 1rem 0;
  padding: 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.impact-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.impact-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.impact-label.removed { color: var(--danger, #f87171); }
.impact-label.kept    { color: var(--cyan, #67e8f9); }
.impact-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-2, #cbd5e1);
}
.btn-danger {
  background: var(--danger, #dc2626);
  color: #fff;
  border-color: var(--danger, #dc2626);
}
.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
  border-color: #b91c1c;
}
</style>
