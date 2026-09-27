// A club joining a region its state body has claimed, through the real
// My club and My region pages.
//
// Where there's no federation, the region a club sits in decides who
// can step in on its meets and appoint its admins, so once a region is
// claimed neither side moves a club alone: the club's admin asks, the
// region's admin accepts. The permission edges are pinned in
// test/integration.test.js; this covers the screens.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// The Bahamas: nothing else in test/ touches it.
const COUNTRY = "BHS";
const world = {};

async function wipeCountry() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

// Sign a club founder up by country, the way /register does, and
// verify them. Returns their id and club.
async function founder(request, clubName) {
  const username = `e2e-rj-${setup.rand()}`;
  const r = await request.post("/api/auth/register", {
    data: {
      username, full_name: clubName.replace(/ Divers$/, " Admin"), password: setup.TEST_PASSWORD,
      email: `${username}@example.test`, country_code: COUNTRY, new_club_name: clubName,
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  const u = await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id, org_id, club_id",
    [username],
  );
  return { username, id: u.rows[0].id, orgId: u.rows[0].org_id, clubId: u.rows[0].club_id };
}

async function signIn(page, username) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

const regionOf = async (clubId) =>
  (await setup.pool.query("SELECT region_id, requested_region_id FROM clubs WHERE id = $1", [clubId])).rows[0];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await wipeCountry();
  world.nassau = await founder(request, "Nassau Divers");
  world.freeport = await founder(request, "Freeport Divers");
  // Grand Bahama's body has claimed its region; Freeport's founder runs it.
  const rg = await setup.pool.query(
    `INSERT INTO regions (org_id, name, short_code, claim_state, claimed_name)
     VALUES ($1, 'Grand Bahama', 'GB', 'claimed', 'Grand Bahama Diving') RETURNING id`,
    [world.nassau.orgId],
  );
  world.regionId = rg.rows[0].id;
  await setup.pool.query("UPDATE clubs SET region_id = $1 WHERE id = $2", [world.regionId, world.freeport.clubId]);
  await setup.pool.query(
    "INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)",
    [world.regionId, world.freeport.id, world.nassau.orgId],
  );
});

test.afterAll(wipeCountry);

test("a club asks to join a claimed region, and the region accepts", async ({ page }) => {
  await signIn(page, world.nassau.username);
  await page.goto("/club");

  const picker = page.locator(`#region-${world.nassau.clubId}`);
  await picker.selectOption(world.regionId);
  await expect(page.getByText(/Request sent\. Grand Bahama Diving decides/)).toBeVisible();
  // Nothing moved: the picker is back where the club is, and says it's waiting.
  await expect(picker).toHaveValue("");
  await expect(page.locator("[data-test-id=region-request-pending]")).toContainText("Waiting for Grand Bahama Diving");
  expect(await regionOf(world.nassau.clubId)).toEqual({ region_id: null, requested_region_id: world.regionId });

  // Over to Grand Bahama's admin.
  await page.context().clearCookies();
  await signIn(page, world.freeport.username);
  await page.goto("/region");
  const asking = page.locator("[data-test-id=region-club-requests]");
  await expect(asking).toContainText("Nassau Divers");
  await asking.getByRole("button", { name: "Approve" }).click();
  await expect(asking).toHaveCount(0);
  expect(await regionOf(world.nassau.clubId)).toEqual({ region_id: world.regionId, requested_region_id: null });

  // And it can let the club go again.
  const nassauRow = page.locator("li", { hasText: "Nassau Divers" });
  await nassauRow.getByRole("button", { name: "Take out of region" }).click();
  await expect(nassauRow).toHaveCount(0);
  expect((await regionOf(world.nassau.clubId)).region_id).toBeNull();
});

test("a club can withdraw its ask", async ({ page }) => {
  await signIn(page, world.nassau.username);
  await page.goto("/club");
  await page.locator(`#region-${world.nassau.clubId}`).selectOption(world.regionId);
  const pending = page.locator("[data-test-id=region-request-pending]");
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "Withdraw request" }).click();
  await expect(pending).toHaveCount(0);
  expect(await regionOf(world.nassau.clubId)).toEqual({ region_id: null, requested_region_id: null });
});
