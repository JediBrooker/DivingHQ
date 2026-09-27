// The public records page (/records), end to end.
//
// The record-writing rules (gender books, individual dives only) are
// pinned in test/integration.test.js. This spec is about the screen:
// that an anonymous visitor can read a book, sees the Unofficial note
// until the country is claimed, and that the book tabs, height chips and
// dive-code filter all drive the URL and the table the way they should.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Saint Pierre and Miquelon: no other spec, seed or integration test
// uses it, so this file owns the country outright.
const COUNTRY = "SPM";
const world = {};

async function wipeCountry() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM records_federation WHERE org_id = $1", [id]);
    await setup.pool.query(
      "DELETE FROM records_club WHERE club_id IN (SELECT id FROM clubs WHERE org_id = $1)", [id]);
    await setup.pool.query("DELETE FROM clubs WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await wipeCountry();
  // A country the clubs started (unclaimed), two clubs, one diver and a
  // handful of marks written straight into the books.
  const org = await setup.pool.query(
    `INSERT INTO organisations (name, country_code, slug, status, claim_state)
     VALUES ('Miquelon Diving', $1, $2, 'active', 'unclaimed') RETURNING id`,
    [COUNTRY, `e2e-spm-${setup.rand()}`],
  );
  world.orgId = org.rows[0].id;
  world.club = (await setup.insertClub({ orgId: world.orgId, name: "Saint-Pierre Plongeon", shortCode: "SPP" })).clubId;
  world.emptyClub = (await setup.insertClub({ orgId: world.orgId, name: "Langlade Divers", shortCode: "LGD" })).clubId;
  const diver = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: "Lea Detcheverry", clubId: world.club });
  world.diverId = diver.userId;

  const marks = [
    ["3m", "105", "B", 52.2],
    ["3m", "5253", "B", 58.8],
    ["10m", "107", "C", 61.5],
    ["1m", "401", "C", 31.2],
  ];
  for (const [height, code, pos, score] of marks) {
    await setup.pool.query(
      `INSERT INTO records_federation (org_id, holder_id, gender, height, dive_code, position, score)
       VALUES ($1, $2, 'Female', $3, $4, $5, $6)`,
      [world.orgId, world.diverId, height, code, pos, score],
    );
    await setup.pool.query(
      `INSERT INTO records_club (club_id, holder_id, gender, height, dive_code, position, score)
       VALUES ($1, $2, 'Female', $3, $4, $5, $6)`,
      [world.club, world.diverId, height, code, pos, score],
    );
  }
});

test.afterAll(wipeCountry);

test("anyone can read a national book, marked unofficial until the country is claimed", async ({ page }) => {
  await setup.installClickHighlight(page);
  await page.goto(`/records/federation/${world.orgId}`);

  await expect(page.getByTestId("records-row")).toHaveCount(4);
  const note = page.getByTestId("records-unofficial");
  await expect(note).toContainText("Unofficial");
  await expect(note).toContainText("Miquelon Diving");
  await expect(note.getByRole("link", { name: /Claim it/ })).toHaveAttribute("href", "/register-org");

  // Rows read like a record book: grouped by board, with the dive named.
  await expect(page.locator(".records-group")).toHaveText(["1m", "3m", "10m"]);
  await expect(page.getByTestId("records-row").first()).toContainText("401C");
  await expect(page.getByTestId("records-row").first()).toContainText("Lea Detcheverry");

  // Nothing in the men's book yet.
  await page.getByTestId("records-gender-male").click();
  await expect(page).toHaveURL(/gender=Male/);
  await expect(page.getByText("No records yet")).toBeVisible();
  await page.getByTestId("records-gender-female").click();

  // Once a federation claims the country the same marks are official.
  await setup.pool.query("UPDATE organisations SET claim_state = 'claimed' WHERE id = $1", [world.orgId]);
  try {
    await page.reload();
    await expect(page.getByTestId("records-row")).toHaveCount(4);
    await expect(page.getByTestId("records-unofficial")).toHaveCount(0);
  } finally {
    await setup.pool.query("UPDATE organisations SET claim_state = 'unclaimed' WHERE id = $1", [world.orgId]);
  }
});

test("tabs, height chips and the dive-code filter drive the URL and the table", async ({ page }) => {
  await setup.installClickHighlight(page);
  await page.goto(`/records/federation/${world.orgId}`);
  await expect(page.getByTestId("records-row")).toHaveCount(4);

  // Height chips only offer boards that have a record.
  await page.getByTestId("records-height-3m").click();
  await expect(page).toHaveURL(/height=3m/);
  await expect(page.getByTestId("records-row")).toHaveCount(2);

  // "5" narrows to the twisters, which on 3m is just the 5253B.
  await page.getByTestId("records-search").fill("5");
  await expect(page).toHaveURL(/q=5/);
  await expect(page.getByTestId("records-row")).toHaveCount(1);
  await expect(page.getByTestId("records-row")).toContainText("5253B");

  // Nothing on 3m starts with 4, so the page says so and offers a way back.
  await page.getByTestId("records-search").fill("4");
  await expect(page.getByText("No records match these filters.")).toBeVisible();
  await page.getByRole("button", { name: /Clear filters/ }).click();
  await expect(page.getByTestId("records-row")).toHaveCount(4);
  await expect(page).not.toHaveURL(/height=|q=/);

  // Club tab: two clubs, so the page asks which, and the URL follows.
  await page.getByTestId("records-tab-club").click();
  await expect(page).toHaveURL(new RegExp(`/records/club\\?org=${world.orgId}`));
  await expect(page.getByText("Pick a record book")).toBeVisible();
  await page.getByTestId("records-book-select").selectOption(world.club);
  await expect(page).toHaveURL(new RegExp(`/records/club/${world.club}`));
  await expect(page.getByTestId("records-row")).toHaveCount(4);
  // Club records don't wait on a federation.
  await expect(page.getByTestId("records-unofficial")).toHaveCount(0);

  await page.getByTestId("records-book-select").selectOption(world.emptyClub);
  await expect(page.getByText("No records yet")).toBeVisible();
  await expect(page.getByRole("link", { name: /Scoreboard & Results/ })).toBeVisible();

  // A bare club link, with no ?org, still fills in the country.
  await page.goto(`/records/club/${world.club}`);
  await expect(page.getByTestId("records-row")).toHaveCount(4);
  await expect(page.getByTestId("records-country")).toHaveValue(world.orgId);
});

test("signed in, Records is in the menu and opens on your own national book", async ({ page, request }) => {
  await setup.installClickHighlight(page);
  await setup.bypassRoleTour(page);
  // A diver rather than the org admin: a brand-new federation's admin is
  // sent through the setup wizard first.
  const admin = await setup.createOrgAndAdmin(request);
  const diver = await setup.insertUser({ orgId: admin.orgId, role: "diver", fullName: "Records Reader" });
  try {
    await page.goto("/login");
    await page.locator('input[autocomplete="username"]').fill(diver.username);
    await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
    await page.getByRole("button", { name: /Sign In/i }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: /^Records$/ }).click();
    await expect(page).toHaveURL(new RegExp(`/records/federation/${admin.orgId}`));
    await expect(page.getByText("No records yet")).toBeVisible();
  } finally {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [admin.orgId]);
    await setup.deleteOrg(admin.orgId);
  }
});
