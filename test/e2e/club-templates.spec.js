// Saved event templates for a club admin, through the real Meet Manager
// (migration 104, docs/club-first-onboarding.md §21).
//
// A template belongs to the organisation that saved it and nobody else, so
// in club mode the strip is pointed at the club hosting the meet: it saves
// into the club and never shows the federation's or another club's. The
// permission edges (who gets a 403 where) are in test/integration.test.js;
// this pins that the strip is back for club admins and that a saved
// template really applies.
//
// Seychelles, which no other spec touches, so the wipe can't take anybody
// else's rows with it.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const COUNTRY = "SYC";

async function wipe() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
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

// A club founder in a country nobody else is in yet: the club's admin, no
// org role, so the Manager opens in club mode.
async function founder(request, clubName) {
  const username = `e2e-ctpl-${setup.rand()}`;
  const r = await request.post("/api/auth/register", {
    data: { username, full_name: `${clubName} Admin`, password: setup.TEST_PASSWORD,
            email: `${username}@example.test`, country_code: COUNTRY, new_club_name: clubName },
  });
  expect(r.status()).toBe(201);
  const u = await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id, org_id, club_id", [username],
  );
  return { username, ...u.rows[0] };
}

// The create form's selects have a .label beside them, not a <label for>.
const field = (page, label) =>
  page.locator(".modal-create-event .field", { has: page.locator("label.label", { hasText: label }) }).locator("select").first();

async function openCreate(page) {
  await page.goto("/manager");
  await page.getByRole("button", { name: /^\+ New event$/ }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible();
}

test("a club admin saves an event template for their club and applies it", async ({ page, request }) => {
  test.setTimeout(90_000);
  await setup.installClickHighlight(page);
  const A = await founder(request, "Victoria Divers");
  const meet = (await setup.pool.query(
    "INSERT INTO meets (org_id, name, host_club_id) VALUES ($1, 'Victoria Club Night', $2) RETURNING id",
    [A.org_id, A.club_id],
  )).rows[0].id;
  // Someone else's templates in the same country: another club's, and one
  // the org itself owns. Neither is this club admin's to see.
  const other = (await setup.pool.query(
    "INSERT INTO clubs (org_id, name) VALUES ($1, 'Praslin Divers') RETURNING id", [A.org_id],
  )).rows[0].id;
  await setup.pool.query(
    "INSERT INTO event_templates (club_id, name, config) VALUES ($1, 'Praslin Sunday', '{\"gender\":\"Male\"}'::jsonb)", [other],
  );
  await setup.pool.query(
    "INSERT INTO event_templates (org_id, name, config) VALUES ($1, 'Federation Open', '{\"gender\":\"Male\"}'::jsonb)", [A.org_id],
  );

  await signIn(page, A.username);
  await openCreate(page);
  // Club mode starts the form on the club's meet, and with nothing saved
  // yet there's no strip, just the button.
  await expect(field(page, "Add to meet")).toHaveValue(meet);
  const strip = page.getByTestId("event-templates");
  await expect(strip).toHaveCount(0);

  await field(page, "Gender Category").selectOption("Female");
  await field(page, "Board / Platform Height").selectOption("3m");
  await field(page, "Judge Panel Size").selectOption("7");
  await page.getByRole("button", { name: /Save as template/ }).click();
  await expect(strip).toContainText("Templates for Victoria Divers");
  await strip.getByRole("textbox", { name: /Template name/ }).fill("Victoria Juniors 3m");
  await strip.getByRole("button", { name: "Save", exact: true }).click();

  const saved = strip.locator(".event-template-row", { hasText: "Victoria Juniors 3m" });
  await expect(saved).toBeVisible();
  await expect(strip).not.toContainText("Praslin Sunday");
  await expect(strip).not.toContainText("Federation Open");
  const row = (await setup.pool.query(
    "SELECT club_id, org_id, config FROM event_templates WHERE name = 'Victoria Juniors 3m'",
  )).rows;
  expect(row).toHaveLength(1);
  expect(row[0].club_id).toBe(A.club_id);
  expect(row[0].org_id).toBeNull();
  expect(row[0].config).toMatchObject({ gender: "Female", height: "3m", number_of_judges: 7 });

  // A fresh visit: the club's template is still there (and still only
  // theirs), and clicking it puts the form back the way it was saved.
  await page.reload();
  await openCreate(page);
  await expect(saved).toBeVisible();
  await expect(strip.locator(".event-template-row")).toHaveCount(1);
  await field(page, "Gender Category").selectOption("Male");
  await field(page, "Board / Platform Height").selectOption("1m");
  await field(page, "Judge Panel Size").selectOption("5");
  await saved.locator(".event-template-apply").click();
  await expect(field(page, "Gender Category")).toHaveValue("Female");
  await expect(field(page, "Board / Platform Height")).toHaveValue("3m");
  await expect(field(page, "Judge Panel Size")).toHaveValue("7");

  // And the club admin can take it away again.
  await saved.getByRole("button", { name: "Delete template" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete template" }).click();
  await expect(strip).toHaveCount(0);
  const left = await setup.pool.query("SELECT name FROM event_templates WHERE club_id = $1", [A.club_id]);
  expect(left.rows).toHaveLength(0);
  const others = await setup.pool.query(
    "SELECT count(*)::int AS n FROM event_templates WHERE club_id = $1 OR org_id = $2", [other, A.org_id],
  );
  expect(others.rows[0].n).toBe(2);
});
