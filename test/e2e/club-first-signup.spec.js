// Club-first signup, end to end through the real UI (phase 1 of
// docs/club-first-onboarding.md).
//
// A club founder from a country with nobody on DivingHQ signs up by
// country, becomes their club's admin, and can run a meet without any
// federation or sysadmin in the loop. The permission edges are covered
// in test/integration.test.js; this pins down that the screens actually
// get a founder from signup to their first meet.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Tonga: small enough that no other spec or seed touches it.
const COUNTRY = "TON";
const world = {};

async function wipeCountry() {
  const orgs = await setup.pool.query(
    "SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'",
    [COUNTRY],
  );
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

// One worker for the whole file. The hooks run once per worker, so with
// two workers the second one's clean-up deleted Tonga's account out from
// under the first test mid-run.
test.describe.configure({ mode: "serial" });

test.beforeAll(wipeCountry);
test.afterAll(wipeCountry);

test("a founder signs up by country and runs their club's first meet", async ({ page }) => {
  await setup.installClickHighlight(page);
  world.username = `e2e-founder-${setup.rand()}`;

  await page.goto("/register");
  await page.locator('input[autocomplete="name"]').fill("Sione Fifita");
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="email"]').fill(`${world.username}@example.test`);
  await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);

  // Country first; nobody from Tonga is on DivingHQ yet.
  const country = page.locator("select").first();
  await country.selectOption(COUNTRY);
  await expect(page.getByText(/Nobody from .* is on DivingHQ yet/)).toBeVisible();

  const club = page.locator("select").filter({ has: page.locator('option[value="new"]') });
  await club.selectOption("new");
  await page.getByPlaceholder("e.g. Sydney Springboard").fill("Nuku'alofa Divers");
  await expect(page.getByText(/You'll be this club's admin/)).toBeVisible();
  // No federation, so no org-wide meet manager on offer.
  await expect(page.locator('option[value="meet_manager"]')).toHaveCount(0);

  await page.getByRole("button", { name: /Create Account/i }).click();
  await expect(page.locator(".msg-success")).toBeVisible();

  // The country account exists, unclaimed, with the founder as club admin.
  const org = await setup.pool.query(
    "SELECT id, claim_state FROM organisations WHERE country_code = $1", [COUNTRY],
  );
  expect(org.rows).toHaveLength(1);
  expect(org.rows[0].claim_state).toBe("unclaimed");

  // Signing in before verifying offers a fresh link rather than a dead end.
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.getByTestId("resend-verification").click();
  await expect(page.getByText(/a new link is on its way/)).toBeVisible();

  // A dead link on the verify page offers the same.
  await page.goto("/verify-email?token=not-a-real-token");
  await expect(page.getByTestId("verify-failed")).toBeVisible();
  await expect(page.getByRole("button", { name: /Send a new link/ })).toBeVisible();

  // No inbox in e2e, so mint the link the email would carry and follow it.
  const { id } = (await setup.pool.query("SELECT id FROM users WHERE username = $1", [world.username])).rows[0];
  const token = require("jsonwebtoken").sign({ sub: id, type: "email_verify" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await expect(page.getByTestId("verify-done")).toContainText(/You can sign in now/);
  await page.getByRole("link", { name: /^Sign in$/ }).click();
  await page.waitForURL(/\/login$/);
  await page.locator('input[autocomplete="username"]').fill(world.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

  // Club admins get the meet screens and their club page, not the
  // federation's admin tools.
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: /My club/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /Meet Manager/ })).toBeVisible();
  await expect(nav.getByRole("link", { name: /User Manager/ })).toHaveCount(0);

  await page.goto("/manager");
  await page.getByRole("button", { name: /New meet/i }).click();
  await page.getByPlaceholder("e.g. 2026 National Open").fill("Tonga Club Open");
  await page.getByRole("button", { name: /Create meet/i }).click();
  await expect(page.getByText("Tonga Club Open")).toBeVisible();

  const meet = await setup.pool.query(
    `SELECT m.host_club_id, c.name AS club
       FROM meets m JOIN clubs c ON c.id = m.host_club_id
      WHERE m.org_id = $1`,
    [org.rows[0].id],
  );
  expect(meet.rows).toHaveLength(1);
  expect(meet.rows[0].club).toBe("Nuku'alofa Divers");
});

// Phase 2: a country with regions (Canada has provinces) asks which one
// before a new club can be created, and records it on the club.
test("a founder in a country with provinces picks one", async ({ page }) => {
  const CAN = "CAN";
  const wipeCan = async () => {
    const orgs = await setup.pool.query(
      "SELECT id FROM organisations WHERE country_code = $1 AND claim_state = 'unclaimed'", [CAN],
    );
    for (const { id } of orgs.rows) await setup.deleteOrg(id);
  };
  await wipeCan();
  try {
    await setup.installClickHighlight(page);
    const username = `e2e-prov-${setup.rand()}`;
    await page.goto("/register");
    await page.locator('input[autocomplete="name"]').fill("Marie Leblanc");
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[autocomplete="email"]').fill(`${username}@example.test`);
    await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
    await page.locator("select").first().selectOption(CAN);

    const province = page.locator("#reg-region");
    await expect(province).toBeVisible();
    await expect(page.getByText("Province", { exact: true })).toBeVisible();
    await page.locator("select").filter({ has: page.locator('option[value="new"]') }).selectOption("new");
    await page.getByPlaceholder("e.g. Sydney Springboard").fill("Halifax Divers");
    await province.selectOption("NS");
    await page.getByRole("button", { name: /Create Account/i }).click();
    await expect(page.locator(".msg-success")).toBeVisible();

    const club = await setup.pool.query(
      `SELECT rg.short_code FROM clubs c JOIN regions rg ON rg.id = c.region_id
        JOIN organisations o ON o.id = c.org_id
       WHERE o.country_code = $1 AND c.name = 'Halifax Divers'`,
      [CAN],
    );
    expect(club.rows.map((r) => r.short_code)).toEqual(["NS"]);
  } finally {
    await wipeCan();
  }
});

// Phase 3: a federation claims a country its clubs started, and the
// clubs vote it in through the Claims page.
test("a federation claims a country and the clubs vote it in", async ({ page, request }) => {
  const FSM = "FSM";
  const wipeFsm = async () => {
    const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [FSM]);
    for (const { id } of orgs.rows) {
      await setup.pool.query("DELETE FROM claims WHERE org_id = $1", [id]);
      await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
      await setup.deleteOrg(id);
    }
  };
  await wipeFsm();
  try {
    // Two established clubs: signed up, backdated, each with a meet.
    const founders = [];
    for (const name of ["Pohnpei Divers", "Chuuk Divers"]) {
      const username = `e2e-fsm-${setup.rand()}`;
      const r = await request.post("/api/auth/register", {
        data: { username, full_name: `${name} Admin`, password: setup.TEST_PASSWORD,
                email: `${username}@example.test`, country_code: FSM, new_club_name: name },
      });
      expect(r.status()).toBe(201);
      founders.push(username);
    }
    await setup.pool.query(
      `UPDATE users SET email_verified_at = now() WHERE username = ANY($1::text[])`, [founders],
    );
    await setup.pool.query(
      `UPDATE clubs SET created_at = now() - interval '90 days'
        WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)`, [FSM],
    );
    await setup.pool.query(
      `INSERT INTO meets (org_id, name, host_club_id)
       SELECT org_id, name || ' Night', id FROM clubs
        WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)`, [FSM],
    );

    // The federation registers through the UI and gets a claim.
    await setup.installClickHighlight(page);
    const fedUser = `e2e-fsmfed-${setup.rand()}`;
    await page.goto("/register-org");
    await page.locator("#org-name").fill("Micronesia Diving Federation");
    await page.locator("#org-country").selectOption(FSM);
    await expect(page.getByTestId("claim-note")).toContainText("taking over from the clubs that started it");
    await page.locator('input[autocomplete="name"]').fill("Kasio Ehsa");
    // Its own domain: a club admin on the claimant's domain wouldn't get a vote.
    await page.locator('input[type="email"]').fill(`${fedUser}@fsmdiving.example.org`);
    await page.locator('input[autocomplete="username"]').fill(fedUser);
    await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
    await page.getByRole("button", { name: /Submit Registration/i }).click();
    await expect(page.locator(".msg-success")).toContainText("Verify your email");

    // Stand in for the emailed link: what the verify-email route does, done
    // directly, so the test doesn't need the server's JWT secret.
    const fedId = (await setup.pool.query("SELECT id FROM users WHERE username = $1", [fedUser])).rows[0].id;
    await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fedId]);
    expect(await require("../../lib/claims").activateForUser(setup.pool, fedId)).toBe(1);

    // Both clubs approve on the Claims page; the second vote passes it.
    for (const username of founders) {
      await page.goto("/login");
      await page.locator('input[autocomplete="username"]').fill(username);
      await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
      await page.getByRole("button", { name: /Sign In/i }).click();
      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      await page.goto("/claims");
      await expect(page.getByText("Micronesia Diving Federation")).toBeVisible();
      await page.getByRole("button", { name: /^Approve$/ }).click();
      await expect(page.getByText(/approved$/)).toBeVisible();
      await page.context().clearCookies();
    }
    const org = await setup.pool.query(
      "SELECT name, claim_state FROM organisations WHERE country_code = $1", [FSM],
    );
    expect(org.rows[0]).toEqual({ name: "Micronesia Diving Federation", claim_state: "claimed" });
  } finally {
    await wipeFsm();
  }
});

// R5 / R6 / R19: the register-org page sends clubs to /register, asks for
// a country and no slug, and says up front what registering will do.
test("register-org explains what registering does for each kind of country", async ({ page, request }) => {
  const NEW = "SMR";   // San Marino: nobody there, the account gets started
  const TAKEN = "LIE"; // Liechtenstein: a federation already runs it
  const wipe = async () => {
    const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code IN ($1, $2)", [NEW, TAKEN]);
    for (const { id } of orgs.rows) {
      await setup.pool.query("DELETE FROM claims WHERE org_id = $1", [id]);
      await setup.deleteOrg(id);
    }
  };
  await wipe();
  try {
    await setup.createOrgAndAdmin(request, { countryCode: TAKEN, orgName: "Liechtenstein Diving" });
    await setup.installClickHighlight(page);
    await page.goto("/register-org");

    // Clubs are pointed at the page meant for them.
    const callout = page.getByTestId("club-callout");
    await expect(callout).toContainText("Registering a club?");
    await callout.getByRole("link", { name: "Clubs sign up here instead" }).click();
    await page.waitForURL(/\/register$/);
    await page.goto("/register-org");

    // No slug, no made-up domain, and the country is required.
    await expect(page.getByText(/divedmeet|URL Slug/)).toHaveCount(0);
    await expect(page.locator("#org-country")).toHaveAttribute("required", "");
    await expect(page.getByText("Organisation name", { exact: true })).toBeVisible();

    // A country with a federation already: say so, and don't submit.
    await page.locator("#org-country").selectOption(TAKEN);
    await expect(page.getByTestId("claim-note")).toContainText("Liechtenstein Diving already runs");
    await expect(page.getByRole("button", { name: /Submit Registration/i })).toBeDisabled();

    // Nobody from the country yet: the account is started and claimed.
    const fedUser = `e2e-smr-${setup.rand()}`;
    await page.locator("#org-name").fill("San Marino Diving");
    await page.locator("#org-country").selectOption(NEW);
    await expect(page.getByTestId("claim-note")).toContainText("Nobody from San Marino is on DivingHQ yet");
    await expect(page.getByText(/State or regional body\?/)).toBeVisible();
    await page.locator('input[autocomplete="name"]').fill("Marco Rossi");
    await page.locator('input[type="email"]').fill(`${fedUser}@example.test`);
    await page.locator('input[autocomplete="username"]').fill(fedUser);
    await page.locator('input[autocomplete="new-password"]').fill(setup.TEST_PASSWORD);
    await page.getByRole("button", { name: /Submit Registration/i }).click();
    await expect(page.locator(".msg-success")).toContainText("DivingHQ reviews it");

    const orgs = await setup.pool.query(
      "SELECT status, claim_state FROM organisations WHERE country_code = $1", [NEW],
    );
    expect(orgs.rows).toEqual([{ status: "active", claim_state: "unclaimed" }]);
    const claim = await setup.pool.query(
      "SELECT body_name, approver FROM claims c JOIN users u ON u.id = c.claimant_id WHERE u.username = $1", [fedUser],
    );
    expect(claim.rows).toEqual([{ body_name: "San Marino Diving", approver: "sysadmin" }]);
  } finally {
    await wipe();
  }
});
