// A parent's guardian link, approved by the child's club, in a country
// with no federation on DivingHQ (lib/guardian-requests.js).
//
// The permission edges (other clubs, the region, nobody deciding their
// own, other countries, federations) are pinned in
// test/integration.test.js. This covers what only a browser shows: the
// parent's request waiting on /guardians, the club admin's queue on My
// club, and the link going live once they approve.
//
// Works in a country nobody else in test/ uses, wiped before and after.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const COUNTRY = "LAO";

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
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/(dashboard|setup)/, { timeout: 10_000 });
}

test("a parent asks to pay for a child and the child's club admin approves it on My club", async ({ page, browser, request }) => {
  test.setTimeout(90_000);

  // The club's founder, which makes them its admin in a country the clubs run.
  const username = `e2e-gca-${setup.rand()}`;
  const reg = await request.post("/api/auth/register", {
    data: { username, full_name: "Vientiane Divers Admin", password: setup.TEST_PASSWORD,
            email: `${username}@example.test`, country_code: COUNTRY, new_club_name: "Vientiane Divers" },
  });
  expect(reg.status()).toBe(201);
  const founder = (await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING id, org_id, club_id", [username],
  )).rows[0];
  const orgState = (await setup.pool.query("SELECT claim_state FROM organisations WHERE id = $1", [founder.org_id])).rows[0];
  expect(orgState.claim_state).toBe("unclaimed");

  const kid = await setup.insertUser({ orgId: founder.org_id, role: "diver", fullName: "Noy Vongsa", clubId: founder.club_id });
  await setup.pool.query("UPDATE users SET date_of_birth = CURRENT_DATE - interval '11 years' WHERE id = $1", [kid.userId]);
  const parent = await setup.insertUser({ orgId: founder.org_id, role: "spectator", fullName: "Kham Vongsa" });

  // The parent finds the child and asks. It waits on their page.
  await signIn(page, parent.username);
  await page.goto("/guardians");
  await page.getByPlaceholder(/search by name/i).fill("Noy Vongsa");
  const result = page.getByRole("button", { name: /Noy Vongsa/ });
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.click();
  const link = page.locator('[data-testid="guardian-link"]', { hasText: "Noy Vongsa" });
  await expect(link).toContainText(/waiting for approval/i, { timeout: 10_000 });
  await expect(link.getByRole("button", { name: /withdraw request/i })).toBeVisible();

  // The club admin has it on My club, and a line in their inbox.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, username);
  await admin.goto("/club");
  const section = admin.getByTestId("club-guardian-requests");
  const row = section.getByTestId("guardian-queue-row").filter({ hasText: "Noy Vongsa" });
  await expect(row).toContainText("Kham Vongsa", { timeout: 10_000 });
  await expect(row).toContainText(/11 years old/);
  await expect(section).toContainText(/only approve someone you know/i);
  await row.getByRole("button", { name: /approve/i }).click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  await expect(section).toContainText(/no guardian requests waiting/i);

  const told = await setup.pool.query(
    "SELECT action_url FROM notifications WHERE user_id = $1 AND category = 'guardian_request'", [founder.id],
  );
  expect(told.rows.map((r) => r.action_url)).toEqual(["/club"]);
  await adminCtx.close();

  // Linked: no longer waiting, and the parent heard how it went.
  await page.reload();
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).not.toContainText(/waiting for approval/i);
  await expect(link.getByRole("button", { name: /revoke/i })).toBeVisible();
  const status = await setup.pool.query(
    "SELECT status, reviewed_by FROM guardians WHERE dependent_user_id = $1", [kid.userId],
  );
  expect(status.rows).toEqual([{ status: "approved", reviewed_by: founder.id }]);
  const heard = await setup.pool.query(
    "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND category = 'guardian_decision'", [parent.userId],
  );
  expect(heard.rows[0].n).toBe(1);
});
