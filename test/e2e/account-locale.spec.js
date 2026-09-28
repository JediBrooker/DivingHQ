// The language a signed-in person picks is saved on their account
// (users.locale), and the account's language is what they get on a new
// device. Nothing used to call POST /api/users/me/locale, so users.locale
// stayed NULL and every server-side mail that reads it (receipts, fines,
// appeal decisions, a verify link an admin resends) went out in English.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const world = {};

async function signIn(page, username) {
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

const savedLocale = async (userId) =>
  (await setup.pool.query("SELECT locale FROM users WHERE id = $1", [userId])).rows[0].locale;

test.beforeAll(async ({ request }) => {
  const { orgId } = await setup.createOrgAndAdmin(request, { orgName: "Locale Memory Fed" });
  world.orgId = orgId;
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

test("switching language while signed in saves it on the account", async ({ page }) => {
  const diver = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: "Lena Sprung" });
  await signIn(page, diver.username);
  // An account with no language yet takes the one on screen.
  await expect.poll(() => savedLocale(diver.userId), { timeout: 10_000 }).toBe("en");

  await page.goto("/profile");
  await page.locator("select.locale-select").first().selectOption("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect.poll(() => savedLocale(diver.userId), { timeout: 10_000 }).toBe("de");
});

test("signing in on a fresh device picks up the account's language", async ({ page }) => {
  const diver = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: "Amélie Plongeon" });
  await setup.pool.query("UPDATE users SET locale = 'fr' WHERE id = $1", [diver.userId]);
  await signIn(page, diver.username);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr", { timeout: 10_000 });

  // And a reload keeps it, from the account as much as from this device.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  expect(await savedLocale(diver.userId)).toBe("fr");
});

test("a language picked on the login page wins over the account's", async ({ page }) => {
  const diver = await setup.insertUser({ orgId: world.orgId, role: "diver", fullName: "Sofia Salto" });
  await setup.pool.query("UPDATE users SET locale = 'fr' WHERE id = $1", [diver.userId]);
  await page.goto("/login");
  await page.locator("select.locale-select").first().selectOption("es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.locator('input[autocomplete="username"]').fill(diver.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
  await expect.poll(() => savedLocale(diver.userId), { timeout: 10_000 }).toBe("es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
});
