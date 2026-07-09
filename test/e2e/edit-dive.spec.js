// Meet manager edits a diver's dive mid-event (WA Article 6.7.4,
// change-of-dives via the official form, signed by the
// athlete's representative under Referee oversight).
//
// The flow rides on POST /api/events/:id/roster, an upsert
// endpoint already used late-entry adds. This commit split
// the audit action so an INSERT (new roster row) audits as
// `roster.late_entry_added` while an ON-CONFLICT UPDATE (dive
// swap on an existing row) audits as `roster.dive_edited`.
//
// Test:
//   1. Insert a diver into a 2-round event with 101B in both
//      rounds.
//   2. Hit POST /roster with a different dive_id for round 1
//      → server should treat as an UPDATE (200), audit row
//      action='roster.dive_edited', dive_id swapped, the
//      OTHER round untouched.
//   3. Hit POST /roster for a round that doesn't have a row
//      yet → server should INSERT (201), audit row
//      action='roster.late_entry_added'.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("edit-dive: existing row updates audit as dive_edited; new row audits as late_entry_added", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Edit-Dive",
    height: "3m",
    number_of_judges: 5,
    // Heads up: 3 rounds so the round-3 add below is a legitimate
    // fresh INSERT, since the roster upsert now bounds-checks
    // round_number against total_rounds (phantom rounds get rejected with 400).
    total_rounds: 3,
  });

  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Edit-Dive Diver",
  });
  const dive101B = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  const dive107B = await setup.pickDiveId({
    height: 3.0, dive_code: "107", position: "B",
  });
  // Pre-populate rounds 1 + 2 with 101B.
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [
      { round_number: 1, dive_id: dive101B },
      { round_number: 2, dive_id: dive101B },
    ],
  });

  // ---- Edit round 1: 101B → 107B. Existing row → 200 + dive_edited.
  const editRes = await request.post(
    `/api/events/${event.id}/roster`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        competitor_id: diver.userId,
        dive_id:       dive107B,
        round_number:  1,
      },
    },
  );
  expect(editRes.status()).toBe(200);
  const editBody = await editRes.json();
  expect(editBody.action).toBe("edited");

  // Round 1 swapped, round 2 untouched.
  const after = await setup.pool.query(
    `SELECT round_number, dive_id FROM competitor_dive_lists
       WHERE event_id = $1 AND competitor_id = $2
       ORDER BY round_number ASC`,
    [event.id, diver.userId],
  );
  expect(after.rows[0].round_number).toBe(1);
  expect(after.rows[0].dive_id).toBe(dive107B);
  expect(after.rows[1].round_number).toBe(2);
  expect(after.rows[1].dive_id).toBe(dive101B);

  // Audit row action = 'roster.dive_edited' (NOT
  // late_entry_added, since the row already existed).
  const editAudit = await setup.pool.query(
    `SELECT action, metadata FROM audit_log
       WHERE org_id = $1 AND entity_type = 'roster_entry'
       ORDER BY created_at DESC LIMIT 1`,
    [orgId],
  );
  expect(editAudit.rows[0].action).toBe("roster.dive_edited");
  expect(editAudit.rows[0].metadata.round_number).toBe(1);
  expect(editAudit.rows[0].metadata.dive_id).toBe(dive107B);

  // ---- Add a NEW round-3 row. The diver only has a round-1
  // entry, so round 3 forces the fresh INSERT path (and stays
  // within the event's total_rounds=3 bound the upsert enforces).
  const addRes = await request.post(
    `/api/events/${event.id}/roster`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        competitor_id: diver.userId,
        dive_id:       dive101B,
        round_number:  3,
      },
    },
  );
  expect(addRes.status()).toBe(201);
  const addBody = await addRes.json();
  expect(addBody.action).toBe("added");

  // Audit row for the INSERT path = 'roster.late_entry_added'.
  const addAudit = await setup.pool.query(
    `SELECT action FROM audit_log
       WHERE org_id = $1 AND entity_type = 'roster_entry'
       ORDER BY created_at DESC LIMIT 1`,
    [orgId],
  );
  expect(addAudit.rows[0].action).toBe("roster.late_entry_added");

  await setup.deleteOrg(orgId);
});
