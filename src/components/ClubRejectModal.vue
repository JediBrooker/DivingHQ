<script setup>
// Turn down a club that signed up under the federation (migration 096,
// POST /api/clubs/:id/reject). It deletes the club; the founder keeps
// their account. The usual reason is a duplicate, someone founding a club
// that's already here, so they can be moved into that one in the same
// step, and the Clubs page preselects the look-alike when it spots one.
import { ref } from 'vue'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  // A pending row from GET /api/clubs (ClubRow).
  club: { type: Object, required: true },
  // Approved clubs in the same org, [{ id, name, short_code }].
  candidates: { type: Array, default: () => [] },
  // Id of the club this one looks like, if any.
  suggested: { type: String, default: '' },
})
const emit = defineEmits(['close', 'done'])

const auth = useAuthStore()

const reason = ref('')
const moveTo = ref(props.suggested || '')
const busy = ref(false)
const error = ref('')

async function submit() {
  busy.value = true
  error.value = ''
  try {
    const out = await auth.apiFetch(`/api/clubs/${props.club.id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.value.trim() || null, move_members_to: moveTo.value || null }),
    })
    emit('done', out)
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal max-width="520px" @close="emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" :title="$t('clubs.reject_title')" :subtitle="club.name" @close="emit('close')" />
      <form class="lb-body" data-testid="club-reject-dialog" @submit.prevent="submit">
        <p class="hint intro">{{ $t('clubs.reject_body', { club: club.name, name: club.founder_name || '—' }) }}</p>
        <div class="field">
          <label class="label" for="reject-club-reason">{{ $t('clubs.reject_reason') }}</label>
          <textarea id="reject-club-reason" class="input" rows="3" maxlength="1000" v-model="reason"></textarea>
        </div>
        <div class="field">
          <label class="label" for="reject-club-move">{{ $t('clubs.reject_move_to') }}</label>
          <select id="reject-club-move" class="select" v-model="moveTo">
            <option value="">{{ $t('clubs.reject_move_none') }}</option>
            <option v-for="c in candidates" :key="c.id" :value="c.id">
              {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
            </option>
          </select>
        </div>
        <div v-if="error" class="msg msg-error">{{ error }}</div>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">{{ $t('common.cancel') }}</button>
          <button class="btn btn-danger btn-sm" type="submit" :disabled="busy">
            {{ busy ? $t('common.saving') : $t('clubs.reject') }}
          </button>
        </div>
      </form>
    </template>
  </BaseModal>
</template>

<style scoped>
.intro { margin: 0 0 0.9rem; }
.hint { font-size: var(--text-sm); color: var(--fg-3); }
.field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
.field textarea { resize: vertical; min-height: 4.5rem; font-family: inherit; }
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem; }
.msg { margin-top: 0.75rem; }
</style>
