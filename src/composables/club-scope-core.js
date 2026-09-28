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

// Whose saved event templates a club-mode Manager works with, for an event
// going into `meet`. Templates belong to the club or region that saved them
// and nobody else (migration 104), so this follows the meet's host: my club
// if I admin it, else the region hosting it, else the region the host club
// is in. That last one is a region admin stepping in on one of its clubs'
// meets, who gets the region's templates, not the club's. null when the
// meet isn't one of mine (or there's no meet), and then there's no strip.
export function templateScopeFor(meet, clubIds, regionIds) {
  if (!meet) return null
  if (meet.host_club_id && clubIds.has(meet.host_club_id)) return { club_id: meet.host_club_id }
  if (meet.host_region_id && regionIds.has(meet.host_region_id)) return { region_id: meet.host_region_id }
  if (meet.host_club_region_id && regionIds.has(meet.host_club_region_id)) {
    return { region_id: meet.host_club_region_id }
  }
  return null
}

// The query string /api/event-templates wants for a scope. {} is the org's
// own templates (''), null is no scope at all (null back).
export function templateScopeQuery(scope) {
  if (!scope) return null
  if (scope.club_id) return `?club_id=${encodeURIComponent(scope.club_id)}`
  if (scope.region_id) return `?region_id=${encodeURIComponent(scope.region_id)}`
  return ''
}
