// The Control Room has to come back with the live dive's scores.
//
// The rehearsal found it three separate times: reload the Control Room
// (or open it on a second laptop, or let its socket drop while judges
// score) and the dive on the stage came back with five empty tiles and
// "Waiting for 5 more judge scores", while History beside it listed the
// same dive fully scored. The judges' keypads are shut once they've
// scored, so nobody could send anything again, Next (or Finalise on the
// last dive) never armed, and Skip was the only way out. Its dialog then
// said no score was recorded for the dive, which wasn't true either.
//
// The pool now puts back what the server has stored for the dive it lands
// on: on a fresh load, after a reconnect, and when it picks up from the
// history because the server has nobody up (an undone finalise).
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");
const { signIn, liveEvent } = require("./_meetday");

test.describe.configure({ mode: "serial" });

const world = {};

test.beforeAll(async ({ request }) => {
  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Reload Scores Diving",
  });
  Object.assign(world, { orgId, username, adminToken });
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

// Two divers, one round, AAA first.
async function twoDivers(request, name) {
  const made = await liveEvent(request, {
    orgId: world.orgId, adminToken: world.adminToken, name,
    diverNames: [`AAA ${name}`, `BBB ${name}`], status: "Upcoming",
  });
  await setup.pool.query(
    "UPDATE competitor_dive_lists SET display_order = CASE competitor_id WHEN $2 THEN 1 ELSE 2 END WHERE event_id = $1",
    [made.event.id, made.divers[0].userId],
  );
  await setup.setEventStatus(request, { adminToken: world.adminToken, eventId: made.event.id, status: "Live" });
  return made;
}

function scoreJudges(baseURL, w, diverIdx, judges, scores) {
  return setup.submitPanelScores({
    baseURL, judges, eventId: w.event.id,
    competitorId: w.divers[diverIdx].userId, roundNumber: 1, diveId: w.diveId, scores,
  });
}

async function storedCount(eventId, competitorId) {
  const r = await setup.pool.query(
    "SELECT count(*)::int AS n FROM scores WHERE event_id = $1 AND competitor_id = $2 AND round_number = 1",
    [eventId, competitorId],
  );
  return r.rows[0].n;
}

// Who the server has up. Judges only ever score the diver their phone was
// sent, so each test waits for the Control Room's announce to land before
// scoring, the same order a real meet runs in.
async function serverDiver(eventId) {
  const r = await setup.pool.query(
    "SELECT active_diver_payload->>'full_name' AS n FROM event_live_state WHERE event_id = $1", [eventId],
  );
  return r.rows[0]?.n ?? null;
}

async function openControl(page, eventId) {
  await page.goto(`/control?event=${eventId}`);
  const card = page.locator(`.cv2-pool[data-event-id="${eventId}"]`);
  await expect(card.locator(".cv2-live-diver")).toBeVisible({ timeout: 10_000 });
  return card;
}

function tiles(card) {
  return card.locator(".cv2-tile");
}

test("a reload with the whole panel in comes back armed, and doesn't start the auto-next countdown", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDivers(request, "Full Reload");
  await signIn(page, world.username);
  let card = await openControl(page, w.event.id);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Full Reload");
  await expect.poll(() => serverDiver(w.event.id), { timeout: 8_000 }).toBe("AAA Full Reload");

  await scoreJudges(baseURL, w, 0, w.judges, [7, 7.5, 8, 8.5, 9]);
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });

  // The operator runs a 5 s auto-next. A reload shouldn't fire it off by
  // itself: nobody has seen this dive finish on this screen yet.
  await page.evaluate((key) => localStorage.setItem(key, "5"), `dr_control_auto_advance_seconds:${w.event.id}`);
  await page.reload();
  card = await openControl(page, w.event.id);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Full Reload");
  await expect(tiles(card)).toHaveText(["7.0", "7.5", "8.0", "8.5", "9.0"], { timeout: 8_000 });
  const primary = card.locator(".cv2-primary");
  await expect(primary).toBeEnabled();
  await expect(primary).toContainText(/Next Diver/);
  await expect(card.locator(".cv2-skip")).toHaveCount(0);
  await expect(card.locator(".cv2-autopill")).toHaveCount(0);
  await page.waitForTimeout(6_500);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Full Reload");

  // And Next still works by hand.
  await primary.click();
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Full Reload");
});

test("a reload part way through a dive keeps the scores in, and the rest arm Next", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDivers(request, "Part Reload");
  await signIn(page, world.username);
  let card = await openControl(page, w.event.id);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Part Reload");
  await expect.poll(() => serverDiver(w.event.id), { timeout: 8_000 }).toBe("AAA Part Reload");
  await scoreJudges(baseURL, w, 0, w.judges.slice(0, 2), [9, 7]);
  await expect(tiles(card).nth(1)).toHaveText("7.0", { timeout: 8_000 });

  await page.reload();
  card = await openControl(page, w.event.id);
  await expect(tiles(card)).toHaveText(["9.0", "7.0", "—", "—", "—"], { timeout: 8_000 });
  await expect(card.locator(".cv2-blockers")).toContainText("Waiting for 3 more judge scores");

  // Skip asks with the real count, not "nothing has reached this screen".
  await card.locator(".cv2-skip").click();
  const dialog = page.locator(".confirm-modal");
  await expect(dialog.locator(".confirm-body")).toContainText("Only 2 of 5 judges have submitted");
  await dialog.locator(".confirm-btn-cancel").click();
  await expect(dialog).toHaveCount(0);

  await scoreJudges(baseURL, w, 0, w.judges.slice(2), [7.5, 8, 8.5]);
  await expect(tiles(card)).toHaveText(["9.0", "7.0", "7.5", "8.0", "8.5"], { timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toBeEnabled();
});

test("a Control Room opened on a finished event put back to Live can finalise it", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDivers(request, "Back Live");
  await scoreJudges(baseURL, w, 0, w.judges);
  await scoreJudges(baseURL, w, 1, w.judges, [6, 6.5, 7, 7.5, 8]);
  // Finalised, then put back from the Manager: the server has nobody up.
  await setup.setEventStatus(request, { adminToken: world.adminToken, eventId: w.event.id, status: "Completed" });
  await setup.setEventStatus(request, { adminToken: world.adminToken, eventId: w.event.id, status: "Live" });

  await signIn(page, world.username);
  const card = await openControl(page, w.event.id);
  await expect(card.locator(".cv2-live-diver")).toContainText("BBB Back Live");
  await expect(tiles(card)).toHaveText(["6.0", "6.5", "7.0", "7.5", "8.0"], { timeout: 8_000 });
  const primary = card.locator(".cv2-primary");
  await expect(primary).toHaveClass(/is-finalise/);
  await expect(primary).toBeEnabled();
  await primary.click();
  await page.locator(".confirm-btn-primary").click();
  await expect(page.locator('.cv2-mode[aria-label="Review"]')).toBeVisible({ timeout: 6_000 });
});

test("scores sent while the Control Room was offline are there when it reconnects", async ({ page, request, baseURL, context }) => {
  test.setTimeout(120_000);
  const w = await twoDivers(request, "Blip");
  await signIn(page, world.username);
  const card = await openControl(page, w.event.id);
  await expect(card.locator(".cv2-live-diver")).toContainText("AAA Blip");
  await expect.poll(() => serverDiver(w.event.id), { timeout: 8_000 }).toBe("AAA Blip");

  await context.setOffline(true);
  // Long enough for the socket to notice and drop.
  await page.waitForTimeout(1_500);
  await scoreJudges(baseURL, w, 0, w.judges.slice(0, 2), [6.5, 7]);
  expect(await storedCount(w.event.id, w.divers[0].userId)).toBe(2);
  await context.setOffline(false);

  await expect(tiles(card)).toHaveText(["6.5", "7.0", "—", "—", "—"], { timeout: 15_000 });
  await scoreJudges(baseURL, w, 0, w.judges.slice(2), [7.5, 8, 8.5]);
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });
});

// The referee's calls already made on the dive come back with it: a
// Failed dive comes back at 0 and still armed, a re-dive's set-aside
// panel doesn't come back at all (those judges have to score again).
test("a reload keeps a Failed call's zeros, and leaves a re-dive's old panel out", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const w = await twoDivers(request, "Calls");
  await signIn(page, world.username);
  let card = await openControl(page, w.event.id);
  await expect.poll(() => serverDiver(w.event.id), { timeout: 8_000 }).toBe("AAA Calls");
  await scoreJudges(baseURL, w, 0, w.judges, [6, 7, 7, 8, 8]);
  await expect(card.locator(".cv2-primary")).toBeEnabled({ timeout: 8_000 });
  await card.locator(".cv2-ref-failed").click();
  await expect(tiles(card)).toHaveText(["0.0", "0.0", "0.0", "0.0", "0.0"], { timeout: 6_000 });

  await page.reload();
  card = await openControl(page, w.event.id);
  await expect(tiles(card)).toHaveText(["0.0", "0.0", "0.0", "0.0", "0.0"], { timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toBeEnabled();

  // Re-dive: the old panel is set aside until each judge scores again.
  await card.locator(".cv2-ref-btn", { hasText: "Re-dive" }).click();
  await expect(card.locator(".cv2-tile.scored")).toHaveCount(0, { timeout: 6_000 });
  await scoreJudges(baseURL, w, 0, w.judges.slice(0, 2), [5, 5.5]);
  await expect(card.locator(".cv2-tile.scored")).toHaveCount(2, { timeout: 6_000 });

  await page.reload();
  card = await openControl(page, w.event.id);
  await expect(tiles(card)).toHaveText(["5.0", "5.5", "—", "—", "—"], { timeout: 8_000 });
  await expect(card.locator(".cv2-primary")).toBeDisabled();
});

// Synchro: every seat's score goes back on its own tile, so Exec A, Exec B
// and Sync keep their judges.
test("a synchro panel comes back seat by seat", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const made = await liveEvent(request, {
    orgId: world.orgId, adminToken: world.adminToken, name: "Sync Reload",
    diverNames: ["AAA Sync Reload"], judges: 9, eventType: "synchro_pair",
  });
  await signIn(page, world.username);
  let card = await openControl(page, made.event.id);
  await expect.poll(() => serverDiver(made.event.id), { timeout: 8_000 }).toBe("AAA Sync Reload");
  // Seats 1, 3, 6 and 9 score; the other five are still to come.
  const seats = [0, 2, 5, 8];
  for (const i of seats) {
    await setup.submitJudgeScore({
      baseURL, token: made.judges[i].token, eventId: made.event.id,
      competitorId: made.divers[0].userId, roundNumber: 1, diveId: made.diveId, score: 5 + i / 2,
    });
  }
  await page.reload();
  card = await openControl(page, made.event.id);
  await expect(tiles(card)).toHaveText(["5.0", "—", "6.0", "—", "—", "7.5", "—", "—", "9.0"], { timeout: 8_000 });
  await expect(card.locator(".cv2-blockers")).toContainText("Waiting for 5 more judge scores");
});
