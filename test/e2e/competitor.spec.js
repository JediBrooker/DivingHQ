// Competitor self-service flow.
//
// What this exercises end-to-end:
//   1. Diver self-registers via POST /api/auth/register — note
//      this leaves email_verified_at = NULL on purpose.
//   2. Login is REFUSED with code: "email_not_verified" — this is
//      the gate Migration 021 added.
//   3. We "click the link" by stamping email_verified_at directly
//      (the real link is signed with the same JWT_SECRET, but we
//      don't ship that to the test process and don't want to peek
//      at it via the mailer transport — easier to bypass).
//   4. Login now succeeds and returns a token.
//   5. Diver approves themselves into a 'diver' role (real flow:
//      role_request → admin reviews → role granted; bypass via
//      direct SQL the same way _setup.insertUser does).
//   6. Admin (separately) creates an event with entries_close_at
//      in the future so the diver can submit against it.
//   7. Diver POSTs /api/competitor/submit-list with two rounds.
//   8. Roster GET (as admin) shows the diver's two dives.
//
// Why API-driven: the registration form is a normal HTML form
// in the SPA; testing it through Playwright would only exercise
// vue-router + the form bindings, not the gate logic that's
// the regression risk here.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("diver registers, gates on email verification, then submits a dive list", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(60_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- 1. Self-register a fresh diver via the public API. ----
  const slug    = setup.rand();
  const username = `e2e-diver-${slug}`;
  const email    = `e2e-diver-${slug}@example.test`;
  const reg = await request.post("/api/auth/register", {
    data: {
      username,
      password:        setup.TEST_PASSWORD,
      email,
      org_id:          orgId,
      full_name:       "Diver Self-Reg",
      requested_role:  "diver",
    },
  });
  expect(reg.status()).toBe(201);

  // ---- 2. Login should be refused: email not yet verified. ----
  const blocked = await request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(blocked.status()).toBe(403);
  const blockedBody = await blocked.json();
  expect(blockedBody.code).toBe("email_not_verified");

  // ---- 3. "Click the link" — stamp email_verified_at directly.
  //         The real flow POSTs the JWT from the email back to
  //         /api/auth/verify-email; we don't have access to the
  //         mailer queue from the test, so we bypass.
  const userIdRow = await setup.pool.query(
    "SELECT id FROM users WHERE org_id = $1 AND username = $2",
    [orgId, username],
  );
  const diverUserId = userIdRow.rows[0].id;
  await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE id = $1",
    [diverUserId],
  );

  // Self-register only grants the 'spectator' role and files a
  // role_request. Bypass the admin review by inserting the diver
  // role directly (same trade-off _setup.insertUser makes).
  await setup.pool.query(
    `INSERT INTO user_org_roles (user_id, org_id, role)
     VALUES ($1, $2, 'diver')
     ON CONFLICT DO NOTHING`,
    [diverUserId, orgId],
  );

  // ---- 4. Login now succeeds. ----
  const diverLogin = await setup.loginAs(request, username);
  expect(diverLogin.token).toBeTruthy();

  // ---- 5. Admin creates an event the diver can submit into. ----
  // entries_close_at must be in the future or
  // loadEventForEntries refuses the submission.
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Competitor Submit",
    number_of_judges: 5,
    total_rounds:     2,
    height:           "3m",
    entries_close_at: future,
  });
  const eventId = event.id;

  // ---- 6. Diver submits a two-round list. ----
  const dive1 = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const dive2 = await setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" });
  const submit = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: eventId,
      dives: [
        { round_number: 1, dive_id: dive1 },
        { round_number: 2, dive_id: dive2 },
      ],
    },
  });
  expect(submit.status()).toBe(200);

  // ---- 7. Admin reads the roster back; the diver's two dives
  //         should be there in round order. ----
  const rosterRead = await request.get(`/api/events/${eventId}/roster`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(rosterRead.status()).toBe(200);
  const roster = await rosterRead.json();
  expect(roster).toHaveLength(2);
  expect(roster[0].full_name).toBe("Diver Self-Reg");
  expect(roster[0].competitor_org_id).toBe(orgId);
  expect(typeof roster[0].competitor_org_name).toBe("string");
  expect(roster[0].competitor_org_name.length).toBeGreaterThan(0);
  expect(Number(roster[0].round_number)).toBe(1);
  expect(roster[0].dive_code).toBe("101");
  expect(Number(roster[1].round_number)).toBe(2);
  expect(roster[1].dive_code).toBe("201");

  // ---- 8. Browser sanity: SPA boots. ----
  await page.goto(`/scoreboard/${eventId}`);
  await expect(page).toHaveTitle(/divinghq/i);

  // ---- Cleanup ----
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
