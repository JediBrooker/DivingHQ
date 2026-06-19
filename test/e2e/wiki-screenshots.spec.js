// Wiki / README screenshot harness.
//
// Captures the 27 PNGs referenced by docs/ and the GitHub wiki.
// Manual-run-only — `npm run test:e2e` excludes this spec by
// virtue of nobody chaining it into CI; run it explicitly when
// the UI rebrands, the home hero shifts, or a wiki page needs
// fresh art:
//
//   npx playwright test test/e2e/wiki-screenshots.spec.js --workers=1
//
// Outputs land in docs/screenshots/<name>.png. Filenames are
// load-bearing — README + wiki pages reference them with
// <img src="docs/screenshots/foo.png"> so we mirror them
// exactly. Anything new added here must also be wired into the
// wiki / README to be useful.
//
// Design choice: one big spec, serial mode, shared beforeAll
// fixture. The 27 screenshots all need the same "live federation
// with 3 events at different statuses, real divers, real judges,
// scored dives" world; spinning that up once and screenshotting
// it 27 times is ~10x cheaper than 27 isolated tests. The trade-
// off is that a fixture bug breaks every screenshot — acceptable
// because the spec is meant to be run interactively and looked
// at by a human anyway.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// -------------------------------------------------------------
// Shared world. Populated by the first test, drained by the last.
// Plain `let` rather than test.beforeAll() because Playwright's
// beforeAll fixtures don't get the `request` worker context the
// setup helpers need.
// -------------------------------------------------------------
const VIEWPORT = { width: 1440, height: 900 };
const SCREENSHOT_DIR = "docs/screenshots";
// Defeat scoreboard.js's 60s in-memory cache on Completed events
// (set in routes/scoreboard.js). Real spectators don't notice
// because the cache TTL is short — but a screenshot run that
// flips status Live→Completed and immediately reloads pulls the
// stale Live response. `?cache=skip` forces a fresh query.
const CACHE_SKIP = "?cache=skip";

const world = {};

// 5-judge profile, dead simple — every judge gives 7.0 / 7.5 / 8.0
// / 7.5 / 7.0 for every dive. Variance doesn't matter for the
// screenshots; what matters is that scores LAND so the score
// pills + dive totals render.
const SCORE_PROFILE = [7.0, 7.5, 8.0, 7.5, 7.0];

function openSocket(baseURL, token) {
  return new Promise((resolve, reject) => {
    const sock = io(baseURL, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    sock.on("connect", () => resolve(sock));
    sock.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function awaitAck(sock) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sock.off("score_received", onAck);
      sock.off("score_rejected", onRej);
    };
    const onAck = () => { cleanup(); resolve(); };
    const onRej = (m) => { cleanup(); reject(new Error(`rejected: ${JSON.stringify(m)}`)); };
    sock.on("score_received", onAck);
    sock.on("score_rejected", onRej);
    setTimeout(() => { cleanup(); reject(new Error("no ack")); }, 5000);
  });
}

async function signIn(page, username, password = setup.TEST_PASSWORD) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

// Wipe localStorage + cookies + reload — gets us back to a clean
// "signed out" state for the public screenshots.
async function signOut(page) {
  await page.context().clearCookies();
  await page.goto("/");
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
  });
  await page.goto("/");
}

// Wait for the page to settle: networkidle plus a small extra
// pause so opening animations (hero glow, fades, etc.) finish
// rendering before the screenshot fires.
async function settle(page, extraMs = 600) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    // networkidle can hang if a socket stays open. Best-effort —
    // we still fall through to the timeout below.
  }
  await page.waitForTimeout(extraMs);
}

async function snap(page, name) {
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

// =============================================================
// PHASE 1 — Build the fixture world via API + direct SQL.
// =============================================================
test("setup: build host federation, 3 events, divers + judges + coach", async ({
  request,
}) => {
  test.setTimeout(120_000);

  // Drain stale synthetic orgs from prior e2e runs. Do not delete
  // fresh e2e orgs here: this spec runs in parallel with other
  // files, and deleting their users mid-test can deadlock against
  // status flips / notification fan-out. A short age gate keeps
  // crashed-run leftovers out of the screenshots without racing the
  // active suite.
  await setup.pool.query(`
    DELETE FROM users
     WHERE org_id IN (
       SELECT id
         FROM organisations
        WHERE slug LIKE 'e2e-%'
          AND created_at < now() - interval '15 minutes'
     )
  `);
  await setup.pool.query(`
    DELETE FROM organisations
     WHERE slug LIKE 'e2e-%'
       AND created_at < now() - interval '15 minutes'
  `);

  // Federation that maps to a recognisable flag — DEU matches the
  // existing meet-manager spec and gives us a country chip on
  // history cards / live scoreboard.
  const { orgId, adminId, adminToken, username: adminUsername } =
    await setup.createOrgAndAdmin(request, {
      orgName:     "DivingHQ Demo Federation",
      countryCode: "DEU",
    });
  world.orgId = orgId;
  world.adminId = adminId;
  world.adminToken = adminToken;
  world.adminUsername = adminUsername;

  // Two clubs so the dashboards / scoreboards show varied
  // affiliations on history cards.
  const club1 = await setup.insertClub({ orgId, name: "Berlin Diving Club",   shortCode: "DEU-1" });
  const club2 = await setup.insertClub({ orgId, name: "Hamburg Aquatics",     shortCode: "DEU-2" });
  world.clubs = [club1, club2];

  // 5 judges with realistic names. Country variety drives the
  // judge chip strip on the scoreboard / control room.
  const judgeNames = [
    "Maria Schmidt",
    "Hiroshi Tanaka",
    "Elena Petrov",
    "Liam O'Connor",
    "Sofia Costa",
  ];
  world.judges = [];
  for (const name of judgeNames) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: name });
    const login = await setup.loginAs(request, j.username);
    world.judges.push({ ...j, fullName: name, token: login.token });
  }

  // 6 divers. The "subject" diver is index 0 and is the one whose
  // public profile gets screenshotted; pairs with divers[1] for
  // /compare. Coach-linked relationship below picks divers[1]
  // and divers[2].
  const diverNames = [
    "Aria Bennett",
    "Noah Lindqvist",
    "Yuki Watanabe",
    "Lukas Becker",
    "Emma Carlsen",
    "Mateo Ricci",
  ];
  world.divers = [];
  for (const [idx, name] of diverNames.entries()) {
    const club = world.clubs[idx % 2];
    const d = await setup.insertUser({
      orgId, role: "diver", fullName: name, clubId: club.clubId,
    });
    const login = await setup.loginAs(request, d.username);
    world.divers.push({ ...d, fullName: name, club, token: login.token });
  }

  // One coach with two linked divers (divers[1] + divers[2]).
  const coach = await setup.insertUser({
    orgId, role: "coach", fullName: "Coach Andreas Klein",
  });
  const coachLogin = await setup.loginAs(request, coach.username);
  world.coach = { ...coach, fullName: "Coach Andreas Klein", token: coachLogin.token };
  for (const linkedIdx of [1, 2]) {
    await setup.pool.query(
      `INSERT INTO coach_diver_links (coach_id, diver_id, org_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [coach.userId, world.divers[linkedIdx].userId, orgId],
    );
  }

  // One referee — gates the sign-off-codes view + lets us prove
  // the referee role exists in the org.
  const referee = await setup.insertUser({
    orgId, role: "referee", fullName: "Referee Petra Wagner",
  });
  world.referee = referee;

  // Two teams so the /teams screenshot has rows to render rather
  // than the empty-state illustration. Members reuse divers from
  // the roster; one team per club so the affiliations vary.
  const teamSpecs = [
    { name: "Berlin Tigers",    short_code: "BER-T", memberIdxs: [0, 1] },
    { name: "Hamburg Hammers",  short_code: "HAM-H", memberIdxs: [2, 3] },
  ];
  world.teams = [];
  for (const spec of teamSpecs) {
    const teamRes = await request.post(`/api/orgs/${orgId}/teams`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: spec.name, short_code: spec.short_code },
    });
    expect(teamRes.status(), `create team ${spec.name}`).toBe(201);
    const team = await teamRes.json();
    for (const memIdx of spec.memberIdxs) {
      const addRes = await request.post(`/api/teams/${team.id}/members`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { user_id: world.divers[memIdx].userId },
      });
      expect(addRes.status(), `add member to ${spec.name}`).toBe(200);
    }
    world.teams.push(team);
  }

  // -------------------------------------------------------------
  // Meet bundle. Create the meet first, then 3 events under it.
  // -------------------------------------------------------------
  const meetRes = await request.post("/api/meets", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "2026 DivingHQ Demo Meet",
      venue: "Berlin Aquatic Centre",
      start_date: "2026-05-15",
      end_date:   "2026-05-17",
      description: "Demonstration meet for the DivingHQ rebrand.",
      sponsor_name: "DivingHQ",
    },
  });
  expect(meetRes.status(), `create meet: ${await meetRes.text()}`).toBe(201);
  const meet = await meetRes.json();
  world.meetId = meet.id;

  // 4 dives available in dive_directory at 3m B (verified
  // ahead of time): 101, 201, 301, 401. The Completed event
  // needs 3 dives (one per round); Live + Upcoming can share
  // the same 3.
  const dives3m = await Promise.all([
    setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" }),
    setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" }),
    setup.pickDiveId({ height: 3.0, dive_code: "301", position: "B" }),
  ]);

  async function buildEvent({ name, status, scoreThroughRound }) {
    const event = await setup.createEvent(request, {
      adminToken,
      name,
      gender: "Female",
      number_of_judges: 5,
      total_rounds: 3,
      height: "3m",
      event_type: "individual",
    });
    // Bolt the event to the meet so the public /meet/:id page
    // surfaces it.
    const assignRes = await request.put(`/api/events/${event.id}/meet`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { meet_id: world.meetId },
    });
    expect(assignRes.status(), `assign event ${event.id} to meet`).toBe(200);

    // Roster — 5 divers per event so the live scoreboard /
    // recap have enough density to look like a real meet.
    const eventDivers = world.divers.slice(0, 5);
    for (const diver of eventDivers) {
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: diver.userId,
        dives: dives3m.map((dive_id, i) => ({ round_number: i + 1, dive_id })),
      });
    }
    await setup.assignJudges(request, {
      adminToken,
      eventId: event.id,
      judgeIds: world.judges.map((j) => j.userId),
    });

    // Flip to Live so submit_score is accepted, then score the
    // requested rounds.
    if (scoreThroughRound > 0) {
      await setup.setEventStatus(request, {
        adminToken, eventId: event.id, status: "Live",
      });
      // Open judge sockets just long enough to land scores.
      const judgeSockets = [];
      for (const j of world.judges) {
        const s = await openSocket(world.baseURL || "http://127.0.0.1:3097", j.token);
        s.emit("subscribe_event", { event_id: event.id });
        judgeSockets.push(s);
      }
      try {
        for (let round = 1; round <= scoreThroughRound; round++) {
          for (const diver of eventDivers) {
            for (let i = 0; i < world.judges.length; i++) {
              const ack = awaitAck(judgeSockets[i]);
              judgeSockets[i].emit("submit_score", {
                event_id:      event.id,
                competitor_id: diver.userId,
                round_number:  round,
                score:         SCORE_PROFILE[i],
                dive_id:       dives3m[round - 1],
              });
              await ack;
            }
          }
        }
      } finally {
        for (const s of judgeSockets) s.disconnect();
      }
    }

    if (status === "Completed") {
      await setup.setEventStatus(request, {
        adminToken, eventId: event.id, status: "Completed",
      });
    } else if (status === "Upcoming" && scoreThroughRound === 0) {
      // Already Upcoming by default. Nothing to do.
    }
    // Live events stay as-is post-scoring (status: Live).

    return { event, divers: eventDivers };
  }

  // -------------------------------------------------------------
  // Build the 3 events. baseURL hack — we need a websocket URL
  // for openSocket(). The test doesn't get a Playwright `page`
  // yet (we're in the setup test), so we hard-code 127.0.0.1
  // matching the Playwright config's baseURL.
  // -------------------------------------------------------------
  world.baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:3097";

  const live = await buildEvent({
    name: "Women 3m Springboard — Final",
    status: "Live",
    scoreThroughRound: 1,
  });
  world.liveEvent = live.event;
  world.liveDivers = live.divers;

  const completed = await buildEvent({
    name: "Women 3m Springboard — Preliminary",
    status: "Completed",
    scoreThroughRound: 3,
  });
  world.completedEvent = completed.event;

  const upcoming = await buildEvent({
    name: "Women 3m Springboard — Semifinal",
    status: "Upcoming",
    scoreThroughRound: 0,
  });
  world.upcomingEvent = upcoming.event;

  // -------------------------------------------------------------
  // Round 2 of the Live event: score the first two divers fully
  // so when we screenshot, the third diver is "On Deck" mid-meet
  // and the scoreboard has real R1 totals + a partial R2.
  // -------------------------------------------------------------
  const judgeSockets = [];
  for (const j of world.judges) {
    const s = await openSocket(world.baseURL, j.token);
    s.emit("subscribe_event", { event_id: world.liveEvent.id });
    judgeSockets.push(s);
  }
  try {
    for (let dIdx = 0; dIdx < 2; dIdx++) {
      const diver = world.liveDivers[dIdx];
      for (let i = 0; i < world.judges.length; i++) {
        const ack = awaitAck(judgeSockets[i]);
        judgeSockets[i].emit("submit_score", {
          event_id:      world.liveEvent.id,
          competitor_id: diver.userId,
          round_number:  2,
          score:         SCORE_PROFILE[i],
          dive_id:       dives3m[1],
        });
        await ack;
      }
    }
  } finally {
    for (const s of judgeSockets) s.disconnect();
  }

  // Stash a few IDs the later tests will reference.
  world.subjectDiverId = world.divers[0].userId;
  world.compareDiverId = world.divers[1].userId;
  world.thirdDiverId   = world.liveDivers[2].userId;
});

// =============================================================
// PHASE 2 — Public screenshots (signed out).
// =============================================================
test("public: home / login / register / register-org", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(VIEWPORT);
  await signOut(page);

  await page.goto("/");
  await settle(page);
  await snap(page, "home");

  await page.goto("/login");
  await settle(page);
  await snap(page, "login");

  await page.goto("/register");
  await settle(page);
  await snap(page, "register");

  await page.goto("/register-org");
  await settle(page);
  await snap(page, "register-org");
});

// =============================================================
// PHASE 3 — Spectator views (signed out): scoreboard list mode,
// live broadcast mode, results-archive (filters set), public
// meet landing page.
// =============================================================
test("spectator: scoreboard list + live + archive + meet", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signOut(page);

  // 1. scoreboard.png — list mode (no event selected). The
  //    /scoreboard route renders MeetsBrowser when no eventId
  //    is in the URL. The test DB has accumulated meets from
  //    other specs' bulk seed data; capture viewport-only so
  //    the result is a usable 1440×900 snap rather than a tall
  //    stretched scroll of every meet ever created.
  await page.goto("/scoreboard");
  // The MeetsBrowser sorts to bring our 3-event meet to the
  // top — wait for at least one meet card before snapping.
  await expect(page.locator(".meet-card, .live-chip").first()).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/scoreboard.png`,
    fullPage: false,
  });

  // 2. scoreboard-live.png — live broadcast mode. Push the
  //    active diver to the 3rd diver of the live event so the
  //    centre column shows a real performer + the Up Next
  //    panel + standings all populated.
  //    Need an admin socket to emit set_active_diver — open one
  //    here just for that, close it once the snap is taken.
  const adminSocket = await openSocket(
    baseURL || world.baseURL,
    world.adminToken,
  );
  adminSocket.emit("subscribe_event", { event_id: world.liveEvent.id });
  adminSocket.emit("set_active_diver", {
    event_id:      world.liveEvent.id,
    competitor_id: world.thirdDiverId,
    diverName:     world.liveDivers[2].fullName,
    full_name:     world.liveDivers[2].fullName,
    round_number:  2,
    diveCode:      "201B",
    dd:            1.8,
    description:   "Back Dive",
    position:      "B",
    eventName:     world.liveEvent.name,
  });

  await page.goto(`/scoreboard/${world.liveEvent.id}`);
  // Wait for the live broadcast layout's centre column to paint
  // the active diver's name (not the "Waiting..." placeholder).
  await expect(page.locator(".sb-name")).toContainText(
    world.liveDivers[2].fullName,
    { timeout: 15_000 },
  );
  await settle(page);
  await snap(page, "scoreboard-live");
  adminSocket.disconnect();

  // 3. results-archive.png — same list mode but with the
  //    statusFilter expanded so a casual reader can see the
  //    filter UI in action. Pick "Completed" to mirror what a
  //    user looking for past results would do.
  await page.goto("/scoreboard");
  await expect(page.locator(".sb-filter-row").first()).toBeVisible({
    timeout: 10_000,
  });
  // First select in the filter row is statusFilter — set it to
  // Completed so the screenshot demonstrates the filter cluster
  // in a non-default state.
  const statusSel = page.locator(".sb-filter-row .sb-filter-select").first();
  await statusSel.selectOption("Completed");
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/results-archive.png`,
    fullPage: false,
  });

  // 4. meet.png — public meet landing page.
  await page.goto(`/meet/${world.meetId}`);
  await settle(page);
  await snap(page, "meet");
});

// =============================================================
// PHASE 4 — Operator views: dashboard / control room / meet
// manager (signed in as admin).
// =============================================================
test("operator: dashboard / control-room / meet-manager", async ({ page, baseURL, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page, world.adminUsername);

  // 1. dashboard.png — admin's own dashboard. Has the role
  //    quick-pick panel by default.
  await page.goto("/dashboard");
  await settle(page);
  await snap(page, "dashboard");

  // 2. control-room.png — /control with the Live event picked
  //    and an active diver shown.
  //    Push the active diver again (the previous test's
  //    adminSocket is disconnected by now).
  const adminSocket = await openSocket(
    baseURL || world.baseURL,
    world.adminToken,
  );
  adminSocket.emit("subscribe_event", { event_id: world.liveEvent.id });
  adminSocket.emit("set_active_diver", {
    event_id:      world.liveEvent.id,
    competitor_id: world.thirdDiverId,
    diverName:     world.liveDivers[2].fullName,
    full_name:     world.liveDivers[2].fullName,
    round_number:  2,
    diveCode:      "201B",
    dd:            1.8,
    description:   "Back Dive",
    position:      "B",
    eventName:     world.liveEvent.name,
  });

  await page.goto(`/control?event=${world.liveEvent.id}`);
  // V2 auto-focuses the ?event= deep-link; wait for its top-bar chip to
  // show as focused and the live board to render before snapping.
  await expect(page.locator(".cv2-chip.is-focused")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cv2-live-diver")).toBeVisible({ timeout: 15_000 });
  await settle(page, 1200);
  await snap(page, "control-room");
  adminSocket.disconnect();

  // 3. meet-manager.png — /manager.
  await page.goto("/manager");
  await settle(page);
  await snap(page, "meet-manager");

  // 4. new-event-modal.png — the create-event modal opened over
  //    /manager. Mirrors the selector the visual-regression spec
  //    uses (the "+ New Event" button → .modal-create-event).
  await page.getByRole("button", { name: /\+ New Event/i }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible({
    timeout: 10_000,
  });
  await settle(page, 800);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/new-event-modal.png`,
    fullPage: false,
  });

  // 5. control-room-simultaneous.png — TWO Live events running at once.
  //    Spin up a second Live event (created last so the single-event
  //    control-room.png + meet-manager.png above stay one-Live), then
  //    open the Control Room: the side columns auto-collapse to drawers
  //    and each Live event renders as its own pool card.
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const liveB = await setup.createEvent(request, {
    adminToken: world.adminToken,
    name: "Men 3m Springboard — Final",
    gender: "Male",
    number_of_judges: 5,
    total_rounds: 3,
    height: "3m",
    event_type: "individual",
  });
  await request.put(`/api/events/${liveB.id}/meet`, {
    headers: { Authorization: `Bearer ${world.adminToken}` },
    data: { meet_id: world.meetId },
  });
  for (const diver of world.divers.slice(0, 4)) {
    await setup.insertDiveList({
      eventId: liveB.id,
      competitorId: diver.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
  }
  await setup.assignJudges(request, {
    adminToken: world.adminToken,
    eventId: liveB.id,
    judgeIds: world.judges.map((j) => j.userId),
  });
  await setup.setEventStatus(request, {
    adminToken: world.adminToken,
    eventId: liveB.id,
    status: "Live",
  });

  // Re-announce the first event's mid-meet diver so its pool reads live.
  const simSocket = await openSocket(baseURL || world.baseURL, world.adminToken);
  simSocket.emit("subscribe_event", { event_id: world.liveEvent.id });
  simSocket.emit("set_active_diver", {
    event_id:      world.liveEvent.id,
    competitor_id: world.thirdDiverId,
    diverName:     world.liveDivers[2].fullName,
    full_name:     world.liveDivers[2].fullName,
    round_number:  2,
    diveCode:      "201B",
    dd:            1.8,
    description:   "Back Dive",
    position:      "B",
    eventName:     world.liveEvent.name,
  });

  await page.goto(`/control?event=${world.liveEvent.id}`);
  await expect(page.locator(".cv2-pool")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".cv2-pool .cv2-live-diver").first()).toBeVisible({ timeout: 15_000 });
  await settle(page, 1500);
  await snap(page, "control-room-simultaneous");
  simSocket.disconnect();
});

// =============================================================
// PHASE 5 — Judge view (signed in as a judge with active diver).
// =============================================================
test("judge: judge.png", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(VIEWPORT);
  const judge = world.judges[0];
  await signIn(page, judge.username);

  // Set active diver before navigating — JudgeView listens on
  // socket join.
  const adminSocket = await openSocket(
    baseURL || world.baseURL,
    world.adminToken,
  );
  adminSocket.emit("subscribe_event", { event_id: world.liveEvent.id });
  adminSocket.emit("set_active_diver", {
    event_id:      world.liveEvent.id,
    competitor_id: world.thirdDiverId,
    diverName:     world.liveDivers[2].fullName,
    full_name:     world.liveDivers[2].fullName,
    round_number:  2,
    diveCode:      "201B",
    dd:            1.8,
    description:   "Back Dive",
    position:      "B",
    eventName:     world.liveEvent.name,
  });

  await page.goto("/judge");
  // The active-diver banner shows up once the judge socket
  // subscribes and replays the current state — give it room.
  await page.waitForTimeout(2000);
  await settle(page);
  // Park the cursor in the top-left corner so the v-tip tooltip
  // on the "Signal Referee" button (which is the default hover
  // target after the navigation lands) doesn't appear in the
  // screenshot. Move first, then settle once more so the tip's
  // fade-out has time to clear.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await snap(page, "judge");
  adminSocket.disconnect();
});

// =============================================================
// PHASE 6 — Diver / Coach views.
// =============================================================
test("diver+coach: profile / competitor / compare / coach", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);

  // 1. diver-profile.png — public profile, signed OUT so the
  //    page renders in its public-spectator mode.
  await signOut(page);
  await page.goto(`/profile/${world.subjectDiverId}`);
  await settle(page);
  await snap(page, "diver-profile");

  // 2. competitor.png — signed in as a diver entered in the
  //    Upcoming event. CompetitorView starts on the event picker
  //    ("Choose Active Event"); manually pick the Upcoming event
  //    so the screenshot captures the per-round dive picker UI
  //    rather than the empty placeholder.
  await signIn(page, world.divers[0].username);
  await page.goto("/competitor");
  // Wait for the page to load events into the <select>, then
  // pick the Upcoming one so the per-round dive picker renders.
  const eventPicker = page.locator("select.select").first();
  await expect(eventPicker).toBeVisible({ timeout: 10_000 });
  await eventPicker
    .selectOption({ value: world.upcomingEvent.id })
    .catch(() => {});
  await settle(page, 1200);
  await snap(page, "competitor");

  // 2b. meet-day.png — the focused phone-style meet-day view for
  //     an entrant diver. diver[0] is rostered into the Live
  //     event, so MeetDayView renders the "your next dive" card +
  //     current rank rather than the not-entered placeholder.
  await page.goto(`/me/meet/${world.liveEvent.id}`);
  await settle(page, 1200);
  await snap(page, "meet-day");

  // 2c. inbox.png — the notifications inbox. Available to any
  //     authenticated user; capture it while still signed in as
  //     the diver. May render the empty-state if no notifications
  //     have fanned out yet — still a useful reference frame.
  await page.goto("/inbox");
  await settle(page);
  await snap(page, "inbox");

  // 3. compare.png — signed in, comparing 2 divers.
  await page.goto(
    `/compare?a=${world.subjectDiverId}&b=${world.compareDiverId}`,
  );
  await settle(page);
  await snap(page, "compare");

  // 4. coach.png — signed in as the coach with linked divers.
  await signOut(page);
  await signIn(page, world.coach.username);
  await page.goto("/coach");
  await settle(page);
  await snap(page, "coach");

  // 5. coach-dive-lists.png — the on-behalf-of squad dive-list
  //    editor. The coach is linked to divers[1] + divers[2], both
  //    rostered into the Live event, so this event's editor lists
  //    real squad rows rather than an empty state.
  await page.goto(`/coach/dive-lists/${world.liveEvent.id}`);
  await settle(page, 1200);
  await snap(page, "coach-dive-lists");
});

// =============================================================
// PHASE 7 — Admin views (all 7).
// =============================================================
test("admin: user-manager / clubs / teams / assign-judges / audit / dive-directory / sign-off-codes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page, world.adminUsername);

  // /users
  await page.goto("/users");
  await settle(page);
  await snap(page, "user-manager");

  // /clubs
  await page.goto("/clubs");
  await settle(page);
  await snap(page, "clubs");

  // /teams
  await page.goto("/teams");
  await settle(page);
  await snap(page, "teams");

  // /assign-judges — auto-select an event so the screenshot
  //                  shows the assignable judges + currently
  //                  assigned panel, not just an empty picker.
  await page.goto("/assign-judges");
  await expect(page.locator("select.select").first()).toBeVisible({
    timeout: 10_000,
  });
  await page
    .locator("select.select")
    .first()
    .selectOption({ value: world.liveEvent.id })
    .catch(() => {});
  await settle(page, 1200);
  await snap(page, "assign-judges");

  // /events/:id/audit — Completed event's audit page. Like
  //                     dive-directory, the score-audit log
  //                     can grow to tens of thousands of pixels
  //                     tall (75 rows for our 5×3×5 fixture is
  //                     already 1700px). Viewport-only keeps
  //                     the image legible for documentation.
  await page.goto(`/events/${world.completedEvent.id}/audit`);
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/score-audit.png`,
    fullPage: false,
  });

  // /dive-directory — the directory renders all ~830 World
  //                   Aquatics dives in a single un-paginated
  //                   list, so fullPage:true generates a 60_000px
  //                   tall image that's unusable. Take a
  //                   viewport-only snap (1440×900) to capture
  //                   just the top of the list + filter chrome.
  await page.goto("/dive-directory");
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/dive-directory.png`,
    fullPage: false,
  });

  // /sign-off-codes (admin or referee can access).
  await page.goto("/sign-off-codes");
  await settle(page);
  await snap(page, "sign-off-codes");
});

// =============================================================
// PHASE 8 — Teardown. Drains the federation we spun up so two
// reruns don't pile up orgs in the test DB.
// =============================================================
test("teardown", async () => {
  if (world.orgId) {
    await setup.deleteOrg(world.orgId);
  }
});
