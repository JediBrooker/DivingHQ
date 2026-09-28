// Club mode for the meet screens.
//
// Someone who runs meets only because they admin a club or a region (in
// a country with no federation on DivingHQ, or appointed by one) holds
// no org role that opens the screen. The API still returns the whole
// org's meets and events, and the server refuses them everything outside
// their own club's meets, so the Manager and Control Room narrow
// themselves to those rather than show buttons that would 403. Org
// editors and sysadmins see no difference.
//
// screenRoles is the list of org roles the screen's route admits on its
// own (see club-scope-core.js). Anyone holding one of those isn't in club
// mode, whatever clubs they also admin.
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { MANAGER_ROLES, isClubScoped, isMyClubMeetFor, narrowEventsTo, templateScopeFor } from './club-scope-core.js'

export { MANAGER_ROLES, CONTROL_ROOM_ROLES, templateScopeQuery } from './club-scope-core.js'

export function useClubScope(screenRoles = MANAGER_ROLES) {
  const auth = useAuthStore()

  const clubMode = computed(() => isClubScoped(auth.user, screenRoles))

  const myClubIds = computed(() => new Set(auth.clubAdminOf.map(c => c.id)))
  const myRegionIds = computed(() => new Set(auth.regionAdminOf.map(r => r.id)))

  function isMyClubMeet(meet) {
    return isMyClubMeetFor(meet, myClubIds.value, myRegionIds.value)
  }

  // Keep only events inside meets our clubs host. Pass the org's meets
  // if they're already loaded, otherwise they're fetched here.
  async function narrowEvents(events, orgMeets = null) {
    if (!clubMode.value) return events
    const meets = orgMeets && orgMeets.length
      ? orgMeets
      : await auth.apiFetch(`/api/orgs/${auth.user.org_id}/meets`).catch(() => [])
    return narrowEventsTo(events, meets, myClubIds.value, myRegionIds.value)
  }

  // Whose saved event templates the create form uses for an event going
  // into this meet: {} is the org's own, { club_id } / { region_id } a
  // club's or region's, null none at all (club mode with no meet of mine).
  function templateScopeForMeet(meet) {
    if (!clubMode.value) return {}
    return templateScopeFor(meet, myClubIds.value, myRegionIds.value)
  }

  return { clubMode, myClubIds, myRegionIds, isMyClubMeet, narrowEvents, templateScopeForMeet }
}
