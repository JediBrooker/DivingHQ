// The outbox's whole promise, from src/guide/content/offline-competitions.md:
//
//   "queued operations are durable - they survive page refreshes,
//    navigation between views, and even closing and reopening the browser"
//   "When the connection comes back, the outbox drains automatically"
//
// It didn't. Two faults stacked up, and together they lost an operator's
// work in the middle of a meet:
//
//   1. fetchMe() couldn't tell "the network is down" from "you are
//      anonymous", so refreshing on dead venue wifi threw the operator out
//      to a login page they had no way of using. Their session cookie was
//      still perfectly valid.
//   2. The connect -> drain hook only existed while the Control Room was
//      rendered, because useHttpOutbox() is what installed it. Land
//      anywhere else and reconnecting moved nothing.
//
// These specs pin both down. If either regresses, an operator silently
// loses scores, so they are worth the ~20s they cost.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  // Also bypasses the first-login role tour, which would sit over the
  // account menu the sign-out test needs to click.
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

// A Live event with two divers, the panel already in for diver 1, so the
// operator's next click is a real Next Diver advance.
async function liveMeetReadyToAdvance(request, page, baseURL, name) {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: `${name} Diving`,
  });
  await setup.insertClub({ orgId, name: `${name} Club`, shortCode: "OBX" });
  const event = await setup.createEvent(request, {
    adminToken, name: `${name} Meet`, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of ["AAA Diver", "ZZZ Diver"]) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({
      eventId: event.id, competitorId: d.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });
    divers.push(d);
  }
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, `${name} Meet`);
  await expect(page.locator(".cv2-live-diver")).toContainText("AAA Diver");
  await setup.submitPanelScores({
    baseURL, judges, eventId: event.id,
    competitorId: divers[0].userId, roundNumber: 1, diveId,
  });
  await expect(page.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });
  return { event, username };
}

// The server's authoritative active diver, written through by
// set_active_diver (lib/live-state.js). The only proof the queued action
// actually landed.
async function serverActiveDiver(eventId) {
  const r = await setup.pool.query(
    "SELECT active_diver_payload FROM event_live_state WHERE event_id = $1",
    [eventId],
  );
  return r.rows[0]?.active_diver_payload?.full_name ?? null;
}

// Advance while offline. The click moves only the operator's screen; the
// action goes to IndexedDB and waits.
async function advanceOffline(page) {
  await page.context().setOffline(true);
  await page.waitForTimeout(600);
  await page.locator(".cv2-primary").click();
  await expect(page.locator(".cv2-live-diver")).toContainText("ZZZ Diver");
  // Let the IDB write commit before anything navigates.
  await page.waitForTimeout(1500);
}

test("an offline refresh keeps the operator signed in, and the queued advance lands on reconnect", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { event } = await liveMeetReadyToAdvance(request, page, baseURL, "ObxA");

  await advanceOffline(page);
  // Precondition, not the point of the test: the advance is still sat in IDB.
  // Don't assert the server has NO live state. The Control Room announces
  // roster[0] itself if the server hasn't named a diver within 1500ms of
  // mount, and on a loaded runner that timer fires before we go offline,
  // leaving "AAA Diver" on the server. That's correct behaviour, and a
  // toBeNull() here would fail on it for reasons having nothing to do with
  // the outbox.
  expect(
    await serverActiveDiver(event.id),
    "the offline advance must not reach the server before the network returns",
  ).not.toBe("ZZZ Diver");

  // The refresh that used to end the operator's afternoon.
  await page.reload().catch(() => {});
  await page.waitForTimeout(1500);
  expect(page.url(), "an offline refresh must not evict a signed-in operator to /login")
    .not.toContain("/login");

  await page.context().setOffline(false);

  await expect
    .poll(() => serverActiveDiver(event.id), {
      timeout: 20_000,
      message: "the queued advance never replayed after the network came back",
    })
    .toBe("ZZZ Diver");
});

test("reconnecting drains the queue from a route that never mounts the Control Room", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { event } = await liveMeetReadyToAdvance(request, page, baseURL, "ObxB");

  await advanceOffline(page);

  // Somewhere with no LivePoolCard, so only the app-level hook can drain.
  await page.goto("/dashboard").catch(() => {});
  await page.waitForTimeout(1200);
  expect(page.url()).not.toContain("/control");
  expect(page.url()).not.toContain("/login");

  await page.context().setOffline(false);

  await expect
    .poll(() => serverActiveDiver(event.id), {
      timeout: 20_000,
      message: "the outbox only drains while the Control Room is on screen",
    })
    .toBe("ZZZ Diver");
});

test("an anonymous tab never opens the outbox and caches no identity", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/scoreboard");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);

  const dbs = await page.evaluate(async () => {
    const list = (await indexedDB.databases?.()) || [];
    return list.map((d) => d.name);
  });
  expect(
    dbs,
    "an anonymous visitor must not create an outbox; it would be pinned to the 'anon' fingerprint forever",
  ).not.toContain("divinghq-outbox");

  const cached = await page.evaluate(() => localStorage.getItem("dhq_identity"));
  expect(cached, "no identity cached for a visitor who never signed in").toBeNull();
});

test("signing out clears the cached identity, so an offline reload stays signed out", async ({ request, page }) => {
  test.setTimeout(90_000);
  const { orgId, username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Obx Signout Diving",
  });
  // A club, so the dashboard doesn't punt a brand-new org admin into the
  // /setup wizard, which renders without the app shell.
  await setup.insertClub({ orgId, name: "Obx Signout Club", shortCode: "OSC" });

  await signIn(page, username);
  expect(
    await page.evaluate(() => localStorage.getItem("dhq_identity")),
    "a signed-in session is mirrored so an offline boot still knows who you are",
  ).not.toBeNull();

  // Drive the real control, so clearSession() is what does the clearing.
  await page.locator(".sb-user").click();
  await page.getByRole("button", { name: /Sign Out/i }).click();
  await page.waitForURL(/\/login/, { timeout: 10_000 });

  expect(
    await page.evaluate(() => localStorage.getItem("dhq_identity")),
    "signing out must not leave an identity behind for the next person on this laptop",
  ).toBeNull();

  // And with nothing cached, an offline boot is anonymous again.
  await page.context().setOffline(true);
  await page.goto("/control").catch(() => {});
  await page.waitForTimeout(1200);
  expect(page.url()).toContain("/login");
  await page.context().setOffline(false);
});

// The judge path deserves its own case. JudgeView predates the 'socket:'
// prefix and pushes plain 'submit_score' entries. Now that the drain runs
// app-wide, those entries can be picked up by useHttpOutbox's unifiedSend,
// which routes anything without the prefix to fetch(). Sending a judge's
// score to fetch(undefined) would burn its retries and mark it failed. A
// dropped score in a live meet is the worst thing this codebase can do.
test("a judge's score queued offline replays when the network returns", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Obx Judge Diving",
  });
  await setup.insertClub({ orgId, name: "Obx Judge Club", shortCode: "OJC" });
  const event = await setup.createEvent(request, {
    adminToken, name: "Obx Judge Meet", total_rounds: 1, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diver = await setup.insertUser({ orgId, role: "diver", fullName: "Solo Diver" });
  await setup.insertDiveList({
    eventId: event.id, competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `Obx J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });

  const scoreCount = async () => {
    const r = await setup.pool.query(
      "SELECT count(*)::int AS n FROM scores WHERE event_id = $1 AND judge_id = $2",
      [event.id, judges[0].userId],
    );
    return r.rows[0].n;
  };

  // Put a diver on the board so the judge's keypad unlocks.
  const adminSocket = await setup.openSocket(baseURL, adminToken);
  adminSocket.emit("subscribe_event", { event_id: event.id });
  adminSocket.emit("set_active_diver", {
    event_id: event.id, competitor_id: diver.userId, round_number: 1,
    full_name: "Solo Diver", diverName: "Solo Diver",
    diveCode: "101B", dd: 1.5, description: "Forward Dive", position: "B",
    dive_id: diveId, eventName: "Obx Judge Meet", status: "ready",
  });

  await signIn(page, judges[0].username);
  await page.goto(`/judge?event=${event.id}`);
  await page.waitForTimeout(2500);
  adminSocket.disconnect();

  await expect(page.locator(".submit-btn")).toBeEnabled({ timeout: 15_000 });
  expect(await scoreCount()).toBe(0);

  // Wifi dies. The judge scores anyway, which is the whole point.
  await page.context().setOffline(true);
  await page.waitForTimeout(600);
  await page.locator(".key", { hasText: /^7$/ }).click();
  await page.locator(".submit-btn").click();
  await page.waitForTimeout(1500);
  expect(await scoreCount(), "still offline, nothing should have reached the server").toBe(0);

  // Walk away from the judging screen while still offline, so JudgeView's
  // own drainOutbox() is gone and the app-level hook is the only thing that
  // can move this. That is also the path that exposes the routing: the
  // entry's action_type is the bare 'submit_score', not 'socket:...'.
  await page.goto("/dashboard").catch(() => {});
  await page.waitForTimeout(1000);
  expect(page.url()).not.toContain("/judge");
  expect(page.url()).not.toContain("/login");

  await page.context().setOffline(false);
  await expect
    .poll(scoreCount, {
      timeout: 20_000,
      message: "a judge's queued score never replayed; check unifiedSend's action-type routing",
    })
    .toBe(1);
});
