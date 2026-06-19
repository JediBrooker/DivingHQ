// Control Room broadcast chooser coverage for the Daktronics bridge.
//
// The bridge itself is unit-tested in test/venue-daktronics-bridge.test.js.
// This spec makes sure operators can discover the bridge from the
// Control Room's Broadcast flow and receive event-specific commands.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.beforeEach(() => {
  test.skip(
    process.env.VITE_CONTROL_V2 === "on",
    "Legacy V1 control surface; skipped in the V2 build (default/off build serves V1).",
  );
});

async function signIn(page, username) {
  await page.addInitScript(() => {
    localStorage.setItem("locale", "en");
    localStorage.setItem("setup.wizardCompleted.v1", "1");
    localStorage.setItem("setup.wizardDismissed.v1", "1");
  });
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test("Control Room Broadcast exposes Daktronics bridge setup", async ({ request, page }) => {
  test.setTimeout(45_000);

  const { orgId, username, adminToken } = await setup.createOrgAndAdmin(request);
  try {
    const event = await setup.createEvent(request, {
      adminToken,
      name: "E2E Daktronics Broadcast Event",
      total_rounds: 2,
      number_of_judges: 5,
      height: "3m",
    });

    await signIn(page, username);
    await page.goto(`/control?event=${event.id}`);
    await expect(page.locator(".ctrl-layout")).toBeVisible();
    await expect(page.locator(".event-title-select")).toHaveValue(event.id);

    await page.locator(".header-menu-host .btn-icon").click();
    await page.getByText("📺 Broadcast").click();
    await expect(page.getByText("Venue hardware — Daktronics bridge…")).toBeVisible();

    await page.getByText("Venue hardware — Daktronics bridge…").click();
    await expect(page.getByText("Send live meet data to a Daktronics venue board")).toBeVisible();
    await expect(page.getByText("Diagnostic snapshot for")).toBeVisible();

    await expect(page.locator(".venue-bridge-instructions .obs-url-input")).toHaveValue(
      new RegExp(`/api/venue/scoreboard-state/${event.id}$`),
    );

    const panelText = await page.locator(".venue-bridge-instructions").innerText();
    expect(panelText).toContain(`npm run venue:daktronics -- --app-url`);
    expect(panelText).toContain(`--event-id ${event.id}`);
    expect(panelText).toContain("--transport udp");
    expect(panelText).toContain("--broadcast");
    expect(panelText).toContain("--format json");
  } finally {
    await setup.deleteOrg(orgId);
  }
});
