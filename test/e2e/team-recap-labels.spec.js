// Team events in a state championship: the recap's team rows carry the
// state their divers share (migration 095), and the medal table, which
// groups by those codes, is titled by what they are.
//
// Seed: a meet set to represent divers by state, in an org whose regions
// are called states. Three teams in a completed team event:
//   East A   two East divers             -> EA
//   West A   two West divers             -> WE
//   Mixed    one East, one West diver    -> the org's country (TST)
// Every team dives two rounds, East A scores highest, so the medal
// table has three rows with a gold, a silver and a bronze.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test("team recap: state chips on team rows and a state medal table", async ({ request, page, baseURL }) => {
  test.setTimeout(120_000);
  await setup.installClickHighlight(page);

  const { orgId, adminToken, countryCode } = await setup.createOrgAndAdmin(request);
  let eventId = null;
  try {
    await setup.pool.query("UPDATE organisations SET region_label = 'state' WHERE id = $1", [orgId]);
    const region = async (name, code) => (await setup.pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, name, code],
    )).rows[0].id;
    const east = await region("East", "EA");
    const west = await region("West", "WE");
    const club = async (name, code, regionId) => {
      const { clubId } = await setup.insertClub({ orgId, name, shortCode: code });
      await setup.pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [regionId, clubId]);
      return clubId;
    };
    const eastClub = await club("East Divers", "EDV", east);
    const westClub = await club("West Divers", "WDV", west);

    const meet = await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: `E2E State Champs ${setup.rand()}`, represent_as: "region" },
    });
    expect(meet.status()).toBe(201);
    const event = await setup.createEvent(request, {
      adminToken, name: "E2E Mixed Team", event_type: "team", total_rounds: 2,
      meet_id: (await meet.json()).id,
    });
    eventId = event.id;

    const judges = [];
    for (let i = 1; i <= 5; i++) {
      judges.push((await setup.insertUser({ orgId, role: "judge", fullName: `Team Judge ${i}` })).userId);
      await setup.pool.query(
        "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)",
        [event.id, judges[i - 1], i],
      );
    }
    const dive = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

    const teams = [
      { name: "East A", code: "EAT", clubs: [eastClub, eastClub], score: 8 },
      { name: "West A", code: "WAT", clubs: [westClub, westClub], score: 7 },
      { name: "Mixed", code: "MXT", clubs: [eastClub, westClub], score: 6 },
    ];
    for (const tm of teams) {
      const teamId = (await setup.pool.query(
        "INSERT INTO teams (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [orgId, tm.name, tm.code],
      )).rows[0].id;
      await setup.pool.query("INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)", [event.id, teamId]);
      for (let i = 0; i < tm.clubs.length; i++) {
        const { userId } = await setup.insertUser({ orgId, role: "diver", fullName: `${tm.name} Diver ${i + 1}`, clubId: tm.clubs[i] });
        await setup.pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, userId]);
        await setup.pool.query(
          `INSERT INTO competitor_dive_lists (event_id, competitor_id, team_id, dive_id, round_number)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.id, userId, teamId, dive, i + 1],
        );
        for (const judgeId of judges) {
          await setup.pool.query(
            `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [event.id, userId, judgeId, dive, i + 1, tm.score],
          );
        }
      }
    }
    await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Completed" });

    await page.goto(`${baseURL}/scoreboard/${event.id}`);

    // Final standings (the default recap view): one row per team, with
    // the shared state as its chip and the team code underneath.
    const row = (name) => page.locator(".final-standings .fs-row", { hasText: name });
    await expect(row("East A")).toBeVisible({ timeout: 20_000 });
    await expect(row("East A").locator(".diver-country")).toHaveText("EA");
    await expect(row("East A").locator(".fs-club")).toHaveText("EAT");
    await expect(row("West A").locator(".diver-country")).toHaveText("WE");
    await expect(row("Mixed").locator(".diver-country")).toHaveText(countryCode);

    // The medal table groups by those codes and says they're states.
    const medal = page.locator(".medal-card");
    await expect(medal.locator(".col-head")).toHaveText("State Medal Table");
    await expect(medal.locator(".medal-head-row .medal-country")).toHaveText("State");
    await expect(medal.locator(".medal-row .medal-country")).toHaveText(["EA", "WE", countryCode]);
  } finally {
    if (eventId) await setup.pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [orgId]);
    await setup.deleteOrg(orgId);
  }
});
