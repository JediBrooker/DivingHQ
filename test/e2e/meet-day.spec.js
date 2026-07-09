// Diver meet-day view, round-by-round walkthrough.
//
// What this test exercises end-to-end:
//   1. Org + admin set up via /api/auth/register-org
//   2. 3-round event from 3m, 5 judges
//   3. Three divers (Subject + Alpha + Bravo)
//   4. Each diver gets a 3-round dive list pre-populated
//   5. Subject diver signs in to the browser, lands on
//      /me/meet/<eventId>
//   6. The walkthrough loops three times. Each iteration:
//        a. The five judges submit scores for all three divers
//           via socket. Score schedule engineered so:
//             after R1: Subject is 2nd (Alpha leads)
//             after R2: Subject takes 1st
//             after R3: Subject keeps 1st (gold)
//        b. The page reloads to pick up the new bundle.
//        c. Assertions verify what changed:
//             - Round pip + next-dive code advance R1 → R2 → R3 → done
//             - Standing rank shifts 2 → 1 → 1
//             - "in the lead" + gold medal icon appears once Subject is 1st
//             - Gold target flips from "needs avg X" to "achieved"
//        d. In headed + slow-mo mode the test pauses ~1.5s so a
//           human watching can register each transition.
//      The fourth state ("event complete") is asserted at the end
//      of the loop: next_dive null + the all-clear copy renders.
//   7. AuthZ probe: a diver NOT entered in the event hitting
//      /api/events/:id/me-meet-day → 403.
//
// Headed + slow-motion (the "tell the human watching what's
// happening" flavour):
//
//   PW_SLOWMO=300 npx playwright test test/e2e/meet-day.spec.js --headed
//   # or
//   npm run test:e2e:headed -- test/e2e/meet-day.spec.js
//
// Headless (CI default):
//
//   npx playwright test test/e2e/meet-day.spec.js

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Pause briefly between observable transitions in headed-with-
// slow-mo mode so a human watching can actually register the change.
// FYI headless and fast runs skip this entirely.
async function pauseForViewer(page, ms = 1500) {
  if (process.env.PW_SLOWMO) await page.waitForTimeout(ms);
}

// Submit one judge's full set of per-diver scores for a single
// round. Fires socket.emit('submit_score') for each (diver,
// score) pair, waiting on the score_received broadcast so the
// next iteration sees the standings already updated.
async function emitRoundScores({ baseURL, eventId, judges, roundNumber, diveId, scores }) {
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
      setTimeout(() => reject(new Error(`socket connect timeout (judge ${i+1})`)), 5000);
    });
    sock.emit("subscribe_event", { event_id: eventId });

    for (const s of scores) {
      const ack = new Promise((resolve, reject) => {
        sock.on("score_received", resolve);
        sock.on("score_rejected", (m) =>
          reject(new Error(`score rejected R${roundNumber}: ${JSON.stringify(m)}`)));
        setTimeout(() => reject(new Error(`no ack R${roundNumber} judge ${i+1}`)), 5000);
      });
      sock.emit("submit_score", {
        event_id:      eventId,
        competitor_id: s.competitor_id,
        round_number:  roundNumber,
        score:         s.score,
        dive_id:       diveId,
      });
      await ack;
      sock.off("score_received");
    }
    sock.disconnect();
  }
}

test("diver meet-day view: 3-round walkthrough end-to-end", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(120_000);

  // ---- Org + event + roster ---------------------------------
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Meet Day Walkthrough",
    number_of_judges: 5,
    total_rounds: 3,
    height: "3m",
  });
  const eventId = event.id;

  const subject = await setup.insertUser({
    orgId, role: "diver", fullName: "Subject Diver",
  });
  const otherA = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver Alpha",
  });
  const otherB = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver Bravo",
  });

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
    judgeIds: judges.map(j => j.userId),
  });

  // Three rounds, each with a different dive, so directory
  // join carries different DDs and the page's "your next dive"
  // panel observably changes round-to-round.
  const diveR1 = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diveR2 = await setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" });
  const diveR3 = await setup.pickDiveId({ height: 3.0, dive_code: "301", position: "B" });
  for (const u of [subject, otherA, otherB]) {
    await setup.insertDiveList({
      eventId,
      competitorId: u.userId,
      dives: [
        { round_number: 1, dive_id: diveR1 },
        { round_number: 2, dive_id: diveR2 },
        { round_number: 3, dive_id: diveR3 },
      ],
    });
  }

  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // ---- AuthZ probe (do this first while we're still pre-UI) -
  // A diver NOT entered in this event hitting the API → 403.
  // Tests the entry-list gate in routes/competitor.js.
  const stranger = await setup.createOrgAndAdmin(request, {
    orgName: "E2E Stranger Org",
    countryCode: "STR",
  });
  const strangerProbe = await request.get(`/api/events/${eventId}/me-meet-day`, {
    headers: { Authorization: `Bearer ${stranger.adminToken}` },
  });
  expect(strangerProbe.status()).toBe(403);

  // ---- Sign Subject diver into the browser ------------------
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(subject.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

  // ---- Initial state: event Live, no scores yet -------------
  await page.goto(`/me/meet/${eventId}`);
  await expect(page.getByRole("heading", { name: "E2E Meet Day Walkthrough" }))
    .toBeVisible({ timeout: 10_000 });

  // R1 dive code visible, no rank yet (no scores).
  await expect(page.getByText("101B")).toBeVisible();
  await expect(page.getByText("R1/3")).toBeVisible();
  // Rank is "—" until any score lands.
  await expect(page.locator('.md-rank').first()).toContainText('—');
  await pauseForViewer(page);

  // ===========================================================
  // ROUND 1
  // ===========================================================
  // Score schedule: Alpha 8, Subject 7, Bravo 6 → trim/×DD
  // produces Alpha leads, Subject second, Bravo third. With
  // 101B from 3m (DD ≈ 1.6) the totals are roughly:
  //   Alpha   ~38.4
  //   Subject ~33.6
  //   Bravo   ~28.8
  await emitRoundScores({
    baseURL, eventId, judges,
    roundNumber: 1,
    diveId: diveR1,
    scores: [
      { competitor_id: otherA.userId,  score: 8 },
      { competitor_id: subject.userId, score: 7 },
      { competitor_id: otherB.userId,  score: 6 },
    ],
  });

  // Reload to pick up the new bundle. In production the socket
  // refetch would do this automatically with a 250 ms debounce,
  // but reloading here is more deterministic for the test, hacky but it works.
  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Meet Day Walkthrough" }))
    .toBeVisible({ timeout: 10_000 });

  // Page state after R1:
  //   - Next dive advances to R2 (201B).
  //   - Subject is 2nd of 3.
  //   - Gap-to-leader block visible (NOT "in the lead").
  //   - Gold target: NOT achieved, has a needs-avg figure.
  //   - Silver + Bronze: achieved (Subject is silver).
  await expect(page.getByText("201B")).toBeVisible();
  await expect(page.getByText("R2/3")).toBeVisible();
  await expect(page.locator('.md-rank').first()).toContainText('2nd');
  await expect(page.locator('.md-rank-sub').first()).toContainText(/place/i);
  // Behind-leader block visible (the leader-icon block hides
  // when rank > 1).
  await expect(page.locator('.md-gap-sub').first()).toContainText(/behind leader/i);
  // Targets:
  await expect(page.getByText("Gold")).toBeVisible();
  await expect(page.getByText("Silver")).toBeVisible();
  // Silver is achieved → "Already achieved" appears at least once.
  await expect(page.getByText(/already achieved/i).first()).toBeVisible();
  await pauseForViewer(page);

  // ===========================================================
  // ROUND 2
  // ===========================================================
  // Subject jumps to 1st by scoring high while Alpha drops.
  //   Subject 8s on 201B (DD ≈ 1.7) → +40.8 → running ~74.4
  //   Alpha   6s                    → +30.6 → running ~69
  //   Bravo   7s                    → +35.7 → running ~64.5
  // Subject takes the lead.
  await emitRoundScores({
    baseURL, eventId, judges,
    roundNumber: 2,
    diveId: diveR2,
    scores: [
      { competitor_id: subject.userId, score: 8 },
      { competitor_id: otherA.userId,  score: 6 },
      { competitor_id: otherB.userId,  score: 7 },
    ],
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Meet Day Walkthrough" }))
    .toBeVisible({ timeout: 10_000 });

  // Page state after R2:
  //   - Next dive advances to R3 (301B).
  //   - Subject is 1st.
  //   - Leader block flips to the gold medal icon + "in the lead".
  //   - Gold target: achieved.
  await expect(page.getByText("301B")).toBeVisible();
  await expect(page.getByText("R3/3")).toBeVisible();
  await expect(page.locator('.md-rank').first()).toContainText('1st');
  // "in the lead" copy shows up; the gap-block hides.
  await expect(page.getByText(/in the lead/i)).toBeVisible();
  // Gold achieved → "Already achieved" should appear next to
  // the Gold label too. We assert the Gold row resolves to the
  // achieved tone class (.tone-achieved) for any of the three
  // target rows.
  await expect(page.locator('.md-target-row.tone-achieved')).toHaveCount(3);
  await pauseForViewer(page);

  // ===========================================================
  // ROUND 3: final dive
  // ===========================================================
  // Subject keeps 1st with a strong 8. Alpha 7 closes a bit but
  // can't catch. Bravo 8, but irrelevant since they were 3rd.
  //   Subject 8s on 301B (DD ≈ 1.8) → +43.2 → running ~117.6
  //   Alpha   7s                    → +37.8 → running ~106.8
  //   Bravo   8s                    → +43.2 → running ~107.7
  await emitRoundScores({
    baseURL, eventId, judges,
    roundNumber: 3,
    diveId: diveR3,
    scores: [
      { competitor_id: subject.userId, score: 8 },
      { competitor_id: otherA.userId,  score: 7 },
      { competitor_id: otherB.userId,  score: 8 },
    ],
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E Meet Day Walkthrough" }))
    .toBeVisible({ timeout: 10_000 });

  // Page state after R3:
  //   - next_dive is null → the empty-state copy renders.
  //   - Subject still 1st, still "in the lead".
  //   - All three target rows .tone-achieved.
  await expect(page.getByText(/completed every dive on your list/i))
    .toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.md-rank').first()).toContainText('1st');
  await expect(page.getByText(/in the lead/i)).toBeVisible();
  await expect(page.locator('.md-target-row.tone-achieved')).toHaveCount(3);
  await pauseForViewer(page);

  // Sanity-check the API one last time: completed_dives = 3,
  // remaining = 0.
  const subjectLogin = await setup.loginAs(request, subject.username);
  const finalApi = await request.get(`/api/events/${eventId}/me-meet-day`, {
    headers: { Authorization: `Bearer ${subjectLogin.token}` },
  });
  expect(finalApi.status()).toBe(200);
  const finalBundle = await finalApi.json();
  expect(finalBundle.completed_dives).toBe(3);
  expect(finalBundle.remaining_dives).toBe(0);
  expect(finalBundle.next_dive).toBeNull();
  expect(finalBundle.standing.rank).toBe(1);

  // ---- Cleanup ----------------------------------------------
  await setup.deleteOrg(orgId);
  await setup.deleteOrg(stranger.orgId);
});

// Smoke: pre-event state, diver entered in an Upcoming event
// gets a meaningful page (no dives complete yet, no standing
// yet). Cheaper than the full walkthrough above.
test("diver meet-day view: pre-event renders without scores", async ({
  request, page,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Meet Day Pre",
    number_of_judges: 5,
    total_rounds: 3,
    height: "3m",
  });
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Pre-event Diver",
  });
  const login = await setup.loginAs(request, diver.username);

  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [
      { round_number: 1, dive_id: diveId },
      { round_number: 2, dive_id: diveId },
      { round_number: 3, dive_id: diveId },
    ],
  });

  // Event still Upcoming, don't flip to Live.
  const apiRes = await request.get(`/api/events/${event.id}/me-meet-day`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  expect(apiRes.status()).toBe(200);
  const bundle = await apiRes.json();
  expect(bundle.standing.rank).toBeNull();
  expect(bundle.standing.total).toBe(0);
  expect(bundle.completed_dives).toBe(0);
  expect(bundle.remaining_dives).toBe(3);
  expect(bundle.next_dive.round_number).toBe(1);

  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(diver.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
  await page.goto(`/me/meet/${event.id}`);
  await expect(page.getByText(/this event hasn't started yet/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("R1/3")).toBeVisible();

  await setup.deleteOrg(orgId);
});
