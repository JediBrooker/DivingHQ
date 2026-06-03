// Meet routes — a meet bundles multiple events. Public-readable
// (any spectator can browse meets) but write-restricted to
// org_admin / meet_manager.
//
//   GET    /api/orgs/:id/meets       list meets in an org (public)
//   GET    /api/meets/:id            public detail (meet + events)
//   POST   /api/meets                create
//   PUT    /api/meets/:id            update
//   DELETE /api/meets/:id            remove (events become standalone)
//   PUT    /api/events/:id/meet      assign / re-assign / detach
//
// Mounted via:
//   app.use(require('./routes/meets')({ … }))

const express = require("express");

module.exports = function createMeetsRouter({
  pool,
  optionalAuth,
  requireMeetEditor,
  requireEventManager,
}) {
  if (!pool) throw new Error("createMeetsRouter requires { pool, … }");
  const router = express.Router();
  const maybeAuth = optionalAuth || ((req, _res, next) => next());

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  async function requireEditableMeet(db, req, res) {
    const r = await db.query(
      "SELECT id, org_id FROM meets WHERE id = $1",
      [req.params.id],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: "Meet not found" });
      return null;
    }
    const meet = r.rows[0];
    if (!req.user?.is_system_admin && meet.org_id !== req.user?.org_id) {
      res.status(403).json({ error: "Cannot manage meets in other organisations" });
      return null;
    }
    return meet;
  }

  // Sponsor URL hardening. The sponsor_link_url field renders into
  // a Vue :href binding on the public meet detail page, so any
  // visitor (including not-yet-signed-in spectators) clicks
  // whatever a meet manager pasted in. Reject anything that isn't
  // a parsable absolute http/https URL — blocks javascript: /
  // data: / file: schemes that would otherwise become a one-click
  // session-takeover. sponsor_logo_url is image src so we apply
  // the same allowlist for defence in depth.
  //
  // Migration 045 also writes server-relative paths into this
  // field (e.g. `/api/meets/<id>/sponsor-logos/<logo-id>/image`)
  // when an uploaded logo replaces an external URL. Accept those
  // too — they're same-origin, parsed by the browser as
  // <current-host>/api/… and can't carry a javascript: scheme.
  function safeHttpUrl(u) {
    if (u == null || u === "") return null;
    if (typeof u !== "string") return null;
    // Same-origin relative path. Must start with a single `/`
    // (not `//host` — that's a protocol-relative URL pointing
    // off-origin) and stay under /api/ to limit the surface to
    // backend-served content.
    if (/^\/api\/[^\s]+$/.test(u)) return u;
    try {
      const parsed = new URL(u);
      return ["http:", "https:"].includes(parsed.protocol) ? u : null;
    } catch { return null; }
  }
  function rejectIfUnsafeUrl(res, label, raw) {
    if (raw == null || raw === "") return null;
    const cleaned = safeHttpUrl(raw);
    if (cleaned === null) {
      res.status(400).json({
        error: `${label} must be an absolute http(s) URL or a /api/… path`,
      });
      return false;   // sentinel: caller bails
    }
    return cleaned;
  }

  // List meets in an organisation. Public — used by the
  // Scoreboard list to group events by meet.
  router.get("/api/orgs/:id/meets", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT m.*,
                COUNT(e.id)::int AS event_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Live')::int      AS live_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Completed')::int AS completed_count
         FROM meets m
         LEFT JOIN events e ON e.meet_id = m.id
         WHERE m.org_id = $1
         GROUP BY m.id
         ORDER BY COALESCE(m.start_date, m.created_at) DESC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[List Meets Error]", err.message);
      res.status(500).json([]);
    }
  });

  // All meets across every federation — sysadmin only. Powers the
  // Meet Manager's cross-org view so a system admin sees (and can
  // open) every federation's meets, not just their own org's. The
  // org_name / country_code let the rail label which federation
  // each meet belongs to.
  router.get("/api/meets", maybeAuth, async (req, res) => {
    if (!req.user?.is_system_admin) {
      return res.status(403).json([]);
    }
    try {
      const r = await pool.query(
        `SELECT m.*, o.name AS org_name, o.country_code,
                COUNT(e.id)::int AS event_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Live')::int      AS live_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Completed')::int AS completed_count
         FROM meets m
         JOIN organisations o ON o.id = m.org_id
         LEFT JOIN events e ON e.meet_id = m.id
         GROUP BY m.id, o.name, o.country_code
         ORDER BY COALESCE(m.start_date, m.created_at) DESC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[List All Meets Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Public meet detail — meet metadata + every event nested
  // inside, in a shape suitable for the public landing page.
  router.get("/api/meets/:id", maybeAuth, async (req, res) => {
    try {
      const meetRes = await pool.query(
        `SELECT m.*, o.name AS org_name, o.country_code, o.id AS org_id
         FROM meets m
         JOIN organisations o ON o.id = m.org_id
         WHERE m.id = $1`,
        [req.params.id],
      );
      if (!meetRes.rows.length)
        return res.status(404).json({ error: "Meet not found" });
      const meetRow = meetRes.rows[0];
      const callerOrgId = req.user?.org_id || null;
      const canSeePrivate =
        !!req.user?.is_system_admin || (callerOrgId && callerOrgId === meetRow.org_id);
      const visibleSql = canSeePrivate
        ? "e.meet_id = $1"
        : callerOrgId
          ? `e.meet_id = $1
             AND (
               e.status IN ('Live','Completed')
               OR EXISTS (
                 SELECT 1 FROM event_participating_orgs epo_vis
                  WHERE epo_vis.event_id = e.id AND epo_vis.org_id = $2
               )
             )`
          : "e.meet_id = $1 AND e.status IN ('Live','Completed')";
      const visibleParams = callerOrgId && !canSeePrivate
        ? [req.params.id, callerOrgId]
        : [req.params.id];
      const eventsRes = await pool.query(
        `SELECT e.id, e.name, e.gender, e.height, e.total_rounds,
                e.number_of_judges, e.event_type, e.status, e.created_at,
                e.event_format, e.parent_event_id,
                COALESCE(stat.competitor_count, 0)::int AS competitor_count
         FROM events e
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT s.competitor_id) AS competitor_count
           FROM scores s WHERE s.event_id = e.id
         ) stat ON true
         WHERE ${visibleSql}
         ORDER BY
           CASE e.status
             WHEN 'Live'      THEN 0
             WHEN 'Upcoming'  THEN 1
             WHEN 'Completed' THEN 2
           END,
           e.created_at ASC`,
        visibleParams,
      );
      // Union of every other federation invited onto any event
      // in this meet — drives the "🌐 Participating: AUS NZL FIJ"
      // strip on the public landing page so spectators see at a
      // glance which countries are competing. Empty array when
      // every event in the meet is domestic-only.
      const partOrgsRes = await pool.query(
        `SELECT DISTINCT o.id AS org_id, o.name AS org_name,
                         o.country_code, o.slug AS org_slug
           FROM event_participating_orgs epo
           JOIN events e        ON e.id = epo.event_id
           JOIN organisations o ON o.id = epo.org_id
          WHERE ${visibleSql}
          ORDER BY o.country_code NULLS LAST, o.name`,
        visibleParams,
      );
      // Multi-sponsor logos (migration 045). Same shape as the
      // dedicated GET /api/meets/:id/sponsor-logos endpoint so
      // the SPA can use either entry point. Inlined here so the
      // public meet landing page doesn't pay a second round trip
      // to render the sponsor strip.
      const logosRes = await pool.query(
        `SELECT id, meet_id, slot_number, mime_type, byte_size,
                alt_text, link_url, updated_at
           FROM meet_sponsor_logos
          WHERE meet_id = $1
          ORDER BY slot_number ASC`,
        [req.params.id],
      );
      let logos = logosRes.rows.map((row) => ({
        id:          row.id,
        meet_id:     row.meet_id,
        slot_number: row.slot_number,
        mime_type:   row.mime_type,
        byte_size:   row.byte_size,
        alt_text:    row.alt_text,
        link_url:    row.link_url,
        image_url:   logoImageUrl(req.params.id, row),
        legacy:      false,
      }));
      // Legacy fallback — only when the new table is empty AND
      // the meet has an old-style sponsor URL or name.
      if (!logos.length && (meetRow.sponsor_logo_url || meetRow.sponsor_name)) {
        logos = [{
          id: null,
          meet_id: meetRow.id,
          slot_number: 1,
          alt_text:  meetRow.sponsor_name || "Sponsor",
          link_url:  meetRow.sponsor_link_url || null,
          image_url: meetRow.sponsor_logo_url || null,
          legacy:    true,
        }];
      }
      res.json({
        meet: meetRow,
        events: eventsRes.rows,
        participating_orgs: partOrgsRes.rows,
        sponsor_logos: logos,
      });
    } catch (err) {
      console.error("[Meet Detail Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/meets", requireMeetEditor, async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Meet name is required" });
    }
    const safeLogo = rejectIfUnsafeUrl(res, "sponsor_logo_url", sponsor_logo_url);
    if (safeLogo === false) return;
    const safeLink = rejectIfUnsafeUrl(res, "sponsor_link_url", sponsor_link_url);
    if (safeLink === false) return;
    try {
      const r = await pool.query(
        `INSERT INTO meets
           (org_id, name, venue, start_date, end_date, description,
            sponsor_name, sponsor_logo_url, sponsor_link_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          req.user.org_id, name.trim(), venue || null,
          start_date || null, end_date || null, description || null,
          sponsor_name || null, safeLogo, safeLink,
        ],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/meets/:id", requireMeetEditor, async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    const body = req.body || {};
    const updates = [];
    const params = [];
    function setField(column, value) {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    }
    if (hasOwn(body, "name")) {
      if (!name || !name.trim()) {
        return res.status(400).json({ error: "Meet name is required" });
      }
      setField("name", name.trim());
    }
    if (hasOwn(body, "venue")) setField("venue", venue || null);
    if (hasOwn(body, "start_date")) setField("start_date", start_date || null);
    if (hasOwn(body, "end_date")) setField("end_date", end_date || null);
    if (hasOwn(body, "description")) setField("description", description || null);
    if (hasOwn(body, "sponsor_name")) setField("sponsor_name", sponsor_name || null);
    if (hasOwn(body, "sponsor_logo_url")) {
      const safeLogo = rejectIfUnsafeUrl(res, "sponsor_logo_url", sponsor_logo_url);
      if (safeLogo === false) return;
      setField("sponsor_logo_url", safeLogo);
    }
    if (hasOwn(body, "sponsor_link_url")) {
      const safeLink = rejectIfUnsafeUrl(res, "sponsor_link_url", sponsor_link_url);
      if (safeLink === false) return;
      setField("sponsor_link_url", safeLink);
    }
    if (!updates.length) {
      return res.status(400).json({ error: "No updatable fields in body" });
    }
    try {
      if (!(await requireEditableMeet(pool, req, res))) return;
      params.push(req.params.id);
      const r = await pool.query(
        `UPDATE meets SET ${updates.join(", ")}
         WHERE id = $${params.length}
         RETURNING *`,
        params,
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/meets/:id", requireMeetEditor, async (req, res) => {
    try {
      if (!(await requireEditableMeet(pool, req, res))) return;
      const r = await pool.query(
        "DELETE FROM meets WHERE id = $1 RETURNING id",
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      // ON DELETE SET NULL on events.meet_id means the events
      // survive and become standalone — no separate cleanup
      // needed.
      res.json({ ok: true });
    } catch (err) {
      console.error("[Delete Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Assign / re-assign an event to a meet (or detach with
  // meet_id = null). Manager-only — both meet and event must
  // already exist in the same org.
  router.put("/api/events/:id/meet", requireEventManager(), async (req, res) => {
    const { meet_id } = req.body || {};
    try {
      // For non-sysadmin the meet must live in their own org.
      // sysadmin can move events between meets across any org.
      if (meet_id) {
        const m = await pool.query(
          "SELECT id, org_id FROM meets WHERE id = $1",
          [meet_id],
        );
        if (!m.rows.length) {
          return res.status(400).json({ error: "Meet not found" });
        }
        if (!req.user.is_system_admin && m.rows[0].org_id !== req.user.org_id) {
          return res
            .status(400)
            .json({ error: "Meet not found in this organisation" });
        }
      }
      const r = await pool.query(
        "UPDATE events SET meet_id = $1 WHERE id = $2 AND ($3::boolean OR org_id = $4) RETURNING *",
        [meet_id || null, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Event not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Assign Event Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ===============================================================
  // SPONSOR LOGOS — multi-logo upload + rotation (migration 045).
  //
  // List + image GETs are public (the logos render on the public
  // scoreboard + meet landing page); upload / update / delete /
  // reorder are gated on requireMeetEditor (org_admin or
  // meet_manager of the host org).
  //
  //   GET  /api/meets/:id/sponsor-logos
  //          → metadata + image URLs, ordered by slot
  //   POST /api/meets/:id/sponsor-logos
  //          ?alt_text=…&link_url=…
  //          Content-Type: image/(png|jpeg|webp)
  //          Body: raw image bytes (≤1MB)
  //   PUT  /api/meets/:id/sponsor-logos/:logoId
  //          { alt_text?, link_url? }
  //          (metadata-only update — slot is changed via the
  //          /reorder endpoint to keep the unique constraint
  //          atomic across multiple rows)
  //   DELETE /api/meets/:id/sponsor-logos/:logoId
  //   PUT  /api/meets/:id/sponsor-logos/reorder
  //          { order: [logoId, logoId, …] }
  //          (the array's index becomes the new slot_number)
  //   GET  /api/meets/:id/sponsor-logos/:logoId/image
  //          → image bytes with the correct Content-Type and a
  //            year-long Cache-Control (cache-busted via ?v=…
  //            stamped into sponsor_logo_url by the upload step).
  //   PUT  /api/meets/:id/sponsor-rotation
  //          { sponsor_rotation_seconds: 0..60 }
  // ===============================================================

  // Whitelist of MIME types we accept. Raster types go through
  // sharp for validation + auto-resize so a 4K logo doesn't
  // bloat the table. SVG upload is intentionally blocked because
  // browser SVG execution rules are too sharp-edged for first-
  // party uploaded sponsor content.
  const SPONSOR_LOGO_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);
  const SPONSOR_LOGO_MAX_BYTES = 1024 * 1024;          // 1MB
  const SPONSOR_LOGO_MAX_DIMENSION = 600;              // long-edge px

  // Shared shape — the URL the rest of the app references.
  // Stamped with the row's updated_at (epoch seconds) so the
  // browser cache bursts cleanly on a swap without us needing a
  // per-image ETag.
  function logoImageUrl(meetId, row) {
    const v = Math.floor(new Date(row.updated_at).getTime() / 1000);
    return `/api/meets/${meetId}/sponsor-logos/${row.id}/image?v=${v}`;
  }

  // GET /api/meets/:id/sponsor-logos — list every uploaded logo
  // for a meet, ordered by slot. Includes the legacy single-
  // sponsor field as a virtual slot if (and only if) the new
  // table has no rows — so pre-045 meets keep working.
  router.get("/api/meets/:id/sponsor-logos", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, meet_id, slot_number, mime_type, byte_size,
                alt_text, link_url, created_at, updated_at
           FROM meet_sponsor_logos
          WHERE meet_id = $1
          ORDER BY slot_number ASC`,
        [req.params.id],
      );
      if (r.rows.length === 0) {
        // Fallback to the legacy single-sponsor field so existing
        // meets render their sponsor strip without backfill.
        const legacy = await pool.query(
          `SELECT sponsor_name, sponsor_logo_url, sponsor_link_url,
                  sponsor_rotation_seconds
             FROM meets WHERE id = $1`,
          [req.params.id],
        );
        if (!legacy.rows.length) {
          return res.status(404).json({ error: "Meet not found" });
        }
        const m = legacy.rows[0];
        const logos = (m.sponsor_logo_url || m.sponsor_name)
          ? [{
              id: null,
              meet_id: req.params.id,
              slot_number: 1,
              alt_text:   m.sponsor_name || "Sponsor",
              link_url:   m.sponsor_link_url || null,
              image_url:  m.sponsor_logo_url || null,
              legacy:     true,
            }]
          : [];
        return res.json({
          logos,
          rotation_seconds: m.sponsor_rotation_seconds ?? 8,
        });
      }
      const meetRow = await pool.query(
        `SELECT sponsor_rotation_seconds FROM meets WHERE id = $1`,
        [req.params.id],
      );
      res.json({
        logos: r.rows.map((row) => ({
          id:          row.id,
          meet_id:     row.meet_id,
          slot_number: row.slot_number,
          mime_type:   row.mime_type,
          byte_size:   row.byte_size,
          alt_text:    row.alt_text,
          link_url:    row.link_url,
          image_url:   logoImageUrl(req.params.id, row),
          legacy:      false,
        })),
        rotation_seconds: meetRow.rows[0]?.sponsor_rotation_seconds ?? 8,
      });
    } catch (err) {
      console.error("[Sponsor Logos List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/meets/:id/sponsor-logos/:logoId/image — public image
  // bytes endpoint. Aggressive caching is safe because the URL is
  // cache-busted via ?v=<updated_at> stamped by the upload step.
  router.get("/api/meets/:id/sponsor-logos/:logoId/image", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT mime_type, image_bytes
           FROM meet_sponsor_logos
          WHERE meet_id = $1 AND id = $2`,
        [req.params.id, req.params.logoId],
      );
      if (!r.rows.length) {
        return res.status(404).json({ error: "Logo not found" });
      }
      const row = r.rows[0];
      res.setHeader("Content-Type", row.mime_type);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Length", row.image_bytes.length);
      res.end(row.image_bytes);
    } catch (err) {
      console.error("[Sponsor Logo Image Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/meets/:id/sponsor-logos — upload a new logo.
  // Content-Type from the request determines the MIME we store;
  // the raw body IS the image. alt_text + link_url come from
  // query params so the client doesn't need multipart for a
  // single-file upload.
  router.post(
    "/api/meets/:id/sponsor-logos",
    requireMeetEditor,
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp"],
      limit: SPONSOR_LOGO_MAX_BYTES,
    }),
    async (req, res) => {
      try {
        if (!(await requireEditableMeet(pool, req, res))) return;
        const mime = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!SPONSOR_LOGO_MIMES.has(mime)) {
          return res.status(400).json({
            error: `Content-Type must be one of: ${[...SPONSOR_LOGO_MIMES].join(", ")}`,
          });
        }
        if (!req.body || !req.body.length) {
          return res.status(400).json({ error: "Empty body — send the image bytes" });
        }
        if (req.body.length > SPONSOR_LOGO_MAX_BYTES) {
          return res.status(413).json({
            error: `Image exceeds ${Math.round(SPONSOR_LOGO_MAX_BYTES / 1024)}KB limit`,
          });
        }

        // Pipe through sharp so we (a) verify it parses, (b)
        // auto-resize the long edge to SPONSOR_LOGO_MAX_DIMENSION
        // so a 4K logo doesn't burn 800KB in the table.
        let bytes = req.body;
        let finalMime = mime;
        try {
          const sharp = require("sharp");
          const pipeline = sharp(req.body, { failOnError: true })
            .resize({
              width: SPONSOR_LOGO_MAX_DIMENSION,
              height: SPONSOR_LOGO_MAX_DIMENSION,
              fit: "inside",
              withoutEnlargement: true,
            });
          // Re-encode in the source format. PNG/JPEG/WebP all
          // round-trip cleanly through sharp.
          if (mime === "image/png")  bytes = await pipeline.png().toBuffer();
          if (mime === "image/jpeg") bytes = await pipeline.jpeg({ quality: 88 }).toBuffer();
          if (mime === "image/webp") bytes = await pipeline.webp({ quality: 88 }).toBuffer();
        } catch (err) {
          return res.status(400).json({
            error: `Image could not be decoded: ${err.message}`,
          });
        }

        const altText = req.query.alt_text ? String(req.query.alt_text).slice(0, 255) : null;
        const linkRaw = req.query.link_url ? String(req.query.link_url) : null;
        const linkUrl = linkRaw ? rejectIfUnsafeUrl(res, "link_url", linkRaw) : null;
        if (linkUrl === false) return; // rejectIfUnsafeUrl already sent the 400

        // Atomic insert: next slot is (max(slot_number) + 1) for
        // this meet — deterministic, no race because the (meet_id,
        // slot_number) UNIQUE constraint catches concurrent
        // uploads and the caller can retry.
        const insert = await pool.query(
          `INSERT INTO meet_sponsor_logos
             (meet_id, slot_number, mime_type, byte_size, image_bytes,
              alt_text, link_url)
           VALUES (
             $1,
             COALESCE((SELECT MAX(slot_number) + 1
                         FROM meet_sponsor_logos
                        WHERE meet_id = $1), 1),
             $2, $3, $4, $5, $6
           )
           RETURNING id, slot_number, mime_type, byte_size, alt_text,
                     link_url, updated_at`,
          [req.params.id, finalMime, bytes.length, bytes, altText, linkUrl],
        );
        const row = insert.rows[0];
        res.status(201).json({
          id:          row.id,
          slot_number: row.slot_number,
          mime_type:   row.mime_type,
          byte_size:   row.byte_size,
          alt_text:    row.alt_text,
          link_url:    row.link_url,
          image_url:   logoImageUrl(req.params.id, row),
        });
      } catch (err) {
        if (err && /unique/i.test(err.message)) {
          return res.status(409).json({
            error: "Slot collision — retry the upload",
          });
        }
        console.error("[Sponsor Logo Upload Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // PUT /api/meets/:id/sponsor-logos/reorder — atomic slot
  // reorder. Body: `{ order: [logoId, logoId, …] }` — the array
  // position becomes the new slot_number (1-indexed).
  //
  // Two-phase swap to keep the (meet_id, slot_number) UNIQUE
  // constraint consistent without deferred constraints:
  //   1. Move every row to slot = -(new_slot) (negative numbers
  //      can't collide with the current positive ones).
  //   2. Flip back to slot = ABS(slot) inside the transaction.
  //
  // REGISTERED BEFORE the `:logoId` PUT handler below so Express
  // matches `/reorder` as a literal path rather than treating
  // "reorder" as a UUID parameter.
  router.put(
    "/api/meets/:id/sponsor-logos/reorder",
    requireMeetEditor,
    async (req, res) => {
      const order = Array.isArray(req.body?.order) ? req.body.order : null;
      if (!order || !order.length) {
        return res.status(400).json({ error: "Body must be { order: [logoId, …] }" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (!(await requireEditableMeet(client, req, res))) {
          await client.query("ROLLBACK");
          return;
        }
        const owned = await client.query(
          `SELECT id FROM meet_sponsor_logos
            WHERE meet_id = $1 AND id = ANY($2::uuid[])`,
          [req.params.id, order],
        );
        if (owned.rows.length !== order.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "order contains ids that don't belong to this meet",
          });
        }
        for (let i = 0; i < order.length; i++) {
          await client.query(
            `UPDATE meet_sponsor_logos
                SET slot_number = $1
              WHERE meet_id = $2 AND id = $3`,
            [-(i + 1), req.params.id, order[i]],
          );
        }
        await client.query(
          `UPDATE meet_sponsor_logos
              SET slot_number = -slot_number,
                  updated_at  = now()
            WHERE meet_id = $1 AND slot_number < 0`,
          [req.params.id],
        );
        await client.query("COMMIT");
        res.json({ reordered: true, count: order.length });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Sponsor Logo Reorder Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // PUT /api/meets/:id/sponsor-logos/:logoId — update alt_text /
  // link_url. Slot changes go through /reorder so the unique
  // constraint stays consistent.
  router.put(
    "/api/meets/:id/sponsor-logos/:logoId",
    requireMeetEditor,
    async (req, res) => {
      try {
        if (!(await requireEditableMeet(pool, req, res))) return;
        const updates = {};
        if ("alt_text" in (req.body || {})) {
          updates.alt_text = req.body.alt_text
            ? String(req.body.alt_text).slice(0, 255)
            : null;
        }
        if ("link_url" in (req.body || {})) {
          const raw = req.body.link_url;
          if (raw == null || raw === "") {
            updates.link_url = null;
          } else {
            const safe = rejectIfUnsafeUrl(res, "link_url", raw);
            if (safe === false) return;
            updates.link_url = safe;
          }
        }
        if (!Object.keys(updates).length) {
          return res.status(400).json({ error: "No updatable fields in body" });
        }
        const setSql = Object.keys(updates)
          .map((k, i) => `${k} = $${i + 3}`)
          .join(", ");
        const r = await pool.query(
          `UPDATE meet_sponsor_logos
              SET ${setSql}, updated_at = now()
            WHERE meet_id = $1 AND id = $2
            RETURNING id, slot_number, mime_type, byte_size, alt_text,
                      link_url, updated_at`,
          [req.params.id, req.params.logoId, ...Object.values(updates)],
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: "Logo not found" });
        }
        const row = r.rows[0];
        res.json({
          id:          row.id,
          slot_number: row.slot_number,
          mime_type:   row.mime_type,
          byte_size:   row.byte_size,
          alt_text:    row.alt_text,
          link_url:    row.link_url,
          image_url:   logoImageUrl(req.params.id, row),
        });
      } catch (err) {
        console.error("[Sponsor Logo Update Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // DELETE /api/meets/:id/sponsor-logos/:logoId — remove a logo.
  // The (meet_id, slot_number) UNIQUE constraint stays satisfied
  // because we're removing a row, not shifting existing ones.
  // The next upload picks (max + 1) so removing slot 2 of 3
  // leaves a gap (1, _, 3) — the client can call /reorder to
  // close it.
  router.delete(
    "/api/meets/:id/sponsor-logos/:logoId",
    requireMeetEditor,
    async (req, res) => {
      try {
        if (!(await requireEditableMeet(pool, req, res))) return;
        const r = await pool.query(
          `DELETE FROM meet_sponsor_logos
            WHERE meet_id = $1 AND id = $2
            RETURNING id`,
          [req.params.id, req.params.logoId],
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: "Logo not found" });
        }
        res.json({ deleted: true });
      } catch (err) {
        console.error("[Sponsor Logo Delete Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // PUT /api/meets/:id/sponsor-rotation — set the broadcast
  // rotation cadence in seconds. 0 disables rotation (all logos
  // render statically). Clamped to 0..60.
  router.put(
    "/api/meets/:id/sponsor-rotation",
    requireMeetEditor,
    async (req, res) => {
      try {
        if (!(await requireEditableMeet(pool, req, res))) return;
        const n = parseInt(req.body?.sponsor_rotation_seconds, 10);
        if (!Number.isInteger(n) || n < 0 || n > 60) {
          return res.status(400).json({
            error: "sponsor_rotation_seconds must be an integer 0..60",
          });
        }
        const r = await pool.query(
          `UPDATE meets SET sponsor_rotation_seconds = $1
            WHERE id = $2
            RETURNING id, sponsor_rotation_seconds`,
          [n, req.params.id],
        );
        if (!r.rows.length) {
          return res.status(404).json({ error: "Meet not found" });
        }
        res.json({ sponsor_rotation_seconds: r.rows[0].sponsor_rotation_seconds });
      } catch (err) {
        console.error("[Sponsor Rotation Update Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
};
