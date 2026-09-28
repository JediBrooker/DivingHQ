// lib/admin-rows.js isOrgAdminOf: the "this org's admin, or the sysadmin"
// test that club approvals, regions, club setup, club changes, the member
// routes and the Clubs screen gates all share. No database.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isOrgAdminOf } = require("../lib/admin-rows");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("the sysadmin passes for any org", () => {
  assert.equal(isOrgAdminOf({ is_system_admin: true, org_roles: [], org_id: OTHER }, ORG), true);
});

test("an org admin passes for their own org and nobody else's", () => {
  const admin = { is_system_admin: false, org_roles: ["judge", "org_admin"], org_id: ORG };
  assert.equal(isOrgAdminOf(admin, ORG), true);
  assert.equal(isOrgAdminOf(admin, OTHER), false);
});

test("other roles, missing roles and no user at all don't pass", () => {
  assert.equal(isOrgAdminOf({ org_roles: ["meet_manager"], org_id: ORG }, ORG), false);
  assert.equal(isOrgAdminOf({ org_id: ORG }, ORG), false);
  assert.equal(isOrgAdminOf(null, ORG), false);
  assert.equal(isOrgAdminOf(undefined, ORG), false);
});
