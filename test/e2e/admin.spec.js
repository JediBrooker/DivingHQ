// Admin / event-manager pipeline test.
//
// What this exercises end-to-end:
//   1. Org admin creates an event via POST /api/events
//   2. Adds a diver to the roster via POST /api/events/:id/roster
//      (the late-entry add path used when a competitor walks up
//      without having pre-submitted a list)
//   3. Flips the event Upcoming → Live → Completed via
//      PUT /api/events/:id/status
//   4. Reads the roster back via GET /api/events/:id/roster and
//      confirms the diver shows up with the right dive
//   5. Browses to the manager view in a real browser to make
//      sure the SPA renders without throwing
//
// We don't drive the manager UI for the writes — the API path is
// what the SPA calls anyway, and exercising it directly keeps
// the test fast and focused on the pipeline (event create →
// roster add → status flip → roster read), not on the SPA's
// click flow.

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

  // ---- Add a diver to the roster via the late-entry endpoint --
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

  // ---- Flip the status: Upcoming → Live → Completed ----
  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });
  // ---- Read the roster back ----
  // The roster endpoint requires a meet_controller / event manager
  // role; the admin token has the org_admin role, which the
  // requireMeetController middleware accepts (org_admin is the
  // top of the hierarchy).
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
  // We can confirm by reading any event-listing endpoint, but the
  // simplest is to GET the same event again. The events list is
  // the closest public read path.
  const list = await request.get(`/api/events?org_id=${orgId}`);
  expect(list.status()).toBe(200);
  const allEvents = await list.json();
  const ours = allEvents.find((e) => e.id === eventId);
  expect(ours).toBeTruthy();
  expect(ours.status).toBe("Completed");

  // ---- Browser sanity check: SPA boots without throwing -------
  // The manager view is gated by login (the SPA reads localStorage
  // for the JWT and redirects to /login if missing). We don't try
  // to log in via the SPA — we already have a token from the API
  // — but we can at least check the public scoreboard for this
  // event renders.
  await page.goto(`/scoreboard/${eventId}`);
  await expect(page).toHaveTitle(/divinghq/i);

  // ---- Cleanup ----
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
