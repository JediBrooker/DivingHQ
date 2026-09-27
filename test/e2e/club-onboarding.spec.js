// A club founder's first week, and the payment surfaces that stay dark
// while payments are switched off.
//
// Covers, through the real screens:
//   * the dashboard's Get started checklist ticking itself off from real
//     data, and staying hidden once dismissed
//   * My club's invite link preselecting country and club on /register,
//     and its club code editor
//   * a club admin's new meet defaulting "Divers represent" to club, and
//     Edit meet not mounting (or fetching) the federation-only fee panels
//   * the check-inbox panel's resend cooldown after signing up
//   * with the payments flag off: no fee panels, no Billing column, no
//     payouts in the club admin blurb, no Payments / Classes guide pages
//     (the flag is faked per page, since the e2e server forces payments on)
//
// The API rules behind these are in test/integration.test.js.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// French Polynesia: no other spec, test or seed uses it. Specs run in
// parallel and each wipes its own country, so it has to stay that way.
const COUNTRY = "PYF";

async function wipeCountry() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [COUNTRY]);
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

// Club founder through the public API, email verified the way the link would.
async function founder(request, clubName) {
  const username = `e2e-onb-${setup.rand()}`;
  const r = await request.post("/api/auth/register", {
    data: { username, full_name: `${clubName} Admin`, password: setup.TEST_PASSWORD,
            email: `${username}@example.test`, country_code: COUNTRY, new_club_name: clubName },
  });
  expect(r.status()).toBe(201);
  const u = await setup.pool.query(
    "UPDATE users SET email_verified_at = now() WHERE username = $1 RETURNING club_id", [username],
  );
  return { username, clubId: u.rows[0].club_id };
}

async function signIn(page, username) {
  // A fresh org admin would otherwise be bounced to the setup wizard.
  await page.addInitScript(() => {
    try { localStorage.setItem("setup.wizardDismissed.v1", "1") } catch { /* ignore */ }
  });
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

// The e2e server runs with payments and classes forced on; this makes one
// page see them off, the way a production box does at launch.
async function paymentsOff(page) {
  await page.route("**/api/features", async (route) => {
    const res = await route.fetch();
    const flags = await res.json();
    await route.fulfill({ response: res, json: { ...flags, payments: false, classes: false } });
  });
}

test.describe.configure({ mode: "serial" });
test.beforeAll(wipeCountry);
test.afterAll(wipeCountry);

test("a club founder's checklist, invite link, club code and first meet", async ({ page, browser, request }) => {
  await setup.installClickHighlight(page);
  const F = await founder(request, "Papeete Divers");
  await signIn(page, F.username);

  const panel = page.getByTestId("club-getting-started");
  await expect(panel).toContainText("Papeete Divers");
  await expect(panel).toContainText("0 of 4 done");
  for (const id of ["meet", "invite", "code", "guide"]) {
    await expect(page.getByTestId(`gs-step-${id}`)).toHaveAttribute("data-done", "false");
  }
  // The sidebar section with My club no longer claims to be a federation.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.locator(".sb-group", { hasText: /^Organisation$/ })).toBeVisible();
  await expect(nav.locator(".sb-group", { hasText: /^Federation$/ })).toHaveCount(0);

  // The code step goes to My club, which has the invite link and the code.
  await page.getByTestId("gs-step-code").click();
  await page.waitForURL(/\/club$/);
  const card = page.getByTestId(`club-setup-${F.clubId}`);
  const invite = card.getByTestId("club-invite-url");
  await expect(invite).toHaveValue(new RegExp(`/register\\?country=${COUNTRY}&club=${F.clubId}$`));
  const inviteUrl = await invite.inputValue();
  await card.getByLabel("Club code").fill("ppt");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByLabel("Club code")).toHaveValue("PPT");
  await expect.poll(async () =>
    (await setup.pool.query("SELECT short_code FROM clubs WHERE id = $1", [F.clubId])).rows[0].short_code,
  ).toBe("PPT");

  // A new meet defaults to club codes, and Edit meet leaves the fee panels
  // (and their 403s) out entirely for a club admin.
  await page.goto("/manager");
  await page.getByRole("button", { name: /New meet/i }).click();
  await expect(page.locator("#new-meet-represent")).toHaveValue("club");
  await page.getByPlaceholder("e.g. 2026 National Open").fill("Tahiti Club Night");
  await page.getByRole("button", { name: /Create meet/i }).click();
  await page.locator(".mgr-acc-header", { hasText: "Tahiti Club Night" }).click();
  const feeCalls = [];
  page.on("request", (r) => {
    if (/\/fees\/config|\/access-fee|\/bundle\/config/.test(r.url())) feeCalls.push(r.url());
  });
  await page.locator(".mgr-detail-actions button", { hasText: /^Edit$/ }).click();
  const editMeet = page.locator(".modal-edit-meet");
  await expect(editMeet).toBeVisible();
  await expect(page.locator("#meet-represent")).toHaveValue("club");
  await expect(editMeet).not.toContainText("Registration fees");
  await expect(page.locator(".notify-bar-error")).toHaveCount(0);
  expect(feeCalls).toEqual([]);
  const meetRow = await setup.pool.query(
    "SELECT represent_as FROM meets WHERE name = 'Tahiti Club Night' AND host_club_id = $1", [F.clubId],
  );
  expect(meetRow.rows[0].represent_as).toBe("club");

  await page.goto("/dashboard");
  await expect(page.getByTestId("gs-step-meet")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("gs-step-code")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("gs-step-invite")).toHaveAttribute("data-done", "false");

  // Someone follows the invite link in their own browser: country and
  // club are already picked, so they land in this club.
  const guestCtx = await browser.newContext();
  try {
    const guest = await guestCtx.newPage();
    const member = `e2e-onbm-${setup.rand()}`;
    await guest.goto(inviteUrl);
    await expect(guest.locator("select").first()).toHaveValue(COUNTRY);
    const clubSelect = guest.locator("select").filter({ has: guest.locator('option[value="new"]') });
    await expect(clubSelect).toHaveValue(F.clubId);
    await guest.locator('input[autocomplete="name"]').fill("Invited Member");
    await guest.locator('input[autocomplete="username"]').fill(member);
    await guest.locator('input[autocomplete="email"]').fill(`${member}@example.test`);
    await guest.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
    await guest.getByRole("button", { name: /Create Account/i }).click();
    await expect(guest.getByTestId("check-inbox")).toContainText(`${member}@example.test`);
    const joined = await setup.pool.query("SELECT club_id FROM users WHERE username = $1", [member]);
    expect(joined.rows[0].club_id).toBe(F.clubId);
  } finally {
    await guestCtx.close();
  }

  await page.reload();
  await expect(page.getByTestId("gs-step-invite")).toHaveAttribute("data-done", "true");
  // The guide step ticks when opened from here, and lands on the club admin card.
  await page.getByTestId("gs-step-guide").click();
  await page.waitForURL(/\/guide#club-admin$/);
  await expect(page.locator("#club-admin")).toBeInViewport();
  await expect(page.locator("#club-admin")).toContainText("share your club's invite link");
  await page.goto("/dashboard");
  await expect(panel).toContainText("4 of 4 done");

  // Hidden stays hidden.
  await page.getByTestId("club-getting-started-dismiss").click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".tab-strip")).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("invite parameters that don't check out leave the signup form alone", async ({ page, request }) => {
  const F = await founder(request, "Moorea Divers");
  await page.goto("/register?country=ZZZ&club=not-a-club");
  const country = page.locator("select").first();
  await expect(country).toBeVisible();
  expect(await country.inputValue()).not.toBe("ZZZ");

  // A real country with a club that isn't one of its clubs: country only.
  await page.goto(`/register?country=${COUNTRY.toLowerCase()}&club=00000000-0000-4000-8000-000000000000`);
  await expect(country).toHaveValue(COUNTRY);
  const clubSelect = page.locator("select").filter({ has: page.locator('option[value="new"]') });
  await expect(clubSelect.locator(`option[value="${F.clubId}"]`)).toHaveCount(1);
  await expect(clubSelect).toHaveValue("");
});

test("the check-inbox panel stays put and its resend cools down", async ({ page }) => {
  await page.clock.install();
  const username = `e2e-onbr-${setup.rand()}`;
  await page.goto("/register");
  await page.locator('input[autocomplete="name"]').fill("Resend Tester");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="email"]').fill(`${username}@example.test`);
  await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
  await page.locator("select").first().selectOption(COUNTRY);
  await page.getByRole("button", { name: /Create Account/i }).click();

  const inbox = page.getByTestId("check-inbox");
  await expect(inbox).toContainText(`${username}@example.test`);
  // The submit button went with the form, so focus moves to the heading.
  // The panel itself isn't a live region (the countdown would be read out
  // every second); only the "new link" line is.
  await expect(inbox.getByRole("heading", { name: "Check your inbox" })).toBeFocused();
  await expect(inbox).not.toHaveAttribute("role", "status");
  const resend = page.getByTestId("check-inbox-resend");
  await expect(resend).toBeDisabled();

  const sent = page.waitForRequest((r) => r.url().endsWith("/api/auth/resend-verification") && r.method() === "POST");
  await page.clock.fastForward(61_000);
  await expect(page).toHaveURL(/\/register$/);
  await expect(resend).toBeEnabled();
  await resend.click();
  expect((await sent).postDataJSON()).toEqual({ username });
  await expect(inbox.getByRole("status")).toContainText("A new link is on its way");
  await expect(resend).toBeDisabled();
});

test("with payments off an org admin sees no fee panels, billing or payment guides", async ({ page, request }) => {
  const admin = await setup.createOrgAndAdmin(request);
  try {
    await setup.insertClub({ orgId: admin.orgId, name: "Dark Payments Club", shortCode: "DPC" });
    const meet = await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${admin.adminToken}` }, data: { name: "Dark Payments Meet" },
    });
    expect(meet.status()).toBe(201);

    await paymentsOff(page);
    await signIn(page, admin.username);

    await page.goto("/clubs");
    await expect(page.getByText("Dark Payments Club")).toBeVisible();
    await expect(page.locator("th", { hasText: "Billing" })).toHaveCount(0);
    await expect(page.locator(".billing-note")).toHaveCount(0);
    await expect(page.locator(".affil-pill")).toHaveCount(0);
    // Appointing a club admin doesn't promise them payouts or classes.
    await page.locator("tr", { hasText: "Dark Payments Club" }).getByRole("button", { name: "Admins" }).click();
    const adminsDialog = page.getByRole("dialog");
    await expect(adminsDialog).toContainText("Club admins run the meets their club hosts.");
    await expect(adminsDialog).not.toContainText(/payouts|classes/);
    await page.keyboard.press("Escape");
    await expect(adminsDialog).toHaveCount(0);

    await page.goto("/manager");
    await page.locator(".mgr-acc-header", { hasText: "Dark Payments Meet" }).click();
    await page.locator(".mgr-detail-actions button", { hasText: /^Edit$/ }).click();
    await expect(page.locator(".modal-edit-meet")).toBeVisible();
    await expect(page.locator(".modal-edit-meet")).not.toContainText("Registration fees");

    await page.goto("/guide");
    await expect(page.locator('.guide-next-list a[href="/guide/features"]')).toBeVisible();
    await expect(page.locator('a[href="/guide/payments"]')).toHaveCount(0);
    await expect(page.locator('a[href="/guide/classes"]')).toHaveCount(0);

    await page.goto("/guide/quick-start");
    await expect(page.locator(".gt-nav-link", { hasText: "Quick Start" })).toBeVisible();
    await expect(page.locator(".gt-nav-link", { hasText: /^Payments$/ })).toHaveCount(0);
    await expect(page.locator(".gt-nav-link", { hasText: /^Classes$/ })).toHaveCount(0);
    await page.goto("/guide/payments");
    await expect(page.getByText("Topic not found.")).toBeVisible();
  } finally {
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [admin.orgId]);
    await setup.pool.query("DELETE FROM clubs WHERE org_id = $1", [admin.orgId]);
    await setup.deleteOrg(admin.orgId);
  }
});

test("with payments on an org admin still gets the fee panels and billing column", async ({ page, request }) => {
  const admin = await setup.createOrgAndAdmin(request);
  try {
    await setup.insertClub({ orgId: admin.orgId, name: "Live Payments Club" });
    const meet = await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${admin.adminToken}` }, data: { name: "Live Payments Meet" },
    });
    expect(meet.status()).toBe(201);
    await signIn(page, admin.username);

    await page.goto("/clubs");
    await expect(page.getByText("Live Payments Club")).toBeVisible();
    await expect(page.locator("th", { hasText: "Billing" })).toBeVisible();
    await page.locator("tr", { hasText: "Live Payments Club" }).getByRole("button", { name: "Admins" }).click();
    await expect(page.getByRole("dialog")).toContainText("look after its classes, payouts and affiliation payments");
    await page.keyboard.press("Escape");

    await page.goto("/manager");
    await page.locator(".mgr-acc-header", { hasText: "Live Payments Meet" }).click();
    await page.locator(".mgr-detail-actions button", { hasText: /^Edit$/ }).click();
    await expect(page.locator(".modal-edit-meet")).toContainText("Registration fees");
    // An org's own meet still defaults to country codes.
    await expect(page.locator("#meet-represent")).toHaveValue("country");
  } finally {
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [admin.orgId]);
    await setup.pool.query("DELETE FROM clubs WHERE org_id = $1", [admin.orgId]);
    await setup.deleteOrg(admin.orgId);
  }
});
