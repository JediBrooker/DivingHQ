// Admin / event-manager pipeline test.
//
// What this exercises end-to-end:
//   1. Org admin creates an event via POST /api/events
//   2. Adds a diver to the roster via POST /api/events/:id/roster
//      (the late-entry add path used when a competitor walks up
//      without having pre-submitted a list)
//   3. Flips the event Upcoming -> Live -> Completed via
//      PUT /api/events/:id/status
//   4. Reads the roster back via GET /api/events/:id/roster and
//      confirms the diver shows up with the right dive
//   5. Browses to the manager view in a real browser just to make
//      sure the SPA renders without throwing
//
// We don't drive the manager UI for the writes, the API path is
// what the SPA calls anyway, and hitting it directly keeps the
// test fast and focused on the pipeline (event create -> roster
// add -> status flip -> roster read), not on the SPA's click flow.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("admin creates event, adds roster, flips status, reads it back", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(60_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- Create the event ----
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Admin Pipeline",
    number_of_judges: 5,
    total_rounds: 2,
    height: "3m",
  });
  const eventId = event.id;
  expect(event.status).toBe("Upcoming");           // default

  // ---- add a diver to the roster via the late-entry endpoint --
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver Late-Add",
  });
  const diveId = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });

  const rosterAdd = await request.post(`/api/events/${eventId}/roster`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      competitor_id: diver.userId,
      dive_id:       diveId,
      round_number:  1,
    },
  });
  expect(rosterAdd.status()).toBe(201);
  const rosterAddBody = await rosterAdd.json();
  expect(rosterAddBody.ok).toBe(true);
  expect(rosterAddBody.dive_list_id).toBeTruthy();

  // ---- Flip the status: Upcoming -> Live -> Completed ----
  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });
  // ---- Read the roster back ----
  // The roster endpoint requires a meet_controller / event manager
  // role. The admin token has the org_admin role though, which
  // requireMeetController accepts fine (org_admin sits at the top
  // of the hierarchy).
  const rosterRead = await request.get(`/api/events/${eventId}/roster`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(rosterRead.status()).toBe(200);
  const roster = await rosterRead.json();
  expect(Array.isArray(roster)).toBe(true);
  expect(roster).toHaveLength(1);
  const row = roster[0];
  expect(row.full_name).toBe("Diver Late-Add");
  expect(row.competitor_org_id).toBe(orgId);
  expect(typeof row.competitor_org_name).toBe("string");
  expect(row.competitor_org_name.length).toBeGreaterThan(0);
  expect(row.dive_code).toBe("101");
  expect(row.position).toBe("B");
  expect(Number(row.round_number)).toBe(1);

  const auditRead = await request.get(`/api/events/${eventId}/audit-recent?limit=5`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(auditRead.status()).toBe(200);
  const auditRows = await auditRead.json();
  expect(auditRows.some((auditRow) =>
    auditRow.kind === "activity" &&
    auditRow.action === "roster.late_entry_added" &&
    auditRow.metadata?.event_id === eventId,
  )).toBeTruthy();

  // ---- Flip to Completed and confirm the status sticks ----
  await setup.setEventStatus(request, { adminToken, eventId, status: "Completed" });
  // Could confirm this via any event-listing endpoint, but the
  // simplest option is to GET the same event again since the
  // events list is the closest public read path.
  const list = await request.get(`/api/events?org_id=${orgId}`);
  expect(list.status()).toBe(200);
  const allEvents = await list.json();
  const ours = allEvents.find((e) => e.id === eventId);
  expect(ours).toBeTruthy();
  expect(ours.status).toBe("Completed");

  // ---- Browser sanity check: SPA boots without throwing -------
  // The manager view is gated by login (the SPA reads localStorage
  // for the JWT and redirects to /login if missing). We don't try
  // to log in via the SPA (already have a token from the API), but
  // we can at least check the public scoreboard for this event
  // renders okay.
  await page.goto(`/scoreboard/${eventId}`);
  await expect(page).toHaveTitle(/divinghq/i);

  // ---- Cleanup ----
  await setup.deleteOrg(orgId);
});

test("meet readiness report returns event summary and CSV export", async ({ request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  const meetRes = await request.post("/api/meets", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name: "E2E Readiness Meet", venue: "Test Pool" },
  });
  expect(meetRes.status()).toBe(201);
  const meet = await meetRes.json();
  const event = await setup.createEvent(request, {
    adminToken,
    meet_id: meet.id,
    name: "E2E Readiness Event",
    total_rounds: 2,
  });

  const reportRes = await request.get(`/api/meets/${meet.id}/readiness-report`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(reportRes.status()).toBe(200);
  const report = await reportRes.json();
  expect(report.summary.event_count).toBe(1);
  expect(report.events[0].event_id).toBe(event.id);
  expect(report.events[0].ready).toBe(false);
  expect(Array.isArray(report.events[0].blockers)).toBe(true);

  const csvRes = await request.get(`/api/meets/${meet.id}/readiness-report?format=csv`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(csvRes.status()).toBe(200);
  const csv = await csvRes.text();
  expect(csv).toContain("event,status,ready");
  expect(csv).toContain("E2E Readiness Event");

  await setup.deleteOrg(orgId);
});

test("roster CSV import supports preview before commit", async ({ request }) => {
  test.setTimeout(60_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Roster Preview",
    total_rounds: 1,
    height: "3m",
  });
  const diver = await setup.insertUser({
    orgId,
    role: "diver",
    fullName: "Preview Diver",
  });
  const csv = `username,round_1_code,round_1_pos\n${diver.username},101,B\n`;

  const previewRes = await request.post(`/api/events/${event.id}/roster/import`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { csv, preview: true },
  });
  expect(previewRes.status()).toBe(200);
  const preview = await previewRes.json();
  expect(preview.preview).toBe(true);
  expect(preview.added).toBe(1);
  expect(preview.rounds_written).toBe(1);
  expect(preview.rows[0].rounds[0].action).toBe("insert");

  const before = await setup.pool.query(
    "SELECT COUNT(*)::int AS n FROM competitor_dive_lists WHERE event_id = $1",
    [event.id],
  );
  expect(before.rows[0].n).toBe(0);

  const commitRes = await request.post(`/api/events/${event.id}/roster/import`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { csv },
  });
  expect(commitRes.status()).toBe(200);
  const commit = await commitRes.json();
  expect(commit.preview).toBe(false);
  expect(commit.rounds_written).toBe(1);

  const after = await setup.pool.query(
    "SELECT COUNT(*)::int AS n FROM competitor_dive_lists WHERE event_id = $1",
    [event.id],
  );
  expect(after.rows[0].n).toBe(1);

  await setup.deleteOrg(orgId);
});

test("participating federation invite requires accept before entry opens", async ({ request }) => {
  test.setTimeout(60_000);
  const host = await setup.createOrgAndAdmin(request, {
    orgName: "E2E Host Federation",
    countryCode: "AUS",
  });
  const guest = await setup.createOrgAndAdmin(request, {
    orgName: "E2E Guest Federation",
    countryCode: "NZL",
  });
  const event = await setup.createEvent(request, {
    adminToken: host.adminToken,
    name: "E2E Participation Workflow",
  });

  const inviteRes = await request.post(`/api/events/${event.id}/participation-requests`, {
    headers: { Authorization: `Bearer ${host.adminToken}` },
    data: { org_id: guest.orgId },
  });
  expect(inviteRes.status()).toBe(201);
  const invite = await inviteRes.json();
  expect(invite.status).toBe("pending");

  const beforeRes = await request.get(`/api/events/${event.id}/participating-orgs`, {
    headers: { Authorization: `Bearer ${host.adminToken}` },
  });
  expect(beforeRes.status()).toBe(200);
  const before = await beforeRes.json();
  expect(before.some((row) => row.org_id === guest.orgId)).toBe(false);

  const guestRequestsRes = await request.get(`/api/events/${event.id}/participation-requests`, {
    headers: { Authorization: `Bearer ${guest.adminToken}` },
  });
  expect(guestRequestsRes.status()).toBe(200);
  const guestRequests = await guestRequestsRes.json();
  expect(guestRequests).toHaveLength(1);
  expect(guestRequests[0].org_id).toBe(guest.orgId);

  const acceptRes = await request.post(`/api/events/${event.id}/participation-requests/${invite.id}/respond`, {
    headers: { Authorization: `Bearer ${guest.adminToken}` },
    data: { decision: "accepted" },
  });
  expect(acceptRes.status()).toBe(200);
  const accepted = await acceptRes.json();
  expect(accepted.status).toBe("accepted");

  const afterRes = await request.get(`/api/events/${event.id}/participating-orgs`, {
    headers: { Authorization: `Bearer ${host.adminToken}` },
  });
  expect(afterRes.status()).toBe(200);
  const after = await afterRes.json();
  expect(after.some((row) => row.org_id === guest.orgId)).toBe(true);

  await setup.deleteOrg(host.orgId);
  await setup.deleteOrg(guest.orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker, the second one hit a
// closed pool. node-postgres handles process exit gracefully so
// just let it.
