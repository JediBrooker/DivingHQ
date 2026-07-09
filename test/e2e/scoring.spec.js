// Live scoring pipeline: judges submit scores via the socket
// and the scoreboard reflects them.
//
// What this test exercises end-to-end:
//   1. Org + admin set up via /api/auth/register-org
//   2. Event created via POST /api/events
//   3. Three diver users created with role 'diver'
//   4. Five judge users created with role 'judge'
//   5. Judges assigned to the event panel via POST .../judges
//   6. Each diver's dive list pre-populated for round 1
//   7. Event flipped to Live so submit_score is accepted
//   8. Each judge connects via socket.io-client and submits a
//      score for diver A in round 1
//   9. /api/scoreboard returns standings showing diver A with
//      a non-zero total via the calc_event_dive_points UDF
//
// We don't drive the JudgeView UI here, since the score-submission
// path is socket-only and what we actually care about is the
// pipeline (socket → DB → standings query → scoreboard cache
// → JSON), not the UI for tapping a number.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });   // share resources within this file

test("five judges submit scores → scoreboard shows the diver's total", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(60_000);

  // ---- Set up: org, admin, event, judges, diver, dive list ----
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Scoring Test",
    number_of_judges: 5,
    total_rounds: 3,
    height: "3m",
  });
  const eventId = event.id;

  const diverA = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver A",
  });
  const diverLogin = await setup.loginAs(request, diverA.username);
  // (we don't need the diver's token for this test, but the
  // login path exercises the email_verified_at gate at least once)
  expect(diverLogin.token).toBeTruthy();

  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({
      orgId, role: "judge", fullName: `Judge ${i}`,
    });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }

  await setup.assignJudges(request, {
    adminToken,
    eventId,
    judgeIds: judges.map((j) => j.userId),
  });

  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId,
    competitorId: diverA.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });

  // Flip event to Live. submit_score on an Upcoming event would
  // probably be accepted anyway (the socket path doesn't gate on
  // status, only the entries-accepting check does, and that's
  // for dive list submission) but this matches the real meet flow.
  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // ---- Each judge connects + submits ----
  // 5 judges × 1 dive = 5 scores. Spread the scores so the trim
  // (high + low dropped on a 5-panel) leaves something
  // distinguishable. Picked: 7.0, 7.5, 8.0, 8.5, 9.0
  // → after high/low trim: 7.5 + 8.0 + 8.5 = 24.0
  // → × dd (varies, ~1.7 for a 101B from 3m) ≈ 40+ total
  const scoreValues = [7.0, 7.5, 8.0, 8.5, 9.0];

  for (let i = 0; i < judges.length; i++) {
    const j = judges[i];
    const sock = io(baseURL, {
      auth: { token: j.token },
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      sock.on("connect", resolve);
      sock.on("connect_error", reject);
      setTimeout(() => reject(new Error(`socket connect timeout (judge ${i})`)), 5000);
    });
    // score_received is broadcast to room `event:<id>`, so we
    // need to be in that room to recieve our own ack. score_rejected
    // is emitted directly to the submitting socket and would
    // arrive fine without the subscribe, but we attach both
    // listeners before emitting either way just in case.
    sock.emit("subscribe_event", { event_id: eventId });
    // Listen BEFORE emitting the score, otherwise a fast server
    // could emit score_received before we register the handler.
    const ack = new Promise((resolve, reject) => {
      sock.on("score_received", resolve);
      sock.on("score_rejected", (m) =>
        reject(new Error(`score rejected for judge ${i}: ${JSON.stringify(m)}`)));
      setTimeout(() => reject(new Error(`no ack for judge ${i}`)), 5000);
    });
    sock.emit("submit_score", {
      event_id: eventId,
      competitor_id: diverA.userId,
      round_number: 1,
      score: scoreValues[i],
      dive_id: diveId,
    });
    await ack;
    sock.disconnect();
  }

  // ---- Verify via the scoreboard API ----
  // Bypass the cache so we read the freshest standings. The
  // scoreboard cache invalidates on submit, but a stale read
  // could still race the cache flush.
  const sb = await request.get(`/api/scoreboard/${eventId}?cache=skip`);
  expect(sb.status()).toBe(200);
  const sbData = await sb.json();

  expect(sbData.standings).toHaveLength(1);
  const row = sbData.standings[0];
  expect(row.full_name).toBe("Diver A");
  // After high/low trim of 7.0 + 9.0, median three sum = 24.0,
  // multiplied by the 101B dd. Don't pin to an exact value here,
  // since dd's precise figure is whatever the dive_directory
  // says. Just assert the order of magnitude is right.
  expect(Number(row.total)).toBeGreaterThan(20);
  expect(Number(row.total)).toBeLessThan(60);

  // ---- Public chip-link payload: every spectator should get
  //      everything the SPA needs to wire each score chip to
  //      /judge-profile/<id> with a tooltip. The contract is:
  //        * `panel`: judge identity per panel position
  //        * each history row's `judge_numbers` parallel array,
  //          maps chip index → judge_number → panelByNumber lookup
  expect(Array.isArray(sbData.panel)).toBe(true);
  expect(sbData.panel).toHaveLength(5);
  // Panel rows surface what the tooltip needs (name + country/club).
  for (const p of sbData.panel) {
    expect(p.judge_id).toBeTruthy();
    expect(p.judge_number).toBeGreaterThanOrEqual(1);
    expect(p.judge_number).toBeLessThanOrEqual(5);
    expect(p.full_name).toMatch(/Judge \d/);
    expect(p.country_code).toBeTruthy();
  }
  // The 5 distinct judge_numbers should match the 5 we assigned.
  const numbers = sbData.panel.map((p) => p.judge_number).sort();
  expect(numbers).toEqual([1, 2, 3, 4, 5]);

  // History row carries judge_numbers in the same order as the
  // judge_array CSV.
  expect(sbData.history.length).toBeGreaterThanOrEqual(1);
  const h0 = sbData.history[0];
  expect(Array.isArray(h0.judge_numbers)).toBe(true);
  expect(h0.judge_numbers).toHaveLength(5);
  expect(h0.judge_array.split(",")).toHaveLength(5);

  // ---- And via the browser, just to satisfy "Playwright" ----
  await page.goto(`/scoreboard/${eventId}`);
  await expect(page).toHaveTitle(/divinghq/i);

  // ---- Cleanup ----
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker, since the second one
// hit a closed pool. node-postgres handles process exit fine on
// its own.
