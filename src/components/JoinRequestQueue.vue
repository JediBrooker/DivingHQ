<script setup>
// People asking to join a club, for the club and region admin pages in a
// country with no federation (routes/club-changes.js lets those admins
// approve a club_change into a club they run). GET
// /api/club-change-requests already scopes the inbox to what this
// person may decide; the caller's own requests come back too, so they're
// dropped here.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'

defineProps({
  // Say which club each request is for (region admins, or a club admin
  // with several clubs).
  showClub: { type: Boolean, default: false },
})
const emit = defineEmits(['decided'])

const auth = useAuthStore()
const requests = ref([])
const loading = ref(true)
const busyId = ref(null)

async function load() {
  loading.value = true
  try {
    const rows = await auth.apiFetch('/api/club-change-requests')
    requests.value = (Array.isArray(rows) ? rows : []).filter(r =>
      r.status === 'pending' && r.kind === 'club_change' && r.to_club_id && r.user_id !== auth.user?.id)
  } catch (err) {
    showError(err.message)
  } finally {
    loading.value = false
  }
}

async function decide(rq, decision) {
  busyId.value = rq.id
  try {
    await auth.apiFetch(`/api/club-change-requests/${rq.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    requests.value = requests.value.filter(r => r.id !== rq.id)
    // A new member shows up in the co-admin picker, so let the page reload it.
    emit('decided', { request: rq, decision })
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
    :title="$t('my_club.no_join_requests_title')"
    :body="$t('my_club.no_join_requests_body')"
  />
  <ul v-else class="rows" data-test-id="join-requests">
    <li v-for="rq in requests" :key="rq.id" class="row card-sm">
      <div class="who">
        <span class="name">{{ rq.diver_name || rq.diver_username }}</span>
        <span class="meta">
          @{{ rq.diver_username }}
          <template v-if="showClub"> · {{ $t('my_club.wants_to_join', { club: rq.to_club_name }) }}</template>
          <template v-if="rq.from_club_name"> · {{ $t('my_club.currently_at', { club: rq.from_club_name }) }}</template>
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
