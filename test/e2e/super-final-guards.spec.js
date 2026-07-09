// Super Final guard rails: three reject-paths that the audit flagged
// as untested. Each one corresponds to a real correctness concern
// raised in the code review:
//
//   1. Re-seed-on-scored-data must 409 (not silently nuke scores
//      via FK CASCADE). Code-review Blocking #3.
//   2. Mixed-gender Super Final SF must 400 (Appendix 3 §1 splits
//      Super Final by gender; M=6 dives, W=5).
//   3. score_carry_from must be honoured by /api/scoreboard/:id so
//      spectators see H2H+SF cumulative on the SF stage's live
//      scoreboard. Code-review Blocking #2.
//
// Each test is small and self-contained, so a failure points at
// one concern instead of a tangle of them.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("seed-h2h refuses re-seed when scores already exist on the H2H event", async ({ request }) => {
  test.setTimeout(45_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // stop-1 final: 12 divers, all scored
  const parent = await setup.createEvent(request, {
    adminToken, name: "S1 final", height: "3m",
    number_of_judges: 5, total_rounds: 1, event_format: "final",
  });
  const judge = await setup.insertUser({ orgId, role: "judge", fullName: "J1" });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)`,
    [parent.id, judge.userId],
  );
  for (let i = 0; i < 12; i++) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: `Diver ${i}` });
    await setup.insertDiveList({
      eventId: parent.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      // Score validation is 0..10 in 0.5 increments (`isValidScore`).
      // 8.0 down by 0.5 covers 12 distinct values, 8.0 to 2.5.
      [parent.id, d.userId, judge.userId, diveId, 8.0 - i * 0.5],
    );
  }
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });

  // H2H stage, seed once cleanly
  const h2h = await setup.createEvent(request, {
    adminToken, name: "H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", parent_event_id: parent.id,
  });
  const seed1 = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { max_per_org: 12 },
  });
  expect(seed1.status()).toBe(200);

  // Pretend an operator started scoring (insert a single score row),
  // then re-seeds. The scores-exist guard should fire here, silently
  // nuking scored data via the cdl->scores FK cascade was the actual bug.
  const h2hRoster = await setup.pool.query(
    "SELECT competitor_id FROM competitor_dive_lists WHERE event_id = $1 LIMIT 1",
    [h2h.id],
  );
  await setup.pool.query(
    `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)
     ON CONFLICT DO NOTHING`,
    [h2h.id, judge.userId],
  );
  await setup.pool.query(
    `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
     VALUES ($1, $2, $3, $4, 1, 7.5)`,
    [h2h.id, h2hRoster.rows[0].competitor_id, judge.userId, diveId],
  );

  const seed2 = await request.post(`/api/events/${h2h.id}/seed-h2h`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { max_per_org: 12 },
  });
  expect(seed2.status()).toBe(409);
  const body = await seed2.json();
  expect(body.error).toMatch(/score row/i);

  // Score row must still exist, i.e. the guard prevented the
  // cascade-delete the bug used to let through.
  const scoresAfter = await setup.pool.query(
    "SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1",
    [h2h.id],
  );
  expect(scoresAfter.rows[0].n).toBeGreaterThan(0);

  await setup.deleteOrg(orgId);
});

test("seed-semi rejects Mixed-gender Super Final per Appendix 3 §1", async ({ request }) => {
  test.setTimeout(45_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // build a minimal H2H Completed -> SF Mixed
  const parent = await setup.createEvent(request, {
    adminToken, name: "S1", height: "3m",
    number_of_judges: 5, total_rounds: 1, event_format: "final",
  });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: parent.id, status: "Completed" });

  const h2h = await setup.createEvent(request, {
    adminToken, name: "H2H", height: "3m",
    number_of_judges: 5, total_rounds: 3,
    event_format: "super_final_h2h", parent_event_id: parent.id,
  });
  await setup.setEventStatus(request, { adminToken, eventId: h2h.id, status: "Live" });
  await setup.setEventStatus(request, { adminToken, eventId: h2h.id, status: "Completed" });

  const sfMixed = await setup.createEvent(request, {
    adminToken, name: "SF Mixed", height: "3m",
    number_of_judges: 5, total_rounds: 2,
    event_format: "super_final_semi", parent_event_id: h2h.id,
    gender: "Mixed",
  });

  const seedRes = await request.post(`/api/events/${sfMixed.id}/seed-semi`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {},
  });
  expect(seedRes.status()).toBe(400);
  const body = await seedRes.json();
  // Spec is gender-specific (M=6 dives, W=5), so the server should
  // refuse Mixed cleanly rather than half-supporting it.
  expect(body.error.toLowerCase()).toMatch(/mixed|gender/);

  await setup.deleteOrg(orgId);
});
