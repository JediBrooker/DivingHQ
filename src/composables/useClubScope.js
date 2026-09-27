// Club mode for the meet screens.
//
// Someone who runs meets only because they admin a club (in a country
// with no federation on DivingHQ, or appointed by one) holds no org
// role. The API still returns the whole org's meets and events, and the
// server refuses them everything outside their own club's meets, so the
// Manager and Control Room narrow themselves to those rather than show
// buttons that would 403. Org editors and sysadmins see no difference.
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function useClubScope() {
  const auth = useAuthStore()

  const clubMode = computed(() =>
    !auth.user?.is_system_admin
    && !auth.hasAnyRole(['org_admin', 'meet_manager'])
    && auth.isClubAdmin)

  const myClubIds = computed(() => new Set(auth.clubAdminOf.map(c => c.id)))

  function isMyClubMeet(meet) {
    return !!meet?.host_club_id && myClubIds.value.has(meet.host_club_id)
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

  return { clubMode, myClubIds, isMyClubMeet, narrowEvents }
}
