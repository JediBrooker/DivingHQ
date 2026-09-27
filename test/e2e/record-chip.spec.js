// The scoreboard's record chip, end to end: real judges on real sockets,
// the record written by the live path, and the chip on the spectator's
// screen.
//
// What it pins:
//   * a diver's first go at a dive sets first marks everywhere and gets
//     no chip (the noise that got the old record toasts removed);
//   * beating a standing record puts one chip on the history card, named
//     for the biggest book, with the rest in the tooltip;
//   * the chip arrives live off record_broken even when the payload the
//     page fetched has no marks in it yet, and survives a reload from the
//     payload alone;
//   * the broadcast screen stays bare;
//   * the recap's dive-by-dive rows wear it too.
//
// The rules for which dives set records live in test/integration.test.js.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Wallis and Futuna: no other spec, seed or integration test uses it.
const COUNTRY = "WLF";

test.describe.configure({ mode: "serial" });

test("a dive that beats a standing record wears a quiet chip, a first mark doesn't", async ({
  page, request, baseURL, browser,
}) => {
  test.setTimeout(90_000);
  await setup.installClickHighlight(page);

  const admin = await setup.createOrgAndAdmin(request, { countryCode: COUNTRY, orgName: "Wallis Diving" });
  try {
    const { clubId } = await setup.insertClub({ orgId: admin.orgId, name: "Uvea Plongeon", shortCode: "UVE" });
    const first = await setup.insertUser({ orgId: admin.orgId, role: "diver", fullName: "Malia Opener", clubId });
    const second = await setup.insertUser({ orgId: admin.orgId, role: "diver", fullName: "Sina Breaker", clubId });

    const event = await setup.createEvent(request, {
      adminToken: admin.adminToken, name: "Wallis Open 3m", gender: "Female", total_rounds: 1,
    });
    const judges = [];
    for (let i = 1; i <= 5; i++) {
      const j = await setup.insertUser({ orgId: admin.orgId, role: "judge", fullName: `WLF Judge ${i}` });
      judges.push({ ...j, token: (await setup.loginAs(request, j.username)).token });
    }
    await setup.assignJudges(request, {
      adminToken: admin.adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId),
    });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    for (const d of [first, second]) {
      await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
    }
    await setup.setEventStatus(request, { adminToken: admin.adminToken, eventId: event.id, status: "Live" });

    // Malia opens every book.
    await setup.submitPanelScores({
      baseURL, judges, eventId: event.id, competitorId: first.userId, roundNumber: 1, diveId,
      scores: [6, 6, 6, 6, 6],
    });

    // The spectator's page gets its payload with the marks stripped out,
    // so a chip that shows up below can only have come off the socket.
    await page.route(`**/api/scoreboard/${event.id}`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, records: [] } });
    });
    await page.goto(`/scoreboard/${event.id}`);
    const cards = page.locator(".hist-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Malia Opener");
    await expect(page.getByTestId("record-chip")).toHaveCount(0);

    // Sina beats it, then the announcer puts her score up, which is what
    // makes a spectator's page pull the new history card.
    await setup.submitPanelScores({
      baseURL, judges, eventId: event.id, competitorId: second.userId, roundNumber: 1, diveId,
      scores: [7, 7, 7, 7, 7],
    });
    // Wait for the server's ack, and announce again if the card hasn't
    // come: under a loaded full-suite run the page's socket can still be
    // joining the event room when the first announcement goes out, and a
    // fire-and-forget emit then lands on nobody.
    const sinaCard = cards.filter({ hasText: "Sina Breaker" });
    const announcer = await setup.openSocket(baseURL, admin.adminToken);
    try {
      await expect(async () => {
        const ack = await announcer.timeout(5000).emitWithAck("announce_score", {
          event_id: event.id, competitor_id: second.userId, round_number: 1,
        });
        expect(ack?.ok).toBe(true);
        await expect(sinaCard).toHaveCount(1, { timeout: 3000 });
      }).toPass({ timeout: 30_000 });
    } finally {
      announcer.disconnect();
    }
    const chip = sinaCard.getByTestId("record-chip");
    // National beats club, so the chip names the country and the club
    // record waits in the tooltip. The personal best was her first go at
    // the dive, so it isn't mentioned at all.
    await expect(chip).toHaveText(`${COUNTRY} record`);
    await expect(chip).toHaveClass(/badge-amber/);
    const tip = await chip.getAttribute("data-tip");
    expect(tip).toContain("UVE record");
    expect(tip).toContain("Previous record: ");
    expect(tip).not.toContain("Unofficial");
    await expect(cards.filter({ hasText: "Malia Opener" }).getByTestId("record-chip")).toHaveCount(0);

    // Somebody opening the page afterwards gets the same chip from the
    // payload alone. A fresh browser context, because this one's
    // IndexedDB still holds the stripped payload for a few seconds.
    const later = await browser.newContext();
    try {
      const fresh = await later.newPage();
      await fresh.goto(`/scoreboard/${event.id}`);
      const freshCards = fresh.locator(".hist-card");
      await expect(freshCards).toHaveCount(2);
      await expect(freshCards.filter({ hasText: "Sina Breaker" }).getByTestId("record-chip"))
        .toHaveText(`${COUNTRY} record`);

      // The venue projector stays clean.
      await fresh.goto(`/scoreboard/${event.id}/broadcast`);
      await expect(freshCards).toHaveCount(2);
      await expect(fresh.getByTestId("record-chip")).toHaveCount(0);

      // And the recap's full scoresheet carries it.
      await setup.setEventStatus(request, { adminToken: admin.adminToken, eventId: event.id, status: "Completed" });
      await fresh.goto(`/scoreboard/${event.id}`);
      await fresh.getByText("Final scores only").click();
      const row = fresh.locator(".diver-block", { hasText: "Sina Breaker" }).locator(".dive-row").last();
      await expect(row.getByTestId("record-chip")).toHaveText(`${COUNTRY} record`);
      await expect(fresh.locator(".diver-block", { hasText: "Malia Opener" }).getByTestId("record-chip"))
        .toHaveCount(0);
    } finally {
      await later.close();
    }
  } finally {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [admin.orgId]);
    await setup.pool.query(
      "DELETE FROM records_club_history WHERE club_id IN (SELECT id FROM clubs WHERE org_id = $1)", [admin.orgId]);
    await setup.pool.query("DELETE FROM records_federation_history WHERE org_id = $1", [admin.orgId]);
    await setup.pool.query(
      "DELETE FROM records_personal_history WHERE user_id IN (SELECT id FROM users WHERE org_id = $1)", [admin.orgId]);
    await setup.pool.query("DELETE FROM clubs WHERE org_id = $1", [admin.orgId]);
    await setup.deleteOrg(admin.orgId);
  }
});
