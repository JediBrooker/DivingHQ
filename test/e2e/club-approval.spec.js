// Federation approval of new clubs (migration 096), through the real
// screens: a founder signs up under a claimed federation and is told the
// club waits; the federation's org admin approves it from Clubs, fixing
// its code and making the founder its admin; the founder then has My club.
//
// The rules behind it (who may decide, what a pending club can't do,
// reject, the auto-join setting, claim revokes) are in
// test/integration.test.js.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Mali: no other spec, test or seed uses it. Specs run in parallel and each
// wipes its own country, so it has to stay that way.
const COUNTRY = "MLI";

async function wipeCountry() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

async function signIn(page, username) {
  // A fresh org admin would otherwise be sent to the setup wizard.
  await page.addInitScript(() => {
    try { localStorage.setItem("setup.wizardDismissed.v1", "1") } catch { /* ignore */ }
  });
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test.describe.configure({ mode: "serial" });
test.beforeAll(wipeCountry);
test.afterAll(wipeCountry);

test("a club founded under a federation waits for it, then its founder runs it", async ({ page, browser, request }) => {
  await setup.installClickHighlight(page);
  const fed = await setup.createOrgAndAdmin(request, { countryCode: COUNTRY, orgName: "Fédération Malienne de Plongeon" });
  const username = `e2e-appr-${setup.rand()}`;

  // Sign up and found a club. The form says it'll wait for the federation.
  await page.goto("/register");
  await page.locator('input[autocomplete="name"]').fill("Aminata Traoré");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="email"]').fill(`${username}@example.test`);
  await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
  await page.locator("select").first().selectOption(COUNTRY);
  const club = page.locator("select").filter({ has: page.locator('option[value="new"]') });
  await club.selectOption("new");
  await page.getByPlaceholder("e.g. Sydney Springboard").fill("Bamako Divers");
  await expect(page.getByTestId("club-needs-approval")).toContainText("Fédération Malienne de Plongeon approves new clubs");
  await expect(page.getByText(/You'll be this club's admin/)).toHaveCount(0);
  await page.getByRole("button", { name: /Create Account/i }).click();
  await expect(page.getByTestId("check-inbox")).toBeVisible();
  await expect(page.getByTestId("club-pending-note"))
    .toContainText("Bamako Divers is waiting for Fédération Malienne de Plongeon to approve it");

  const row = (await setup.pool.query(
    `SELECT c.id, c.status, u.id AS user_id FROM clubs c JOIN users u ON u.id = c.created_by
      WHERE c.org_id = $1 AND c.name = 'Bamako Divers'`, [fed.orgId],
  )).rows[0];
  expect(row.status).toBe("pending");
  // No inbox in e2e: stand in for the verify click.
  await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [row.user_id]);

  // The founder can sign in; the dashboard says what's waiting, and there's
  // no My club yet.
  const founderCtx = await browser.newContext();
  const founderPage = await founderCtx.newPage();
  try {
    await setup.installClickHighlight(founderPage);
    await signIn(founderPage, username);
    await expect(founderPage.getByText(/club awaiting approval/i).first()).toBeVisible();
    const nav = founderPage.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: /My club/ })).toHaveCount(0);

    // The federation's admin sees it on the dashboard and decides on Clubs.
    await signIn(page, fed.username);
    await expect(page.getByText(/New clubs/).first()).toBeVisible();
    await page.goto("/clubs");
    const panel = page.getByTestId("pending-clubs");
    await expect(panel).toContainText("Bamako Divers");
    await expect(panel).toContainText("Started by Aminata Traoré");
    await expect(panel).toContainText("Email verified");
    await expect(page.getByTestId("clubs-stat-pending")).toContainText("1");
    // It isn't in the registry table until it's approved.
    await expect(page.locator(".club-row", { hasText: "Bamako Divers" })).toHaveCount(0);

    await panel.getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByTestId("club-approve-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Code").fill("bko");
    await expect(dialog.getByLabel(/Make Aminata Traoré the club's admin/)).toBeChecked();
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Bamako Divers approved")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".club-row", { hasText: "Bamako Divers" })).toContainText("BKO");

    const after = (await setup.pool.query(
      `SELECT c.status, c.short_code,
              EXISTS (SELECT 1 FROM club_admins ca WHERE ca.club_id = c.id AND ca.user_id = $2) AS founder_admin
         FROM clubs c WHERE c.id = $1`, [row.id, row.user_id],
    )).rows[0];
    expect(after).toEqual({ status: "active", short_code: "BKO", founder_admin: true });

    // The founder's next page load picks it up: My club, and no waiting chip.
    await founderPage.goto("/dashboard");
    await expect(founderPage.getByText(/club awaiting approval/i)).toHaveCount(0);
    await expect(nav.getByRole("link", { name: /My club/ })).toBeVisible();
    await nav.getByRole("link", { name: /My club/ }).click();
    await founderPage.waitForURL(/\/club$/);
    await expect(founderPage.getByText("Bamako Divers").first()).toBeVisible();
    // Under a federation its role requests go to the federation, so My club
    // says that rather than promising requests that never come.
    await expect(founderPage.getByTestId("requests-federation")).toHaveText("Your federation reviews your members' role requests.");
    await expect(founderPage.getByText("No requests waiting")).toHaveCount(0);
    await expect(founderPage.getByText(/Approve your members' role requests/)).toHaveCount(0);
  } finally {
    await founderCtx.close();
  }
});

test("the federation can let new clubs join automatically", async ({ page, request }) => {
  await setup.installClickHighlight(page);
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
  const fed = orgs.rows.length
    ? null
    : await setup.createOrgAndAdmin(request, { countryCode: COUNTRY, orgName: "Fédération Malienne de Plongeon" });
  const orgId = fed ? fed.orgId : orgs.rows[0].id;
  const admin = fed
    ? fed.username
    : (await setup.pool.query(
        `SELECT u.username FROM users u JOIN user_org_roles r ON r.user_id = u.id
          WHERE r.org_id = $1 AND r.role = 'org_admin' LIMIT 1`, [orgId],
      )).rows[0].username;

  await signIn(page, admin);
  await page.goto("/clubs");
  const setting = page.locator("#club-join-setting");
  await expect(setting).toHaveValue("approval");
  await setting.selectOption("auto");
  await expect(page.getByText("New clubs will join automatically")).toBeVisible();
  await expect.poll(async () =>
    (await setup.pool.query("SELECT auto_approve_clubs FROM organisations WHERE id = $1", [orgId])).rows[0].auto_approve_clubs,
  ).toBe(true);

  // Signup now says the club joins straight away.
  await page.goto("/register");
  await page.locator("select").first().selectOption(COUNTRY);
  await page.locator("select").filter({ has: page.locator('option[value="new"]') }).selectOption("new");
  await expect(page.getByTestId("club-joins-now")).toContainText("New clubs join Fédération Malienne de Plongeon straight away");
  await expect(page.getByTestId("club-needs-approval")).toHaveCount(0);
});
