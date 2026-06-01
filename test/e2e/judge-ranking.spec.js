// Judge Ranking Analysis — endpoint coverage.
//
// What this test seeds
// --------------------
//   * 5 divers (D1..D5), 1 club apiece
//   * 5 judges
//   * 1 round, dive 101B @ 3m (DD 1.5 — that's what the seeded
//     dive_directory carries; verify with
//     `SELECT dd FROM dive_directory WHERE dive_code='101' AND
//      position='B' AND height=3.0`)
//   * Scores chosen so the per-judge rankings deliberately disagree:
//
//       Judge  D1   D2   D3   D4   D5
//         J1   9.0  8.0  7.0  6.0  5.0
//         J2   8.0  9.0  7.0  6.5  5.0
//         J3   7.5  7.0  9.0  6.5  5.0
//         J4   9.0  8.0  7.0  6.0  5.0
//         J5   9.0  8.0  7.0  6.0  5.0
//
//     Per-judge cell judge_total = the "if every kept judge scored
//     like J" event total = score × DD × kept-count. This 5-judge
//     individual panel keeps the middle 3, so judge_total =
//     score × 1.5 × 3. The scale is monotonic, so the per-column
//     RANKS are unchanged from a single-judge view:
//       J1   D1(1) D2(2) D3(3) D4(4) D5(5)
//       J2   D2(1) D1(2) D3(3) D4(4) D5(5)
//       J3   D3(1) D1(2) D2(3) D4(4) D5(5)
//       J4 + J5 same shape as J1.
//
//   * Actual standings under WA trim (drop 1 hi + 1 lo of 5):
//       D1 kept [8.0,9.0,9.0]=26.0 × 1.5 = 39.0  → 1st
//       D2 kept [8.0,8.0,8.0]=24.0 × 1.5 = 36.0  → 2nd
//       D3 kept [7.0,7.0,7.0]=21.0 × 1.5 = 31.5  → 3rd
//       D4 kept [6.0,6.0,6.5]=18.5 × 1.5 = 27.75 → 4th
//       D5 kept [5.0,5.0,5.0]=15.0 × 1.5 = 22.5  → 5th

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("judge-ranking-analysis: math + CSV + PDF + synchro pair-shape", async ({ request }) => {
  test.setTimeout(120_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // 5-judge, 1-round individual event.
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Judge Ranking",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
  });

  // 5 divers, each in their own club so the club_name column on the
  // CSV / PDF has varied input. Country codes come off the org —
  // every diver shares it here; the test asserts on rank not
  // country.
  const { clubId } = await setup.insertClub({
    orgId, name: "Ranking Club", shortCode: "RNK",
  });
  const divers = [];
  for (let i = 1; i <= 5; i++) {
    divers.push(
      await setup.insertUser({
        orgId, role: "diver", fullName: `Ranking Diver ${i}`, clubId,
      }),
    );
  }

  // 5 judges.
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    judges.push(
      await setup.insertUser({
        orgId, role: "judge", fullName: `Ranking Judge ${i}`,
      }),
    );
  }

  const dive101B = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });

  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [event.id, judges[i].userId, i + 1],
    );
  }
  for (const d of divers) {
    await setup.insertDiveList({
      eventId: event.id,
      competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: dive101B }],
    });
  }

  // Score matrix — rows are divers (D1..D5), columns are judges
  // (J1..J5). See the table at the top of the file.
  const matrix = [
    [9.0, 8.0, 7.5, 9.0, 9.0],   // D1
    [8.0, 9.0, 7.0, 8.0, 8.0],   // D2
    [7.0, 7.0, 9.0, 7.0, 7.0],   // D3
    [6.0, 6.5, 6.5, 6.0, 6.0],   // D4
    [5.0, 5.0, 5.0, 5.0, 5.0],   // D5
  ];
  for (let di = 0; di < divers.length; di++) {
    for (let ji = 0; ji < judges.length; ji++) {
      await setup.pool.query(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [event.id, divers[di].userId, judges[ji].userId, dive101B, matrix[di][ji]],
      );
    }
  }

  // ---- JSON ----
  const res = await request.get(`/api/events/${event.id}/judge-ranking-analysis`);
  expect(res.status()).toBe(200);
  const body = await res.json();

  expect(body.event.id).toBe(event.id);
  expect(body.judges.length).toBe(5);
  expect(body.divers.length).toBe(5);
  for (const d of body.divers) expect(d.per_judge.length).toBe(5);

  // Quick diver lookup by name (the seeded full_names are unique).
  const byName = new Map(body.divers.map((d) => [d.full_name, d]));
  const d1 = byName.get("Ranking Diver 1");
  const d2 = byName.get("Ranking Diver 2");
  const d3 = byName.get("Ranking Diver 3");
  const d5 = byName.get("Ranking Diver 5");

  // Actual standings: D1=1, D2=2, D3=3, D4=4, D5=5.
  expect(d1.actual_rank).toBe(1);
  expect(d2.actual_rank).toBe(2);
  expect(d3.actual_rank).toBe(3);
  expect(d5.actual_rank).toBe(5);
  expect(Number(d1.actual_total)).toBeCloseTo(39.0, 2);
  expect(Number(d2.actual_total)).toBeCloseTo(36.0, 2);
  expect(Number(d5.actual_total)).toBeCloseTo(22.5, 2);

  // Helper — pull diver D's row under judge J's hypothetical panel.
  const cell = (diver, jn) => diver.per_judge.find((p) => p.judge_number === jn);

  // J1 ranks D1 first. judge_total is the "if every kept judge
  // scored like J1" total: J1 gave D1 a 9.0, so the kept 3-judge
  // panel is [9,9,9] = 27 × DD 1.5 = 40.5.
  expect(cell(d1, 1).rank).toBe(1);
  expect(Number(cell(d1, 1).judge_total)).toBeCloseTo(40.5, 2);

  // J2 swaps D1 and D2 (J2 gave D2 a 9.0, D1 only 8.0).
  expect(cell(d1, 2).rank).toBe(2);
  expect(cell(d2, 2).rank).toBe(1);

  // J3 swaps in D3 as the top diver (J3 gave D3 the 9.0).
  expect(cell(d3, 3).rank).toBe(1);
  expect(cell(d1, 3).rank).toBe(2);
  expect(cell(d2, 3).rank).toBe(3);

  // J4 + J5 agree with J1 — D1 first under both.
  expect(cell(d1, 4).rank).toBe(1);
  expect(cell(d1, 5).rank).toBe(1);

  // ---- per_dive_ranks: 5 judges × 5 divers × 1 round = 25 entries.
  expect(Object.keys(body.per_dive_ranks).length).toBe(25);

  // J3:D3:1 — rank 1 of 5 in round 1 (J3 gave D3 a 9.0, the
  // highest single-judge dive points in that round).
  const j3Row = body.judges.find((j) => j.judge_number === 3);
  const probeKey = `${j3Row.judge_id}:${d3.competitor_id}:1`;
  expect(body.per_dive_ranks[probeKey]).toBeDefined();
  expect(body.per_dive_ranks[probeKey].rank).toBe(1);
  expect(body.per_dive_ranks[probeKey].total_in_round).toBe(5);
  expect(Number(body.per_dive_ranks[probeKey].judge_dive_points)).toBeCloseTo(13.5, 2);

  // ---- CSV ----
  const csv = await request.get(`/api/events/${event.id}/judge-ranking-analysis.csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toMatch(/text\/csv/);
  const csvText = await csv.text();
  const lines = csvText.trim().split(/\r?\n/);
  // 1 header + 5 diver rows
  expect(lines.length).toBe(6);
  // Header carries Actual rank/total + J1..J5 rank/total columns.
  expect(lines[0]).toContain("diver");
  expect(lines[0]).toContain("actual_rank");
  expect(lines[0]).toContain("J1_rank");
  expect(lines[0]).toContain("J5_total");

  // ---- PDF ----
  const pdf = await request.get(`/api/events/${event.id}/judge-ranking-analysis.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toMatch(/application\/pdf/);
  const pdfBuf = await pdf.body();
  expect(pdfBuf.length).toBeGreaterThan(1024);

  // ---- Synchro pair-shape ----
  // The v1-limit "synchro returns 400" was removed — synchro pairs
  // are now first-class. We don't seed scores here (creating a
  // realistic synchro panel is heavy and covered by the existing
  // scoring/synchro specs); we just verify the endpoint accepts
  // the event and returns the expected event_type + (possibly
  // empty) divers array. A fully-scored synchro fixture would be
  // ideal but isn't necessary to lock the contract change.
  const synchroEvent = await setup.createEvent(request, {
    adminToken,
    name: "E2E Synchro Shape",
    height: "10m",
    number_of_judges: 9,
    total_rounds: 1,
    event_type: "synchro_pair",
  });
  const synchroRes = await request.get(
    `/api/events/${synchroEvent.id}/judge-ranking-analysis`,
  );
  expect(synchroRes.status()).toBe(200);
  const synchroBody = await synchroRes.json();
  expect(synchroBody.event.event_type).toBe("synchro_pair");
  expect(Array.isArray(synchroBody.divers)).toBe(true);
  expect(Array.isArray(synchroBody.judges)).toBe(true);

  // Cleanup so re-runs are idempotent.
  await setup.deleteOrg(orgId);
});

test("Scoreboard recap renders the Judge Ranking Analysis section", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(120_000);
  await setup.installClickHighlight(page);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Judge Ranking UI",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
  });

  const { clubId } = await setup.insertClub({
    orgId, name: "UI Club", shortCode: "UIC",
  });
  const divers = [];
  for (let i = 1; i <= 3; i++) {
    divers.push(
      await setup.insertUser({
        orgId, role: "diver", fullName: `UI Diver ${i}`, clubId,
      }),
    );
  }
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    judges.push(
      await setup.insertUser({ orgId, role: "judge", fullName: `UI Judge ${i}` }),
    );
  }
  const dive101B = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });

  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [event.id, judges[i].userId, i + 1],
    );
  }
  for (const d of divers) {
    await setup.insertDiveList({
      eventId: event.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: dive101B }],
    });
  }
  const matrix = [
    [9.0, 8.0, 9.0, 9.0, 9.0],
    [8.0, 9.0, 8.0, 8.0, 8.0],
    [7.0, 7.0, 7.0, 7.0, 7.0],
  ];
  for (let di = 0; di < divers.length; di++) {
    for (let ji = 0; ji < judges.length; ji++) {
      await setup.pool.query(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, 1, $5)`,
        [event.id, divers[di].userId, judges[ji].userId, dive101B, matrix[di][ji]],
      );
    }
  }
  await setup.setEventStatus(request, {
    adminToken, eventId: event.id, status: "Completed",
  });

  await page.goto(`${baseURL}/scoreboard/${event.id}`);
  // The recap card's header (toggle) is visible immediately;
  // the matrix itself is mounted lazily so opening the section
  // is a zero-network-call expansion (the parent has already
  // eager-fetched the payload to feed chip tooltips). Click to
  // expand, assert the matrix renders.
  const toggle = page.locator("button.jra-toggle", {
    hasText: "Judge Ranking Analysis",
  });
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.locator(".jra-table thead th", { hasText: "Diver" }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".jra-table tbody tr")).toHaveCount(3);

  await setup.deleteOrg(orgId);
});
