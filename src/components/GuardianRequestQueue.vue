<script setup>
// Parents asking to be linked to a child so they can pay the child's
// fees, for the club and region admin pages in a country with no
// federation. GET /api/guardian-requests already narrows it to children
// in the clubs this person runs, and leaves out any request they're part
// of (lib/guardian-requests.js), so this just lists them and posts the
// decisions. Once approved the parent can pay for the child and see what
// they owe, which is why the hint says to approve only people you know.
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'
import LoadError from '@/components/LoadError.vue'

defineProps({
  // Say which club each child is in (region admins, or a club admin with
  // several clubs).
  showClub: { type: Boolean, default: false },
})

const auth = useAuthStore()
const requests = ref([])
const loading = ref(true)
// A failed load isn't "nobody waiting", so it gets its own state.
const loadError = ref(false)
const busyId = ref(null)

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const rows = await auth.apiFetch('/api/guardian-requests')
    requests.value = Array.isArray(rows) ? rows : []
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function decide(rq, decision) {
  busyId.value = rq.id
  try {
    await auth.apiFetch(`/api/guardian-requests/${rq.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    })
    requests.value = requests.value.filter(r => r.id !== rq.id)
  } catch (err) {
    // 409: a co-admin (or the parent withdrawing it) got there first. It's
    // settled either way, so it leaves the list with the reason shown.
    if (err.status === 409) requests.value = requests.value.filter(r => r.id !== rq.id)
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div v-if="loading" class="muted">…</div>
  <LoadError v-else-if="loadError" @retry="load" />
  <EmptyState
    v-else-if="!requests.length"
    icon="✓"
    :title="$t('my_club.no_guardian_requests_title')"
    :body="$t('my_club.no_guardian_requests_body')"
  />
  <template v-else>
    <p class="muted">{{ $t('my_club.guardian_requests_hint') }}</p>
    <ul class="rows" data-testid="guardian-queue">
      <li v-for="rq in requests" :key="rq.id" class="row card-sm" data-testid="guardian-queue-row">
        <div class="who">
          <span class="name">{{ rq.dependent_name }}</span>
          <span class="meta">
            {{ $t('user_manager.guardian_request_by', { name: rq.guardian_name }) }}
            <template v-if="rq.dependent_age != null"> · {{ $t('guardians.age_years', { age: rq.dependent_age }) }}</template>
            <template v-if="showClub && rq.club_name"> · {{ rq.club_name }}</template>
          </span>
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
</template>

<style scoped>
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; max-width: 64ch; }
@media (max-width: 720px) {
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
