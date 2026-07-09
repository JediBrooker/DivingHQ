// Stage progression: prelim → semi → final advance flow
// (migration 040 + the matching POST /api/events/:id/advance
// + GET /api/events/:id/advance/preview endpoints).
//
// The test exercises the API contract end-to-end:
//
//   1. Create a prelim + final event (final.parent_event_id =
//      prelim.id).
//   2. Hit the preview endpoint, returns the child event's
//      handle and an empty `ranked` array (no scores yet).
//   3. Hit advance on a non-Completed parent, rejected with
//      `400 Parent event must be Completed`.
//   4. Flip the prelim to Completed without scoring → advance
//      now passes the status gate but rejects with
//      `400 Parent event has no scored divers`.
//   5. Insert a synthetic reserve row + hit the promote
//      endpoint, flag flips, display_order is assigned at the
//      back of the queue.
//
// Note: a "real" advance (top divers actually picked from a
// scored prelim) requires inserting score rows + judges + the
// calc_event_dive_points stored proc to produce ranks. The
// meet-manager spec already exercises that end-to-end flow on
// a single event; this spec focuses on the API contract for
// the new advance + promote endpoints.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("advance: preview + status gates + promote", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- Build the two-stage chain --------------------------
  const prelim = await setup.createEvent(request, {
    adminToken,
    name: "E2E Prelim",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "preliminary",
  });
  const finalEv = await setup.createEvent(request, {
    adminToken,
    name: "E2E Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "final",
    parent_event_id: prelim.id,
  });

  // ---- Preview returns child + empty ranked list ----------
  const previewRes = await request.get(
    `/api/events/${prelim.id}/advance/preview`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(previewRes.status()).toBe(200);
  const preview = await previewRes.json();
  expect(preview.child).toBeTruthy();
  expect(preview.child.id).toBe(finalEv.id);
  expect(preview.child.format).toBe("final");
  expect(Array.isArray(preview.ranked)).toBe(true);
  expect(preview.ranked).toHaveLength(0);

  // ---- ADVANCE on a non-Completed parent → 400 ------------
  const earlyRes = await request.post(
    `/api/events/${prelim.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 12, reserves: 0, dive_order: "inherit" },
    },
  );
  expect(earlyRes.status()).toBe(400);
  expect((await earlyRes.json()).error).toMatch(/Completed/i);

  // ---- Flip prelim to Completed, but no scores → 400 ------
  // setEventStatus walks Upcoming → Live → Completed; the
  // server allows Completed directly (Live requires sign-off).
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Completed",
  });
  const noScoresRes = await request.post(
    `/api/events/${prelim.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 12, reserves: 0, dive_order: "inherit" },
    },
  );
  expect(noScoresRes.status()).toBe(400);
  expect((await noScoresRes.json()).error).toMatch(/no scored divers/i);

  // ---- PROMOTE a synthetic reserve ------------------------
  // Insert a reserve row directly so we can exercise the
  // /reserves/:competitorId/promote endpoint without needing
  // the full advance flow.
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Reserve Test Diver",
  });
  const fwd = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  // Manual reserve row, bypass the public API since
  // submit-list won't write is_reserve.
  await setup.pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number, is_reserve, reserve_position)
     VALUES ($1, $2, $3, 1, TRUE, 1)`,
    [finalEv.id, diver.userId, fwd],
  );

  const promoteRes = await request.post(
    `/api/events/${finalEv.id}/reserves/${diver.userId}/promote`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(promoteRes.status()).toBe(200);
  const promoteBody = await promoteRes.json();
  expect(promoteBody.promoted).toBe(true);
  expect(promoteBody.display_order).toBe(1); // first/only active diver

  // Verify the row is no longer flagged as reserve.
  const verify = await setup.pool.query(
    `SELECT is_reserve, reserve_position, display_order
       FROM competitor_dive_lists
      WHERE event_id = $1 AND competitor_id = $2
      LIMIT 1`,
    [finalEv.id, diver.userId],
  );
  expect(verify.rows[0].is_reserve).toBe(false);
  expect(verify.rows[0].reserve_position).toBeNull();
  expect(Number(verify.rows[0].display_order)).toBe(1);

  // Promoting an already-active diver returns 404.
  const repromoteRes = await request.post(
    `/api/events/${finalEv.id}/reserves/${diver.userId}/promote`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(repromoteRes.status()).toBe(404);

  await setup.deleteOrg(orgId);
});

// Migration 041: post-advance dive-list lock (WA Article 6.7.3,
// change-of-dives submission window) + confirm-list endpoint.
// Verifies:
//   * the advance endpoint stamps dive_list_locks_at on the
//     child event (and respects lock_minutes from the body)
//   * loadEventForEntries treats a past lock as a 409 with the
//     "dive list locked" message
//   * /api/competitor/confirm-list stamps confirmed_at
//   * a re-submit via /api/competitor/submit-list upserts the
//     existing rows + stamps confirmed_at

test("advance: dive-list lock + confirm-list endpoint", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Build a prelim → final pair, populate prelim with a single
  // diver + one synthetic score row so the advance has someone
  // to rank.
  const prelim = await setup.createEvent(request, {
    adminToken,
    name: "E2E Lock Prelim",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "preliminary",
  });
  const finalEv = await setup.createEvent(request, {
    adminToken,
    name: "E2E Lock Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "final",
    parent_event_id: prelim.id,
  });

  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Lock Diver",
  });
  const fwd = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  await setup.insertDiveList({
    eventId: prelim.id,
    competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: fwd }],
  });

  // Synthetic 5-judge panel + scores. Each judge_user gets a
  // judge_id assigned via event_judges; scores rows reference
  // both. calc_event_dive_points trims high+low + sums × DD.
  const judges = await Promise.all(Array.from({ length: 5 }, () =>
    setup.insertUser({ orgId, role: "judge", fullName: "Lock Judge" }),
  ));
  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [prelim.id, judges[i].userId, i + 1],
    );
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, 7.0)`,
      [prelim.id, diver.userId, judges[i].userId, fwd],
    );
  }

  // Flip prelim to Completed.
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Completed",
  });

  // Advance with lock_minutes: 30 (default), verify the lock
  // timestamp is stamped on the final.
  const advanceRes = await request.post(`/api/events/${prelim.id}/advance`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { top_n: 1, reserves: 0, dive_order: "inherit", lock_minutes: 30 },
  });
  expect(advanceRes.status()).toBe(200);
  const advance = await advanceRes.json();
  expect(advance.advanced).toBe(1);
  expect(advance.dive_list_locks_at).toBeTruthy();

  // The lock timestamp on events.dive_list_locks_at should be ~30
  // minutes in the future.
  const lockRow = await setup.pool.query(
    "SELECT dive_list_locks_at FROM events WHERE id = $1",
    [finalEv.id],
  );
  const lockAt = new Date(lockRow.rows[0].dive_list_locks_at);
  const now = new Date();
  const minutesAhead = (lockAt - now) / 60000;
  expect(minutesAhead).toBeGreaterThan(28);
  expect(minutesAhead).toBeLessThan(32);

  // confirm-list endpoint stamps confirmed_at.
  const diverLogin = await setup.loginAs(request, diver.username);
  const confirmRes = await request.post("/api/competitor/confirm-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: { event_id: finalEv.id },
  });
  expect(confirmRes.status()).toBe(200);
  expect((await confirmRes.json()).confirmed).toBe(true);

  const confirmedRow = await setup.pool.query(
    `SELECT confirmed_at FROM competitor_dive_lists
       WHERE event_id = $1 AND competitor_id = $2 LIMIT 1`,
    [finalEv.id, diver.userId],
  );
  expect(confirmedRow.rows[0].confirmed_at).not.toBeNull();

  // Push the lock into the past + verify the entries gate fires.
  await setup.pool.query(
    "UPDATE events SET dive_list_locks_at = NOW() - interval '5 minutes' WHERE id = $1",
    [finalEv.id],
  );
  const lateSubmit = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: finalEv.id,
      dives: [{ round_number: 1, dive_id: fwd }],
    },
  });
  expect(lateSubmit.status()).toBe(409);
  expect((await lateSubmit.json()).error).toMatch(/locked/i);

  // Confirm-list still works post-lock (it's a no-op on the
  // dive_id, just re-stamps the timestamp).
  const lateConfirm = await request.post("/api/competitor/confirm-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: { event_id: finalEv.id },
  });
  expect(lateConfirm.status()).toBe(200);

  await setup.deleteOrg(orgId);
});

// Reserve replacement in a final: World Aquatics Article 4.1.8
// (reverse-rank start order) + Article 4.1.12 (advancement). The
// reserve has the worst qualifying rank in the new field, so
// they always dive FIRST (display_order=1). Every primary
// qualified worse than the replaced diver (i.e. currently has a
// smaller display_order than the replaced diver) shifts +1 to
// make room. Highest qualifier still dives last.
//
// Test setup: 3 primaries at DO 1, 2, 3 + 1 reserve (no DO).
// Under reverse-rank that means semi rank #3 → DO=1,
// semi rank #2 → DO=2, semi rank #1 → DO=3.
//
// Replace the MIDDLE primary (DO=2, semi rank #2). Expected:
//   * Reserve gets DO=1 (worst qualifier in new field).
//   * The diver formerly at DO=1 shifts to DO=2.
//   * The diver at DO=3 stays at DO=3.
//   * Replaced primary withdrawn with cleared DO.

test("advance: reserve replacing a final primary takes DO=1 + shifts others up (Article 4.1.8)", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Reserve Replace Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "final",
  });

  // Insert three primaries at DO 1, 2, 3 + one reserve.
  const fwd = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const semiRank3 = await setup.insertUser({ orgId, role: "diver", fullName: "Semi Rank 3" });
  const semiRank2 = await setup.insertUser({ orgId, role: "diver", fullName: "Semi Rank 2" });
  const semiRank1 = await setup.insertUser({ orgId, role: "diver", fullName: "Semi Rank 1" });
  const reserve   = await setup.insertUser({ orgId, role: "diver", fullName: "Reserve One" });

  await setup.pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number, display_order, is_reserve, reserve_position)
     VALUES
       ($1, $2, $3, 1, 1, FALSE, NULL),
       ($1, $4, $3, 1, 2, FALSE, NULL),
       ($1, $5, $3, 1, 3, FALSE, NULL),
       ($1, $6, $3, 1, NULL, TRUE, 1)`,
    [event.id, semiRank3.userId, fwd, semiRank2.userId, semiRank1.userId, reserve.userId],
  );

  // Replace the MIDDLE primary (semi rank #2 at DO=2).
  const promoteRes = await request.post(
    `/api/events/${event.id}/reserves/${reserve.userId}/promote`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { replaces_competitor_id: semiRank2.userId },
    },
  );
  expect(promoteRes.status()).toBe(200);
  const promoteBody = await promoteRes.json();
  // Reserve dives first per Article 4.1.8.
  expect(promoteBody.display_order).toBe(1);
  expect(promoteBody.replaced_name).toBe("Semi Rank 2");

  const verify = await setup.pool.query(
    `SELECT competitor_id, display_order, is_reserve, withdrawn_at
       FROM competitor_dive_lists
      WHERE event_id = $1`,
    [event.id],
  );
  const reserveRow   = verify.rows.find(r => r.competitor_id === reserve.userId);
  const wasDo1Row    = verify.rows.find(r => r.competitor_id === semiRank3.userId);
  const replacedRow  = verify.rows.find(r => r.competitor_id === semiRank2.userId);
  const wasDo3Row    = verify.rows.find(r => r.competitor_id === semiRank1.userId);

  // Reserve now competes at DO=1 (dives first).
  expect(Number(reserveRow.display_order)).toBe(1);
  expect(reserveRow.is_reserve).toBe(false);
  // Diver formerly at DO=1 shifted to DO=2 (the replaced
  // diver was qualified BETTER than them, so when that diver
  // leaves the field, this diver moves UP one position in the
  // reverse-rank start order).
  expect(Number(wasDo1Row.display_order)).toBe(2);
  // Replaced primary withdrawn.
  expect(replacedRow.display_order).toBeNull();
  expect(replacedRow.withdrawn_at).not.toBeNull();
  // Top qualifier unchanged at DO=3 (still dives last).
  expect(Number(wasDo3Row.display_order)).toBe(3);

  // Diver-side list-status flips for the promoted reserve.
  const reserveLogin = await setup.loginAs(request, reserve.username);
  const status = await request.get(
    `/api/competitor/list-status?event_id=${event.id}`,
    { headers: { Authorization: `Bearer ${reserveLogin.token}` } },
  );
  const statusBody = await status.json();
  expect(statusBody.is_reserve).toBe(false);

  // Reserves list now shows 0 reserves + 1 withdrawn + 3 active.
  const after = await request.get(`/api/events/${event.id}/reserves`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const afterBody = await after.json();
  expect(afterBody.reserves).toHaveLength(0);
  expect(afterBody.withdrawn).toHaveLength(1);
  expect(afterBody.withdrawn[0].full_name).toBe("Semi Rank 2");
  expect(afterBody.active).toHaveLength(3);

  await setup.deleteOrg(orgId);
});

// Reserve replacement in a SEMI-FINAL: per WA Article 4.1.8
// the semi uses reverse-rank start order based on the
// preliminary ranking, so the SAME algorithm as a final
// applies. Reserve gets DO=1, divers below the replaced
// primary shift +1.
test("advance: reserve replacing a semi-final primary applies the same reverse-rank shift as a final", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Reserve Replace Semi",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "semifinal",
  });

  const fwd = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const a = await setup.insertUser({ orgId, role: "diver", fullName: "Semi A" });
  const b = await setup.insertUser({ orgId, role: "diver", fullName: "Semi B" });
  const c = await setup.insertUser({ orgId, role: "diver", fullName: "Semi C" });
  const reserve = await setup.insertUser({ orgId, role: "diver", fullName: "Semi Reserve" });
  await setup.pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number, display_order, is_reserve, reserve_position)
     VALUES
       ($1, $2, $3, 1, 1, FALSE, NULL),
       ($1, $4, $3, 1, 2, FALSE, NULL),
       ($1, $5, $3, 1, 3, FALSE, NULL),
       ($1, $6, $3, 1, NULL, TRUE, 1)`,
    [event.id, a.userId, fwd, b.userId, c.userId, reserve.userId],
  );

  // Replace middle primary (DO=2, qualified middle of field).
  // WA reverse-rank: reserve takes DO=1 (worst qualifier dives
  // first), the diver formerly at DO=1 shifts to DO=2, and
  // DO=3 stays put.
  const promoteRes = await request.post(
    `/api/events/${event.id}/reserves/${reserve.userId}/promote`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { replaces_competitor_id: b.userId },
    },
  );
  expect(promoteRes.status()).toBe(200);
  expect((await promoteRes.json()).display_order).toBe(1);

  const verify = await setup.pool.query(
    `SELECT competitor_id, display_order
       FROM competitor_dive_lists
      WHERE event_id = $1 AND withdrawn_at IS NULL AND is_reserve = FALSE`,
    [event.id],
  );
  const orderByName = Object.fromEntries(
    verify.rows.map(r => [r.competitor_id, Number(r.display_order)]),
  );
  expect(orderByName[reserve.userId]).toBe(1);  // worst qualifier dives first
  expect(orderByName[a.userId]).toBe(2);        // shifted +1
  expect(orderByName[c.userId]).toBe(3);        // unchanged (qualified above replaced diver)

  await setup.deleteOrg(orgId);
});
