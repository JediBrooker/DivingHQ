<script setup>
// A club admin's own page. In a country with no federation on DivingHQ
// the club admin is the only person who can approve their members'
// role requests (lib/role-requests.js) and appoint co-admins, so this
// is where that happens. Under a federation the requests list is empty
// (the federation reviews) and the admins list is read-only.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'

const { t } = useI18n()
const auth = useAuthStore()

const requests = ref([])
const requestsLoading = ref(true)
const busyId = ref(null)

// Per club: { admins, members, canManage, toAdd }
const clubState = ref({})
const clubs = computed(() => auth.clubAdminOf)

function roleLabel(role) {
  return ['diver', 'judge', 'referee'].includes(role) ? t(`role.${role}`) : role
}

async function loadRequests() {
  requestsLoading.value = true
  try {
    const rows = await auth.apiFetch('/api/role-requests')
    requests.value = Array.isArray(rows) ? rows : []
  } catch (err) {
    showError(err.message)
  } finally {
    requestsLoading.value = false
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

async function loadClub(club) {
  try {
    const body = await auth.apiFetch(`/api/clubs/${club.id}/admins`)
    clubState.value[club.id] = {
      admins: body.admins || [], members: body.members || [], canManage: true, toAdd: '',
    }
  } catch {
    // 403 under a federation: it appoints admins, not the club.
    clubState.value[club.id] = { admins: [], members: [], canManage: false, toAdd: '' }
  }
}

function addable(clubId) {
  const st = clubState.value[clubId]
  if (!st) return []
  const taken = new Set(st.admins.map(a => a.id))
  return st.members.filter(m => !taken.has(m.id))
}

async function addAdmin(club) {
  const st = clubState.value[club.id]
  if (!st?.toAdd) return
  busyId.value = club.id
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/admins`, {
      method: 'POST',
      body: JSON.stringify({ user_id: st.toAdd }),
    })
    await loadClub(club)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function removeAdmin(club, admin) {
  busyId.value = club.id
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/admins/${admin.id}`, { method: 'DELETE' })
    await loadClub(club)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(() => {
  loadRequests()
  for (const c of clubs.value) loadClub(c)
})
</script>

<template>
  <div class="main">
    <header class="head">
      <div>
        <h1 class="title">{{ $t('my_club.title') }}</h1>
        <p class="intro">{{ $t('my_club.intro') }}</p>
      </div>
      <RouterLink to="/manager" class="btn btn-primary btn-sm">{{ $t('my_club.run_meets') }}</RouterLink>
    </header>

    <section class="block">
      <h2 class="block-title">{{ $t('my_club.requests') }}</h2>
      <div v-if="requestsLoading" class="muted">…</div>
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
              <template v-if="clubs.length > 1 && rq.club_name"> · {{ rq.club_name }}</template>
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
    </section>

    <section v-for="club in clubs" :key="club.id" class="block">
      <h2 class="block-title">{{ $t('my_club.admins') }} · {{ club.name }}</h2>
      <template v-if="clubState[club.id]">
        <p v-if="!clubState[club.id].canManage" class="muted">{{ $t('my_club.federation_appoints') }}</p>
        <template v-else>
          <ul class="rows">
            <li v-for="a in clubState[club.id].admins" :key="a.id" class="row card-sm">
              <div class="who">
                <span class="name">{{ a.full_name }}</span>
                <span class="meta">@{{ a.username }}</span>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="busyId === club.id"
                      @click="removeAdmin(club, a)">{{ $t('my_club.remove') }}</button>
            </li>
          </ul>
          <div class="add-row">
            <select class="select" v-model="clubState[club.id].toAdd" :disabled="!addable(club.id).length"
                    :aria-label="$t('my_club.add_admin')">
              <option value="">{{ $t('my_club.pick_member') }}</option>
              <option v-for="m in addable(club.id)" :key="m.id" :value="m.id">
                {{ m.full_name }} (@{{ m.username }})
              </option>
            </select>
            <button class="btn btn-primary btn-sm" :disabled="!clubState[club.id].toAdd || busyId === club.id"
                    @click="addAdmin(club)">{{ $t('my_club.add') }}</button>
          </div>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.main {
  max-width: 880px; margin: 0 auto; padding: var(--space-6) var(--space-8);
  display: flex; flex-direction: column; gap: var(--space-8);
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
.title { font-size: var(--text-h2); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.intro { margin: var(--space-1) 0 0; color: var(--fg-3); font-size: var(--text-sm); max-width: 56ch; }
.block { display: flex; flex-direction: column; gap: var(--space-3); }
.block-title { font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.note { font-size: var(--text-xs); color: var(--fg-2); font-style: italic; overflow-wrap: anywhere; }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.add-row { display: flex; gap: var(--space-2); align-items: center; }
.add-row .select { flex: 1; min-width: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
