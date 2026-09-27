<script setup>
// A region admin's page (migration 088): the clubs in their region, who
// runs each one, and the pending role requests from those clubs'
// members. Region admins sit one level above club admins, so they can
// act on any of these requests, not just ones whose club has no admin.
// Where there's no federation they also add and remove their own
// co-admins here (the server says so with can_manage).
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import EmptyState from '@/components/EmptyState.vue'
import RoleRequestQueue from '@/components/RoleRequestQueue.vue'

const { t } = useI18n()
const auth = useAuthStore()

const regions = computed(() => auth.regionAdminOf)
// Per region id: { region, clubs, admins, candidates, canManage, toAdd }
const detail = ref({})
const busyId = ref(null)

function labelFor(key) {
  return key ? t(`regions.label.${key}`) : ''
}

async function load(region) {
  try {
    const [overview, admins] = await Promise.all([
      auth.apiFetch(`/api/regions/${region.id}/overview`),
      auth.apiFetch(`/api/regions/${region.id}/admins`),
    ])
    detail.value[region.id] = {
      ...overview,
      admins: admins.admins || [],
      candidates: admins.candidates || [],
      canManage: !!admins.can_manage,
      toAdd: '',
    }
    if (placesClubs(region.id)) await loadOrgClubs(overview.region?.org_id)
  } catch (err) {
    showError(err.message)
  }
}

// A state body that has claimed its region decides which clubs are in
// it (a club admin can't move in or out on their own there), so it gets
// the controls. Other clubs in the org come from the public club list.
const orgClubs = ref({})       // org id -> clubs
const orgRegions = ref({})     // org id -> regions
const clubToAdd = ref({})      // region id -> club id

function placesClubs(regionId) {
  const d = detail.value[regionId]
  return !!d && d.canManage && d.region?.claim_state === 'claimed'
}

async function loadOrgClubs(orgId) {
  if (!orgId || orgClubs.value[orgId]) return
  try {
    const [clubs, regionList] = await Promise.all([
      auth.apiFetch(`/api/orgs/${orgId}/clubs`),
      auth.apiFetch(`/api/orgs/${orgId}/regions`),
    ])
    orgClubs.value[orgId] = Array.isArray(clubs) ? clubs : []
    orgRegions.value[orgId] = regionList?.regions || []
  } catch { /* the add picker just stays empty */ }
}

// Clubs this admin could bring in: not already here, and not sitting in
// another claimed region they don't run (that one's admin decides).
function clubsToAdd(regionId) {
  const d = detail.value[regionId]
  const orgId = d?.region?.org_id
  const mine = new Set((auth.regionAdminOf || []).map(r => r.id))
  const regionsById = new Map((orgRegions.value[orgId] || []).map(r => [r.id, r]))
  return (orgClubs.value[orgId] || []).filter(c => {
    if (c.region_id === regionId) return false
    const from = c.region_id ? regionsById.get(c.region_id) : null
    return !(from?.claim_state === 'claimed' && !mine.has(from.id))
  })
}

async function moveClub(region, clubId, regionId) {
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/clubs/${clubId}/region`, {
      method: 'PUT',
      body: JSON.stringify({ region_id: regionId }),
    })
    clubToAdd.value[region.id] = ''
    const orgId = detail.value[region.id]?.region?.org_id
    if (orgId) delete orgClubs.value[orgId]
    await load(region)
    await loadOrgClubs(orgId)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

function addable(regionId) {
  const d = detail.value[regionId]
  if (!d) return []
  const taken = new Set(d.admins.map(a => a.id))
  return d.candidates.filter(c => !taken.has(c.id))
}

async function addAdmin(region) {
  const d = detail.value[region.id]
  if (!d?.toAdd) return
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/regions/${region.id}/admins`, {
      method: 'POST',
      body: JSON.stringify({ user_id: d.toAdd }),
    })
    await load(region)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function removeAdmin(region, admin) {
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/regions/${region.id}/admins/${admin.id}`, { method: 'DELETE' })
    // Taking yourself off loses you the page, so re-read who you are.
    if (admin.id === auth.user?.id) await auth.fetchMe()
    else await load(region)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(() => {
  for (const r of regions.value) load(r)
})
</script>

<template>
  <div class="main">
    <header class="head">
      <div>
        <h1 class="title">{{ $t('my_region.title') }}</h1>
        <p class="intro">{{ $t('my_region.intro') }}</p>
      </div>
      <RouterLink to="/manager" class="btn btn-primary btn-sm">{{ $t('my_club.run_meets') }}</RouterLink>
    </header>

    <section class="block">
      <h2 class="block-title">{{ $t('my_club.requests') }}</h2>
      <RoleRequestQueue show-club />
    </section>

    <section v-for="r in regions" :key="r.id" class="block">
      <h2 class="block-title">
        {{ r.name }}
        <span v-if="detail[r.id]?.region?.label" class="kind">{{ labelFor(detail[r.id].region.label) }}</span>
      </h2>
      <template v-if="detail[r.id]">
        <h3 class="sub-title">{{ $t('my_region.clubs') }}</h3>
        <EmptyState
          v-if="!detail[r.id].clubs.length"
          icon="🏊"
          :title="$t('my_region.no_clubs_title')"
          :body="$t('my_region.no_clubs_body')"
        />
        <ul v-else class="rows">
          <li v-for="c in detail[r.id].clubs" :key="c.id" class="row card-sm">
            <div class="who">
              <span class="name">{{ c.name }}<template v-if="c.short_code"> · {{ c.short_code }}</template></span>
              <span class="meta">{{ $t('my_region.members', { n: c.member_count }) }}</span>
            </div>
            <span class="meta admins">
              <template v-if="c.admins.length">{{ c.admins.map(a => a.full_name).join(', ') }}</template>
              <template v-else>{{ $t('my_region.no_admin') }}</template>
            </span>
            <button v-if="placesClubs(r.id)" class="btn btn-ghost btn-sm" :disabled="busyId === r.id"
                    @click="moveClub(r, c.id, null)">{{ $t('my_region.release_club') }}</button>
          </li>
        </ul>
        <div v-if="placesClubs(r.id)" class="add-row" data-test-id="region-add-club">
          <select class="select" v-model="clubToAdd[r.id]" :disabled="!clubsToAdd(r.id).length"
                  :aria-label="$t('my_region.add_club')">
            <option value="">{{ $t('my_region.pick_club') }}</option>
            <option v-for="c in clubsToAdd(r.id)" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="btn btn-primary btn-sm" :disabled="!clubToAdd[r.id] || busyId === r.id"
                  @click="moveClub(r, clubToAdd[r.id], r.id)">{{ $t('my_club.add') }}</button>
        </div>

        <h3 class="sub-title">{{ $t('my_region.region_admins') }}</h3>
        <template v-if="detail[r.id].canManage">
          <ul class="rows" data-test-id="region-admins">
            <li v-for="a in detail[r.id].admins" :key="a.id" class="row card-sm">
              <div class="who">
                <span class="name">{{ a.full_name }}</span>
                <span class="meta">@{{ a.username }}</span>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="busyId === r.id"
                      @click="removeAdmin(r, a)">{{ $t('my_club.remove') }}</button>
            </li>
          </ul>
          <div class="add-row">
            <select class="select" v-model="detail[r.id].toAdd" :disabled="!addable(r.id).length"
                    :aria-label="$t('my_club.add_admin')">
              <option value="">{{ $t('my_region.pick_member') }}</option>
              <option v-for="m in addable(r.id)" :key="m.id" :value="m.id">
                {{ m.full_name }} (@{{ m.username }}) · {{ m.club_name }}
              </option>
            </select>
            <button class="btn btn-primary btn-sm" :disabled="!detail[r.id].toAdd || busyId === r.id"
                    @click="addAdmin(r)">{{ $t('my_club.add') }}</button>
          </div>
          <p v-if="!addable(r.id).length" class="meta">{{ $t('my_region.no_candidates') }}</p>
        </template>
        <p v-else class="meta">{{ detail[r.id].admins.map(a => a.full_name).join(', ') }}</p>
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
.block-title { font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; display: flex; align-items: baseline; gap: var(--space-2); }
.kind { font-size: var(--text-xs); font-weight: 500; color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.08em; }
.sub-title { font-size: var(--text-sm); font-weight: 600; color: var(--fg-2); margin: var(--space-2) 0 0; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); margin: 0; }
.admins { text-align: end; }
.add-row { display: flex; gap: var(--space-2); align-items: center; }
.add-row .select { flex: 1; min-width: 0; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: flex-start; }
  .admins { text-align: start; }
}
</style>
