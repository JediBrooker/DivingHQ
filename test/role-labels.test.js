// src/lib/roleLabels.js: the role line under a user's name (sidebar and
// dashboard header). DB-less, runs in test:safe. The rehearsal dry run
// found a club admin in a country with no federation labelled
// "Spectator", since they hold no org role.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let roleLabels
before(async () => {
  ;({ roleLabels } = await import('../src/lib/roleLabels.js'))
})

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'locales', 'en.json'), 'utf8'))
function t(key) {
  const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), en)
  if (typeof v !== 'string') throw new Error(`missing en key ${key}`)
  return v
}

test('a club admin with no org role reads as a club admin, not a spectator', () => {
  assert.deepEqual(
    roleLabels({ org_roles: ['spectator'], club_admin_of: [{ id: 'c1', name: 'Adamstown Divers' }] }, t),
    ['Club Admin'],
  )
})

test('region admin comes after club admin, both after the org roles', () => {
  assert.deepEqual(
    roleLabels({
      org_roles: ['referee', 'spectator'],
      club_admin_of: [{ id: 'c1' }],
      region_admin_of: [{ id: 'r1' }],
    }, t),
    ['Referee', 'Club Admin', 'Region Admin'],
  )
})

test("spectator isn't tacked on to a real role", () => {
  assert.deepEqual(roleLabels({ org_roles: ['referee', 'spectator'] }, t), ['Referee'])
  assert.deepEqual(roleLabels({ org_roles: ['spectator', 'judge', 'coach'] }, t), ['Judge', 'Coach'])
})

test('spectator still shows when it is all there is', () => {
  assert.deepEqual(roleLabels({ org_roles: ['spectator'], club_admin_of: [] }, t), ['Spectator'])
})

test('nothing at all, or a role without a name', () => {
  assert.deepEqual(roleLabels(null, t), [])
  assert.deepEqual(roleLabels({}, t), [])
  assert.deepEqual(roleLabels({ org_roles: ['timekeeper'] }, t), ['timekeeper'])
})

test('every key it asks for is in every locale', () => {
  const dir = path.join(__dirname, '..', 'src', 'locales')
  const keys = [
    'user_manager.role_org_admin', 'user_manager.role_meet_manager', 'user_manager.role_referee',
    'user_manager.role_judge', 'user_manager.role_coach', 'user_manager.role_diver',
    'user_manager.role_spectator', 'guide.role.club_admin.name', 'guide.role.region_admin.name',
  ]
  for (const f of fs.readdirSync(dir).filter((n) => /^[a-z]{2}\.json$/.test(n))) {
    const msgs = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), msgs)
      assert.equal(typeof v, 'string', `${f} is missing ${k}`)
    }
  }
})
