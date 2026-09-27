// The pure half of useClubScope: no Vue, no store, just the user object
// and the meet rows. Split out so test/use-club-scope.test.js can run it
// under plain node, which can't resolve the '@/' alias the store needs.

// Roles that open the meet screens org-wide. Which of them count depends
// on the screen: a referee runs any event in the Control Room
// (requireMeetController on the server) but gets nothing extra in the
// Manager, so each screen passes the roles its own route admits.
export const MANAGER_ROLES = ['org_admin', 'meet_manager']
export const CONTROL_ROOM_ROLES = ['org_admin', 'meet_manager', 'referee']

// True when admining a club or region is this person's only way onto the
// screen. Anyone with one of the screen's org roles already sees the
// whole org there, and narrowing them to their club's meets would hide
// events the server is happy to let them run (a referee who also admins
// a club lost every federation meet in the Control Room that way).
export function isClubScoped(user, screenRoles = MANAGER_ROLES) {
  if (!user || user.is_system_admin) return false
  const roles = user.org_roles || []
  if (screenRoles.some(r => roles.includes(r))) return false
  return (user.club_admin_of?.length || 0) > 0 || (user.region_admin_of?.length || 0) > 0
}

// "Mine" mirrors isMeetHostAdmin on the server: hosted by a club I admin,
// by a region I admin, or by a club inside a region I admin.
export function isMyClubMeetFor(meet, clubIds, regionIds) {
  if (!meet) return false
  if (meet.host_club_id && clubIds.has(meet.host_club_id)) return true
  if (meet.host_region_id && regionIds.has(meet.host_region_id)) return true
  return !!meet.host_club_region_id && regionIds.has(meet.host_club_region_id)
}

// Keep the events whose meet is one of mine. Standalone events (no
// meet_id) never are, a club admin only ever works inside a meet.
export function narrowEventsTo(events, meets, clubIds, regionIds) {
  const mine = new Set((meets || []).filter(m => isMyClubMeetFor(m, clubIds, regionIds)).map(m => m.id))
  return (events || []).filter(e => mine.has(e.meet_id))
}
