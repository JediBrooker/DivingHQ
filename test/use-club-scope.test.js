// Club mode for the Manager and Control Room (useClubScope). DB-less;
// runs in test:safe. The case that bit us: a referee who also admins a
// club was narrowed to their club's meets in the Control Room, which hid
// every federation meet the server would happily let them run.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let isClubScoped, isMyClubMeetFor, narrowEventsTo, templateScopeFor, templateScopeQuery, MANAGER_ROLES, CONTROL_ROOM_ROLES

before(async () => {
  ;({ isClubScoped, isMyClubMeetFor, narrowEventsTo, templateScopeFor, templateScopeQuery, MANAGER_ROLES, CONTROL_ROOM_ROLES } = await import(
    '../src/composables/club-scope-core.js'
  ))
})

const club = { id: 'club-1', name: 'Apia Divers' }
const region = { id: 'region-1', name: 'Ontario', short_code: 'ON' }
const user = (over = {}) => ({ id: 'u1', org_roles: [], club_admin_of: [], region_admin_of: [], ...over })

test('a club admin with no org role is scoped on both screens', () => {
  const u = user({ club_admin_of: [club] })
  assert.equal(isClubScoped(u, MANAGER_ROLES), true)
  assert.equal(isClubScoped(u, CONTROL_ROOM_ROLES), true)
})

test('a region admin with no org role is scoped too', () => {
  assert.equal(isClubScoped(user({ region_admin_of: [region] })), true)
})

test('a referee who admins a club sees the whole org in the Control Room', () => {
  const u = user({ org_roles: ['referee'], club_admin_of: [club] })
  assert.equal(isClubScoped(u, CONTROL_ROOM_ROLES), false)
  // The Manager doesn't admit referees, so their club is still their only way in there.
  assert.equal(isClubScoped(u, MANAGER_ROLES), true)
})

test('org_admin and meet_manager are never scoped', () => {
  for (const role of ['org_admin', 'meet_manager']) {
    const u = user({ org_roles: [role], club_admin_of: [club], region_admin_of: [region] })
    assert.equal(isClubScoped(u, MANAGER_ROLES), false, role)
    assert.equal(isClubScoped(u, CONTROL_ROOM_ROLES), false, role)
  }
})

test('a sysadmin is never scoped, whatever else they hold', () => {
  assert.equal(isClubScoped(user({ is_system_admin: true, club_admin_of: [club] }), CONTROL_ROOM_ROLES), false)
})

test('judges and divers who admin a club are scoped (neither role opens these screens)', () => {
  assert.equal(isClubScoped(user({ org_roles: ['judge', 'diver'], club_admin_of: [club] }), CONTROL_ROOM_ROLES), true)
})

test('nobody without a club or region is scoped', () => {
  assert.equal(isClubScoped(user()), false)
  assert.equal(isClubScoped(null), false)
  assert.equal(isClubScoped({ id: 'u2' }), false)
})

test('isMyClubMeetFor: hosted by my club, my region, or a club in my region', () => {
  const clubs = new Set(['club-1'])
  const regions = new Set(['region-1'])
  assert.equal(isMyClubMeetFor({ host_club_id: 'club-1' }, clubs, regions), true)
  assert.equal(isMyClubMeetFor({ host_region_id: 'region-1' }, clubs, regions), true)
  assert.equal(isMyClubMeetFor({ host_club_id: 'club-9', host_club_region_id: 'region-1' }, clubs, regions), true)
  assert.equal(isMyClubMeetFor({ host_club_id: 'club-9' }, clubs, regions), false)
  // A federation-hosted meet has no host club or region at all.
  assert.equal(isMyClubMeetFor({ host_club_id: null, host_region_id: null }, clubs, regions), false)
  assert.equal(isMyClubMeetFor(null, clubs, regions), false)
})

test('narrowEventsTo keeps events in my meets and drops the rest', () => {
  const meets = [
    { id: 'm-mine', host_club_id: 'club-1' },
    { id: 'm-fed', host_club_id: null },
  ]
  const events = [
    { id: 'e1', meet_id: 'm-mine' },
    { id: 'e2', meet_id: 'm-fed' },
    { id: 'e3', meet_id: null },
  ]
  const kept = narrowEventsTo(events, meets, new Set(['club-1']), new Set())
  assert.deepEqual(kept.map(e => e.id), ['e1'])
  assert.deepEqual(narrowEventsTo(events, null, new Set(['club-1']), new Set()), [])
})

// Saved event templates belong to the club or region that made them
// (migration 104), so club mode picks the host of the meet the event goes
// into, and never a club the caller doesn't admin.
test('templateScopeFor follows the meet host: my club, my region, or the region above the host club', () => {
  const clubs = new Set(['club-1'])
  const regions = new Set(['region-1'])
  assert.deepEqual(templateScopeFor({ host_club_id: 'club-1', host_club_region_id: 'region-1' }, clubs, regions), { club_id: 'club-1' })
  assert.deepEqual(templateScopeFor({ host_region_id: 'region-1' }, clubs, regions), { region_id: 'region-1' })
  // A region admin working a club meet in their region uses the region's templates.
  assert.deepEqual(templateScopeFor({ host_club_id: 'club-9', host_club_region_id: 'region-1' }, clubs, regions), { region_id: 'region-1' })
  assert.equal(templateScopeFor({ host_club_id: 'club-9' }, clubs, regions), null)
  assert.equal(templateScopeFor({ host_club_id: null, host_region_id: null }, clubs, regions), null)
  assert.equal(templateScopeFor(null, clubs, regions), null)
})

test('templateScopeQuery: the org is no params, a club or region is one, no scope is null', () => {
  assert.equal(templateScopeQuery({}), '')
  assert.equal(templateScopeQuery({ club_id: 'c 1' }), '?club_id=c%201')
  assert.equal(templateScopeQuery({ region_id: 'r1' }), '?region_id=r1')
  assert.equal(templateScopeQuery(null), null)
})
