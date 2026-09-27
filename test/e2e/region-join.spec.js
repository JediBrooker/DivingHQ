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
  // Grand Bahama's only admin can't step down, and the button says why.
  const soleRemove = page.locator("[data-test-id=region-admins] li").getByRole("button", { name: "Remove" });
  await expect(soleRemove).toBeDisabled();
  await expect(soleRemove).toHaveAttribute("data-tip", /A region needs at least one admin/);
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

// Two region admins, then the other one is suspended while the page is
// open. Remove still looks live on the stale page; the server refuses,
// and the page gives the reason in the reader's words rather than the
// server's English, then greys the button out.
test("a stale My region page explains the last-admin refusal", async ({ page, request }) => {
  // A Freeport member, so a region admin the region could have picked itself.
  const username = `e2e-rj-${setup.rand()}`;
  const r = await request.post("/api/auth/register", {
    data: { username, full_name: "Lucaya Co-admin", password: setup.TEST_PASSWORD,
            email: `${username}@example.test`, org_id: world.freeport.orgId, club_id: world.freeport.clubId },
  });
  expect(r.status(), await r.text()).toBe(201);
  const co = (await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id", [username],
  )).rows[0];
  await setup.pool.query(
    "INSERT INTO region_admins (region_id, user_id, org_id) VALUES ($1, $2, $3)",
    [world.regionId, co.id, world.freeport.orgId],
  );
  await signIn(page, world.freeport.username);
  await page.goto("/region");
  const mine = page.locator("[data-test-id=region-admins] li", { hasText: "Freeport Admin" })
    .getByRole("button", { name: "Remove" });
  await expect(mine).toBeEnabled();

  await setup.pool.query("UPDATE users SET suspended_at = now() WHERE id = $1", [co.id]);
  await mine.click();
  await page.getByRole("button", { name: "Remove me" }).click();
  await expect(page.getByText("A region needs at least one admin. Add a co-admin before removing this one.")).toBeVisible();
  await expect(mine).toBeDisabled();
  const still = await setup.pool.query(
    "SELECT 1 FROM region_admins WHERE region_id = $1 AND user_id = $2", [world.regionId, world.freeport.id],
  );
  expect(still.rows).toHaveLength(1);
  await setup.pool.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [co.id]);
  world.coAdmin = co.id;
});

// Stepping down yourself: it asks first, since only another admin can put
// you back, then leaves the page (you've nothing left to see there).
test("removing yourself from My region asks first, then takes you to the dashboard", async ({ page }) => {
  await signIn(page, world.freeport.username);
  await page.goto("/region");
  const mine = page.locator("[data-test-id=region-admins] li", { hasText: "Freeport Admin" })
    .getByRole("button", { name: "Remove" });
  await expect(mine).toBeEnabled();

  // Cancelling changes nothing.
  await mine.click();
  await expect(page.getByText("Remove yourself as an admin of Grand Bahama?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  const seat = () => setup.pool.query(
    "SELECT 1 FROM region_admins WHERE region_id = $1 AND user_id = $2", [world.regionId, world.freeport.id],
  );
  expect((await seat()).rows).toHaveLength(1);

  await mine.click();
  await page.getByRole("button", { name: "Remove me" }).click();
  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByText("You're no longer an admin of Grand Bahama.")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /My region/ })).toHaveCount(0);
  expect((await seat()).rows).toHaveLength(0);
});
