// Meet program export: verifies the new ?include= options on
// /api/meets/:id/program.pdf and the matching /api/meets/:id/
// program.csv endpoint.
//
// We don't introspect the PDF body (PDFKit output is binary and
// not worth pulling a parser in for), so content-type + 200 status
// plus a reasonable size is enough to catch the renderer crashing.
// The CSV body IS introspected since it's text: header columns,
// section markers (event / judge / dive), and the timing math.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe("meet program export options", () => {
  let context = {};

  test.beforeAll(async ({ request }) => {
    const { orgId, adminToken, adminId } = await setup.createOrgAndAdmin(request);
    context.orgId = orgId;
    context.adminToken = adminToken;
    context.adminId = adminId;

    // Meet, required because the program endpoint is meet-scoped.
    const meetRes = await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: "Program Export Smoke Meet", venue: "Test Pool" },
    });
    expect(meetRes.status()).toBe(201);
    const meet = await meetRes.json();
    context.meetId = meet.id;

    // One event with 3 rounds + a 5-judge panel, small enough
    // for a fast test but big enough to exercise the dive-list +
    // judge sections.
    const event = await setup.createEvent(request, {
      adminToken,
      name: "Women 3m Program Smoke",
      height: "3m",
      total_rounds: 3,
      number_of_judges: 5,
      meet_id: meet.id,
    });
    context.eventId = event.id;

    // Judges: exact count to fill the panel. The helper creates
    // verified users via direct SQL so we don't pay the signup +
    // email-verify round-trip per judge.
    const judges = [];
    for (let i = 0; i < 5; i++) {
      const j = await setup.insertUser({
        orgId, role: "judge",
        fullName: `Judge ${String.fromCharCode(65 + i)}`,
      });
      judges.push(j.userId);
    }
    await setup.assignJudges(request, {
      adminToken, eventId: context.eventId, judgeIds: judges,
    });
    context.judgeIds = judges;

    // Two divers + 3-round dive lists each so the dive_lists
    // section renders something.
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    const diverIds = [];
    for (let i = 0; i < 2; i++) {
      const u = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${i + 1}`,
      });
      diverIds.push(u.userId);
      await setup.insertDiveList({
        eventId: context.eventId,
        competitorId: u.userId,
        dives: [1, 2, 3].map((round_number) => ({ round_number, dive_id: diveId })),
      });
    }
    context.diverIds = diverIds;
  });

  test.afterAll(async () => {
    if (context.orgId) await setup.deleteOrg(context.orgId);
  });

  test("PDF without ?include= still works (legacy schedule)", async ({ request }) => {
    const r = await request.get(`/api/meets/${context.meetId}/program.pdf`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
    const body = await r.body();
    // Sanity: PDF magic number + non-trivial payload.
    expect(body.slice(0, 4).toString()).toBe("%PDF");
    expect(body.length).toBeGreaterThan(1000);
  });

  test("PDF with all extras is materially larger than the bare schedule", async ({ request }) => {
    const bare = await request.get(`/api/meets/${context.meetId}/program.pdf`);
    expect(bare.status()).toBe(200);
    const bareLen = (await bare.body()).length;

    const enriched = await request.get(
      `/api/meets/${context.meetId}/program.pdf` +
        `?include=dive_lists,judges,timing&seconds_per_dive=30`,
    );
    expect(enriched.status()).toBe(200);
    expect(enriched.headers()["content-type"]).toContain("application/pdf");
    const enrichedLen = (await enriched.body()).length;

    // Extras add the judge panel (5 rows), 2 dive lists × 3 rounds,
    // a timing line per event + a meet-total summary block. Even
    // accounting for PDF compression that's a multi-hundred-byte
    // bump over the bare schedule.
    expect(enrichedLen).toBeGreaterThan(bareLen + 200);
  });

  test("PDF rejects garbage seconds_per_dive by falling back to 45s", async ({ request }) => {
    // The handler treats unrecognised values as 45s instead of
    // 400ing, just normalises them. Confirm we still get a PDF.
    const r = await request.get(
      `/api/meets/${context.meetId}/program.pdf` +
        `?include=timing&seconds_per_dive=999`,
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
  });

  test("CSV without options returns one event row + header", async ({ request }) => {
    const r = await request.get(`/api/meets/${context.meetId}/program.csv`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
    const text = await r.text();
    const lines = text.trim().split("\n");
    // Header + 1 event row.
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("section");
    expect(lines[0]).toContain("event_name");
    expect(lines[1]).toMatch(/^event,/);
    expect(lines[1]).toContain("Women 3m Program Smoke");
  });

  test("CSV with judges + dive_lists writes the per-row sections", async ({ request }) => {
    const r = await request.get(
      `/api/meets/${context.meetId}/program.csv?include=judges,dive_lists`,
    );
    expect(r.status()).toBe(200);
    const text = await r.text();
    const lines = text.trim().split("\n");
    const sections = lines.slice(1).map((l) => l.split(",")[0]);
    expect(sections).toContain("event");
    // 5 judge rows
    expect(sections.filter((s) => s === "judge").length).toBe(5);
    // 2 divers × 3 rounds = 6 dive rows
    expect(sections.filter((s) => s === "dive").length).toBe(6);
    expect(text).toContain("Judge A");
    expect(text).toContain("Diver 1");
  });

  test("CSV timing math: 2 divers × 3 rounds × 30s = 180s per event", async ({ request }) => {
    const r = await request.get(
      `/api/meets/${context.meetId}/program.csv?include=timing&seconds_per_dive=30`,
    );
    expect(r.status()).toBe(200);
    const text = await r.text();
    const eventRow = text.split("\n").find((l) => l.startsWith("event,"));
    expect(eventRow).toBeTruthy();
    // estimated_duration_seconds column. Find it positionally:
    // header order is fixed by the route. 2 divers × 3 rounds × 30s = 180.
    const headers = text.split("\n")[0].split(",");
    const cells = eventRow.split(",");
    const durIdx = headers.indexOf("estimated_duration_seconds");
    expect(cells[durIdx]).toBe("180");
  });
});
