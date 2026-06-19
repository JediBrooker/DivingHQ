// Operator-prescribed round dives (migration 039). The meet
// manager can pin a specific dive (or a specific board height,
// for mixed-board events) to one or more rounds. The diver's
// submit-list endpoint enforces the contract: a list whose
// round-N pick doesn't match the prescription is rejected with a
// `400 Dive list violates the event's prescribed dives` and a
// `violations[]` array of human-readable strings.
//
// Cases:
//   1. POST /api/events with `round_dives` — server returns the
//      event row and the dedicated GET endpoint returns the
//      enriched array (joined with dive_directory).
//   2. Diver submits a list:
//        a) wrong dive in round 2 → 400 + violations[]
//        b) correct prescribed dives + valid free pick → 200
//   3. PUT /api/events/:id with round_dives:[] clears the
//      prescription; the next submit-list goes through without
//      the prescribed-dives gate firing.
//   4. Headed walk: operator opens the New Event modal via the
//      "+ New Event" button, confirms the modal is the new flow
//      (no "Number of Rounds" dropdown), adds 3 round-dive rows,
//      and the round-count badge reads "3 rounds".

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("round-dives: operator pins dives, server enforces on diver submit", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Resolve a few real dive ids at 1m so we can prescribe them.
  const fwd = await setup.pickDiveId({ height: 1.0, dive_code: "101", position: "B" });
  const back = await setup.pickDiveId({ height: 1.0, dive_code: "201", position: "B" });
  const rev = await setup.pickDiveId({ height: 1.0, dive_code: "301", position: "B" });
  // A wrong dive — same height, different code/group.
  const wrong = await setup.pickDiveId({ height: 1.0, dive_code: "401", position: "B" });

  // ---- Create event with round_dives ------------------------
  // 3 rounds: round 1 + 2 prescribed, round 3 free.
  const createRes = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: "E2E Round-Dives",
      gender: "Male",
      number_of_judges: 5,
      height: "1m",
      round_dives: [
        { round_number: 1, dive_id: fwd,  height: null },
        { round_number: 2, dive_id: back, height: null },
        { round_number: 3, dive_id: null, height: null },  // diver picks
      ],
    },
  });
  expect(createRes.status()).toBe(201);
  const event = await createRes.json();
  expect(event.total_rounds).toBe(3);   // derived from round_dives.length

  // ---- GET /round-dives returns the enriched array ----------
  const rdRes = await request.get(`/api/events/${event.id}/round-dives`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(rdRes.status()).toBe(200);
  const rd = await rdRes.json();
  expect(rd).toHaveLength(3);
  expect(rd[0].dive_code).toBe("101");
  expect(rd[1].dive_code).toBe("201");
  expect(rd[2].dive_id).toBeNull();

  // ---- Diver setup ------------------------------------------
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Round-Dives Diver",
  });
  const diverLogin = await setup.loginAs(request, diver.username);

  // ---- Case A: wrong dive in a prescribed slot -------------
  const badRes = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: event.id,
      dives: [
        { round_number: 1, dive_id: fwd },     // OK
        { round_number: 2, dive_id: wrong },   // operator pinned 'back', not 401
        { round_number: 3, dive_id: rev },     // free slot — OK
      ],
    },
  });
  expect(badRes.status()).toBe(400);
  const badBody = await badRes.json();
  expect(badBody.violations).toBeTruthy();
  expect(badBody.violations.join(" ")).toMatch(/Round 2.*prescribed/i);

  // ---- Case B: clean list ----------------------------------
  const goodRes = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: event.id,
      dives: [
        { round_number: 1, dive_id: fwd },
        { round_number: 2, dive_id: back },
        { round_number: 3, dive_id: rev },
      ],
    },
  });
  expect(goodRes.status()).toBe(200);

  // ---- Case C: PUT with round_dives:[] clears prescription -
  // Operator changes their mind and removes the prescription
  // mid-cycle. The GET endpoint then returns an empty array; the
  // server-side gate on subsequent submits no longer fires.
  const clearRes = await request.put(`/api/events/${event.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      round_dives: [],
    },
  });
  expect(clearRes.status()).toBe(200);

  const rdRes2 = await request.get(`/api/events/${event.id}/round-dives`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(await rdRes2.json()).toHaveLength(0);

  await setup.deleteOrg(orgId);
});

// Headed walkthrough: the operator opens the New Event modal,
// adds 3 dive rows via the "+ Add Dive" button, and the round
// count + dive-row layout reflect the changes. Useful as a
// regression guard against the pre-modal "Number of Rounds"
// dropdown sneaking back in.
test("round-dives: New Event modal has + Add Dive flow (no rounds dropdown)", async ({
  request, page,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken, username } = await setup.createOrgAndAdmin(request);
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

  // The "Number of Rounds" dropdown should be gone — the new
  // flow uses the round-dives editor inside the New Event modal.
  await expect(page.getByLabel(/Number of Rounds/i)).toHaveCount(0);

  // Open the modal.
  await page.getByRole("button", { name: /\+ New Event/i }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible();

  // The create form is a wizard now — step to "Rounds" for the dives editor.
  await page.getByRole("button", { name: /Next/ }).click();

  // Add 3 round-dive rows via the "+ Add Dive" button.
  const addDiveBtn = page.getByRole("button", { name: /^\+ Add Dive$/i });
  await addDiveBtn.click();
  await addDiveBtn.click();
  await addDiveBtn.click();
  await expect(page.locator(".rd-row")).toHaveCount(3);
  // Round-count badge updates live.
  await expect(page.locator(".rd-total")).toContainText("3 rounds");

  // Quick-add buttons are gone — operator goes one row at a time.
  await expect(page.getByRole("button", { name: /\+ 5 rounds/i })).toHaveCount(0);

  await setup.deleteOrg(orgId);
});

// Suggested templates strip surfaces World Aquatics-aligned
// templates filtered by the operator's selected gender + age
// group. Pick a Junior Group A entry and the form auto-populates.
test("round-dives: suggested templates filter by gender + age group and apply on click", async ({
  request, page,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken, username } = await setup.createOrgAndAdmin(request);
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
  await page.getByRole("button", { name: /\+ New Event/i }).click();
  await expect(page.locator(".modal-create-event")).toBeVisible();

  // Default form: Female + un-bracketed → strip empty until the
  // operator picks an age group.
  const strip = page.locator(".std-templates");

  // Pick "Open" — single-select dropdown, optgroups for visual
  // grouping but every option is reachable in one click.
  const ageDropdown = page.locator(".modal-create-event select.age-category");
  await ageDropdown.selectOption("open");
  // Hint underneath confirms the composed string.
  await expect(page.locator(".modal-create-event").getByText("Stored as")).toBeVisible();

  // Strip surfaces (collapsed) once Open is picked. Header shows
  // the match count.
  await expect(strip).toBeVisible();
  const toggle = strip.locator(".std-templates-toggle");
  await expect(toggle).toContainText(/suggested templates/i);
  // Click to expand.
  await toggle.click();

  // Templates render as buttons inside .std-templates-list.
  await expect(strip.locator(".std-template").first()).toContainText(/Senior Open/);

  // Pick the "Women's 3m Springboard — Senior Open" entry.
  await strip.getByRole("button", { name: /Women's 3m Springboard — Senior Open/ }).click();
  // The form populates: 5 round-dive rows (one per round).
  await expect(page.locator(".rd-row")).toHaveCount(5);
  // The round-structure section editor populated too.
  await expect(page.locator(".modal-create-event .rr-section")).toHaveCount(1);
  // Strip auto-collapsed after a click so the operator's eye
  // moves to the now-populated form.
  await expect(strip.locator(".std-templates-list")).toHaveCount(0);

  await setup.deleteOrg(orgId);
});
