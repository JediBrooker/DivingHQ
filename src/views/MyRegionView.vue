<script setup>
// A region admin's page (migration 088): the clubs in their region, who
// runs each one, and the pending role requests from those clubs'
// members. Region admins sit one level above club admins, so they can
// act on any of these requests, not just ones whose club has no admin.
// Where there's no federation they also add and remove their own
// co-admins here (the server says so with can_manage), and once their
// body has claimed the region they accept or turn down clubs asking to
// join it and can let a club go.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { usePlural } from '@/composables/usePlural'
import { showError, showInfo } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import EmptyState from '@/components/EmptyState.vue'
import RoleRequestQueue from '@/components/RoleRequestQueue.vue'
import JoinRequestQueue from '@/components/JoinRequestQueue.vue'
import LoadError from '@/components/LoadError.vue'

const { t } = useI18n()
const { tn } = usePlural()
const auth = useAuthStore()
const router = useRouter()

const regions = computed(() => auth.regionAdminOf)
// Bumped to remount the request queues. They load once on mount and
// have no reload of their own, so after you step down from one region
// (but still run another) they'd keep offering its requests.
const queueKey = ref(0)
// Per region id: { region, clubs, admins, candidates, canManage, keepOneLive, toAdd }
const detail = ref({})
const busyId = ref(null)
// Region ids whose load failed, each gets a retry instead of a blank section.
const failed = ref({})

function labelFor(key) {
  return key ? t(`regions.label.${key}`) : ''
}

async function load(region) {
  failed.value[region.id] = false
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
      keepOneLive: !!admins.keep_one_live,
      toAdd: '',
    }
  } catch (err) {
    // 403 on a region we were listed for: somebody took us off it since
    // sign-in. Catch the session up rather than show a retry.
    if (err?.status === 403) return refreshAfterLosingRegion(region)
    failed.value[region.id] = true
  }
}

// Same as My club: regionAdminOf drives the nav entry and the /region
// guard, so it has to catch up straight away. With no region left the
// page has nothing to show, so go to the dashboard and say why.
async function refreshAfterLosingRegion(region) {
  await auth.fetchMe()
  if (!auth.isRegionAdmin && !auth.user?.is_system_admin) {
    showInfo(t('my_region.left_notice', { region: region.name }))
    router.push('/dashboard')
    return
  }
  delete detail.value[region.id]
  queueKey.value++
}

// A state body that has claimed its region decides which clubs it takes
// and lets go: clubs ask to join (PUT /api/clubs/:id/region answers 202),
// the region accepts or declines here, and can take a club back out.
// It can't pull in a club that never asked.
function placesClubs(regionId) {
  const d = detail.value[regionId]
  return !!d && d.canManage && d.region?.claim_state === 'claimed'
}

async function moveClub(region, clubId, regionId) {
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/clubs/${clubId}/region`, {
      method: 'PUT',
      body: JSON.stringify({ region_id: regionId }),
    })
    await load(region)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function declineClub(region, clubId) {
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/clubs/${clubId}/region-request`, { method: 'DELETE' })
    await load(region)
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

// Same rule as My club: the last live region admin can't step down
// until there's someone else, so say so on the button up front.
function soleLiveAdmin(regionId, admin) {
  const d = detail.value[regionId]
  if (!d?.keepOneLive || !admin.live) return false
  return !d.admins.some(a => a.live && a.id !== admin.id)
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
  const self = admin.id === auth.user?.id
  // Only another admin can put you back, so ask first (My club does too).
  if (self && !await confirmAction({
    title: t('my_region.leave_title', { region: region.name }),
    body: t('my_region.leave_body'),
    confirmLabel: t('my_club.leave_confirm'),
    cancelLabel: t('common.cancel'),
    confirmKind: 'danger',
  })) return
  busyId.value = region.id
  try {
    await auth.apiFetch(`/api/regions/${region.id}/admins/${admin.id}`, { method: 'DELETE' })
    if (self) await refreshAfterLosingRegion(region)
    else await load(region)
  } catch (err) {
    // Stale page, same as My club: someone else left first. Translated
    // reason, then reload so Remove shows up greyed out.
    if (err.status === 409) {
      showError(t('my_region.last_admin_tip'))
      await load(region)
    } else {
      showError(err.message)
    }
  } finally {
    busyId.value = null
  }
}

// can_manage from the admins endpoint means "no federation here".
const selfRun = computed(() => regions.value.some(r => detail.value[r.id]?.canManage))

function reloadAll() {
  for (const r of regions.value) load(r)
}

onMounted(reloadAll)
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
      <RoleRequestQueue :key="`rq-${queueKey}`" show-club />
    </section>

    <!-- Only where there's no federation: that's when a region admin can
         approve someone into one of its clubs. -->
    <section v-if="selfRun" class="block">
      <h2 class="block-title">{{ $t('my_club.join_requests') }}</h2>
      <JoinRequestQueue :key="`jq-${queueKey}`" show-club @decided="reloadAll" />
    </section>

    <section v-for="r in regions" :key="r.id" class="block">
      <div class="block-head">
        <h2 class="block-title">
          {{ r.name }}
          <span v-if="detail[r.id]?.region?.label" class="kind">{{ labelFor(detail[r.id].region.label) }}</span>
        </h2>
        <RouterLink :to="{ path: `/records/region/${r.id}`, query: detail[r.id]?.region?.org_id ? { org: detail[r.id].region.org_id } : {} }"
                    class="records-link" :data-testid="`region-records-${r.id}`">{{ $t('records.view') }}</RouterLink>
      </div>
      <LoadError v-if="failed[r.id] && !detail[r.id]" @retry="load(r)" />
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
              <span class="meta">{{ tn('counts.members', c.member_count) }}</span>
            </div>
            <span class="meta admins">
              <template v-if="c.admins.length">{{ c.admins.map(a => a.full_name).join(', ') }}</template>
              <template v-else>{{ $t('my_region.no_admin') }}</template>
            </span>
            <button v-if="placesClubs(r.id)" class="btn btn-ghost btn-sm" :disabled="busyId === r.id"
                    @click="moveClub(r, c.id, null)">{{ $t('my_region.release_club') }}</button>
          </li>
        </ul>
        <template v-if="placesClubs(r.id) && detail[r.id].join_requests?.length">
          <h3 class="sub-title">{{ $t('my_region.club_requests') }}</h3>
          <ul class="rows" data-test-id="region-club-requests">
            <li v-for="c in detail[r.id].join_requests" :key="c.id" class="row card-sm">
              <div class="who">
                <span class="name">{{ c.name }}<template v-if="c.short_code"> · {{ c.short_code }}</template></span>
                <span class="meta">
                  {{ $t('my_region.members', { n: c.member_count }) }}
                  <template v-if="c.current_region_name"> · {{ $t('my_region.currently_in', { region: c.current_region_name }) }}</template>
                </span>
              </div>
              <div class="actions">
                <button class="btn btn-ghost btn-sm" :disabled="busyId === r.id"
                        @click="declineClub(r, c.id)">{{ $t('my_club.reject') }}</button>
                <button class="btn btn-primary btn-sm" :disabled="busyId === r.id"
                        @click="moveClub(r, c.id, r.id)">{{ $t('my_club.approve') }}</button>
              </div>
            </li>
          </ul>
        </template>

        <h3 class="sub-title">{{ $t('my_region.region_admins') }}</h3>
        <template v-if="detail[r.id].canManage">
          <ul class="rows" data-test-id="region-admins">
            <li v-for="a in detail[r.id].admins" :key="a.id" class="row card-sm">
              <div class="who">
                <span class="name">{{ a.full_name }}</span>
                <span class="meta">@{{ a.username }}</span>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="busyId === r.id || soleLiveAdmin(r.id, a)"
                      v-tip="soleLiveAdmin(r.id, a) ? $t('my_region.last_admin_tip') : ''"
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
.block-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
.records-link { font-size: var(--text-sm); font-weight: 600; white-space: nowrap; }
.kind { font-size: var(--text-xs); font-weight: 500; color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.08em; }
.sub-title { font-size: var(--text-sm); font-weight: 600; color: var(--fg-2); margin: var(--space-2) 0 0; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); margin: 0; }
.admins { text-align: end; }
.add-row { display: flex; gap: var(--space-2); align-items: center; }
.row .btn:disabled { opacity: .55; cursor: not-allowed; }
/* Remove sits at the end of its row, so the usual centred bubble would
   hang off the side of the page on a narrow window. Line it up with the
   button's end edge instead. */
.row .btn[data-tip]::after { inset-inline-start: auto; inset-inline-end: 0; transform: none; }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.add-row .select { flex: 1; min-width: 0; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: flex-start; }
  .admins { text-align: start; }
}
</style>
