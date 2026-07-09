// Round-rules feature (migration 038): operator defines a
// per-section dive-list structure ("4 dives @ 7.6 from 4
// different groups + 4 dives unlimited from 4 different
// groups", matching real Diving NSW youth bulletins), and the
// diver's submit endpoint enforces it. min_distinct_groups is a
// numeric field independent of `rounds` so an operator can
// also express things like "5 dives drawn from 4 different
// groups" (one group is allowed to repeat).
//
// What this test exercises end-to-end:
//   1. Org + admin set up via /api/auth/register-org.
//   2. POST /api/events with a `round_rules` body builds the
//      8-round event with two sections.
//   3. GET /api/events round-trips the rules.
//   4. A diver self-submits, three times:
//        a) too much DD in section 1 → 400 + violations[]
//        b) only 3 distinct groups in section 1 (cap is 4) → 400
//        c) a clean list → 200.
//   5. Validation is mirrored client-side: the SPA's submit
//      button stays disabled while violations show on the page.
//      We don't drive the full SPA dive-picker (that's a
//      modal-heavy UI well-covered elsewhere), the API +
//      validator coverage proves the contract.
//   6. Headed-mode walk: the spec opens the Manager event form
//      via the SPA and asserts the Round-structure editor's
//      "+ Add section" button adds a section row with the new
//      numeric "Min different groups" field.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function pickDive(height, code, position) {
  return await setup.pickDiveId({ height, dive_code: code, position });
}

test("round-rules: 4 @ 7.6 + 4 unlimited blocks bad lists, accepts good ones", async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- Create event with round_rules --------------------------
  // Mirrors the shape from the Diving NSW bulletin: 8 rounds,
  // first 4 capped at SUM-DD ≤ 7.6 + different groups, last 4
  // unlimited DD + different groups.
  const createRes = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "E2E 16/18 Boys 1m",
      gender: "Male",
      number_of_judges: 5,
      total_rounds: 8,
      height: "1m",
      round_rules: {
        sections: [
          { label: "Voluntary", rounds: 4, dd_limit: 7.6,  min_distinct_groups: 4 },
          { label: "Optional",  rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  });
  expect(createRes.status()).toBe(201);
  const event = await createRes.json();
  expect(event.round_rules).toBeTruthy();
  expect(event.round_rules.sections).toHaveLength(2);
  expect(event.round_rules.sections[0].dd_limit).toBe(7.6);
  expect(event.round_rules.sections[0].min_distinct_groups).toBe(4);

  // ---- Resolve some dive ids to play with --------------------
  // 1m board. Pick one dive per group so we can cleanly assemble
  // legal/illegal lists.
  // Forward = 1xx, Back = 2xx, Reverse = 3xx, Inward = 4xx, Twist = 5xx
  const f = await pickDive(1.0, "101", "B");      // forward
  const b = await pickDive(1.0, "201", "B");      // back
  const r = await pickDive(1.0, "301", "B");      // reverse
  const i = await pickDive(1.0, "401", "B");      // inward
  const t = await pickDive(1.0, "5132", "D");     // twist
  // High-DD optional-section picks:
  const f2 = await pickDive(1.0, "103", "B");     // forward 1.5som, different code, same group
  const b2 = await pickDive(1.0, "203", "B");
  const r2 = await pickDive(1.0, "303", "B");
  const i2 = await pickDive(1.0, "403", "B");

  // Sign in as a diver so submit-list has a real user_id.
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Test Diver",
  });
  const diverLogin = await setup.loginAs(request, diver.username);

  // ---- Case A: violates DD-sum cap in voluntary section --------
  // Voluntary section: pick 4 dives whose sum DD definitely
  // exceeds 7.6, since 103B / 203B / 303B / 403B (each ~1.7-2.3
  // DD on 1m board) overshoots easily.
  const badDdRes = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: event.id,
      dives: [
        { round_number: 1, dive_id: f2 },
        { round_number: 2, dive_id: b2 },
        { round_number: 3, dive_id: r2 },
        { round_number: 4, dive_id: i2 },
        { round_number: 5, dive_id: f },
        { round_number: 6, dive_id: b },
        { round_number: 7, dive_id: r },
        { round_number: 8, dive_id: i },
      ],
    },
  });
  expect(badDdRes.status()).toBe(400);
  const badDdBody = await badDdRes.json();
  expect(badDdBody.error).toMatch(/round rules/i);
  expect(badDdBody.violations).toBeTruthy();
  expect(badDdBody.violations.join(" ")).toMatch(/Voluntary.*DD/);

  // ---- Case B: not enough distinct groups in voluntary -----
  // Voluntary picks: 101B + 103B (both forward, group 1) +
  // 201B + 301B. Total DD stays under 7.6, but only 3 distinct
  // groups (forward / back / reverse) appear when the section
  // requires 4. Server rejects with the
  // "needs 4 different groups, 3 used so far" violation.
  const badGroupRes = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: event.id,
      dives: [
        { round_number: 1, dive_id: f },
        { round_number: 2, dive_id: f2 },     // 2nd forward, only 3 distinct groups
        { round_number: 3, dive_id: b },
        { round_number: 4, dive_id: r },
        { round_number: 5, dive_id: i },
        { round_number: 6, dive_id: t },
        { round_number: 7, dive_id: b2 },
        { round_number: 8, dive_id: r2 },
      ],
    },
  });
  expect(badGroupRes.status()).toBe(400);
  const badGroupBody = await badGroupRes.json();
  expect(badGroupBody.violations.join(" ")).toMatch(/Voluntary.*4 different groups.*3/i);

  // ---- Case C: a fully legal list -----------------------------
  // Voluntary: forward + back + reverse + inward (4 different
  // groups, low-DD codes well under 7.6). Optional: 4 different
  // groups, no DD cap.
  const goodRes = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: event.id,
      dives: [
        { round_number: 1, dive_id: f },
        { round_number: 2, dive_id: b },
        { round_number: 3, dive_id: r },
        { round_number: 4, dive_id: i },
        { round_number: 5, dive_id: f2 },
        { round_number: 6, dive_id: b2 },
        { round_number: 7, dive_id: r2 },
        { round_number: 8, dive_id: i2 },
      ],
    },
  });
  expect(goodRes.status()).toBe(200);
  const goodBody = await goodRes.json();
  expect(goodBody.message).toMatch(/submitted/i);

  // ---- Cleanup ----------------------------------------------
  await setup.deleteOrg(orgId);
});

// Server-side rule shape validation: misshapen round_rules in a
// POST /api/events body is caught up-front so a misconfigured
// event never lands in the DB.
test("round-rules: rule-shape validation rejects bad structures up-front", async ({
  request,
}) => {
  test.setTimeout(30_000);
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Section round-counts don't sum to total_rounds.
  const mismatch = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "E2E Mismatch", gender: "Female",
      number_of_judges: 5, total_rounds: 8, height: "1m",
      round_rules: {
        sections: [
          { rounds: 3, dd_limit: 5 },
          { rounds: 3 },              // 3 + 3 = 6 ≠ 8
        ],
      },
    },
  });
  expect(mismatch.status()).toBe(400);
  expect(await mismatch.text()).toMatch(/sum to 6.*total_rounds = 8/);

  // dd_limit out of range.
  const badDd = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "E2E BadDD", gender: "Female",
      number_of_judges: 5, total_rounds: 4, height: "1m",
      round_rules: {
        sections: [
          { rounds: 4, dd_limit: 999 },
        ],
      },
    },
  });
  expect(badDd.status()).toBe(400);
  expect(await badDd.text()).toMatch(/dd_limit must be a positive number/);

  // Non-array sections.
  const notArray = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "E2E NotArr", gender: "Female",
      number_of_judges: 5, total_rounds: 4, height: "1m",
      round_rules: { sections: "oops" },
    },
  });
  expect(notArray.status()).toBe(400);

  await setup.deleteOrg(orgId);
});

// Headed-mode walkthrough: the operator opens the Manager event
// form, clicks "+ Add section", and fills out a section with a
// numeric "Min different groups" value. Useful for visual
// debugging in `npm run test:e2e:headed` and a regression guard
// against the preset button creeping back in.
test("round-rules: section editor exposes the min-distinct-groups field", async ({
  request, page,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken, username } = await setup.createOrgAndAdmin(request);
  // heads up: adminToken is unused below, we just drive the SPA directly via login.
  void adminToken;

  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

  await page.goto("/manager");
  // The page title was dropped in the CRM refresh; gate on the
  // "+ New event" action instead (it's what we click next).
  await expect(page.getByRole("button", { name: /\+ New Event/i }))
    .toBeVisible({ timeout: 10_000 });

  // Migration 039: the New Event form lives in a modal now.
  // Open it.
  await page.getByRole("button", { name: /\+ New Event/i }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible();

  // The Quick preset is gone, make sure it doesn't sneak back in.
  await expect(page.getByRole("button", { name: /Quick: 4 @ 7\.6/ })).toHaveCount(0);

  // The create form is a wizard now: step Details -> Rounds -> Structure.
  await page.getByRole("button", { name: /Next/ }).click();
  await page.getByRole("button", { name: /Next/ }).click();

  // Add a single section via the + Add section button.
  await page.getByRole("button", { name: /\+ Add section/i }).click();
  await expect(page.locator(".rr-section")).toHaveCount(1);

  // The section row exposes a numeric "Min different groups"
  // input alongside Rounds + DD limit. Set it to 5.
  const section = page.locator(".rr-section").first();
  await expect(section.locator(".rr-cell-label", { hasText: /Min different groups/i }))
    .toBeVisible();
  const minGroupsInput = section.locator(".rr-cell", { hasText: /Min different groups/i }).locator("input");
  await minGroupsInput.fill("5");
  await expect(minGroupsInput).toHaveValue("5");

  // The hint underneath updates live to describe the rule in
  // plain English: "X dives drawn from at least 5 different
  // groups…".
  await expect(section.locator(".hint")).toContainText(/different groups/i);

  await setup.deleteOrg(orgId);
});
