// Club-first follow-ups, through the real UI: the fixes that only show up
// on screen. Server-side edges live in test/integration.test.js; the pure
// logic has unit tests (use-club-scope, plural).
//
// Every test works in its own small, otherwise unused country so nothing
// here collides with other specs (or other checkouts) sharing the DB.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const COUNTRIES = ["PCN", "FLK", "CXR", "ABW", "TCA", "VGB", "BMU", "ASM"];

async function wipe() {
  const orgs = await setup.pool.query(
    "SELECT id FROM organisations WHERE country_code = ANY($1::text[])", [COUNTRIES],
  );
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM claims WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

test.describe.configure({ mode: "serial" });
test.beforeAll(wipe);
test.afterAll(wipe);

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/(dashboard|setup)/, { timeout: 10_000 });
}

// A club founder in a country nobody else is in yet, email already verified.
async function founder(request, country, clubName) {
  const username = `e2e-cff-${setup.rand()}`;
  const r = await request.post("/api/auth/register", {
    data: { username, full_name: `${clubName} Admin`, password: setup.TEST_PASSWORD,
            email: `${username}@example.test`, country_code: country, new_club_name: clubName },
  });
  expect(r.status()).toBe(201);
  const u = await setup.pool.query(
    `UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id, org_id, club_id`, [username],
  );
  return { username, ...u.rows[0] };
}

// An org with regions and a club in each, set up straight in the DB.
async function orgWithRegions(country, label, regions) {
  const org = (await setup.pool.query(
    `INSERT INTO organisations (name, slug, country_code, status, region_label)
     VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [`${country} Diving`, `e2e-${country.toLowerCase()}-${setup.rand()}`, country, label],
  )).rows[0];
  const out = { orgId: org.id, regions: {} };
  for (const [code, name, clubName] of regions) {
    const rg = (await setup.pool.query(
      "INSERT INTO regions (org_id, name, short_code) VALUES ($1, $2, $3) RETURNING id", [org.id, name, code],
    )).rows[0];
    const club = (await setup.pool.query(
      "INSERT INTO clubs (org_id, name, region_id) VALUES ($1, $2, $3) RETURNING id", [org.id, clubName, rg.id],
    )).rows[0];
    out.regions[code] = { id: rg.id, clubId: club.id };
  }
  return out;
}

test("a club admin sees members' requests on the dashboard, and can step down cleanly", async ({ page, request }) => {
  test.setTimeout(90_000);
  await setup.installClickHighlight(page);
  const A = await founder(request, "PCN", "Adamstown Divers");

  // A member of the club asks to judge.
  const memberName = `e2e-cfm-${setup.rand()}`;
  const reg = await request.post("/api/auth/register", {
    data: { username: memberName, full_name: "Mele Christian", password: setup.TEST_PASSWORD,
            email: `${memberName}@example.test`, org_id: A.org_id, club_id: A.club_id, requested_role: "judge" },
  });
  expect(reg.status()).toBe(201);
  await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE username = $1", [memberName]);

  // The founder has no dashboard tab of their own, but gets the chip, and
  // it goes straight to the page where they approve.
  await signIn(page, A.username);
  const chip = page.locator(".pulse-chip", { hasText: /pending/i });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("1");
  await chip.click();
  await page.waitForURL(/\/club$/);
  // exact: the member also shows up in the "Add an admin" picker.
  await expect(page.getByText("Mele Christian", { exact: true })).toBeVisible();
  await expect(page.getByText("2 members")).toBeVisible();

  // Alone, the founder can't step down, and the button says why instead
  // of letting them click through to the server's refusal.
  const myRow = page.locator(".row", { hasText: "Adamstown Divers Admin" });
  const removeMe = myRow.getByRole("button", { name: "Remove" });
  await expect(removeMe).toBeDisabled();
  await expect(removeMe).toHaveAttribute("data-tip", /A club needs at least one admin/);

  // Make the member a co-admin, then the founder removes themselves.
  await page.getByRole("combobox", { name: "Add an admin" }).selectOption({ label: `Mele Christian (@${memberName})` });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(removeMe).toBeEnabled();
  await expect(removeMe).not.toHaveAttribute("data-tip", /./);
  await removeMe.click();
  await page.getByRole("button", { name: "Remove me" }).click();

  // Straight back to the dashboard, with the club gone from the nav.
  await page.waitForURL(/\/dashboard$/);
  await expect(page.getByText(/no longer an admin of Adamstown Divers/)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /My club/ })).toHaveCount(0);
  const left = await setup.pool.query("SELECT 1 FROM club_admins WHERE user_id = $1", [A.id]);
  expect(left.rows).toHaveLength(0);
});

test("a claimant finds their claim after signing in; a failed load offers a retry", async ({ page, request }) => {
  test.setTimeout(90_000);
  await setup.installClickHighlight(page);
  await founder(request, "FLK", "Stanley Divers");

  // The website goes in the way people write it, no https://.
  const fedUser = `e2e-cfc-${setup.rand()}`;
  await page.goto("/register-org");
  await page.locator("#org-name").fill("Falklands Diving Association");
  await page.locator("#org-country").selectOption("FLK");
  await expect(page.locator(".claim-note")).toBeVisible();
  await page.locator("#org-website").fill("falklandsdiving.fk");
  await page.locator('input[autocomplete="name"]').fill("Jane Cameron");
  await page.locator('input[type="email"]').fill(`${fedUser}@example.test`);
  await page.locator('input[autocomplete="username"]').fill(fedUser);
  await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Submit Registration/i }).click();
  await expect(page.getByTestId("register-org-next")).toBeVisible();
  const claimRow = await setup.pool.query(
    `SELECT cl.website FROM claims cl JOIN users u ON u.id = cl.claimant_id WHERE u.username = $1`, [fedUser],
  );
  expect(claimRow.rows[0].website).toBe("falklandsdiving.fk");

  // Stand in for the emailed link.
  const fedId = (await setup.pool.query("SELECT id FROM users WHERE username = $1", [fedUser])).rows[0].id;
  await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fedId]);
  expect(await require("../../lib/claims").activateForUser(setup.pool, fedId)).toBe(1);

  await signIn(page, fedUser);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /Claims/ })).toBeVisible();
  const chip = page.locator(".pulse-chip", { hasText: /open claim/i });
  await expect(chip).toBeVisible();
  await chip.click();
  await page.waitForURL(/\/claims$/);
  await expect(page.getByText("Falklands Diving Association")).toBeVisible();

  // A 500 isn't "no claims".
  await page.route("**/api/claims", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: /Couldn't load this/ })).toBeVisible();
  await expect(page.getByText("No claims")).toHaveCount(0);
  await page.unroute("**/api/claims");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Falklands Diving Association")).toBeVisible();
});

test("register: switching region drops a hidden club, and a slow region list can't land late", async ({ page }) => {
  test.setTimeout(60_000);
  await setup.installClickHighlight(page);
  const cxr = await orgWithRegions("CXR", "state", [["AA", "Alpha", "Alpha Divers"], ["BB", "Beta", "Beta Divers"]]);
  await orgWithRegions("ABW", "province", [["CC", "Gamma", "Gamma Divers"]]);

  await page.goto("/register");
  const country = page.locator("select").first();
  const region = page.locator("#reg-region");
  const club = page.locator("select").filter({ has: page.locator('option[value="new"]') });

  await country.selectOption("CXR");
  await region.selectOption("AA");
  await club.selectOption({ label: "Alpha Divers" });
  await region.selectOption("BB");
  await expect(club).toHaveValue("");

  // Hold CXR's region list back, move on to Aruba, then let it through.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route(`**/api/orgs/${cxr.orgId}/regions`, async (route) => { await held; await route.continue(); });
  await country.selectOption("");
  const slow = page.waitForRequest(`**/api/orgs/${cxr.orgId}/regions`);
  await country.selectOption("CXR");
  await slow;
  await country.selectOption("ABW");
  await expect(region.locator("option", { hasText: "Gamma" })).toHaveCount(1);
  release();
  // Give the stale answer time to arrive and (not) land.
  await page.waitForTimeout(500);
  await expect(region.locator("option", { hasText: "Gamma" })).toHaveCount(1);
  await expect(region.locator("option", { hasText: "Alpha" })).toHaveCount(0);
});

test("clubs: meet managers see each club's region; seeding is only offered where it works", async ({ page, request }) => {
  test.setTimeout(60_000);
  await setup.installClickHighlight(page);
  const { orgId } = await setup.createOrgAndAdmin(request, { countryCode: "TCA", orgName: "Turks Diving" });
  const rg = (await setup.pool.query(
    "INSERT INTO regions (org_id, name, short_code) VALUES ($1, 'Grand Turk', 'GT') RETURNING id", [orgId],
  )).rows[0];
  await setup.pool.query("UPDATE organisations SET region_label = 'region' WHERE id = $1", [orgId]);
  await setup.pool.query("INSERT INTO clubs (org_id, name, region_id) VALUES ($1, 'Cockburn Divers', $2)", [orgId, rg.id]);
  const mm = await setup.insertUser({ orgId, role: "meet_manager", fullName: "Turks Manager" });

  await signIn(page, mm.username);
  await page.goto("/clubs");
  const row = page.locator("tr.club-row", { hasText: "Cockburn Divers" });
  await expect(row).toContainText("GT");
  await expect(page.getByRole("button", { name: "Set up regions" })).toHaveCount(0);
  await page.context().clearCookies();

  // A federation in a country with no built-in list doesn't get the button.
  const vgb = await setup.createOrgAndAdmin(request, { countryCode: "VGB", orgName: "BVI Diving" });
  await signIn(page, vgb.username);
  await page.goto("/clubs");
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up regions" })).toHaveCount(0);
  await expect(page.locator(".regions-panel")).toHaveCount(0);
});

test("claim voting rules: an emptied field can't be saved", async ({ page, request }) => {
  test.setTimeout(60_000);
  await setup.installClickHighlight(page);
  const { orgId } = await setup.createOrgAndAdmin(request, { countryCode: "TCA", orgName: "Turks Sysadmin" });
  const sys = await setup.insertUser({ orgId, role: "spectator", fullName: "Platform Operator" });
  await setup.pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [sys.userId]);

  await signIn(page, sys.username);
  await page.goto("/admin/features");
  await expect(page.getByRole("heading", { name: "Claim voting rules" })).toBeVisible();
  const input = page.locator("#set-claim_voter_min_age_days");
  const row = page.locator(".ff-row", { has: input });
  const save = row.getByRole("button", { name: "Save" });
  const original = await input.inputValue();

  await input.fill("");
  await expect(row.getByText("Enter a value.")).toBeVisible();
  await expect(save).toBeDisabled();
  await input.fill("999");
  await expect(row.getByText("Enter a value from 0 to 365.")).toBeVisible();
  await expect(save).toBeDisabled();
  await input.fill(original);
  await expect(row.locator(".ff-err")).toHaveCount(0);
  await expect(save).toBeDisabled();   // unchanged, nothing to save
});

test("control room: a referee who also admins a club still sees the federation's events", async ({ page, request }) => {
  test.setTimeout(60_000);
  await setup.installClickHighlight(page);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: "BMU", orgName: "Bermuda Diving" });
  const ev = await setup.createEvent(request, { adminToken, name: "Bermuda Nationals 3m" });
  const { clubId } = await setup.insertClub({ orgId, name: "Hamilton Divers", shortCode: "HAM" });
  const ref = await setup.insertUser({ orgId, role: "referee", fullName: "Bermuda Referee", clubId });
  await setup.pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [clubId, ref.userId, orgId]);

  await signIn(page, ref.username);
  await page.goto("/control");
  await page.waitForLoadState("networkidle");
  await page.locator(".cv2-allbtn").click();
  await expect(page.locator(".cv2-allitem", { hasText: ev.name })).toBeVisible();
});

test("dashboard: the pending chip names the requested role in the reader's words", async ({ page, request }) => {
  test.setTimeout(60_000);
  await setup.installClickHighlight(page);
  const { orgId, username } = await setup.createOrgAndAdmin(request, { countryCode: "ASM", orgName: "Samoa Pago Diving" });
  // Two roles role.* never had a name for: the chip used to print
  // "Manager" for one and the raw "coach" for the other.
  const mm = await setup.insertUser({ orgId, role: "spectator", fullName: "Would-be Manager" });
  const coach = await setup.insertUser({ orgId, role: "spectator", fullName: "Would-be Coach" });
  await setup.pool.query(
    "INSERT INTO role_requests (user_id, org_id, requested_role) VALUES ($1, $3, 'meet_manager'), ($2, $3, 'coach')",
    [mm.userId, coach.userId, orgId],
  );

  // A fresh federation with no clubs is bounced to the setup wizard.
  await page.addInitScript(() => localStorage.setItem("setup.wizardDismissed.v1", "1"));
  await signIn(page, username);
  const chip = page.locator(".pulse-chip", { hasText: /pending/i });
  await expect(chip).toContainText("2");
  await chip.hover();
  const popover = chip.locator(".pulse-popover");
  await expect(popover.locator(".pulse-popover-item", { hasText: "Would-be Manager" })).toContainText("wants to be: Meet Manager");
  await expect(popover.locator(".pulse-popover-item", { hasText: "Would-be Coach" })).toContainText("wants to be: Coach");
  // The attention card counts them through the plural keys (counts.*).
  await expect(page.locator(".action-card", { hasText: "2 role requests waiting" })).toBeVisible();
});
