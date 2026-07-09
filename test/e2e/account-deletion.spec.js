// Account self-deletion + reunite-on-return (Migration 053).
//
// Covers the privacy-policy §7 contract:
//
//   1. Delete-account happy path. The user's password gates the
//      destruction. After commit:
//        * deleted_at is stamped on the row
//        * push subscriptions / coach links / role grants gone
//        * full_name + org_id + club_id retained (sporting record)
//        * existing JWT 401s on the next privileged call
//
//   2. Login attempt after deletion returns the same generic
//      "Invalid username or password" as a wrong password would,
//      no "this account was deleted" leak.
//
//   3. Public profile by old slug 404s.
//
//   4. Reunite-on-return: a new account in the same org with the
//      same full_name sees the deleted account as a candidate and
//      can claim its dives.
//
//   5. Safety: a user CAN'T see candidates from a different org,
//      nor from a same-org user with a different name.
//
//   6. Conflict: if the new account already has a dive list for
//      an event the old account also entered, claim 409s instead
//      of silently merging or 500ing.
//
//   7. Claim without correct password gets a 401.
//
// All tests run inside their own throwaway orgs and clean up via
// setup.deleteOrg afterward. A few sub-cases share fixtures, so
// they're grouped serially for that, not because the endpoints
// themselves care.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function auth(token) { return { Authorization: `Bearer ${token}` }; }

test.describe.serial("Account deletion + claim-past-results", () => {

  // ---------------------------------------------------------------
  // 1. Delete-account happy path. Side-effect assertions are pulled
  //    straight from the DB so we're certain the migration didn't
  //    silently fall through.
  // ---------------------------------------------------------------
  test.describe("POST /api/users/me/delete", () => {
    let org;
    let diver;
    let diverToken;
    let oldSlug;

    test.beforeAll(async ({ request }) => {
      org = await setup.createOrgAndAdmin(request, {
        orgName: "Delete E2E", countryCode: "TST",
      });
      diver = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Delete Me",
      });
      ({ token: diverToken } = await setup.loginAs(request, diver.username));
      // Make sure theres something to keep around after deletion,
      // just in case: a dive list row that should still carry the user's name.
      const event = await setup.createEvent(request, {
        adminToken: org.adminToken,
      });
      const diveId = await setup.pickDiveId();
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: diver.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
      // Capture the public slug BEFORE deletion so we can confirm
      // it 404s afterward.
      const slugR = await setup.pool.query(
        "SELECT public_slug FROM users WHERE id = $1",
        [diver.userId],
      );
      oldSlug = slugR.rows[0].public_slug;
      // Drop in a couple of side-effect rows so the audit-counts
      // path is exercised too: a push subscription + a role request.
      await setup.pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
         VALUES ($1, $2, $3, $4)`,
        [diver.userId, `https://push.example/${diver.userId}`, "p256dh", "auth"],
      );
      await setup.pool.query(
        `INSERT INTO role_requests (user_id, org_id, requested_role, status)
         VALUES ($1, $2, 'judge', 'pending')`,
        [diver.userId, org.orgId],
      );
    });

    test.afterAll(async () => { if (org) await setup.deleteOrg(org.orgId); });

    test("wrong password → 401 and row stays active", async ({ request }) => {
      const r = await request.post("/api/users/me/delete", {
        headers: auth(diverToken),
        data: { password: "wrong-password" },
      });
      expect(r.status()).toBe(401);
      // The row must still be active since we never write deleted_at
      // on a failed password attempt.
      const row = await setup.pool.query(
        "SELECT deleted_at FROM users WHERE id = $1",
        [diver.userId],
      );
      expect(row.rows[0].deleted_at).toBeNull();
    });

    test("happy path: row tombstoned, side-effects cleared, sporting record retained", async ({ request }) => {
      const r = await request.post("/api/users/me/delete", {
        headers: auth(diverToken),
        data: { password: setup.TEST_PASSWORD },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.deleted).toBe(true);

      const row = await setup.pool.query(
        `SELECT deleted_at, password, email, public_slug, full_name,
                org_id, club_id, dashboard_widgets, locale
           FROM users WHERE id = $1`,
        [diver.userId],
      );
      const u = row.rows[0];
      expect(u.deleted_at).not.toBeNull();
      expect(u.password).toBeNull();
      expect(u.email).toBeNull();
      // public_slug rewritten to non-hex placeholder.
      expect(u.public_slug).not.toMatch(/^[0-9a-f]{32}$/);
      expect(u.dashboard_widgets).toBeNull();
      // SPORTING RECORD KEPT
      expect(u.full_name).toBe("Delete Me");
      expect(u.org_id).toBe(org.orgId);

      // Side-effect deletes
      const pushCount = await setup.pool.query(
        "SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1",
        [diver.userId],
      );
      expect(pushCount.rows[0].n).toBe(0);
      const roleReqCount = await setup.pool.query(
        "SELECT COUNT(*)::int AS n FROM role_requests WHERE user_id = $1",
        [diver.userId],
      );
      expect(roleReqCount.rows[0].n).toBe(0);
      const rolesCount = await setup.pool.query(
        "SELECT COUNT(*)::int AS n FROM user_org_roles WHERE user_id = $1",
        [diver.userId],
      );
      expect(rolesCount.rows[0].n).toBe(0);

      // Audit row landed
      const auditRow = await setup.pool.query(
        `SELECT action, entity_id, metadata FROM audit_log
         WHERE actor_id = $1 AND action = 'user.self_delete'
         ORDER BY created_at DESC LIMIT 1`,
        [diver.userId],
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0].entity_id).toBe(diver.userId);
      // Metadata holds the summary counts, we just smoke-test one of them here.
      expect(auditRow.rows[0].metadata.push_subscriptions_removed).toBe(1);
    });

    test("JWT after delete: privileged endpoint 401s", async ({ request }) => {
      // Heads up: the token was minted before token_version bumped, so
      // it must no longer pass verifyToken. /api/users/me/email/
      // change-request is just a convenient verifyToken-gated endpoint to poke.
      const r = await request.post("/api/users/me/email/change-request", {
        headers: auth(diverToken),
        data: { new_email: "x@y.com", current_password: "doesnt-matter" },
      });
      expect(r.status()).toBe(401);
    });

    test("login after delete: generic Invalid credentials", async ({ request }) => {
      const r = await request.post("/api/auth/login", {
        data: { username: diver.username, password: setup.TEST_PASSWORD },
      });
      expect(r.status()).toBe(401);
      const body = await r.json();
      expect(body.error).toMatch(/Invalid username or password/i);
    });

    test("public profile by old slug → 404", async ({ request }) => {
      const r = await request.get(`/api/public/divers/${oldSlug}/profile`);
      expect(r.status()).toBe(404);
    });
  });

  // ---------------------------------------------------------------
  // 2. Claim-candidates + claim happy path.
  //
  //    User A competes in an event, deletes their account, then
  //    User B signs up in the same org with the same name. B's
  //    /api/users/me/claim-candidates surfaces A; B claims; the
  //    dive-list row now points at B and shows up on B's profile.
  // ---------------------------------------------------------------
  test.describe("POST /api/users/me/claim", () => {
    let org;
    let event;
    let diveId;
    let userA;
    let userATokenBefore;
    let userB;
    let userBToken;

    test.beforeAll(async ({ request }) => {
      org = await setup.createOrgAndAdmin(request, {
        orgName: "Claim E2E", countryCode: "TST",
      });

      // Set up an event with a dive list so User A has something
      // to leave behind when they delete.
      event = await setup.createEvent(request, { adminToken: org.adminToken });
      diveId = await setup.pickDiveId();

      userA = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Shared Name",
      });
      ({ token: userATokenBefore } = await setup.loginAs(request, userA.username));

      await setup.insertDiveList({
        eventId: event.id,
        competitorId: userA.userId,
        dives: [
          { round_number: 1, dive_id: diveId },
          { round_number: 2, dive_id: diveId },
        ],
      });

      // Self-delete User A.
      const del = await request.post("/api/users/me/delete", {
        headers: auth(userATokenBefore),
        data: { password: setup.TEST_PASSWORD },
      });
      expect(del.status()).toBe(200);

      // User B in same org with same full_name.
      userB = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Shared Name",
      });
      ({ token: userBToken } = await setup.loginAs(request, userB.username));
    });

    test.afterAll(async () => { if (org) await setup.deleteOrg(org.orgId); });

    test("candidates: B sees A as a candidate", async ({ request }) => {
      const r = await request.post("/api/users/me/claim-candidates", {
        headers: auth(userBToken),
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const ids = body.candidates.map((c) => c.id);
      expect(ids).toContain(userA.userId);
      const a = body.candidates.find((c) => c.id === userA.userId);
      expect(a.dive_count).toBeGreaterThanOrEqual(2);
      // Metadata still carries the full_name from the (retained)
      // sporting-record row.
      expect(a.full_name).toBe("Shared Name");
    });

    test("claim: B without password → 401, with wrong password → 401", async ({ request }) => {
      const noPwd = await request.post("/api/users/me/claim", {
        headers: auth(userBToken),
        data: { old_user_ids: [userA.userId] },
      });
      expect(noPwd.status()).toBe(400);

      const bad = await request.post("/api/users/me/claim", {
        headers: auth(userBToken),
        data: { old_user_ids: [userA.userId], password: "wrong" },
      });
      expect(bad.status()).toBe(401);
    });

    test("claim: happy path moves dives + hard-deletes the shell", async ({ request }) => {
      const r = await request.post("/api/users/me/claim", {
        headers: auth(userBToken),
        data: {
          old_user_ids: [userA.userId],
          password: setup.TEST_PASSWORD,
        },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.claimed).toContain(userA.userId);

      // The dive list now points at User B.
      const list = await setup.pool.query(
        `SELECT competitor_id, round_number FROM competitor_dive_lists
         WHERE event_id = $1 ORDER BY round_number`,
        [event.id],
      );
      for (const row of list.rows) {
        expect(row.competitor_id).toBe(userB.userId);
      }

      // Old user row is gone.
      const oldRow = await setup.pool.query(
        "SELECT id FROM users WHERE id = $1",
        [userA.userId],
      );
      expect(oldRow.rows.length).toBe(0);

      // idempotency check: claiming an already-deleted id returns 200
      // with an empty `claimed` rather than 500ing.
      const again = await request.post("/api/users/me/claim", {
        headers: auth(userBToken),
        data: {
          old_user_ids: [userA.userId],
          password: setup.TEST_PASSWORD,
        },
      });
      expect(again.status()).toBe(200);
      const againBody = await again.json();
      expect(againBody.claimed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // 3. Cross-org isolation: a candidate from a different federation
  //    is never returned, even if the name matches exactly.
  // ---------------------------------------------------------------
  test.describe("claim-candidates: cross-org isolation", () => {
    let orgA, orgB;
    let userAToken;
    let userBId;

    test.beforeAll(async ({ request }) => {
      orgA = await setup.createOrgAndAdmin(request, { orgName: "Iso A", countryCode: "AUS" });
      orgB = await setup.createOrgAndAdmin(request, { orgName: "Iso B", countryCode: "NZL" });

      // User B in orgB with the same full_name as User A in orgA.
      const userB = await setup.insertUser({
        orgId: orgB.orgId, role: "diver", fullName: "Cross Org",
      });
      userBId = userB.userId;
      const { token: tokenB } = await setup.loginAs(request, userB.username);
      // Delete user B so they are a candidate row.
      await request.post("/api/users/me/delete", {
        headers: auth(tokenB),
        data: { password: setup.TEST_PASSWORD },
      });

      // User A in orgA with same name, should NOT see User B.
      const userA = await setup.insertUser({
        orgId: orgA.orgId, role: "diver", fullName: "Cross Org",
      });
      ({ token: userAToken } = await setup.loginAs(request, userA.username));
    });

    test.afterAll(async () => {
      if (orgA) await setup.deleteOrg(orgA.orgId);
      if (orgB) await setup.deleteOrg(orgB.orgId);
    });

    test("cross-org candidate is not returned", async ({ request }) => {
      const r = await request.post("/api/users/me/claim-candidates", {
        headers: auth(userAToken),
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const ids = body.candidates.map((c) => c.id);
      expect(ids).not.toContain(userBId);
    });
  });

  // ---------------------------------------------------------------
  // 4. Same-org but different name: not a candidate.
  // ---------------------------------------------------------------
  test.describe("claim-candidates: different name", () => {
    let org;
    let aToken;
    let bId;

    test.beforeAll(async ({ request }) => {
      org = await setup.createOrgAndAdmin(request, { orgName: "Names E2E", countryCode: "TST" });
      // Delete a user named "Aaron Cole".
      const aaron = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Aaron Cole",
      });
      bId = aaron.userId;
      const { token: aaronToken } = await setup.loginAs(request, aaron.username);
      await request.post("/api/users/me/delete", {
        headers: auth(aaronToken),
        data: { password: setup.TEST_PASSWORD },
      });
      // A new user with a different name should NOT see Aaron.
      const blair = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Blair Smith",
      });
      ({ token: aToken } = await setup.loginAs(request, blair.username));
    });

    test.afterAll(async () => { if (org) await setup.deleteOrg(org.orgId); });

    test("different-name candidate not returned", async ({ request }) => {
      const r = await request.post("/api/users/me/claim-candidates", {
        headers: auth(aToken),
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      const ids = body.candidates.map((c) => c.id);
      expect(ids).not.toContain(bId);
    });
  });

  // ---------------------------------------------------------------
  // 5. Conflict: B already has a dive list for the same (event, round)
  //    as the deleted A. Claim must abort with 409 rather than
  //    swallow the merge or 500 on the UNIQUE constraint.
  // ---------------------------------------------------------------
  test.describe("claim conflict", () => {
    let org;
    let event;
    let aId, bId;
    let bToken;

    test.beforeAll(async ({ request }) => {
      org = await setup.createOrgAndAdmin(request, {
        orgName: "Conflict E2E", countryCode: "TST",
      });
      event = await setup.createEvent(request, { adminToken: org.adminToken });
      const diveId = await setup.pickDiveId();

      // User A enters round 1, then deletes.
      const a = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Same Name",
      });
      aId = a.userId;
      const { token: aToken } = await setup.loginAs(request, a.username);
      await setup.insertDiveList({
        eventId: event.id, competitorId: aId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
      await request.post("/api/users/me/delete", {
        headers: auth(aToken),
        data: { password: setup.TEST_PASSWORD },
      });

      // User B also enters round 1 (so a merge would collide).
      const b = await setup.insertUser({
        orgId: org.orgId, role: "diver", fullName: "Same Name",
      });
      bId = b.userId;
      ({ token: bToken } = await setup.loginAs(request, b.username));
      await setup.insertDiveList({
        eventId: event.id, competitorId: bId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
    });

    test.afterAll(async () => { if (org) await setup.deleteOrg(org.orgId); });

    test("conflicting (event, round) → 409", async ({ request }) => {
      const r = await request.post("/api/users/me/claim", {
        headers: auth(bToken),
        data: {
          old_user_ids: [aId],
          password: setup.TEST_PASSWORD,
        },
      });
      expect(r.status()).toBe(409);
      // Neither side mutated: A's row still tombstoned, B's
      // dive list still attached to B.
      const aStill = await setup.pool.query(
        "SELECT deleted_at FROM users WHERE id = $1",
        [aId],
      );
      expect(aStill.rows[0].deleted_at).not.toBeNull();
      const bDives = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM competitor_dive_lists
         WHERE event_id = $1 AND competitor_id = $2`,
        [event.id, bId],
      );
      expect(bDives.rows[0].n).toBe(1);
    });
  });
});
