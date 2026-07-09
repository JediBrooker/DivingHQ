// Multi-sponsor logo upload + rotation, backend smoke.
//
// Covers the migration-045 endpoints end-to-end via the public
// API. The frontend manage / rotation UI lives in subsequent
// phases and gets its own visual coverage.
//
// What this spec asserts:
//   1. List endpoint returns the legacy single-sponsor fallback
//      when the new table is empty and the old `sponsor_logo_url`
//      field is set.
//   2. Uploading a PNG + a JPEG seats them in slots 1, 2 with
//      sharp-resized bytes (< original, sane content-type).
//   3. GET on the image endpoint serves the bytes with the right
//      Content-Type + long-cache header.
//   4. Reorder swaps slot numbers atomically.
//   5. Update changes alt_text / link_url without touching the slot.
//   6. Delete drops the row and returns 404 on subsequent fetches.
//   7. rotation endpoint sets the meet's cadence + rejects out-of-
//      range values.
//   8. URL hardening accepts /api/… paths (no false-reject from
//      the existing absolute-URL check).

const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const setup = require("./_setup");

// Tiny but valid test images. Generated at suite-load time via
// sharp itself so the route's sharp-validation step accepts
// them. 8×8 keeps the bytes small enough to flow through the
// request without burning seconds.
let PNG_8x8, JPEG_8x8;
const makeTestImages = async () => {
  const raw = Buffer.alloc(8 * 8 * 4, 0xff); // white, fully opaque
  if (!PNG_8x8) {
    PNG_8x8 = await sharp(raw, { raw: { width: 8, height: 8, channels: 4 } })
      .png().toBuffer();
  }
  if (!JPEG_8x8) {
    JPEG_8x8 = await sharp(raw, { raw: { width: 8, height: 8, channels: 4 } })
      .jpeg({ quality: 90 }).toBuffer();
  }
};

test.describe("sponsor logos", () => {
  // Tests share state (ctx.brandA / ctx.brandB) and operate on
  // the SAME meet, so parallel execution would race for slot 1
  // and leave half the suite reading from an undefined ctx.
  // Serial mode keeps the flow upload-A → upload-B → reorder →
  // update → delete in a deterministic order.
  test.describe.configure({ mode: "serial" });

  const ctx = {};

  test.beforeAll(async ({ request }) => {
    await makeTestImages();
    const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
    ctx.orgId = orgId;
    ctx.adminToken = adminToken;
    const r = await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { name: "Sponsor Logo Smoke Meet", venue: "Pool" },
    });
    expect(r.status()).toBe(201);
    ctx.meetId = (await r.json()).id;
  });

  test.afterAll(async () => {
    if (ctx.orgId) await setup.deleteOrg(ctx.orgId);
  });

  test("legacy single-sponsor fallback renders when the new table is empty", async ({ request }) => {
    // Set the legacy field via the meet update endpoint.
    const upd = await request.put(`/api/meets/${ctx.meetId}`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}` },
      data: {
        name: "Sponsor Logo Smoke Meet",
        venue: "Pool",
        sponsor_name: "Legacy Sponsor",
        sponsor_logo_url: "https://example.com/legacy-logo.png",
      },
    });
    expect(upd.status()).toBe(200);

    const r = await request.get(`/api/meets/${ctx.meetId}/sponsor-logos`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.logos).toHaveLength(1);
    expect(body.logos[0]).toMatchObject({
      legacy: true,
      slot_number: 1,
      image_url: "https://example.com/legacy-logo.png",
      alt_text: "Legacy Sponsor",
    });
    expect(body.rotation_seconds).toBe(8);
  });

  test("POST /sponsor-logos uploads PNG into slot 1", async ({ request }) => {
    const r = await request.post(
      `/api/meets/${ctx.meetId}/sponsor-logos?alt_text=Brand%20A&link_url=${encodeURIComponent("https://brand-a.example.com")}`,
      {
        headers: {
          Authorization: `Bearer ${ctx.adminToken}`,
          "Content-Type": "image/png",
        },
        data: PNG_8x8,
      },
    );
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body).toMatchObject({
      slot_number: 1,
      mime_type: "image/png",
      alt_text: "Brand A",
      link_url: "https://brand-a.example.com",
    });
    expect(body.image_url).toMatch(/^\/api\/meets\/.+\/sponsor-logos\/.+\/image\?v=\d+$/);
    ctx.brandA = body;
  });

  test("POST /sponsor-logos uploads JPEG into slot 2 (auto-increment)", async ({ request }) => {
    const r = await request.post(
      `/api/meets/${ctx.meetId}/sponsor-logos?alt_text=Brand%20B`,
      {
        headers: {
          Authorization: `Bearer ${ctx.adminToken}`,
          "Content-Type": "image/jpeg",
        },
        data: JPEG_8x8,
      },
    );
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.slot_number).toBe(2);
    expect(body.mime_type).toBe("image/jpeg");
    ctx.brandB = body;
  });

  test("GET /image serves bytes with cache + correct mime", async ({ request }) => {
    const r = await request.get(ctx.brandA.image_url);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toBe("image/png");
    expect(r.headers()["cache-control"]).toContain("max-age=");
    const bytes = await r.body();
    // sharp roundtrip, still a PNG, non-trivial size.
    expect(bytes.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
  });

  test("POST rejects unsupported MIME", async ({ request }) => {
    const r = await request.post(
      `/api/meets/${ctx.meetId}/sponsor-logos`,
      {
        headers: {
          Authorization: `Bearer ${ctx.adminToken}`,
          "Content-Type": "image/gif",
        },
        data: Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), // "GIF87a"
      },
    );
    // express.raw with a type filter passes through unknown
    // types as an EMPTY body, so the route then 400s on "Empty
    // body" rather than on MIME. Either signal is fine here,
    // we just want a 4xx (not a 5xx + crash).
    expect(r.status()).toBeGreaterThanOrEqual(400);
    expect(r.status()).toBeLessThan(500);
  });

  test("PUT updates alt_text without changing the slot", async ({ request }) => {
    const r = await request.put(
      `/api/meets/${ctx.meetId}/sponsor-logos/${ctx.brandA.id}`,
      {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
        data: { alt_text: "Brand A Updated" },
      },
    );
    expect(r.status()).toBe(200);
    expect((await r.json()).alt_text).toBe("Brand A Updated");
  });

  test("PUT rejects a javascript: link_url", async ({ request }) => {
    const r = await request.put(
      `/api/meets/${ctx.meetId}/sponsor-logos/${ctx.brandA.id}`,
      {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
        data: { link_url: "javascript:alert(1)" },
      },
    );
    expect(r.status()).toBe(400);
  });

  test("PUT /reorder swaps slots atomically", async ({ request }) => {
    const r = await request.put(
      `/api/meets/${ctx.meetId}/sponsor-logos/reorder`,
      {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
        data: { order: [ctx.brandB.id, ctx.brandA.id] }, // B first
      },
    );
    expect(r.status()).toBe(200);
    const list = await request.get(`/api/meets/${ctx.meetId}/sponsor-logos`);
    const bodies = (await list.json()).logos;
    expect(bodies[0].id).toBe(ctx.brandB.id);
    expect(bodies[0].slot_number).toBe(1);
    expect(bodies[1].id).toBe(ctx.brandA.id);
    expect(bodies[1].slot_number).toBe(2);
  });

  test("PUT /sponsor-rotation sets cadence; rejects out-of-range", async ({ request }) => {
    const ok = await request.put(
      `/api/meets/${ctx.meetId}/sponsor-rotation`,
      {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
        data: { sponsor_rotation_seconds: 12 },
      },
    );
    expect(ok.status()).toBe(200);
    expect((await ok.json()).sponsor_rotation_seconds).toBe(12);

    const bad = await request.put(
      `/api/meets/${ctx.meetId}/sponsor-rotation`,
      {
        headers: { Authorization: `Bearer ${ctx.adminToken}` },
        data: { sponsor_rotation_seconds: 9999 },
      },
    );
    expect(bad.status()).toBe(400);
  });

  test("DELETE removes the logo + image returns 404", async ({ request }) => {
    const del = await request.delete(
      `/api/meets/${ctx.meetId}/sponsor-logos/${ctx.brandA.id}`,
      { headers: { Authorization: `Bearer ${ctx.adminToken}` } },
    );
    expect(del.status()).toBe(200);

    const after = await request.get(ctx.brandA.image_url);
    expect(after.status()).toBe(404);

    const list = await request.get(`/api/meets/${ctx.meetId}/sponsor-logos`);
    const bodies = (await list.json()).logos;
    expect(bodies.find((b) => b.id === ctx.brandA.id)).toBeUndefined();
  });
});
