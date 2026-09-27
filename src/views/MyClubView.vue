<script setup>
// A club admin's own page. In a country with no federation on DivingHQ
// the club admin is the only person who can approve their members'
// role requests (lib/role-requests.js) and appoint co-admins, so this
// is where that happens. Under a federation the requests list is empty
// (the federation reviews) and the admins list is read-only.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError, showInfo, showSuccess } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import { usePlural } from '@/composables/usePlural'
import RoleRequestQueue from '@/components/RoleRequestQueue.vue'
import JoinRequestQueue from '@/components/JoinRequestQueue.vue'
import LoadError from '@/components/LoadError.vue'
import ClubSetupCard from '@/components/ClubSetupCard.vue'

const { t } = useI18n()
const { tn } = usePlural()
const auth = useAuthStore()
const router = useRouter()

const busyId = ref(null)

// The org's regions (states etc.), so a club admin can say which one
// their club is in. Empty for countries without them.
const regions = ref({ label: null, regions: [] })
const regionLabel = computed(() => regions.value.label ? t(`regions.label.${regions.value.label}`) : '')

// Per club: { admins, members, canManage, keepOneLive, denied, failed, toAdd }.
// denied = the server said 403; failed = anything else went wrong, which
// says nothing about who may manage the club, so it gets a retry.
const clubState = ref({})
const clubs = computed(() => auth.clubAdminOf)

async function loadRegions() {
  if (!auth.user?.org_id) return
  try {
    regions.value = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/regions`)
  } catch { /* no regions, nothing to show */ }
}

// A region its state body has claimed decides which clubs it takes and
// lets go (PUT /api/clubs/:id/region). Picking one asks its admins, it
// doesn't move the club, and a club already in one can't pick its way
// out. Unless the person here happens to admin that region too, or the
// body's admins have all gone, in which case the server lets the club go.
const myRegionIds = computed(() => new Set((auth.regionAdminOf || []).map(r => r.id)))
function regionLocked(r) {
  return r?.claim_state === 'claimed' && r.has_live_admin !== false && !myRegionIds.value.has(r.id)
}
function currentRegion(club) {
  return regions.value.regions.find(r => r.id === club.region_id) || null
}
function regionById(id) {
  return regions.value.regions.find(r => r.id === id) || null
}
function regionOptionLabel(r) {
  return r.claim_state === 'claimed' && r.claimed_name ? `${r.name} · ${r.claimed_name}` : r.name
}
// In a sentence the body's own name reads better than "Region · Body".
function regionDisplayName(id) {
  const r = regionById(id)
  return r ? (r.claimed_name || r.name) : ''
}
const anyClaimedRegion = computed(() => regions.value.regions.some(r => r.claim_state === 'claimed'))

async function setRegion(club, regionId, selectEl) {
  busyId.value = club.id
  try {
    const out = await auth.apiFetch(`/api/clubs/${club.id}/region`, {
      method: 'PUT',
      body: JSON.stringify({ region_id: regionId || null }),
    })
    if (out?.requested) {
      // Nothing moved yet, so the picker goes back to where the club is.
      if (selectEl) selectEl.value = club.region_id || ''
      showSuccess(t('my_club.region_request_sent', { region: regionDisplayName(regionId) }))
      await loadClub(club)
      return
    }
    // Keeps auth.clubAdminOf (and so the meet screens) in step.
    await auth.fetchMe()
    await loadClub(club)
  } catch (err) {
    if (selectEl) selectEl.value = club.region_id || ''
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function withdrawRegionRequest(club) {
  busyId.value = club.id
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/region-request`, { method: 'DELETE' })
    await loadClub(club)
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
      regionRequest: body.region_request || null, keepOneLive: !!body.keep_one_live,
    }
  } catch (err) {
    const denied = err.status === 403
    clubState.value[club.id] = {
      admins: [], members: [], canManage: false, denied, failed: !denied, toAdd: '', regionRequest: null,
    }
    // Refused where the clubs run things means we aren't this club's admin
    // any more (someone removed us). Our club list is stale, so refresh it.
    if (denied && club.org_claim_state === 'unclaimed') await refreshAfterLosingClub(club)
  }
}

// Under a federation it appoints the admins; otherwise a 403 only happens
// once you've stopped being one, and refreshAfterLosingClub moves you on.
function deniedMessage(club) {
  return club.org_claim_state === 'unclaimed' ? t('my_club.not_admin') : t('my_club.federation_appoints')
}

// auth.clubAdminOf drives the My club nav entry, the /club route guard
// and the meet screens' club mode, so it has to catch up the moment we
// stop admining a club rather than on the next reload.
async function refreshAfterLosingClub(club) {
  await auth.fetchMe()
  if (!auth.isClubAdmin) {
    showInfo(t('my_club.left_notice', { club: club.name }))
    router.push('/dashboard')
  }
}

// Join requests are only this page's business where the club runs
// itself; under a federation the federation approves them. The admins
// endpoint answering is how we know (403 under a federation).
const selfRun = computed(() => clubs.value.some(c => clubState.value[c.id]?.canManage))

function onJoinDecided({ request, decision }) {
  if (decision !== 'approved') return
  const club = clubs.value.find(c => c.id === request.to_club_id)
  if (club) loadClub(club)
}

// The server won't let a club admin take the club down to no live admin
// (lib/admin-rows.js), so the last one's Remove is greyed out with the
// reason on it rather than failing after the confirm dialog.
function soleLiveAdmin(clubId, admin) {
  const st = clubState.value[clubId]
  if (!st?.keepOneLive || !admin.live) return false
  return !st.admins.some(a => a.live && a.id !== admin.id)
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
  const self = admin.id === auth.user?.id
  // Removing yourself locks you out of the club's meets and this page,
  // and only another admin can undo it, so check first.
  if (self && !await confirmAction({
    title: t('my_club.leave_title', { club: club.name }),
    body: t('my_club.leave_body'),
    confirmLabel: t('my_club.leave_confirm'),
    cancelLabel: t('common.cancel'),
    confirmKind: 'danger',
  })) return
  busyId.value = club.id
  try {
    await auth.apiFetch(`/api/clubs/${club.id}/admins/${admin.id}`, { method: 'DELETE' })
    if (self) await refreshAfterLosingClub(club)
    else await loadClub(club)
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

    <section v-if="selfRun" class="block">
      <h2 class="block-title">{{ $t('my_club.join_requests') }}</h2>
      <JoinRequestQueue :show-club="clubs.length > 1" @decided="onJoinDecided" />
    </section>

    <section v-for="club in clubs" :key="club.id" class="block">
      <div class="block-head">
        <h2 class="block-title">{{ $t('my_club.admins') }} · {{ club.name }}</h2>
        <RouterLink :to="{ path: `/records/club/${club.id}`, query: auth.user?.org_id ? { org: auth.user.org_id } : {} }"
                    class="records-link" :data-testid="`club-records-${club.id}`">{{ $t('records.view') }}</RouterLink>
      </div>
      <p v-if="clubState[club.id]?.canManage" class="muted">{{ tn('counts.members', clubState[club.id].members.length) }}</p>
      <LoadError v-if="clubState[club.id]?.failed" @retry="loadClub(club)" />
      <template v-else-if="clubState[club.id]">
        <!-- Which region the club is in. Same rule as the admins list:
             the club decides where there's no federation. -->
        <div v-if="regions.regions.length && clubState[club.id].canManage" class="region-row">
          <label class="label" :for="`region-${club.id}`">{{ regionLabel }}</label>
          <select :id="`region-${club.id}`" class="select" :value="club.region_id || ''"
                  :disabled="busyId === club.id || regionLocked(currentRegion(club))"
                  @change="setRegion(club, $event.target.value, $event.target)">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="r in regions.regions" :key="r.id" :value="r.id">{{ regionOptionLabel(r) }}</option>
          </select>
          <p v-if="anyClaimedRegion" class="muted hint" data-test-id="region-claimed-note">
            {{ $t('my_club.region_claimed_note') }}
          </p>
          <div v-if="clubState[club.id].regionRequest" class="pending-row" data-test-id="region-request-pending">
            <span class="muted">
              {{ $t('my_club.region_request_pending', { region: regionDisplayName(clubState[club.id].regionRequest.region_id) }) }}
            </span>
            <button class="btn btn-ghost btn-sm" :disabled="busyId === club.id"
                    @click="withdrawRegionRequest(club)">{{ $t('my_club.region_request_cancel') }}</button>
          </div>
        </div>
        <p v-if="!clubState[club.id].canManage" class="muted">{{ deniedMessage(club) }}</p>
        <template v-else>
          <ul class="rows">
            <li v-for="a in clubState[club.id].admins" :key="a.id" class="row card-sm">
              <div class="who">
                <span class="name">{{ a.full_name }}</span>
                <span class="meta">@{{ a.username }}</span>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="busyId === club.id || soleLiveAdmin(club.id, a)"
                      v-tip="soleLiveAdmin(club.id, a) ? $t('my_club.last_admin_tip') : ''"
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
.block-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
.records-link { font-size: var(--text-sm); font-weight: 600; white-space: nowrap; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.note { font-size: var(--text-xs); color: var(--fg-2); font-style: italic; overflow-wrap: anywhere; }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.add-row { display: flex; gap: var(--space-2); align-items: center; }
.row .btn:disabled { opacity: .55; cursor: not-allowed; }
/* Remove sits at the end of its row, so the usual centred bubble would
   hang off the side of the page on a narrow window. Line it up with the
   button's end edge instead. */
.row .btn[data-tip]::after { inset-inline-start: auto; inset-inline-end: 0; transform: none; }
.region-row { display: flex; flex-direction: column; gap: var(--space-1); max-width: 320px; }
.add-row .select { flex: 1; min-width: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; }
.hint { font-size: var(--text-xs); }
.pending-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
