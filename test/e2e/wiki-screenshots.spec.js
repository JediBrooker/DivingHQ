// Guide / README screenshot harness.
//
// Captures the PNGs referenced by the in-app guide and README.
// Manual-run-only: `npm run test:e2e` excludes this spec, so
// run it explicitly when the UI rebrands or a guide page needs
// fresh art:
//
//   npx playwright test test/e2e/wiki-screenshots.spec.js --workers=1
//
// Outputs land in public/guide-screenshots/<name>.png. Filenames
// are load-bearing (the guide markdown and README reference them
// exactly), so anything new added here must also be wired into the
// guide content or README to be useful.
//
// Design choice: one big spec, serial mode, shared beforeAll
// fixture. The screenshots nearly all need the same "live federation
// with 3 events at different statuses, real divers, real judges,
// scored dives" world, and spinning that up once and screenshotting
// it 40-odd times is about 10x cheaper than 40 isolated tests. The
// trade-off is a fixture bug breaks every screenshot, which is fine
// since the spec is meant to be run interactively and looked
// at by a human anyway.
//
// No annotations. An earlier pass drew red callout badges and arrows
// onto these images; they were positioned against a different build
// and ended up covering the very fields they pointed at. If a shot
// needs a callout, the fix is to crop it (see snapEl) or to describe
// it in the surrounding prose, not to paint on the PNG.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// Pin the browser to UTC. Everything the fixture seeds is written as
// a UTC instant, and without this the images bake in whatever zone the
// operator's laptop happens to be in. The session scheduler is the
// obvious casualty: a 09:30 event start renders as "06:45 PM" from
// Sydney and the day spills over midnight. Doc screenshots should look
// the same wherever they get regenerated.
test.use({ timezoneId: "UTC" });

// -------------------------------------------------------------
// Shared world. Populated by the first test, drained by the last.
// Plain `let` rather than test.beforeAll() because Playwright's
// beforeAll fixtures don't get the `request` worker context the
// setup helpers need.
// -------------------------------------------------------------
const VIEWPORT = { width: 1440, height: 900 };
const SCREENSHOT_DIR = "public/guide-screenshots";
// Defeat scoreboard.js's 60s in-memory cache on Completed events
// (set in routes/scoreboard.js). Real spectators don't notice
// because the cache TTL is short, but a screenshot run that
// flips status Live→Completed and immediately reloads pulls the
// stale Live response. `?cache=skip` forces a fresh query.
const CACHE_SKIP = "?cache=skip";

const world = {};

// 5-judge profile, dead simple: every judge gives 7.0 / 7.5 / 8.0
// / 7.5 / 7.0 for every dive. Variance doesn't matter for the
// screenshots, what matters is that scores LAND so the score
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

// Wipe localStorage + cookies + reload, gets us back to a clean
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
    // heads up, networkidle can hang if a socket stays open.
    // Best effort, we still fall through to the timeout below.
  }
  await page.waitForTimeout(extraMs);
}

// The socket fans out "Your event is live" cards into the top-right
// .notif-stack whenever a status flips. They stack up three deep on a
// slow page and land in whatever screenshot happens to fire next, which
// is how meet-day.png ended up with a column of toasts down its side.
// They're also non-deterministic (pure socket timing), so the same run
// twice gives two different images. Hide them for every doc capture.
// The Inbox screenshot is unaffected, that's a route, not this overlay.
async function hideTransientChrome(page) {
  await page.addStyleTag({
    content: `.notif-stack { display: none !important; }`,
  }).catch(() => {
    // addStyleTag throws if we're mid-navigation. Not worth failing a
    // screenshot over, the stack is usually empty anyway.
  });
}

// payments.org_id and payments.payer_user_id are both ON DELETE
// RESTRICT, since a financial record isn't supposed to evaporate when
// someone deletes a user. Right call everywhere except here. This spec
// is the only one that seeds payment rows, so it's also the only one
// that has to sweep them up: without this, neither the stale-org
// cleanup below nor setup.deleteOrg() can drop the fixture, and the
// next run trips over yesterday's org.
//
// Everything that points AT payments (fines, entry_charges,
// class_enrolments, memberships…) is ON DELETE SET NULL, so the
// order here doesn't matter.
async function purgePayments(orgIds) {
  if (!orgIds.length) return;
  await setup.pool.query("DELETE FROM payments WHERE org_id = ANY($1::uuid[])", [orgIds]);
}

async function snap(page, name, opts = {}) {
  await hideTransientChrome(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: opts.fullPage !== false,
    ...(opts.clip ? { clip: opts.clip } : {}),
  });
}

// Screenshot a single element rather than the page. Used where the
// documented thing is a small piece of chrome (the connection pill)
// and a 1440px-wide page shot would render it four pixels tall.
async function snapEl(page, selector, name, padding = 12) {
  await hideTransientChrome(page);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`snapEl: ${selector} has no box`);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    clip: {
      x:      Math.max(0, box.x - padding),
      y:      Math.max(0, box.y - padding),
      width:  box.width  + padding * 2,
      height: box.height + padding * 2,
    },
  });
}

// =============================================================
// PHASE 1: build the fixture world via API + direct SQL.
// =============================================================
test("setup: build host federation, 3 events, divers + judges + coach", async ({
  request,
}) => {
  test.setTimeout(120_000);

  // Drain EVERY synthetic org left behind by other e2e files before
  // we shoot anything.
  //
  // This used to carry a 15-minute age gate, because the spec once ran
  // alongside the rest of the suite and deleting a live spec's users
  // mid-test could deadlock against status flips / notification
  // fan-out. That hasn't been true since playwright.config.js started
  // testIgnore-ing this file unless E2E_DOCS=1, so it now only ever runs
  // alone, via `npm run test:e2e:docs`.
  //
  // The gate was quietly wrecking two screenshots. /scoreboard and
  // /results-archive list every meet in the database, so leftovers
  // from other specs turn up as "Announce Event", "V2 Live", "Pool A"
  // sitting above the demo federation. The last capture had 32 junk
  // live events in it.
  //
  // Seeded demo data (the Grand Prix meets from seed_test_data.sql)
  // has a different slug and survives, which is what we want in frame.
  //
  // Payments go first: they hold RESTRICT references onto both the org
  // and its users, so a previous run that died before teardown leaves
  // rows that make the DELETEs below fail outright.
  const staleOrgs = (await setup.pool.query(
    "SELECT id FROM organisations WHERE slug LIKE 'e2e-%'",
  )).rows.map((r) => r.id);
  await purgePayments(staleOrgs);

  await setup.pool.query(
    "DELETE FROM users WHERE org_id = ANY($1::uuid[])", [staleOrgs],
  );
  await setup.pool.query(
    "DELETE FROM organisations WHERE id = ANY($1::uuid[])", [staleOrgs],
  );

  // Federation that maps to a recognisable flag: DEU matches the
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
  // The club matters: /api/coach/classes resolves the coach's roster
  // through users.club_id, so a clubless coach sees an empty Classes
  // tab no matter how many classes exist.
  const coach = await setup.insertUser({
    orgId, role: "coach", fullName: "Coach Andreas Klein", clubId: club1.clubId,
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

  // One referee: gates the sign-off-codes view and lets us prove
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

    // Roster: 5 divers per event so the live scoreboard /
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
  // Build the 3 events. baseURL hack, kinda gross but it works: we
  // need a websocket URL for openSocket(). The test doesn't get a
  // Playwright `page` yet (we're in the setup test), so we
  // hard-code 127.0.0.1 matching the Playwright config's baseURL.
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

  // -------------------------------------------------------------
  // Give the three events a start time. Two things need it: the
  // meet page renders a running order, and the session scheduler
  // refuses to auto-seed a meet whose events have no scheduled_at
  // (routes/sessions.js seedSessionsForMeet), so it'd hand us an empty
  // timeline to photograph.
  //
  // Times are anchored to the meet's own start_date, NOT to now(),
  // so the screenshot doesn't drift with the wall clock.
  // -------------------------------------------------------------
  const eventTimes = [
    [world.completedEvent.id, "2026-05-15T09:30:00Z"],
    [world.liveEvent.id,      "2026-05-15T13:00:00Z"],
    [world.upcomingEvent.id,  "2026-05-15T16:00:00Z"],
  ];
  for (const [eventId, at] of eventTimes) {
    await setup.pool.query(
      "UPDATE events SET scheduled_at = $2 WHERE id = $1",
      [eventId, at],
    );
  }

  await seedClassesWorld(request);
  await seedPaymentsWorld();
});

// =============================================================
// Fixture: club training classes.
//
// The Classes page is context-adaptive (ClassesView.vue): the
// Manage tab needs a club_admins row, the Coach tab needs role
// 'coach' + a matching users.club_id, and My classes needs an
// enrolment. So we need three different signed-in users to shoot
// the three tabs, and all of them have to point at the same club.
// =============================================================
async function seedClassesWorld(request) {
  const orgId = world.orgId;
  const club  = world.clubs[0];   // Berlin Diving Club, holds divers 0/2/4

  // Club admin. Club-admin-ness is a club_admins row, not an org
  // role, so the JWT alone can't grant it. Give her the coach role
  // too, which is what a real club's head coach usually looks like
  // and is what makes all three tabs render in one screenshot.
  const clubAdmin = await setup.insertUser({
    orgId, role: "coach", fullName: "Nina Roth", clubId: club.clubId,
  });
  await setup.pool.query(
    `INSERT INTO club_admins (club_id, user_id, org_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [club.clubId, clubAdmin.userId, orgId],
  );
  world.clubAdmin = clubAdmin;

  const classSpecs = [
    {
      name: "Learn to Dive", level: "Beginner",
      schedule: "Mondays + Wednesdays, 17:00–18:30", capacity: 16,
      prices: [
        { label: "Term (10 weeks)", amount_cents: 12000 },
        { label: "Pay as you go",   amount_cents: 1500 },
      ],
      enrol: [4],
    },
    {
      name: "Development Squad", level: "Intermediate",
      schedule: "Tue / Thu / Sat, 16:30–19:00", capacity: 12,
      prices: [
        { label: "Term (10 weeks)", amount_cents: 24000 },
        { label: "Monthly",         amount_cents: 9000 },
      ],
      enrol: [2, 4],
    },
    {
      name: "Elite Performance", level: "Advanced",
      schedule: "Daily, 06:00–08:00 + 16:00–19:00", capacity: 8,
      prices: [
        { label: "Term (10 weeks)", amount_cents: 42000 },
      ],
      enrol: [0, 2],
    },
  ];

  world.classes = [];
  for (const spec of classSpecs) {
    const cls = (await setup.pool.query(
      `INSERT INTO classes (club_id, org_id, name, description, level, schedule, capacity, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) RETURNING id`,
      [
        club.clubId, orgId, spec.name,
        `${spec.level} group coached by ${world.coach.fullName}.`,
        spec.level, spec.schedule, spec.capacity, clubAdmin.userId,
      ],
    )).rows[0];

    const priceIds = [];
    for (const [i, p] of spec.prices.entries()) {
      const row = (await setup.pool.query(
        `INSERT INTO class_price_options (class_id, label, amount_cents, currency, active, sort_order)
         VALUES ($1, $2, $3, 'GBP', true, $4) RETURNING id`,
        [cls.id, p.label, p.amount_cents, i],
      )).rows[0];
      priceIds.push({ ...row, ...p });
    }

    for (const diverIdx of spec.enrol) {
      const diver = world.divers[diverIdx];
      const price = priceIds[0];
      await setup.pool.query(
        `INSERT INTO class_enrolments
           (class_id, diver_user_id, club_id, org_id, status, price_option_id,
            amount_cents, discount_cents, currency, enrolled_by)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, 0, 'GBP', $7)`,
        [cls.id, diver.userId, club.clubId, orgId, price.id, price.amount_cents, clubAdmin.userId],
      );
    }
    world.classes.push({ id: cls.id, ...spec });
  }

  // Log the club admin in so the classes test can reuse the token.
  const login = await setup.loginAs(request, clubAdmin.username);
  world.clubAdmin.token = login.token;
}

// =============================================================
// Fixture: payments.
//
// Everything here is inserted with SQL rather than driven through
// the admin API. The API paths run real Stripe calls (Connect
// onboarding, Checkout session creation) and a screenshot run has
// no business hitting Stripe. The diver-facing GET endpoints we're
// photographing are pure reads over these tables, so the pages
// render exactly as they would in production.
//
// The one thing we can't fake is a completed Connect onboarding,
// so the /payments "Account details" tab stays empty. That's why the
// admin captures below stick to Overview plus Fees & pricing.
// =============================================================
async function seedPaymentsWorld() {
  const orgId = world.orgId;

  async function addFee(fields, prices = []) {
    const cols = Object.keys(fields);
    const feeId = (await setup.pool.query(
      `INSERT INTO fee_definitions (org_id, ${cols.join(", ")}, active)
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}, true)
       RETURNING id`,
      [orgId, ...cols.map((c) => fields[c])],
    )).rows[0].id;
    for (const p of prices) {
      await setup.pool.query(
        `INSERT INTO fee_prices (fee_definition_id, label, amount_cents, audience)
         VALUES ($1, $2, $3, $4)`,
        [feeId, p.label, p.amount_cents, p.audience || "all"],
      );
    }
    return feeId;
  }

  // Membership, one fee per tier. MembershipView asks for tier=''
  // (Standard) plus junior/senior/masters, and the endpoint matches
  // on `tier IS NOT DISTINCT FROM $2`, so Standard is a NULL tier.
  const membershipFees = {};
  const tiers = [
    { tier: null,      name: "Annual membership",         amount: 4500 },
    { tier: "junior",  name: "Junior annual membership",  amount: 2500 },
    { tier: "senior",  name: "Senior annual membership",  amount: 4500 },
    { tier: "masters", name: "Masters annual membership", amount: 3500 },
  ];
  for (const t of tiers) {
    membershipFees[t.tier || "standard"] = await addFee(
      {
        scope: "membership", name: t.name, currency: "GBP",
        fee_payer: "absorb", refund_policy: "deadline",
        membership_period: "annual", tier: t.tier,
      },
      [
        { label: "Standard",     amount_cents: t.amount },
        { label: "Members only", amount_cents: Math.round(t.amount * 0.8), audience: "member" },
      ],
    );
  }

  // Donations: buyer picks the amount, so no fee_prices rows. The preset
  // chips come off suggested_amounts.
  world.donationFeeId = await addFee({
    scope: "donation", name: "Support German diving", currency: "GBP",
    fee_payer: "absorb", refund_policy: "none",
    suggested_amounts: [1000, 2500, 5000, 10000],
  });

  // Entry fee for the meet, so the admin Overview has something to
  // total and payment history has a plausible line item.
  world.entryFeeId = await addFee(
    {
      scope: "event_entry", name: "Event entry", currency: "GBP",
      fee_payer: "pass_to_payer", refund_policy: "deadline",
      event_id: world.liveEvent.id,
    },
    [{ label: "Standard", amount_cents: 1800 }],
  );

  // A scratch penalty definition + one charge sitting unpaid against
  // a diver, which is the whole point of the /charges page.
  const scratchFeeId = await addFee(
    {
      scope: "scratch", name: "Late scratch penalty", currency: "GBP",
      fee_payer: "absorb", refund_policy: "none",
      event_id: world.upcomingEvent.id,
    },
    [{ label: "Standard", amount_cents: 2500 }],
  );
  await setup.pool.query(
    `INSERT INTO entry_charges
       (org_id, event_id, entrant_user_id, kind, fee_definition_id, amount_cents, status, triggered_at)
     VALUES ($1, $2, $3, 'scratch', $4, 2500, 'owed', now() - interval '2 days')`,
    [orgId, world.upcomingEvent.id, world.divers[0].userId, scratchFeeId],
  );

  // Two fines: one plain owed, one under appeal, so the page shows
  // both the Pay and the appeal-pending states side by side.
  await setup.pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status, issued_at)
     VALUES ($1, $2, $3, $4, 5000, 'GBP', 'Late arrival to the judges'' briefing', 'owed', now() - interval '5 days')`,
    [orgId, world.divers[0].userId, world.adminId, world.liveEvent.id],
  );
  await setup.pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason,
                        status, appeal_status, appeal_reason, issued_at)
     VALUES ($1, $2, $3, $4, 2000, 'GBP', 'Unregistered kit on poolside', 'appealed', 'pending',
             'The kit was registered on the day — receipt attached.', now() - interval '9 days')`,
    [orgId, world.divers[0].userId, world.adminId, world.liveEvent.id],
  );

  // Payment history for the subject diver. Mixed subject types and
  // one refund, because a ledger with a single row teaches nothing.
  const history = [
    { subject: "membership",  fee: membershipFees.standard, amount: 4500, status: "paid",     daysAgo: 96 },
    { subject: "event_entry", fee: world.entryFeeId,        amount: 1800, status: "paid",     daysAgo: 21, eventId: world.liveEvent.id },
    { subject: "donation",    fee: world.donationFeeId,     amount: 2500, status: "paid",     daysAgo: 12 },
    { subject: "event_entry", fee: world.entryFeeId,        amount: 1800, status: "refunded", daysAgo: 4,  eventId: world.upcomingEvent.id },
  ];
  for (const h of history) {
    const refunded = h.status === "refunded";
    await setup.pool.query(
      `INSERT INTO payments
         (org_id, fee_definition_id, payer_user_id, subject_type, event_id, meet_id,
          amount_cents, platform_fee_cents, currency, fee_payer, status, payer_type,
          created_at, paid_at, refunded_at, refunded_amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'GBP', 'absorb', $9, 'user',
               now() - ($10::int * interval '1 day'),
               now() - ($10::int * interval '1 day'),
               $11, $12)`,
      [
        orgId, h.fee, world.divers[0].userId, h.subject,
        h.eventId || null, h.eventId ? world.meetId : null,
        h.amount, Math.round(h.amount * 0.15), h.status, h.daysAgo,
        refunded ? new Date(Date.now() - 24 * 3600 * 1000) : null,
        refunded ? h.amount : 0,
      ],
    );
  }

  // Guardian → dependent. SubjectSelector.vue only renders its
  // "Paying for" dropdown when /api/guardians/my-dependents comes
  // back non-empty, and it prints the dependent's age, so the
  // dependent needs a date_of_birth or the label reads "(NaN)".
  await setup.pool.query(
    "UPDATE users SET date_of_birth = '2012-04-18' WHERE id = $1",
    [world.divers[0].userId],
  );
  // 'spectator' is what registration actually hands a new account
  // (routes/auth.js), and a parent who signs up purely to pay for their
  // child never earns anything more, so that's the person the screenshot
  // should show. /membership carries allowGuardian in the router and the
  // guard lets anyone holding an approved dependent through, so she
  // reaches the page and SubjectSelector renders her picker.
  const guardian = await setup.insertUser({
    orgId, role: "spectator", fullName: "Marta Bennett",
  });
  await setup.pool.query(
    `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, 'approved', $4, now())`,
    [orgId, guardian.userId, world.divers[0].userId, world.adminId],
  );
  world.guardian = guardian;
}

// =============================================================
// PHASE 2: public screenshots (signed out).
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
// PHASE 3: spectator views (signed out). scoreboard list mode,
// live broadcast mode, results-archive (filters set), public
// meet landing page.
// =============================================================
test("spectator: scoreboard list + live + archive + meet", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signOut(page);

  // 1. scoreboard.png: list mode (no event selected). The
  //    /scoreboard route renders MeetsBrowser when no eventId
  //    is in the URL. The test DB has accumulated meets from
  //    other spec's bulk seed data, so capture viewport-only so
  //    the result is a usable 1440×900 snap rather than a tall
  //    stretched scroll of every meet ever created.
  await page.goto("/scoreboard");
  // The MeetsBrowser sorts to bring our 3-event meet to the
  // top, so wait for at least one meet card before snapping.
  await expect(page.locator(".meet-card, .live-chip").first()).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/scoreboard.png`,
    fullPage: false,
  });

  // 2. scoreboard-live.png: live broadcast mode. Push the
  //    active diver to the 3rd diver of the live event so the
  //    centre column shows a real performer + the Up Next
  //    panel + standings all populated.
  //    Need an admin socket to emit set_active_diver, so open one
  //    here just for that and close it once the snap is taken.
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

  // 3. results-archive.png: same list mode but with the
  //    statusFilter expanded so a casual reader can see the
  //    filter UI in action. Pick "Completed" to mirror what a
  //    user looking for past results would do.
  await page.goto("/scoreboard");
  await expect(page.locator(".sb-filter-row").first()).toBeVisible({
    timeout: 10_000,
  });
  // First select in the filter row is statusFilter, set it to
  // Completed so the screenshot demonstrates the filter cluster
  // in a non-default state.
  const statusSel = page.locator(".sb-filter-row .sb-filter-select").first();
  await statusSel.selectOption("Completed");

  // The LIVE NOW and UPCOMING strips sit above the filtered list and
  // ignore statusFilter entirely (MeetsBrowser.vue renders them off
  // liveByMeet / upcomingByMeet, not the filtered set). Left expanded
  // they push the completed meets clean out of a viewport-only shot,
  // which is how this file ended up byte-for-byte identical to
  // scoreboard.png. Collapse them so the archive is the subject.
  for (const head of [".live-strip-head", ".upcoming-strip-head"]) {
    const btn = page.locator(head);
    if (await btn.count()) {
      if (await btn.getAttribute("aria-expanded") === "true") await btn.click();
    }
  }
  await settle(page);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/results-archive.png`,
    fullPage: false,
  });

  // 4. meet.png: public meet landing page.
  await page.goto(`/meet/${world.meetId}`);
  await settle(page);
  await snap(page, "meet");
});

// =============================================================
// PHASE 4: operator views. dashboard / control room / meet
// manager (signed in as admin).
// =============================================================
test("operator: dashboard / control-room / meet-manager", async ({ page, baseURL, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page, world.adminUsername);

  // 1. dashboard.png: admin's own dashboard. Has the role
  //    quick-pick panel by default.
  await page.goto("/dashboard");
  await settle(page);
  await snap(page, "dashboard");

  // 2. control-room.png: /control with the Live event picked
  //    and an active diver shown.
  //    Push the active diver again since the previous test's
  //    adminSocket is disconnected by now.
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

  // 3. meet-manager.png: /manager.
  await page.goto("/manager");
  await settle(page);
  await snap(page, "meet-manager");

  // 4. new-event-modal.png: the create-event modal opened over
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

  // 5. control-room-simultaneous.png: TWO Live events running at once.
  //    Spin up a second Live event (created last so the single-event
  //    control-room.png + meet-manager.png above stay one-Live), then
  //    open the Control Room. the side columns auto-collapse to drawers
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
// PHASE 5: judge view (signed in as a judge with active diver).
// =============================================================
test("judge: judge.png", async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(VIEWPORT);
  const judge = world.judges[0];
  await signIn(page, judge.username);

  // Set active diver before navigating, since JudgeView listens on
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
  // subscribes and replays the current state, so give it room.
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
// PHASE 6: diver / coach views.
// =============================================================
test("diver+coach: profile / competitor / compare / coach", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);

  // 1. diver-profile.png: public profile, signed OUT so the
  //    page renders in its public-spectator mode.
  await signOut(page);
  await page.goto(`/profile/${world.subjectDiverId}`);
  await settle(page);
  await snap(page, "diver-profile");

  // 2. competitor.png: signed in as a diver entered in the
  //    Upcoming event. CompetitorView starts on the event picker
  //    ("Choose Active Event"), so manually pick the Upcoming event
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

  // 2b. meet-day.png: the focused phone-style meet-day view for
  //     an entrant diver. diver[0] is rostered into the Live
  //     event, so MeetDayView renders the "your next dive" card +
  //     current rank rather than the not-entered placeholder.
  await page.goto(`/me/meet/${world.liveEvent.id}`);
  await settle(page, 1200);
  await snap(page, "meet-day");

  // 2c. inbox.png: the notifications inbox. Available to any
  //     authenticated user, capture it while still signed in as
  //     the diver. May render the empty-state if no notifications
  //     have fanned out yet, still a useful reference frame.
  await page.goto("/inbox");
  await settle(page);
  await snap(page, "inbox");

  // 3. compare.png: signed in, comparing 2 divers.
  await page.goto(
    `/compare?a=${world.subjectDiverId}&b=${world.compareDiverId}`,
  );
  await settle(page);
  await snap(page, "compare");

  // 4. coach.png: signed in as the coach with linked divers.
  await signOut(page);
  await signIn(page, world.coach.username);
  await page.goto("/coach");
  await settle(page);
  await snap(page, "coach");

  // 5. coach-dive-lists.png: the on-behalf-of squad dive-list
  //    editor. The coach is linked to divers[1] + divers[2], both
  //    rostered into the Live event, so this event's editor lists
  //    real squad rows rather than an empty state.
  await page.goto(`/coach/dive-lists/${world.liveEvent.id}`);
  await settle(page, 1200);
  await snap(page, "coach-dive-lists");
});

// =============================================================
// PHASE 7: admin views (all 7).
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

  // /assign-judges: auto-select an event so the screenshot
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

  // /events/:id/audit: Completed event's audit page. Like
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

  // /dive-directory: the directory renders all ~830 World
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
// PHASE 8: payments. Two audiences on the same feature, so two
// sign-ins: the federation admin who configures fees, and the
// diver who pays them.
// =============================================================
test("payments: admin overview + fee editor / membership / charges / donate / history", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);

  // ---- Federation admin -------------------------------------
  await signIn(page, world.adminUsername);

  // payments-admin-overview.png: the landing tab. Shows the
  // money-in totals plus the "how this works" explainer.
  await page.goto("/payments");
  await expect(page.locator(".tabs .tab").first()).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await snap(page, "payments-admin-overview");

  // payments-fee-editor.png: the Fees & pricing tab, where the
  // membership fee, club fees, and entry pricing get set. Scope to
  // the tab bar, because the Overview panel's "how this works" list has
  // a button with the same label that jumps to the same tab.
  await page.locator(".tabs .tab", { hasText: /Fees & pricing/i }).click();
  await settle(page, 800);
  await snap(page, "payments-fee-editor");

  // ---- Diver ------------------------------------------------
  await signOut(page);
  await signIn(page, world.divers[0].username);

  // payments-membership.png: the four tier cards with prices
  // resolved from fee_prices.
  await page.goto("/membership");
  await expect(page.locator(".tier-card").first()).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await snap(page, "payments-membership");

  // payments-charges.png: an unpaid scratch penalty, an owed
  // fine, and a fine already under appeal.
  await page.goto("/charges");
  await settle(page, 900);
  await snap(page, "payments-charges");

  // payments-donate.png: preset amount chips off suggested_amounts.
  await page.goto("/donate");
  await settle(page, 900);
  await snap(page, "payments-donate");

  // payments-history.png: the personal ledger, four rows, one
  // of them refunded.
  await page.goto("/payment-history");
  await settle(page, 900);
  await snap(page, "payments-history");

  // ---- Guardian ---------------------------------------------
  // payments-guardian-selector.png: the "Paying for" dropdown that
  // SubjectSelector.vue renders ONLY for a user with an approved
  // dependent. The old screenshot under this name was the wrong
  // page entirely (it showed an empty /guardians list), so this
  // one actually earns its filename.
  await signOut(page);
  await signIn(page, world.guardian.username);
  await page.goto("/membership");
  const subject = page.locator(".subject-selector select");
  await expect(subject).toBeVisible({ timeout: 10_000 });
  await subject.selectOption({ index: 1 });   // the dependent, not "myself"
  await settle(page, 700);
  await snap(page, "payments-guardian-selector");
});

// =============================================================
// PHASE 9: classes. One page, three tabs, three different users,
// because the tab you land on is decided by what you are.
// =============================================================
test("classes: manage / coach / my-classes", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);

  // classes-manage.png: club admin lands on Manage.
  await signIn(page, world.clubAdmin.username);
  await page.goto("/classes");
  await expect(page.locator(".panel")).toBeVisible({ timeout: 10_000 });
  await settle(page, 900);
  await snap(page, "classes-manage");

  // classes-coach.png: the coach gets the read-only roster view.
  await signOut(page);
  await signIn(page, world.coach.username);
  await page.goto("/classes");
  await expect(page.locator(".panel")).toBeVisible({ timeout: 10_000 });
  await settle(page, 900);
  await snap(page, "classes-coach");

  // classes-my-classes.png: divers[0] is enrolled in Elite
  // Performance, so this renders an enrolment card rather than
  // the "browse your club's classes" empty state.
  await signOut(page);
  await signIn(page, world.divers[0].username);
  await page.goto("/classes");
  await expect(page.locator(".panel")).toBeVisible({ timeout: 10_000 });
  await settle(page, 900);
  await snap(page, "classes-my-classes");
});

// =============================================================
// PHASE 10: the offline connection indicator.
//
// The guide documents an amber "Offline 12s" pill with a pending
// count badge next to it. Getting there means actually cutting the
// socket and then queuing a write, because both halves of that pill
// are derived state: isOffline comes from the socket's connected
// flag (useOutbox.js), and the badge counts unsynced outbox rows.
//
// Captured as a cropped element, not a page. At 1440px wide the
// pill is a ~90px smudge in the top-right corner and the reader
// can't see the thing the page is describing.
// =============================================================
test("offline: connection indicator", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page, world.adminUsername);

  const adminSocket = await openSocket(baseURL || world.baseURL, world.adminToken);
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

  // By now the operator phase has spun up a second Live event, so
  // the Control Room renders two pool cards. Everything below wants
  // the first one.
  await page.goto(`/control?event=${world.liveEvent.id}`);
  await expect(page.locator(".cv2-live-diver").first()).toBeVisible({ timeout: 15_000 });
  await settle(page, 800);
  adminSocket.disconnect();

  // Cut the network. The socket notices, offlineSince is stamped,
  // and the pill flips amber.
  await page.context().setOffline(true);
  await expect(page.locator(".cv2-conn-off")).toBeVisible({ timeout: 20_000 });

  // Now queue something, so the pill grows the pending-count badge
  // the guide describes. A referee Re-dive call is the right lever:
  // LivePoolCard routes it straight through queueSocketAction with
  // no confirm dialog in the way, and unlike Next Diver it stays
  // enabled while the active diver's panel is still incomplete.
  //
  // Bound the click. Playwright waits for actionability with no
  // deadline of its own, so a disabled button would silently burn
  // the whole test timeout rather than fall through to the catch.
  await page
    .locator(".cv2-pool").first()
    .getByRole("button", { name: /Re-dive/i })
    .click({ timeout: 5_000 })
    .catch(() => {
      // No active diver in that pool. The pill is still worth
      // photographing, just without the badge.
    });
  // Give the pill's 1s ticker a beat so it reads "Offline 3s" rather
  // than an empty duration, and let the outbox write land.
  await page.waitForTimeout(3000);

  // Crop to the right-hand action cluster. The guide places the
  // indicator "next to the History and Standings buttons", so those
  // belong in frame; the event chips on the far left do not.
  await snapEl(page, ".cv2-topbar-actions", "offline-connection-indicator", 10);

  await page.context().setOffline(false);
});

// =============================================================
// PHASE 11: session scheduler.
//
// /meet/:id/schedule auto-seeds on first authenticated GET, but
// only for events that carry a scheduled_at (set in the fixture).
// Two extra events at other heights give the timeline more than
// one board column, which is the whole point of the layout. They
// are created HERE, after meet-manager.png and the dashboard have
// already been captured, so those images keep their tidy 3-event
// meet.
// =============================================================
test("scheduler: day timeline + edit mode", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);

  for (const spec of [
    { name: "Women 10m Platform — Preliminary", height: "10m", at: "2026-05-15T11:00:00Z", gender: "Female" },
    { name: "Men 1m Springboard — Final",       height: "1m",  at: "2026-05-15T14:30:00Z", gender: "Male" },
  ]) {
    const ev = await setup.createEvent(request, {
      adminToken: world.adminToken,
      name: spec.name,
      gender: spec.gender,
      number_of_judges: 5,
      total_rounds: 3,
      height: spec.height,
      event_type: "individual",
    });
    await request.put(`/api/events/${ev.id}/meet`, {
      headers: { Authorization: `Bearer ${world.adminToken}` },
      data: { meet_id: world.meetId },
    });
    await setup.pool.query(
      "UPDATE events SET scheduled_at = $2 WHERE id = $1",
      [ev.id, spec.at],
    );
  }

  await signIn(page, world.adminUsername);
  await page.goto(`/meet/${world.meetId}/schedule`);
  // The first authenticated load is the one that seeds boards +
  // sessions + blocks, so wait for a block to paint rather than
  // for networkidle.
  await expect(page.locator(".scheduler-block").first()).toBeVisible({ timeout: 20_000 });
  await settle(page, 1200);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/session-scheduler-timeline.png`,
    fullPage: false,
  });

  // schedule-conflict-drawer.png: the Conflict detection section of
  // the guide is entirely about hard vs soft and the colours that
  // carry them, and a clean schedule has neither. Manufacture one:
  // shove the Semifinal's event block on top of the Final's. Both
  // are 3m, both hold the same five judges and the same five divers,
  // so the detector fires on board, judge, AND diver at once.
  const finalBlock = (await setup.pool.query(
    `SELECT starts_at, ends_at FROM schedule_blocks
      WHERE event_id = $1 AND block_type = 'event_start' LIMIT 1`,
    [world.liveEvent.id],
  )).rows[0];
  expect(finalBlock, "the Final's event block should have been seeded").toBeTruthy();

  await setup.pool.query(
    `UPDATE schedule_blocks
        SET starts_at = $2, ends_at = $3
      WHERE event_id = $1 AND block_type = 'event_start'`,
    [
      world.upcomingEvent.id,
      new Date(finalBlock.starts_at.getTime() + 5 * 60_000),
      new Date(finalBlock.ends_at.getTime()   + 5 * 60_000),
    ],
  );

  // GET /api/meets/:id/conflicts memoises for CONFLICT_CACHE_TTL_MS
  // (5s, routes/sessions.js) and only busts that cache on writes made
  // through the API. We moved the block underneath it with raw SQL, so
  // an immediate reload just re-serves the pre-move "no conflicts"
  // answer. Wait the TTL out rather than reach into the cache.
  await page.waitForTimeout(5_500);

  await page.reload();
  await expect(page.locator(".scheduler-block").first()).toBeVisible({ timeout: 20_000 });
  await page.locator(".scheduler-drawer-toggle").first().click();
  await expect(page.locator(".scheduler-conflict-card.severity-hard").first())
    .toBeVisible({ timeout: 15_000 });
  await settle(page, 900);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/schedule-conflict-drawer.png`,
    fullPage: false,
  });
});

// =============================================================
// PHASE 12: the odds and ends the guide pages ask for but no
// earlier phase happens to be standing in front of.
// =============================================================
test("extras: pre-meet checklist / judge analysis / user drawer / language switcher / rtl", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize(VIEWPORT);
  await signIn(page, world.adminUsername);

  // control-room-premeet-checklist.png: the Control Room in its
  // pre-meet Setup state. Quick Start, Running a Meet, and the FAQ
  // all describe this colour-cycling stepper and none of them
  // could show it. Deep-link the Upcoming event, which is the only
  // one that hasn't started.
  await page.goto(`/control?event=${world.upcomingEvent.id}`);
  await expect(page.locator(".cv2-chip.is-focused")).toBeVisible({ timeout: 15_000 });
  await settle(page, 1200);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/control-room-premeet-checklist.png`,
    fullPage: false,
  });

  // control-room-venue-bridge.png: Venue Integration is otherwise a
  // wall of CLI flags and payload schemas. This panel is the one
  // place an operator actually clicks, and it's four levels deep:
  // Tools → Broadcast → Venue hardware → the copyable commands.
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("button", { name: /Broadcast/ }).click();
  // The drawer's Broadcast section is a blurb + a button; the option
  // list only mounts once the chooser itself is opened.
  await page.getByRole("button", { name: /Open broadcast chooser/i }).click();
  await page.locator(".broadcast-option", { hasText: /Daktronics bridge/i }).click();
  await expect(page.locator(".venue-command").first()).toBeVisible({ timeout: 10_000 });
  await settle(page, 700);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/control-room-venue-bridge.png`,
    fullPage: false,
  });

  // judge-analysis.png: the panel-wide bias + deviation dashboard.
  // Point it at the Completed event, which has a full 3 rounds of
  // scores from all 5 judges behind it.
  await page.goto(`/judge-analysis?event=${world.completedEvent.id}`);
  await settle(page, 1500);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/judge-analysis.png`,
    fullPage: false,
  });

  // user-manager-drawer.png: Roles & Permissions describes where
  // roles are granted and revoked, which is this drawer, not the
  // table behind it.
  await page.goto("/users");
  await settle(page);
  await page.locator("tbody tr[data-user-id], tbody tr:not(.group-head)").first().click();
  await expect(page.locator("aside.drawer")).toBeVisible({ timeout: 10_000 });
  await settle(page, 900);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/user-manager-drawer.png`,
    fullPage: false,
  });

  await signOut(page);

  // stream-overlay-chroma.png: what OBS actually receives. Anyone
  // setting up a broadcast wants to see the green before they trust
  // the chroma key. Public route, no sign-in needed.
  await page.goto(`/scoreboard/${world.liveEvent.id}?overlay=1`);
  await settle(page, 1200);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/stream-overlay-chroma.png`,
    fullPage: false,
  });

  // stream-overlay-minimal.png: the cut-down shape. Same event, same route,
  // only the query flag differs, so the two shots sit next to each other in
  // the guide and the difference is the only thing that moves.
  await page.goto(`/scoreboard/${world.liveEvent.id}?overlay=minimal`);
  await settle(page, 1200);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/stream-overlay-minimal.png`,
    fullPage: false,
  });

  // language-switcher.png: a crop of the flag-prefixed control, not
  // the menu open. It's a native <select>, and the OS draws that popup
  // outside the page, so a screenshot of it "open" is just the closed
  // control again. What the reader actually needs is "look for the flag
  // in the top-right", wich the crop gives them.
  await page.goto("/login");
  await settle(page);
  await snapEl(page, ".locale-switcher", "language-switcher", 40);

  // rtl-arabic-layout.png: the single hardest claim on the
  // Languages page to make in prose ("the whole page mirrors").
  // Set the stored locale the way the switcher would, then reload.
  await page.evaluate(() => localStorage.setItem("locale", "ar"));
  await page.goto("/login");
  await settle(page, 1200);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/rtl-arabic-layout.png`,
    fullPage: false,
  });
  await page.evaluate(() => localStorage.removeItem("locale"));
});

// =============================================================
// PHASE 13: teardown. Drains the federation we spun up so two
// reruns don't pile up orgs in the test DB.
// =============================================================
test("teardown", async () => {
  if (world.orgId) {
    await purgePayments([world.orgId]);
    await setup.deleteOrg(world.orgId);
  }
});
