<script setup>
// "Request a role" from your own profile (POST /api/role-requests).
//
// Signup used to be the only place to ask, so a diver who later wanted
// to judge had no way in. The server decides what's on offer
// (GET /api/role-requests/mine: no org-wide meet manager where there's no
// federation, nothing you already hold) and who reviews it, same routing
// as signup. This just shows the choice, your recent requests, and says
// who will look at it.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess } from '@/composables/useNotify'

const props = defineProps({
  // Where there's no federation, someone with no club has nobody but
  // DivingHQ to ask, which is worth saying before they send it.
  hasClub: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])

const { t } = useI18n()
const auth = useAuthStore()

const loading = ref(true)
const info = ref({ claim_state: null, requestable: [], held: [], requests: [] })
const role = ref('')
const note = ref('')
const sending = ref(false)
const error = ref('')

const ROLE_KEYS = ['diver', 'coach', 'judge', 'referee', 'meet_manager', 'spectator', 'org_admin']
function roleLabel(r) {
  return ROLE_KEYS.includes(r) ? t(`user_manager.role_${r}`) : r
}

const pendingRoles = computed(() =>
  new Set(info.value.requests.filter(r => r.status === 'pending').map(r => r.requested_role)))
const options = computed(() => info.value.requestable.filter(r =>
  !info.value.held.includes(r) && !pendingRoles.value.has(r)))
const heldLabels = computed(() => info.value.held
  .filter(r => r !== 'spectator')
  .map(roleLabel)
  .join(', '))
const unclaimed = computed(() => info.value.claim_state === 'unclaimed')

async function load() {
  loading.value = true
  error.value = ''
  try {
    info.value = await auth.apiFetch('/api/role-requests/mine')
    if (!options.value.includes(role.value)) role.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function send() {
  if (!role.value) return
  sending.value = true
  error.value = ''
  try {
    await auth.apiFetch('/api/role-requests', {
      method: 'POST',
      body: JSON.stringify({ role: role.value, note: note.value.trim() || null }),
    })
    showSuccess(t('request_role.sent'))
    note.value = ''
    role.value = ''
    await load()
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}

function statusLabel(s) {
  return t(`request_role.status_${s}`)
}

onMounted(load)
</script>

<template>
  <BaseModal max-width="520px" @close="emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" :title="$t('request_role.title')" @close="emit('close')" />
      <div class="lb-body" data-test-id="request-role-dialog">
        <div v-if="loading" class="hint">…</div>
        <template v-else>
          <p class="hint intro">
            {{ unclaimed ? $t('request_role.intro_unclaimed') : $t('request_role.intro_claimed') }}
          </p>
          <p v-if="unclaimed && !props.hasClub" class="hint">{{ $t('request_role.no_club_hint') }}</p>
          <p v-if="heldLabels" class="hint">{{ $t('request_role.you_have', { roles: heldLabels }) }}</p>

          <template v-if="options.length">
            <div class="field">
              <label class="label" for="request-role-select">{{ $t('request_role.role_label') }}</label>
              <select id="request-role-select" class="select" v-model="role">
                <option value="">{{ $t('request_role.pick_role') }}</option>
                <option v-for="r in options" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
              <p v-if="unclaimed && role === 'referee'" class="hint">{{ $t('auth.register.referee_note_unclaimed') }}</p>
            </div>
            <div class="field">
              <label class="label" for="request-role-note">{{ $t('request_role.note_label') }}</label>
              <input id="request-role-note" class="input" type="text" maxlength="500" v-model="note"
                     :placeholder="$t('auth.register.note_placeholder')">
            </div>
          </template>
          <p v-else class="hint">{{ $t('request_role.nothing_left') }}</p>

          <div v-if="error" class="msg msg-error">{{ error }}</div>

          <div v-if="info.requests.length" class="history">
            <div class="section-label">{{ $t('request_role.your_requests') }}</div>
            <ul class="history-list">
              <li v-for="rq in info.requests" :key="rq.id" class="history-row">
                <span>{{ roleLabel(rq.requested_role) }}</span>
                <span :class="['badge', rq.status === 'approved' ? 'badge-green' : rq.status === 'rejected' ? 'badge-red' : 'badge-amber']">
                  {{ statusLabel(rq.status) }}
                </span>
              </li>
            </ul>
          </div>

          <div class="actions">
            <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">{{ $t('profile.cancel') }}</button>
            <button v-if="options.length" class="btn btn-primary btn-sm" type="button"
                    :disabled="!role || sending" @click="send">
              {{ sending ? $t('request_role.sending') : $t('request_role.submit') }}
            </button>
          </div>
        </template>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
.intro { margin: 0 0 0.75rem; }
.hint { font-size: var(--text-sm); color: var(--fg-3); margin: 0 0 0.75rem; }
.field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
.field .hint { margin: 0.25rem 0 0; font-size: var(--text-xs); }
.history { margin-top: 1rem; }
.section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.5rem;
}
.history-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.history-row {
  display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;
  padding: 0.45rem 0.7rem; font-size: var(--text-sm);
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem; }
</style>
