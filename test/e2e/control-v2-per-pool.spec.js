// Per-pool controllers (#1, #2, #4): each LivePoolCard owns its own shot
// clock, auto-advance, and meet-hold. Proves a non-focused pool still runs
// its own clock and auto-advances itself, and that holding one pool leaves
// the other untouched. Flag-on only (V2 surface).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

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

test("a NON-focused pool runs its own clock and auto-advances itself", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Per Pool Auto" });
  await setup.insertClub({ orgId, name: "PP Club", shortCode: "PPC" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Pool A", diverNames: ["AAA A", "ZZZ A"] });
  const B = await liveEvent(request, { orgId, adminToken, name: "Pool B", diverNames: ["AAA B", "ZZZ B"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Pool A"); // focus A

  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);

  // #1: both pools show their own shot clock, not just the focused one.
  await expect(cardA.locator(".cv2-shotclock")).toBeVisible();
  await expect(cardB.locator(".cv2-shotclock")).toBeVisible();
  await expect(cardB.locator(".cv2-live-diver")).toContainText("AAA B");

  // Set Pool B's own auto-next to 5s via B's card while A stays focused.
  await cardB.locator(".cv2-split-aside").click();
  await cardB.getByRole("menuitemradio", { name: "5 seconds", exact: true }).click();
  await expect(cardB.locator(".cv2-autonext-menu")).toHaveCount(0);

  // A full panel for B's active diver arms B's countdown, so B advances to
  // its second diver unaided, without ever focusing B (focus stays on A).
  await setup.submitPanelScores({
    baseURL, judges: B.judges, eventId: B.event.id,
    competitorId: B.divers[0].userId, roundNumber: 1, diveId: B.diveId,
  });
  await expect(cardB.locator(".cv2-autopill")).toBeVisible({ timeout: 6_000 });
  await expect(cardB.locator(".cv2-live-diver")).toContainText("ZZZ B", { timeout: 12_000 });
  // Focus never left Pool A
  await expect(page.locator(".cv2-chip.is-focused")).toContainText("Pool A");
});

test("holding one pool leaves the other pool running", async ({ request, page }) => {
  test.setTimeout(120_000);
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "AUS", orgName: "Per Pool Hold" });
  await setup.insertClub({ orgId, name: "PH Club", shortCode: "PHC" });
  const A = await liveEvent(request, { orgId, adminToken, name: "Pool A", diverNames: ["AAA A", "ZZZ A"] });
  const B = await liveEvent(request, { orgId, adminToken, name: "Pool B", diverNames: ["AAA B", "ZZZ B"] });

  await signIn(page, username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await setup.selectControlEvent(page, "Pool A");

  const cardA = page.locator(`.cv2-pool[data-event-id="${A.event.id}"]`);
  const cardB = page.locator(`.cv2-pool[data-event-id="${B.event.id}"]`);

  // Hold Pool B from its own card
  await cardB.locator(".cv2-pool-hold").click();
  await expect(cardB.locator(".cv2-pool-heldbar")).toBeVisible();
  await expect(cardB).toHaveClass(/is-held/);
  // Pool A is untouched, no held bar
  await expect(cardA.locator(".cv2-pool-heldbar")).toHaveCount(0);

  // Resume B, its held state should clear
  await cardB.locator(".cv2-pool-hold").click();
  await expect(cardB.locator(".cv2-pool-heldbar")).toHaveCount(0);
});
