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
import RoleRequestQueue from '@/components/RoleRequestQueue.vue'
import ClubSetupCard from '@/components/ClubSetupCard.vue'

const { t } = useI18n()
const auth = useAuthStore()

const busyId = ref(null)

// The org's regions (states etc.), so a club admin can say which one
// their club is in. Empty for countries without them.
const regions = ref({ label: null, regions: [] })
const regionLabel = computed(() => regions.value.label ? t(`regions.label.${regions.value.label}`) : '')

// Per club: { admins, members, canManage, toAdd }
const clubState = ref({})
const clubs = computed(() => auth.clubAdminOf)

async function loadRegions() {
  if (!auth.user?.org_id) return
  try {
    regions.value = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/regions`)
  } catch { /* no regions, nothing to show */ }
}

async function setRegion(club, regionId) {
  busyId.value = club.id
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/region`, {
      method: 'PUT',
      body: JSON.stringify({ region_id: regionId || null }),
    })
    // Keeps auth.clubAdminOf (and so the meet screens) in step.
    await auth.fetchMe()
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
  loadRegions()
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

    <!-- Invite link + club code, one card per club (dashboard "Get started" links here). -->
    <ClubSetupCard v-for="club in clubs" :key="`setup-${club.id}`" :club="club" />

    <section class="block">
      <h2 class="block-title">{{ $t('my_club.requests') }}</h2>
      <RoleRequestQueue :show-club="clubs.length > 1" />
    </section>

    <section v-for="club in clubs" :key="club.id" class="block">
      <h2 class="block-title">{{ $t('my_club.admins') }} · {{ club.name }}</h2>
      <template v-if="clubState[club.id]">
        <!-- Which region the club is in. Same rule as the admins list:
             the club decides where there's no federation. -->
        <div v-if="regions.regions.length && clubState[club.id].canManage" class="region-row">
          <label class="label" :for="`region-${club.id}`">{{ regionLabel }}</label>
          <select :id="`region-${club.id}`" class="select" :value="club.region_id || ''" :disabled="busyId === club.id"
                  @change="setRegion(club, $event.target.value)">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="r in regions.regions" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </div>
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
.region-row { display: flex; flex-direction: column; gap: var(--space-1); max-width: 320px; }
.add-row .select { flex: 1; min-width: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
