// Per-pool keyboard control. hotkeys act on the FOCUSED pool only, and
// number keys switch which pool is focused. Flag-on only (V2 surface).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { roomWatcher } = require("./_meetday");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

async function liveEvent(request, { orgId, adminToken, name, diverNames }) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: 2, number_of_judges: 5, height: "3m",
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of diverNames) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
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
  return { event, diveId, divers, judges };
}

test("Space advances only the focused pool; number keys switch focus", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Keyboard Diving" });
  await setup.insertClub({ orgId, name: "KB Club", shortCode: "KBC" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Pool A", diverNames: ["AAA A", "ZZZ A"] });
  const B = await liveEvent(request, { orgId, adminToken, name: "Pool B", diverNames: ["AAA B", "ZZZ B"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Pool A");

  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA A");
  await expect(cardB.locator(".cv2-live-diver")).toContainText("AAA B");

  // Arm A's primary, move focus off the chip button, then press Space.
  await setup.submitPanelScores({ baseURL, judges: A.judges, eventId: A.event.id, competitorId: A.divers[0].userId, roundNumber: 1, diveId: A.diveId });
  await expect(cardA.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });
  await cardA.locator(".cv2-live-diver").click(); // blur the chip, need a non-button target
  await page.keyboard.press("Space");

  // Focused pool A advances, background pool B stays put.
  await expect(cardA.locator(".cv2-live-diver")).toContainText("ZZZ A");
  await expect(cardB.locator(".cv2-live-diver")).toContainText("AAA B");

  // number keys switch the focused pool
  await page.keyboard.press("2");
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool B");
  await page.keyboard.press("1");
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool A");
});

test("hotkeys do not fire while typing in a field", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Keyboard Guard Diving" });
  await setup.insertClub({ orgId, name: "KG Club", shortCode: "KGC" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Guard Pool", diverNames: ["AAA A", "ZZZ A"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Guard Pool");
  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  await setup.submitPanelScores({ baseURL, judges: A.judges, eventId: A.event.id, competitorId: A.divers[0].userId, roundNumber: 1, diveId: A.diveId });
  await expect(cardA.locator(".cv2-primary")).toBeEnabled({ timeout: 6_000 });

  // Open the top-bar search (command palette) and type a space, the
  // guard needs to keep it in the input instead of advancing the pool.
  await page.locator(".topbar-search").click({ force: true });
  await expect(page.locator(".cmdk-input")).toBeVisible({ timeout: 5_000 });
  await page.locator(".cmdk-input").type("a b");
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA A"); // still hasn't moved
});

// The window listener used to take Space from whatever had focus: a
// focused Hold button advanced the diver instead, and Space on the
// partial-panel confirm's own "Move on" button queued a second confirm,
// so accepting both skipped a diver who never dived.
test("Space presses the focused button and answers the confirm, it doesn't advance again", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Keyboard Space Diving" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Space Pool", diverNames: ["AAA S", "BBB S", "CCC S", "DDD S"] });

  const room = await roomWatcher(baseURL, A.event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${A.event.id}`);
  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA S", { timeout: 10_000 });
  // The page's announce reaching the room means its socket is in there too
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  room.close();

  // Two of five judges in, then Space from the page: one confirm, with
  // focus on its Move on button.
  await setup.submitPanelScores({
    baseURL, judges: A.judges.slice(0, 2), eventId: A.event.id,
    competitorId: A.divers[0].userId, roundNumber: 1, diveId: A.diveId,
  });
  await expect(cardA.locator(".cv2-tile.scored")).toHaveCount(2, { timeout: 6_000 });
  await cardA.locator(".cv2-live-diver").click();
  await page.keyboard.press("Space");
  const confirm = page.locator('.confirm-backdrop[aria-modal="true"]');
  await expect(confirm).toHaveCount(1);
  // Space again answers it, the way Space answers any focused button
  await page.keyboard.press("Space");
  await expect(confirm).toHaveCount(0);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("BBB S");
  await page.waitForTimeout(500);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("BBB S");

  // Tab onto the card's Hold button: Space holds, the diver stays put
  await cardA.locator(".cv2-pool-hold").focus();
  await page.keyboard.press("Space");
  await expect(cardA.locator(".cv2-pool-heldbar")).toBeVisible();
  await expect(cardA.locator(".cv2-live-diver")).toContainText("BBB S");
  await setup.deleteOrg(orgId);
});

// Hold is per event. The focused banner and 'h' used to share a single
// flag that stayed put when focus moved, so pool A's hold showed on B and
// 'h' on B sent a resume for B instead of a hold.
test("the hold banner and 'h' follow the focused pool", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Keyboard Hold Diving" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Hold Pool A", diverNames: ["AAA HA", "ZZZ HA"] });
  const B = await liveEvent(request, { orgId, adminToken, name: "Hold Pool B", diverNames: ["AAA HB", "ZZZ HB"] });

  await signIn(page, username);
  await page.goto(`/control?event=${A.event.id}`);
  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA HA", { timeout: 10_000 });
  await expect(cardB.locator(".cv2-live-diver")).toContainText("AAA HB", { timeout: 10_000 });

  await cardA.locator(".cv2-pool-hold").click();
  await expect(cardA.locator(".cv2-pool-heldbar")).toBeVisible();
  await expect(page.locator(".cv2-hold-banner")).toBeVisible();

  // Focus B: its banner is clear, because B isn't held
  await cardA.locator(".cv2-live-diver").click();
  await page.keyboard.press("2");
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Hold Pool B");
  await expect(page.locator(".cv2-hold-banner")).toHaveCount(0);

  // 'h' holds B, and A stays held
  await page.keyboard.press("h");
  await expect(cardB.locator(".cv2-pool-heldbar")).toBeVisible();
  await expect(cardA.locator(".cv2-pool-heldbar")).toBeVisible();
  await expect(page.locator(".cv2-hold-banner")).toBeVisible();
  await setup.deleteOrg(orgId);
});

// The card's referee buttons cancel its auto-next countdown before acting;
// the f / r / c hotkeys queued the same call from the view and couldn't
// reach the card's timer, so the countdown ran on and moved to the next
// diver mid-review.
test("a referee hotkey stops the focused pool's auto-next countdown", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Keyboard Referee Diving" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Referee Pool", diverNames: ["AAA RF", "ZZZ RF"] });
  const room = await roomWatcher(baseURL, A.event.id);

  await signIn(page, username);
  await page.goto(`/control?event=${A.event.id}`);
  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA RF", { timeout: 10_000 });
  await expect.poll(() => room.seen.state.length, { timeout: 8_000 }).toBeGreaterThan(0);
  room.close();

  await cardA.locator(".cv2-split-aside").click();
  await cardA.locator(".cv2-autonext-item").filter({ hasText: /^\s*5 seconds/ }).click();

  await setup.submitPanelScores({ baseURL, judges: A.judges, eventId: A.event.id, competitorId: A.divers[0].userId, roundNumber: 1, diveId: A.diveId });
  await expect(cardA.locator(".cv2-autopill")).toBeVisible({ timeout: 6_000 });
  await cardA.locator(".cv2-live-diver").click();
  await page.keyboard.press("f");
  await expect(cardA.locator(".cv2-autopill")).toHaveCount(0);
  await page.waitForTimeout(6_500);
  await expect(cardA.locator(".cv2-live-diver")).toContainText("AAA RF");
  await setup.deleteOrg(orgId);
});
