// Club mode for the meet screens.
//
// Someone who runs meets only because they admin a club or a region (in
// a country with no federation on DivingHQ, or appointed by one) holds
// no org role. The API still returns the whole org's meets and events, and the
// server refuses them everything outside their own club's meets, so the
// Manager and Control Room narrow themselves to those rather than show
// buttons that would 403. Org editors and sysadmins see no difference.
//
// "Mine" mirrors isMeetHostAdmin on the server: hosted by a club I admin,
// by a region I admin, or by a club inside a region I admin.
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function useClubScope() {
  const auth = useAuthStore()

  const clubMode = computed(() =>
    !auth.user?.is_system_admin
    && !auth.hasAnyRole(['org_admin', 'meet_manager'])
    && (auth.isClubAdmin || auth.isRegionAdmin))

  const myClubIds = computed(() => new Set(auth.clubAdminOf.map(c => c.id)))
  const myRegionIds = computed(() => new Set(auth.regionAdminOf.map(r => r.id)))

  function isMyClubMeet(meet) {
    if (!meet) return false
    if (meet.host_club_id && myClubIds.value.has(meet.host_club_id)) return true
    if (meet.host_region_id && myRegionIds.value.has(meet.host_region_id)) return true
    return !!meet.host_club_region_id && myRegionIds.value.has(meet.host_club_region_id)
  }

  // Keep only events inside meets our clubs host. Pass the org's meets
  // if they're already loaded, otherwise they're fetched here.
  async function narrowEvents(events, orgMeets = null) {
    if (!clubMode.value) return events
    const meets = orgMeets && orgMeets.length
      ? orgMeets
      : await auth.apiFetch(`/api/orgs/${auth.user.org_id}/meets`).catch(() => [])
    const mine = new Set((meets || []).filter(isMyClubMeet).map(m => m.id))
    return events.filter(e => mine.has(e.meet_id))
  }

  return { clubMode, myClubIds, myRegionIds, isMyClubMeet, narrowEvents }
}
