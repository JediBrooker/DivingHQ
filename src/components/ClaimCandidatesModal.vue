<script setup>
// ClaimCandidatesModal, the reunite-on-return UI (Migration 053).
//
// Used in two places:
//   1. Post-registration in RegisterView, after the welcome
//      email goes out and the user lands signed in, we look up
//      any deleted-account candidates with the same name in
//      the same org and offer to re-link them.
//   2. Manual entry point in DiverProfileView's danger zone,
//      for users who skipped the sign-up prompt.
//
// Both surfaces post to /api/users/me/claim-candidates first
// to get the list, then POST /api/users/me/claim with the
// selected old_user_ids and a re-auth password.
//
// We deliberately don't auto-claim, two athletes can genuinely
// share a name so the user's the one who picks which entries
// are actually theirs.

import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const props = defineProps({
  // Pre-fetched candidates, for when the caller already has them.
  // If omitted, we go fetch them ourselves on mount.
  candidates: { type: Array, default: null },
  // Display variant, 'signup' shows the welcome-back banner,
  // 'manual' just uses the generic copy.
  variant: { type: String, default: 'manual' },
})

const emit = defineEmits(['close', 'claimed', 'skipped'])

// Lock background scroll for the lifetime of this modal. The
// component is only mounted while open, so a single lock at
// setup is enough, the composable's own onUnmounted releases
// the lock when this component gets torn down.
useBodyScrollLock().lock()

const { t, locale } = useI18n()
const auth = useAuthStore()

const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const fetched = ref(props.candidates)
// Track which candidate ids the user has ticked. Defaults to
// none, explicit confirmation is the whole point here.
const selected = ref(new Set())
const password = ref('')

const candidatesList = computed(() => fetched.value || [])
const hasSelection = computed(() => selected.value.size > 0)

onMounted(async () => {
  if (props.candidates != null) return
  await refetch()
})

async function refetch() {
  loading.value = true
  error.value = ''
  try {
    const data = await auth.apiFetch('/api/users/me/claim-candidates', {
      method: 'POST',
    })
    fetched.value = Array.isArray(data?.candidates) ? data.candidates : []
  } catch (err) {
    error.value = err?.message || ''
    fetched.value = []
  } finally {
    loading.value = false
  }
}

function toggle(id) {
  // Re-assign the Set so Vue picks up the change, mutating in
  // place won't re-trigger reactivity on a Set ref (classic Vue gotcha).
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  selected.value = next
}

function isSelected(id) {
  return selected.value.has(id)
}

function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(locale.value, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  } catch { return '' }
}

function divePhrase(n) {
  return n === 1
    ? t('profile.claim.candidate_dive_count_one', { n })
    : t('profile.claim.candidate_dive_count_many', { n })
}
function panelPhrase(n) {
  return n === 1
    ? t('profile.claim.candidate_panel_count_one', { n })
    : t('profile.claim.candidate_panel_count_many', { n })
}

async function confirm() {
  error.value = ''
  if (!hasSelection.value) return
  if (!password.value) {
    error.value = t('profile.claim.password_label')
    return
  }
  submitting.value = true
  try {
    const data = await auth.apiFetch('/api/users/me/claim', {
      method: 'POST',
      body: JSON.stringify({
        old_user_ids: Array.from(selected.value),
        password: password.value,
      }),
    })
    emit('claimed', data)
  } catch (err) {
    const msg = err?.message || ''
    // Server-side 409 means a schema-conflict message. We render
    // our own localised string instead of the raw server text so
    // re-translators stay in control of the wording.
    if (/Cannot merge/i.test(msg)) {
      error.value = t('profile.claim.conflict')
    } else {
      error.value = msg
    }
    submitting.value = false
  }
}

function skip() {
  emit('skipped')
}
</script>

<template>
  <!-- Teleport defensively (see notes in ConfirmModal). -->
  <Teleport to="body">
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal claim-modal">
      <div class="modal-head">
        <div class="modal-title">{{ t('profile.claim.title') }}</div>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">Close ✕</button>
      </div>
      <div class="modal-body">

        <p v-if="variant === 'signup' && candidatesList.length" class="modal-hint">
          {{ t('profile.claim.subtitle_signup', { n: candidatesList.length }) }}
        </p>
        <p v-else-if="candidatesList.length" class="modal-hint">
          {{ t('profile.claim.body', { n: candidatesList.length }) }}
        </p>

        <div v-if="loading" class="empty">Loading…</div>
        <div v-else-if="!candidatesList.length" class="empty">
          {{ t('profile.claim.find_none') }}
        </div>

        <ul v-if="candidatesList.length" class="candidate-list">
          <li
            v-for="c in candidatesList"
            :key="c.id"
            class="candidate-row"
            :class="{ 'is-selected': isSelected(c.id) }"
          >
            <label class="candidate-label">
              <input
                type="checkbox"
                :checked="isSelected(c.id)"
                @change="toggle(c.id)"
                :disabled="submitting"
              >
              <div class="candidate-body">
                <div class="candidate-name">
                  {{ c.full_name }}
                  <span v-if="c.club_name" class="candidate-club">
                    · {{ c.club_name }}<span v-if="c.club_code" class="candidate-club-code">{{ c.club_code }}</span>
                  </span>
                </div>
                <div class="candidate-meta">
                  <span v-if="c.dive_count != null">{{ divePhrase(c.dive_count) }}</span>
                  <span v-if="c.panel_count" class="meta-sep">·</span>
                  <span v-if="c.panel_count">{{ panelPhrase(c.panel_count) }}</span>
                  <span v-if="c.deleted_at" class="meta-sep">·</span>
                  <span v-if="c.deleted_at" class="candidate-deleted">
                    {{ t('profile.claim.candidate_deleted_at', { date: fmtDate(c.deleted_at) }) }}
                  </span>
                </div>
                <div
                  v-if="Array.isArray(c.event_names) && c.event_names.length"
                  class="candidate-events"
                >
                  {{ t('profile.claim.candidate_event_summary', { events: c.event_names.slice(0, 4).join(', ') }) }}
                  <span v-if="c.event_names.length > 4">+{{ c.event_names.length - 4 }}…</span>
                </div>
              </div>
            </label>
          </li>
        </ul>

        <div v-if="hasSelection" class="field">
          <label class="label">{{ t('profile.claim.password_label') }}</label>
          <input
            class="input"
            type="password"
            autocomplete="current-password"
            :placeholder="t('profile.claim.password_placeholder')"
            v-model="password"
            @keyup.enter="confirm"
          >
        </div>

        <div v-if="error" class="msg msg-error">{{ error }}</div>

        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" :disabled="submitting" @click="skip">
            {{ t('profile.claim.skip') }}
          </button>
          <button
            v-if="candidatesList.length"
            class="btn btn-primary btn-sm"
            :disabled="submitting || !hasSelection || !password"
            @click="confirm"
          >
            {{ submitting ? t('profile.claim.confirming') : t('profile.claim.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.claim-modal {
  max-width: 560px;
}
.candidate-list {
  list-style: none;
  margin: 0.75rem 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.candidate-row {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2, #1e293b);
  transition: border-color 120ms, background 120ms;
}
.candidate-row.is-selected {
  border-color: var(--cyan, #06b6d4);
  background: var(--cyan-dim, rgba(6, 182, 212, 0.08));
}
.candidate-label {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.7rem 0.85rem;
  cursor: pointer;
}
.candidate-label input[type="checkbox"] {
  margin-top: 0.25rem;
}
.candidate-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.candidate-name {
  font-weight: 600;
  font-size: 14px;
}
.candidate-club {
  font-weight: 400;
  font-size: 12px;
  color: var(--text-2, #cbd5e1);
  margin-inline-start: 0.25rem;
}
.candidate-club-code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--cyan, #67e8f9);
  margin-inline-start: 0.35rem;
}
.candidate-meta {
  font-size: 12px;
  color: var(--text-3, #94a3b8);
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.candidate-meta .meta-sep { opacity: 0.5; }
.candidate-events {
  font-size: 11px;
  color: var(--text-3, #94a3b8);
  font-style: italic;
}
</style>
