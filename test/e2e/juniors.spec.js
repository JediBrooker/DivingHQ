// Junior divers (under 13) end to end in the browser: a parent adds their
// child on /juniors, the club admin confirms it on My club where there's
// no federation, and the parent sees it confirmed. Then a 13-year-old
// takes their profile over through the handover link and signs in with
// it. The rules behind each step are covered in
// test/juniors.integration.test.js; this is the screens wired to them.

const crypto = require("node:crypto");
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

let orgId;
let club;
let admin;
let parent;

function birthday(years, days = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function signIn(page, username, password = setup.TEST_PASSWORD) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test.beforeAll(async () => {
  orgId = (await setup.pool.query(
    `INSERT INTO organisations (name, slug, status, claim_state, country_code)
     VALUES ($1, $1, 'active', 'unclaimed', 'TST') RETURNING id`,
    [`e2e-juniors-${crypto.randomBytes(4).toString("hex")}`],
  )).rows[0].id;
  club = await setup.insertClub({ orgId, name: "Junior Test Club", shortCode: "JTC" });
  admin = await setup.insertUser({ orgId, role: "coach", fullName: "Club Admin", clubId: club.clubId });
  await setup.pool.query(
    "INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [club.clubId, admin.userId, orgId]);
  parent = await setup.insertUser({ orgId, role: "spectator", fullName: "Pat Parent" });
});

test.afterAll(async () => {
  if (orgId) await setup.deleteOrg(orgId);
});

test("a parent adds their child and the club confirms it", async ({ page }) => {
  await signIn(page, parent.username);
  await page.goto("/juniors");
  await expect(page.getByTestId("junior-add")).toBeVisible();
  await page.getByTestId("junior-club").selectOption(club.clubId);
  await page.getByTestId("junior-name").fill("Kit Junior");
  await page.getByTestId("junior-dob").fill(birthday(8));
  await page.getByTestId("junior-gender").selectOption("other");
  // Only a parent here, so that's the one picked; nothing goes without the tick.
  await expect(page.getByTestId("junior-as-parent")).toBeChecked();
  await expect(page.getByTestId("junior-submit")).toBeDisabled();
  await page.getByTestId("junior-consent").check();
  await page.getByTestId("junior-submit").click();
  await expect(page.getByTestId("junior-card")).toHaveCount(1);
  await expect(page.getByTestId("junior-status")).toHaveText(/Waiting to be confirmed/);

  await page.context().clearCookies();
  await signIn(page, admin.username);
  await page.goto("/club");
  const row = page.getByTestId("junior-queue-row").filter({ hasText: "Kit Junior" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Added by Pat Parent, their parent");
  await row.getByRole("button", { name: "Confirm" }).click();
  await expect(row).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, parent.username);
  await page.goto("/juniors");
  await expect(page.getByTestId("junior-status")).toHaveText(/Confirmed/);
  // The nav has it for a parent with no other role.
  await expect(page.getByRole("link", { name: "Junior divers" }).first()).toBeVisible();
});

test("at 13 the diver takes the profile over and signs in with it", async ({ page }) => {
  const id = (await setup.pool.query(
    `INSERT INTO users (username, full_name, org_id, club_id, date_of_birth, gender)
     VALUES ($1, 'Teen Junior', $2, $3, $4, 'female') RETURNING id`,
    [`junior-${crypto.randomBytes(6).toString("hex")}`, orgId, club.clubId, birthday(13, 3)],
  )).rows[0].id;
  await setup.pool.query(
    `INSERT INTO junior_profiles (user_id, org_id, status, created_by, created_as, consent_by)
     VALUES ($1, $2, 'active', $3, 'club', $3)`,
    [id, orgId, admin.userId],
  );
  // The email itself needs a mail provider the test server doesn't have,
  // so the link is minted the way routes/juniors.js does it.
  const token = crypto.randomBytes(32).toString("base64url");
  await setup.pool.query(
    `UPDATE junior_profiles SET handover_email = 'teen@example.test', handover_token_hash = $2,
            handover_sent_at = now(), handover_expires_at = now() + interval '7 days'
      WHERE user_id = $1`,
    [id, crypto.createHash("sha256").update(token).digest("hex")],
  );

  await page.goto(`/junior-handover?token=${token}`);
  await expect(page.getByText("Teen Junior")).toBeVisible();
  const username = `teen-${crypto.randomBytes(3).toString("hex")}`;
  await page.getByTestId("handover-username").fill(username);
  await page.getByTestId("handover-password").fill("a-good-pass-123");
  await page.getByTestId("handover-confirm").fill("a-good-pass-123");
  await page.getByTestId("handover-age").check();
  await page.getByTestId("handover-submit").click();
  await expect(page.getByTestId("handover-done")).toBeVisible();

  await signIn(page, username, "a-good-pass-123");
  // Used once, the link is dead.
  await page.goto(`/junior-handover?token=${token}`);
  await expect(page.getByTestId("handover-gone")).toBeVisible();
});
