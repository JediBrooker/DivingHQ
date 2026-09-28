// A parent who signs up to pay for their child gets exactly one role:
// 'spectator' (routes/auth.js hands that out on registration, and
// 'diver' is only ever a *requested* role an admin has to approve).
//
// /membership is the only page that renders the "Paying for" dropdown,
// and it used to be gated on requiresRole: ['diver'], so that parent
// bounced straight back to the dashboard and could never reach the one
// screen they made an account for. These specs pin the fix down:
// reachability, the dropdown, the sidebar link, and the fact that a
// stranger still can't get in.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const world = {};

async function signIn(page, username) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test.beforeAll(async ({ request }) => {
  const { orgId, adminId, adminToken, username: adminUsername } = await setup.createOrgAndAdmin(request, {
    orgName: "Guardian Access Fed",
    countryCode: "GBR",
  });
  world.orgId = orgId;
  world.adminToken = adminToken;
  world.adminUsername = adminUsername;

  // The dependent needs a date_of_birth or SubjectSelector prints "(NaN)".
  world.minor = await setup.insertUser({ orgId, role: "diver", fullName: "Ivy Marsh" });
  await setup.pool.query("UPDATE users SET date_of_birth = '2013-06-02' WHERE id = $1", [
    world.minor.userId,
  ]);

  // Exactly what registration produces: spectator, nothing else.
  world.guardian = await setup.insertUser({ orgId, role: "spectator", fullName: "Rosa Marsh" });
  await setup.pool.query(
    `INSERT INTO guardians (org_id, guardian_user_id, dependent_user_id, status, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, 'approved', $4, now())`,
    [orgId, world.guardian.userId, world.minor.userId, adminId],
  );

  // A spectator with nobody to look after. Must stay locked out.
  world.stranger = await setup.insertUser({ orgId, role: "spectator", fullName: "Dan Okafor" });

  // Something to buy, so the tier cards render prices rather than
  // "no membership is set for this yet".
  const feeId = (await setup.pool.query(
    `INSERT INTO fee_definitions (org_id, scope, name, currency, fee_payer, refund_policy,
                                  membership_period, active, tier)
     VALUES ($1, 'membership', 'Annual membership', 'GBP', 'absorb', 'deadline', 'annual', true, NULL)
     RETURNING id`,
    [orgId],
  )).rows[0].id;
  await setup.pool.query(
    "INSERT INTO fee_prices (fee_definition_id, label, amount_cents, audience) VALUES ($1, 'Standard', 4500, 'all')",
    [feeId],
  );
});

test.afterAll(async () => {
  if (world.orgId) {
    await setup.pool.query("DELETE FROM payments WHERE org_id = $1", [world.orgId]).catch(() => {});
    await setup.pool.query("DELETE FROM memberships WHERE org_id = $1", [world.orgId]).catch(() => {});
    await setup.deleteOrg(world.orgId);
  }
});

test("a spectator guardian reaches /membership and sees the Paying for picker", async ({ page }) => {
  await signIn(page, world.guardian.username);

  await page.goto("/membership");
  await expect(page).toHaveURL(/\/membership$/);

  const subject = page.locator(".subject-selector select");
  await expect(subject).toBeVisible({ timeout: 10_000 });
  await expect(subject.locator("option")).toHaveCount(2); // myself + Ivy
  await expect(subject).toContainText("Ivy Marsh");

  // And the tier cards actually resolved a price for the dependent.
  await subject.selectOption({ index: 1 });
  await expect(page.locator(".tier-card").first()).toContainText("45.00");
});

test("the Membership link shows up in the guardian's sidebar", async ({ page }) => {
  await signIn(page, world.guardian.username);
  await expect(page.locator('a[href="/membership"]').first()).toBeVisible({ timeout: 10_000 });
});

test("a spectator with no dependents is still bounced off /membership", async ({ page }) => {
  await signIn(page, world.stranger.username);

  await page.goto("/membership");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('a[href="/membership"]')).toHaveCount(0);
});

test("the guardian can switch /charges to the dependent", async ({ page }) => {
  // Give the minor something owed, so the switch has a visible effect.
  const feeId = (await setup.pool.query(
    `INSERT INTO fee_definitions (org_id, scope, name, currency, fee_payer, refund_policy, active, event_id)
     VALUES ($1, 'fine', 'Discipline', 'GBP', 'absorb', 'none', true, NULL) RETURNING id`,
    [world.orgId],
  )).rows[0].id;
  await setup.pool.query(
    `INSERT INTO fines (org_id, liable_user_id, issued_by, amount_cents, currency, reason, status)
     VALUES ($1, $2, $2, 3000, 'GBP', 'Late to the judges briefing', 'owed')`,
    [world.orgId, world.minor.userId],
  );
  expect(feeId).toBeTruthy();

  await signIn(page, world.guardian.username);
  await page.goto("/charges");

  // Nothing owed as myself.
  await expect(page.getByText(/Late to the judges briefing/i)).toHaveCount(0);

  await page.locator(".subject-selector select").selectOption({ index: 1 });
  await expect(page.getByText(/Late to the judges briefing/i)).toBeVisible({ timeout: 10_000 });

  // Appeals belong to the person who was fined, not to their guardian.
  await expect(page.locator(".btn-appeal")).toHaveCount(0);
});

// Linking from the app. The page searched GET /api/users (the org admin's
// member list), so a parent got "Forbidden", nothing showed a request once
// it was made, and no screen let an admin approve one.
test("a parent links to a child from /guardians and an admin approves it in User Manager", async ({ page, browser }) => {
  const kid = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: "Otto Quillfeather" });
  await setup.pool.query("UPDATE users SET date_of_birth = '2014-03-09' WHERE id = $1", [kid.userId]);
  const parent = await setup.insertUser({ orgId: world.orgId, role: "spectator", fullName: "Nell Quillfeather" });

  await signIn(page, parent.username);
  await page.goto("/guardians");
  await page.getByPlaceholder(/search by name/i).fill("Quillfeather");
  const result = page.getByRole("button", { name: /Otto Quillfeather/ });
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.focus();
  await page.keyboard.press("Enter");
  const link = page.locator('[data-testid="guardian-link"]', { hasText: "Otto Quillfeather" });
  await expect(link).toContainText(/waiting for approval/i, { timeout: 10_000 });

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, world.adminUsername);
  await admin.goto("/users");
  await admin.getByRole("button", { name: /pending/i }).first().click();
  const card = admin.locator('[data-testid="guardian-requests"] .request-card', { hasText: "Otto Quillfeather" });
  await expect(card).toContainText("Nell Quillfeather", { timeout: 10_000 });
  await card.getByRole("button", { name: /approve/i }).click();
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await adminCtx.close();

  await page.reload();
  await expect(link).toBeVisible({ timeout: 10_000 });
  await expect(link).not.toContainText(/waiting for approval/i);
});

// The card answers for whoever "Paying for" names, and a membership in its
// last 30 days keeps a button to renew it (the server sells renewals then).
test("the membership card follows the dependent and offers a renewal near the end", async ({ page }) => {
  // The guardian is a member for most of a year; Ivy's runs out in ten days.
  await setup.pool.query(
    `INSERT INTO memberships (org_id, user_id, period_start, period_end, status)
     VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE + 300, 'active'),
            ($1, $3, CURRENT_DATE - 355, CURRENT_DATE + 10, 'active')`,
    [world.orgId, world.guardian.userId, world.minor.userId],
  );
  try {
    await signIn(page, world.guardian.username);
    await page.goto("/membership");
    const standard = page.locator(".tier-card").first();
    // As myself: a member, months to go, nothing to buy.
    await expect(standard.locator(".fp-owned")).toBeVisible({ timeout: 10_000 });
    await expect(standard.locator(".fp-pay")).toHaveCount(0);

    await page.locator(".subject-selector select").selectOption({ index: 1 });
    await expect(standard.locator(".fp-owned")).toBeVisible({ timeout: 10_000 });
    await expect(standard.locator(".fp-pay")).toHaveCount(1);
  } finally {
    await setup.pool.query("DELETE FROM memberships WHERE org_id = $1", [world.orgId]);
  }
});
