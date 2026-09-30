// Claims hardening (lib/claims.js, migration 092) as /claims shows it:
//   - a claimant whose unverified claim got replaced can still see it,
//     withdrawn, with the reason, instead of it just vanishing;
//   - a claim nobody votes on reads "Awaiting decision", not "Voting";
//   - the sysadmin's revoke says how many grants it took back.
// The rules themselves are covered in test/integration.test.js.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// Each running copy of this test gets a country of its own. Claims are per
// country (one account, one live claim on it), and the test starts and
// ends by wiping its country, so two copies sharing one wipe each other's
// data mid-run: --repeat-each runs its copies side by side on separate
// workers, and they failed with "Claim not found" and logins for users
// that had just been deleted. It used to be SJM, which
// test/integration.test.js also uses. These are catalogue codes (claims
// only open for those) that no other test touches and that have no
// built-in regions; parallelIndex is unique among the workers running at
// once, so up to 16 workers never share one.
const CODES = ["GLP", "GUF", "MTQ", "REU", "VIR", "MAC", "FJI", "SUR", "MUS", "MLT", "LUX", "ISL", "CYP", "MNE", "EST", "LVA"];
let CODE = null;

test.beforeEach(({}, testInfo) => {
  CODE = CODES[testInfo.parallelIndex % CODES.length];
});

// The sysadmin's /claims lists every claim on the site, other copies'
// included, so the names carry the country too.
const named = (name) => `${name} ${CODE}`;

async function wipe() {
  const orgs = await setup.pool.query("SELECT id FROM organisations WHERE country_code = $1", [CODE]);
  for (const { id } of orgs.rows) {
    await setup.pool.query("DELETE FROM claims WHERE org_id = $1", [id]);
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [id]);
    await setup.deleteOrg(id);
  }
}

async function signIn(page, username) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

test("claimants see a replaced claim, and a revoke reports what it took back", async ({ page, request }) => {
  test.setTimeout(90_000);
  await wipe();
  let sysadminId = null;
  try {
    // Steps, so a timeout says which part it was stuck in rather than a
    // bare "Test timeout" (it hit 90 s once in a full parallel run).
    const founders = [];
    await test.step("two established clubs sign up", async () => {
      for (const name of ["Longyearbyen Divers", "Barentsburg Divers"]) {
        const username = `e2e-claims-${setup.rand()}`;
        const r = await request.post("/api/auth/register", {
          data: { username, full_name: `${name} Admin`, password: setup.TEST_PASSWORD,
                  email: `${username}@example.test`, country_code: CODE, new_club_name: name },
        });
        expect(r.status()).toBe(201);
        founders.push(username);
      }
      await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE username = ANY($1::text[])", [founders]);
      await setup.pool.query(
        `UPDATE clubs SET created_at = now() - interval '90 days'
          WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)`, [CODE],
      );
      await setup.pool.query(
        `INSERT INTO meets (org_id, name, host_club_id)
         SELECT org_id, name || ' Night', id FROM clubs
          WHERE org_id IN (SELECT id FROM organisations WHERE country_code = $1)`, [CODE],
      );
    });

    // A claim nobody verifies, then the real one, which replaces it.
    const claim = async (orgName) => {
      const username = `e2e-claimsfed-${setup.rand()}`;
      const r = await request.post("/api/auth/register-org", {
        data: { org_name: orgName, country_code: CODE, slug: `claims-${setup.rand()}`, username,
                password: setup.TEST_PASSWORD, full_name: `${orgName} Staff`,
                email: `${username}@claimsfed.example.org` },
      });
      expect(r.status()).toBe(201);
      const id = (await setup.pool.query("SELECT id FROM users WHERE username = $1", [username])).rows[0].id;
      return { username, id, claimId: (await r.json()).claim_id };
    };
    const typo = await test.step("a claim nobody verifies", () => claim(named("Svalbard Stupeforbund")));
    const fed = await test.step("the real claim, which replaces it", () => claim(named("Svalbard Diving Federation")));

    await test.step("the first claimant verifies and sees theirs withdrawn", async () => {
      await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [typo.id]);
      await signIn(page, typo.username);
      await page.goto("/claims");
      const typoCard = page.locator("article.claim", { hasText: named("Svalbard Stupeforbund") });
      await expect(typoCard.locator(".status")).toHaveText("Withdrawn");
      await expect(typoCard).toContainText("A newer claim on the same account replaced it");
    });

    await test.step("the real one goes live and both clubs vote it through", async () => {
      await setup.pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [fed.id]);
      expect(await require("../../lib/claims").activateForUser(setup.pool, fed.id)).toBe(1);
      for (const username of founders) {
        const { token } = await setup.loginAs(request, username);
        const v = await request.post(`/api/claims/${fed.claimId}/vote`, {
          headers: { Authorization: `Bearer ${token}` }, data: { vote: "approve" },
        });
        expect(v.status()).toBe(200);
      }
    });

    const orgId = (await setup.pool.query("SELECT org_id FROM users WHERE id = $1", [fed.id])).rows[0].org_id;
    await test.step("a throwaway sysadmin revokes it from the page", async () => {
      const sys = await setup.insertUser({ orgId, role: "spectator", fullName: "E2E Sysadmin" });
      sysadminId = sys.userId;
      await setup.pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [sysadminId]);
      await signIn(page, sys.username);
      await page.goto("/claims");
      const fedCard = page.locator("article.claim", { hasText: named("Svalbard Diving Federation") });
      await expect(fedCard.locator(".status")).toHaveText("Approved");
      await fedCard.getByRole("button", { name: "Revoke" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("meet manager access");
      await dialog.getByRole("button", { name: "Revoke" }).click();
      // Just the claimant's org_admin in this one.
      await expect(page.getByText("Claim revoked. Grants removed: 1")).toBeVisible();
      await expect(fedCard.locator(".status")).toHaveText("Revoked");
    });

    // One that nobody votes on (DivingHQ decides) reads as waiting on a
    // decision, not "Voting".
    await test.step("an undecided claim reads Awaiting decision", async () => {
      await setup.pool.query(
        `INSERT INTO claims (target_kind, target_id, org_id, claimant_id, body_name, approver, activated_at)
         VALUES ('org', $1, $1, $2, $3, 'sysadmin', now())`,
        [orgId, typo.id, named("Svalbard Review Body")],
      );
      await page.reload();
      await expect(page.locator("article.claim", { hasText: named("Svalbard Review Body") }).locator(".status"))
        .toHaveText("Awaiting decision");
    });
  } finally {
    if (sysadminId) await setup.pool.query("DELETE FROM users WHERE id = $1", [sysadminId]).catch(() => {});
    await wipe();
  }
});
