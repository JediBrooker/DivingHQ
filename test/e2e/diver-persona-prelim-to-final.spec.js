// Diver-persona walkthrough: prelim → semi (rank 13 = reserve)
// → primary withdraws → reserve promoted to final → reserve edits
// dive sheet (swap 107B for 109C, harder DD) → submits.
//
// Threads through every piece of the stage-progression machinery
// shipped in commits dd51a35 + f3db10e + 6155354 + f71faa4 +
// 506ba87:
//
//   * The advance endpoint creating + ranking via the WA
//     tie-break (Article 4.1.10 reverse-rank).
//   * Reserves carrying forward from semi → final (top 12 + 1).
//   * The diver portal's amber "You're Reserve N" banner.
//   * The promote endpoint with `replaces_competitor_id`
//     applying WA Article 4.1.8 / 4.1.10 reverse-rank shift
//     (reserve takes display_order=1, others below shift +1).
//   * The post-advance dive-list lock + Confirm/edit banner
//     (WA Article 6.7.3, 30 min after end of previous stage).
//   * The diver upserting a different dive_id via submit-list
//     (107B → 109C, both real entries in dive_directory at 3m).
//   * confirmed_at stamped server-side on re-submit.
//
// The setup uses direct DB inserts for the heavy lifting
// (13 divers + 5 judges + scores per stage). Driving the full
// scoring flow through the SPA / sockets would balloon the
// runtime to several minutes per stage; the meet-manager spec
// already covers the live-scoring path on a single event. This
// spec specifically tests the persona's diver-portal experience
// end-to-end, with the API + DB providing the surrounding meet
// context.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("persona: prelim → semi (13th, reserve) → promoted into final → edits 107B → 109C", async ({
  request, page,
}) => {
  test.setTimeout(120_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---------------------------------------------------------
  // 13 divers, index 12 is "our" persona diver (rank #13 in
  // both stages so they end up as the lone reserve into the
  // final). 5 judges, all reused across the chain.
  // ---------------------------------------------------------
  const divers = await Promise.all(
    Array.from({ length: 13 }, (_, i) =>
      setup.insertUser({
        orgId,
        role: "diver",
        fullName: i === 12 ? "Persona Diver" : `Diver ${i + 1}`,
      }),
    ),
  );
  const ourDiver = divers[12];
  const judges = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      setup.insertUser({ orgId, role: "judge", fullName: `Judge ${i + 1}` }),
    ),
  );

  // ---------------------------------------------------------
  // Dive ids, both exist on 3m springboard per the catalog.
  // 107B = forward 3.5 som pike, DD 3.1
  // 109C = forward 4.5 som tuck, DD 3.8
  // ---------------------------------------------------------
  const dive107B = await setup.pickDiveId({
    height: 3.0, dive_code: "107", position: "B",
  });
  const dive109C = await setup.pickDiveId({
    height: 3.0, dive_code: "109", position: "C",
  });

  // ---------------------------------------------------------
  // Three-stage event chain.
  // ---------------------------------------------------------
  const prelim = await setup.createEvent(request, {
    adminToken,
    name: "E2E Persona Prelim",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "preliminary",
  });
  const semi = await setup.createEvent(request, {
    adminToken,
    name: "E2E Persona Semi",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "semifinal",
    parent_event_id: prelim.id,
  });
  const final = await setup.createEvent(request, {
    adminToken,
    name: "E2E Persona Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "final",
    parent_event_id: semi.id,
  });

  // ---------------------------------------------------------
  // Helper: wire up an event with judges, dive lists for all
  // 13 divers (every diver attempts 107B), and judge scores
  // arranged so divers[i] ranks (i+1)th, i.e. divers[0]
  // wins, divers[12] (our persona) finishes 13th.
  // ---------------------------------------------------------
  async function wireUpStage(eventId, { skipDiveLists } = {}) {
    if (!skipDiveLists) {
      // Prelim is populated by us directly; semi+final get
      // their rows from the advance endpoint.
      for (const diver of divers) {
        await setup.insertDiveList({
          eventId,
          competitorId: diver.userId,
          dives: [{ round_number: 1, dive_id: dive107B }],
        });
      }
    }
    for (let j = 0; j < judges.length; j++) {
      await setup.pool.query(
        `INSERT INTO event_judges (event_id, judge_id, judge_number)
         VALUES ($1, $2, $3)`,
        [eventId, judges[j].userId, j + 1],
      );
    }
    // Each diver gets 5 identical judge scores. The trim
    // algorithm drops one high + one low; the surviving 3
    // scores × DD give the dive total. Spacing 0.5 between
    // divers makes ranking deterministic.
    for (let d = 0; d < divers.length; d++) {
      const score = 9.0 - d * 0.5;
      for (const judge of judges) {
        await setup.pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [eventId, divers[d].userId, judge.userId, dive107B, score],
        );
      }
    }
  }

  // ---- PRELIM: populate, score, complete -----------------
  await wireUpStage(prelim.id);
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Completed",
  });

  // ---- ADVANCE prelim → semi (top 13) --------------------
  const advanceToSemi = await request.post(
    `/api/events/${prelim.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 13, reserves: 0, dive_order: "reverse" },
    },
  );
  expect(advanceToSemi.status()).toBe(200);
  const semiBody = await advanceToSemi.json();
  expect(semiBody.advanced).toBe(13);

  // ---- SEMI: score (advance copies dive lists; we add
  //          judges + scores). Same scoring → ourDiver = 13th.
  await wireUpStage(semi.id, { skipDiveLists: true });
  await setup.setEventStatus(request, {
    adminToken, eventId: semi.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: semi.id, status: "Completed",
  });

  // ---- ADVANCE semi → final (top 12 + 1 reserve) ---------
  const advanceToFinal = await request.post(
    `/api/events/${semi.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 12, reserves: 1, dive_order: "reverse" },
    },
  );
  expect(advanceToFinal.status()).toBe(200);
  const finalBody = await advanceToFinal.json();
  expect(finalBody.advanced).toBe(12);
  expect(finalBody.reserves).toBe(1);

  // Sanity: our diver is the 1 reserve, with reserve_position 1.
  const reservesRes = await request.get(
    `/api/events/${final.id}/reserves`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const reservesBody = await reservesRes.json();
  expect(reservesBody.reserves).toHaveLength(1);
  expect(reservesBody.reserves[0].competitor_id).toBe(ourDiver.userId);
  expect(reservesBody.reserves[0].reserve_position).toBe(1);

  // The advance fired a `dive_list_reserve` notification; the
  // notifications table should carry it. Push delivery is
  // best-effort + may no-op if SMTP isn't configured, but the
  // row should still be queued.
  const reserveNotif = await setup.pool.query(
    `SELECT category, title FROM notifications
       WHERE user_id = $1 AND category = 'dive_list_reserve'
       ORDER BY created_at DESC LIMIT 1`,
    [ourDiver.userId],
  );
  expect(reserveNotif.rows[0]?.title).toMatch(/reserve/i);

  // =========================================================
  // DIVER UI: log in, see the reserve banner.
  // =========================================================
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(ourDiver.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

  await page.goto("/competitor");
  await expect(page.getByRole("heading", { name: /Submit Dive List/i }))
    .toBeVisible({ timeout: 10_000 });

  // Pick the FINAL from the dropdown (Step 1).
  await page.locator("select").first().selectOption(final.id);

  // Reserve banner visible, amber, "You're Reserve 1".
  await expect(page.locator(".reserve-banner")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".reserve-banner-title"))
    .toContainText(/You're Reserve 1/i);
  // Body cites WA Rule 4.1.12 + the 30-min change window.
  await expect(page.locator(".reserve-banner-body"))
    .toContainText(/4\.1\.12/);

  // The inherited dive (107B) is pre-filled in round 1.
  await expect(page.locator(".dive-row").first()).toContainText("107");

  // =========================================================
  // PROMOTE: simulate diver12 (the 12th-place finisher) being
  // unable to compete, so the meet manager promotes our reserve
  // into their slot. Per WA Article 4.1.8 / 4.1.10 reverse-rank,
  // the reserve doesn't inherit diver12's display_order, they
  // get DO=1 and divers below diver12 in qualifying rank shift
  // up.
  // =========================================================
  const withdrawingPrimary = divers[11]; // 12th-best from semi
  const promoteRes = await request.post(
    `/api/events/${final.id}/reserves/${ourDiver.userId}/promote`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { replaces_competitor_id: withdrawingPrimary.userId },
    },
  );
  expect(promoteRes.status()).toBe(200);
  expect((await promoteRes.json()).replaced_name).toMatch(/Diver 12/);

  // Promote endpoint fires a `reserve_promoted` notification.
  const promoteNotif = await setup.pool.query(
    `SELECT category, title FROM notifications
       WHERE user_id = $1 AND category = 'reserve_promoted'
       ORDER BY created_at DESC LIMIT 1`,
    [ourDiver.userId],
  );
  expect(promoteNotif.rows[0]?.title).toMatch(/promoted/i);

  // =========================================================
  // DIVER UI: refresh, reserve banner gone, lock banner now.
  // =========================================================
  await page.reload();
  await page.locator("select").first().selectOption(final.id);

  await expect(page.locator(".reserve-banner")).toHaveCount(0);
  await expect(page.locator(".advance-banner")).toBeVisible();
  await expect(page.locator(".advance-banner-title"))
    .toContainText(/You've advanced|Confirm or edit/i);

  // =========================================================
  // DIVER UI: edit round 1 from 107B to 109C.
  // =========================================================
  // Click the dive row (opens the picker modal).
  await page.locator(".dive-row").first().click();
  await expect(page.locator(".modal-backdrop .modal").filter({ hasText: /Find Dive/i }))
    .toBeVisible({ timeout: 5_000 });

  // Search for "109".
  const search = page.locator('input[placeholder*="code or description" i]');
  await search.fill("109");

  // Click the 109C result (filter to position C among the 109s).
  await page.locator(".result-item").filter({ hasText: /109/ }).filter({ hasText: /C/ }).first().click();

  // Modal closes; the row now shows 109C.
  await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  await expect(page.locator(".dive-row").first()).toContainText("109");
  await expect(page.locator(".dive-row").first()).toContainText("C");

  // =========================================================
  // DIVER UI: submit, verify success + DB.
  // =========================================================
  await page.getByRole("button", { name: /Finalise & Submit List/i }).click();
  // submitList() redirects to /dashboard on success.
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

  const verify = await setup.pool.query(
    `SELECT cdl.dive_id, cdl.confirmed_at, cdl.is_reserve,
            cdl.display_order, d.dive_code, d.position
       FROM competitor_dive_lists cdl
       JOIN dive_directory d ON d.id = cdl.dive_id
      WHERE cdl.event_id = $1 AND cdl.competitor_id = $2
        AND cdl.round_number = 1`,
    [final.id, ourDiver.userId],
  );
  const row = verify.rows[0];
  // Dive swapped to 109C.
  expect(row.dive_code).toBe("109");
  expect(row.position).toBe("C");
  expect(row.dive_id).toBe(dive109C);
  // Diver is now an active competitor at start position 1
  // (per WA reverse-rank shift, worst qualifier dives first).
  expect(row.is_reserve).toBe(false);
  expect(Number(row.display_order)).toBe(1);
  // confirmed_at is stamped on the upsert.
  expect(row.confirmed_at).not.toBeNull();

  await setup.deleteOrg(orgId);
});
