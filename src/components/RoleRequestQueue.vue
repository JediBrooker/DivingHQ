<script setup>
// Pending role requests with approve / reject, for the club and region
// admin pages. GET /api/role-requests already scopes the list to what
// this person may review (lib/role-requests.js), so the component just
// shows it and posts decisions.
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'

defineProps({
  // Show which club each request comes from (region admins, or a club
  // admin with several clubs).
  showClub: { type: Boolean, default: false },
})

const { t } = useI18n()
const auth = useAuthStore()
const requests = ref([])
const loading = ref(true)
const busyId = ref(null)

// user_manager.role_* has every role, coach and meet manager included.
function roleLabel(role) {
  return ['diver', 'coach', 'judge', 'referee', 'meet_manager'].includes(role)
    ? t(`user_manager.role_${role}`)
    : role
}

async function load() {
  loading.value = true
  try {
    const rows = await auth.apiFetch('/api/role-requests')
    requests.value = Array.isArray(rows) ? rows : []
  } catch (err) {
    showError(err.message)
  } finally {
    loading.value = false
  }
}

async function decide(rq, decision) {
  busyId.value = rq.id
  try {
    await auth.apiFetch(`/api/role-requests/${rq.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    requests.value = requests.value.filter(r => r.id !== rq.id)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="muted">…</div>
  <EmptyState
    v-else-if="!requests.length"
    icon="✓"
    :title="$t('my_club.no_requests_title')"
    :body="$t('my_club.no_requests_body')"
  />
  <ul v-else class="rows">
    <li v-for="rq in requests" :key="rq.id" class="row card-sm">
      <div class="who">
        <span class="name">{{ rq.full_name || rq.username }}</span>
        <span class="meta">
          {{ $t('my_club.wants_role', { role: roleLabel(rq.requested_role) }) }}
          <template v-if="showClub && rq.club_name"> · {{ rq.club_name }}</template>
        </span>
        <span v-if="rq.note" class="note">“{{ rq.note }}”</span>
      </div>
      <div class="actions">
        <button class="btn btn-ghost btn-sm" :disabled="busyId === rq.id"
                @click="decide(rq, 'rejected')">{{ $t('my_club.reject') }}</button>
        <button class="btn btn-primary btn-sm" :disabled="busyId === rq.id"
                @click="decide(rq, 'approved')">{{ $t('my_club.approve') }}</button>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.note { font-size: var(--text-xs); color: var(--fg-2); font-style: italic; overflow-wrap: anywhere; }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; }
@media (max-width: 720px) {
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
