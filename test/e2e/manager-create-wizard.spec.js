// P10 Cluster 1: the create-event form is an in-panel StageStep wizard
// (Details -> Rounds -> Structure -> Schedule & rules -> Review). Proves
// the wizard actually steps through, the review summary reflects the
// inputs, the final Create actually creates the event, and the name
// guard jumps back to the Details step instead of silently failing on
// a hidden required.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

async function openCreate(page) {
  await page.goto("/manager");
  await expect(page.getByRole("button", { name: /\+ New event/i })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /\+ New event/i }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible();
}

test("the create wizard steps through and creates an event", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Wizard Diving",
  });
  await signIn(page, username);
  await openCreate(page);

  // Step 1 (Details) is shown; the pip is current.
  await expect(page.locator(".wizard-pip.is-current .wizard-pip-label")).toHaveText("Details");
  await page.locator(".modal-create-event input.input").first().fill("Wizard Made Event");

  // Step 2 (Rounds): add a round so createEvent's >=1-dive guard passes.
  await page.getByRole("button", { name: /Next/ }).click();
  await expect(page.locator(".wizard-pip.is-current .wizard-pip-label")).toHaveText("Rounds");
  await page.getByRole("button", { name: /^\+ Add Dive$/i }).click();
  await expect(page.locator(".rd-row")).toHaveCount(1);

  // Skip Structure + Schedule, land on Review.
  await page.getByRole("button", { name: /Next/ }).click(); // -> Structure
  await page.getByRole("button", { name: /Next/ }).click(); // -> Schedule & rules
  await page.getByRole("button", { name: /Next/ }).click(); // -> Review
  await expect(page.locator(".wizard-pip.is-current .wizard-pip-label")).toHaveText("Review");
  // The review summary reflects the entered name + round count.
  await expect(page.locator(".wizard-review-grid")).toContainText("Wizard Made Event");
  await expect(page.locator(".wizard-review-grid")).toContainText("1"); // rounds = 1

  // Create: the modal closes and the event lands in the list.
  await page.getByRole("button", { name: /Create|New Event/i }).last().click();
  await expect(page.locator(".modal-create-event")).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: /Your events|All events/i }).first().click();
  await expect(page.locator(".event-item", { hasText: "Wizard Made Event" })).toBeVisible({ timeout: 10_000 });
});

test("creating with no name jumps back to the Details step with an error", async ({ request, page }) => {
  test.setTimeout(60_000);
  const { username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS", orgName: "Wizard Guard Diving",
  });
  await signIn(page, username);
  await openCreate(page);

  // Add a round (so the only failing guard is the missing name), advance
  // to Review, and try to create.
  await page.getByRole("button", { name: /Next/ }).click();
  await page.getByRole("button", { name: /^\+ Add Dive$/i }).click();
  await page.getByRole("button", { name: /Next/ }).click(); // Structure
  await page.getByRole("button", { name: /Next/ }).click(); // Schedule
  await page.getByRole("button", { name: /Next/ }).click(); // Review
  await page.getByRole("button", { name: /Create|New Event/i }).last().click();

  // The guard jumps back to Details and surfaces the error (no silent
  // hidden-required focus trap).
  await expect(page.locator(".wizard-pip.is-current .wizard-pip-label")).toHaveText("Details");
  await expect(page.locator(".modal-create-event .msg-error")).toBeVisible();
  await expect(page.locator(".modal-create-event")).toBeVisible();
});
