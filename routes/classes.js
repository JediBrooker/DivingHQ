// Club training-classes routes — CLUB-PRIVATE.
//
// A "class" is a recurring club-run training group. Access is context-scoped:
//   * Club admins (requireClubAdminOnly — NOT the federation org_admin) manage
//     their club's classes, prices, and enrolments, and see the full roster.
//   * Coaches (role 'coach', in the same club) see who is enrolled (read-only).
//   * Divers see only THEIR OWN enrolments + can browse/self-enrol into their
//     own club's classes. They never see anyone else's enrolment.
//
// Pricing is flexible: each class has price OPTIONS a diver picks from; the
// club may apply a manual per-enrolment discount. Enrolment PAYMENT + club
// payouts arrive in a later change; here enrolment is the roster model and
// works while payments are dormant.
//
// Mounted via:
//   app.use(require('./routes/classes')({ pool, verifyToken, requireClubAdminOnly, logger }))

const express = require("express");
const { recordAudit, auditFromReq } = require("../lib/audit");
const { priceCharge } = require("../lib/fee-pricing");

const APP_BASE_URL =
  process.env.APP_BASE_URL || process.env.CORS_ORIGIN || "http://localhost:5173";

module.exports = function createClassesRouter({ pool, verifyToken, requireClubAdminOnly, logger, payments }) {
  if (!pool) throw new Error("createClassesRouter requires { pool, … }");
  const router = express.Router();

  const log = logger || { error: () => {}, warn: () => {} };

  function ensurePayments(res) {
    if (!payments || !payments.enabled) {
      res.status(503).json({ error: "Payments are not configured on this server." });
      return false;
    }
    return true;
  }

  // Don't let a class-enrolment status change (cancel, or a future admin
  // action) race an in-flight Stripe checkout — expire the session and mark
  // the payment failed so a stale session can't complete after the fact and
  // strand a paid-but-orphaned payment (mirrors retireInFlightFinePayment in
  // routes/payments.js). Returns "paid" if the payment had already settled
  // before we could retire it, so the caller can refuse the status change
  // instead of silently cancelling underneath a successful payment.
  async function retireInFlightClassEnrolmentPayment(enrolmentId) {
    const p = (await pool.query(
      "SELECT id, status, stripe_checkout_session FROM payments WHERE class_enrolment_id = $1 AND status IN ('pending', 'paid') ORDER BY created_at DESC LIMIT 1",
      [enrolmentId],
    )).rows[0];
    if (!p) return null;
    if (p.status === "paid") return "paid";
    // p.status === "pending"
    if (payments && payments.enabled && p.stripe_checkout_session) {
      try {
        await payments.expireCheckoutSession({ sessionId: p.stripe_checkout_session });
      } catch (e) {
        log.warn({ err: e.message }, "[classes] could not expire in-flight enrolment session");
      }
    }
    await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [p.id]);
    return null;
  }

  // ---- validation helpers ----------------------------------------
  function cleanName(v, max) {
    const s = (v == null ? "" : String(v)).trim();
    return s ? s.slice(0, max) : null;
  }
  function intOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  }
  function cleanCurrency(v) {
    const s = (v == null ? "" : String(v)).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(s) ? s : null;
  }
  // Validate an incoming price-option payload -> {label, amount_cents, currency} or {error}.
  function validatePriceOption(p) {
    const label = cleanName(p && p.label, 80);
    if (!label) return { error: "Each price option needs a label." };
    const amount = intOrNull(p && p.amount_cents);
    if (!Number.isInteger(amount) || amount < 0 || amount > 100000000) {
      return { error: "Each price option needs a valid amount." };
    }
    const currency = cleanCurrency(p && p.currency);
    if (!currency) return { error: "Each price option needs a 3-letter currency." };
    return { label, amount_cents: amount, currency };
  }

  // Fetch a class scoped to a club. Returns the row or null.
  async function loadClass(clubId, classId, db = pool) {
    const r = await db.query(
      "SELECT * FROM classes WHERE id = $1 AND club_id = $2",
      [classId, clubId],
    );
    return r.rows[0] || null;
  }

  const PRICE_OPTIONS_JSON =
    `COALESCE((SELECT json_agg(json_build_object(
        'id', po.id, 'label', po.label, 'amount_cents', po.amount_cents,
        'currency', po.currency, 'sort_order', po.sort_order)
        ORDER BY po.sort_order, po.created_at)
      FROM class_price_options po WHERE po.class_id = c.id AND po.active), '[]'::json)`;

  // ================================================================
  // CONTEXT DISCOVERY — lets the SPA pick which panel(s) to show without
  // guessing from JWT roles alone (club-admin-ness isn't in the JWT: it's
  // a club_admins row, not an org role).
  // ================================================================
  router.get("/api/me/club-admin-clubs", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT cl.id, cl.name
           FROM club_admins ca
           JOIN clubs cl ON cl.id = ca.club_id
          WHERE ca.user_id = $1
          ORDER BY lower(cl.name)`,
        [req.user.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] club-admin-clubs failed");
      return res.status(500).json({ error: "Failed to load your club admin memberships." });
    }
  });

  // ================================================================
  // CLUB ADMIN — manage classes (club-private; excludes federation)
  // ================================================================

  // List the club's classes, with live enrolment count + active price options.
  router.get("/api/clubs/:id/classes", requireClubAdminOnly(), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT c.id, c.name, c.description, c.level, c.schedule, c.capacity,
                c.active, c.created_at, c.updated_at,
                COALESCE((SELECT COUNT(*) FROM class_enrolments e
                           WHERE e.class_id = c.id AND e.status IN ('active','pending')), 0)::int AS enrolment_count,
                ${PRICE_OPTIONS_JSON} AS price_options
           FROM classes c
          WHERE c.club_id = $1
          ORDER BY c.active DESC, lower(c.name)`,
        [req.club.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] list failed");
      return res.status(500).json({ error: "Failed to load classes." });
    }
  });

  // Club's own members, for the "add diver to class" picker. Credential-safe
  // projection (id + name only, no username) — mirrors GET /api/orgs/:id/members.
  router.get("/api/clubs/:id/members", requireClubAdminOnly(), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, full_name FROM users
          WHERE club_id = $1 AND deleted_at IS NULL
          ORDER BY lower(full_name)`,
        [req.club.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] club members failed");
      return res.status(500).json({ error: "Failed to load club members." });
    }
  });

  // Create a class (+ optional initial price options).
  router.post("/api/clubs/:id/classes", requireClubAdminOnly(), async (req, res) => {
    const body = req.body || {};
    const name = cleanName(body.name, 120);
    if (!name) return res.status(400).json({ error: "A class name is required." });
    const capacity = intOrNull(body.capacity);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
      return res.status(400).json({ error: "Capacity must be a positive whole number." });
    }
    const priceRows = Array.isArray(body.price_options) ? body.price_options : [];
    const cleanPrices = [];
    for (const p of priceRows) {
      const v = validatePriceOption(p);
      if (v.error) return res.status(400).json({ error: v.error });
      cleanPrices.push(v);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cls = (await client.query(
        `INSERT INTO classes (club_id, org_id, name, description, level, schedule, capacity, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, description, level, schedule, capacity, active, created_at, updated_at`,
        [req.club.id, req.club.org_id, name,
         cleanName(body.description, 4000), cleanName(body.level, 60), cleanName(body.schedule, 200),
         capacity, req.user.id],
      )).rows[0];
      const insertedPrices = [];
      let sort = 0;
      for (const p of cleanPrices) {
        const pr = (await client.query(
          `INSERT INTO class_price_options (class_id, label, amount_cents, currency, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, label, amount_cents, currency, sort_order`,
          [cls.id, p.label, p.amount_cents, p.currency, sort++],
        )).rows[0];
        insertedPrices.push(pr);
      }
      await client.query("COMMIT");
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: req.club.org_id,
        entity_type: "class", entity_id: cls.id, entity_name: cls.name,
        action: "class.created", metadata: { club_id: req.club.id },
      }).catch(() => {});
      cls.price_options = insertedPrices;
      cls.enrolment_count = 0;
      return res.status(201).json(cls);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log.error({ err: err.message }, "[classes] create failed");
      return res.status(500).json({ error: "Failed to create the class." });
    } finally {
      client.release();
    }
  });

  // Update a class's core fields.
  router.put("/api/clubs/:id/classes/:classId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const body = req.body || {};
      const name = body.name === undefined ? cls.name : cleanName(body.name, 120);
      if (!name) return res.status(400).json({ error: "A class name is required." });
      let capacity = cls.capacity;
      if (body.capacity !== undefined) {
        capacity = intOrNull(body.capacity);
        if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
          return res.status(400).json({ error: "Capacity must be a positive whole number." });
        }
      }
      const r = await pool.query(
        `UPDATE classes SET name = $1, description = $2, level = $3, schedule = $4,
                capacity = $5, active = $6, updated_at = now()
          WHERE id = $7 AND club_id = $8
          RETURNING id, name, description, level, schedule, capacity, active, created_at, updated_at`,
        [name,
         body.description === undefined ? cls.description : cleanName(body.description, 4000),
         body.level === undefined ? cls.level : cleanName(body.level, 60),
         body.schedule === undefined ? cls.schedule : cleanName(body.schedule, 200),
         capacity,
         body.active === undefined ? cls.active : body.active === true,
         req.params.classId, req.club.id],
      );
      return res.json(r.rows[0]);
    } catch (err) {
      log.error({ err: err.message }, "[classes] update failed");
      return res.status(500).json({ error: "Failed to update the class." });
    }
  });

  // Delete a class (cascades price options + enrolments).
  router.delete("/api/clubs/:id/classes/:classId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      await pool.query("DELETE FROM classes WHERE id = $1 AND club_id = $2", [req.params.classId, req.club.id]);
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: req.club.org_id,
        entity_type: "class", entity_id: cls.id, entity_name: cls.name,
        action: "class.deleted", metadata: { club_id: req.club.id },
      }).catch(() => {});
      return res.json({ message: "Class deleted" });
    } catch (err) {
      log.error({ err: err.message }, "[classes] delete failed");
      return res.status(500).json({ error: "Failed to delete the class." });
    }
  });

  // ---- price options ---------------------------------------------
  router.post("/api/clubs/:id/classes/:classId/prices", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const v = validatePriceOption(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const sort = intOrNull((req.body || {}).sort_order);
      const r = await pool.query(
        `INSERT INTO class_price_options (class_id, label, amount_cents, currency, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, label, amount_cents, currency, sort_order, active`,
        [cls.id, v.label, v.amount_cents, v.currency, Number.isInteger(sort) ? sort : 0],
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) {
      log.error({ err: err.message }, "[classes] add price failed");
      return res.status(500).json({ error: "Failed to add the price option." });
    }
  });

  router.put("/api/clubs/:id/classes/:classId/prices/:priceId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const v = validatePriceOption(req.body || {});
      if (v.error) return res.status(400).json({ error: v.error });
      const sort = intOrNull((req.body || {}).sort_order);
      const active = (req.body || {}).active === undefined ? true : (req.body || {}).active === true;
      const r = await pool.query(
        `UPDATE class_price_options SET label = $1, amount_cents = $2, currency = $3,
                sort_order = $4, active = $5
          WHERE id = $6 AND class_id = $7
          RETURNING id, label, amount_cents, currency, sort_order, active`,
        [v.label, v.amount_cents, v.currency, Number.isInteger(sort) ? sort : 0, active, req.params.priceId, cls.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Price option not found" });
      return res.json(r.rows[0]);
    } catch (err) {
      log.error({ err: err.message }, "[classes] edit price failed");
      return res.status(500).json({ error: "Failed to update the price option." });
    }
  });

  // Deactivate a price option (kept for enrolment history; amount snapshots survive).
  router.delete("/api/clubs/:id/classes/:classId/prices/:priceId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const r = await pool.query(
        "UPDATE class_price_options SET active = false WHERE id = $1 AND class_id = $2 RETURNING id",
        [req.params.priceId, cls.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Price option not found" });
      return res.json({ message: "Price option removed" });
    } catch (err) {
      log.error({ err: err.message }, "[classes] remove price failed");
      return res.status(500).json({ error: "Failed to remove the price option." });
    }
  });

  // ---- roster + enrolment management -----------------------------
  router.get("/api/clubs/:id/classes/:classId/roster", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const r = await pool.query(
        `SELECT e.id, e.status, e.amount_cents, e.discount_cents, e.currency, e.note, e.enrolled_at,
                u.id AS diver_id, u.full_name AS diver_name,
                po.label AS price_label
           FROM class_enrolments e
           JOIN users u ON u.id = e.diver_user_id
           LEFT JOIN class_price_options po ON po.id = e.price_option_id
          WHERE e.class_id = $1 AND e.status <> 'cancelled'
          ORDER BY (e.status = 'active') DESC, lower(u.full_name)`,
        [cls.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] roster failed");
      return res.status(500).json({ error: "Failed to load the roster." });
    }
  });

  // Club admin adds a diver to a class.
  router.post("/api/clubs/:id/classes/:classId/enrolments", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const body = req.body || {};
      const diverId = body.diver_user_id;
      if (!diverId) return res.status(400).json({ error: "A diver is required." });
      const diver = (await pool.query("SELECT id, org_id FROM users WHERE id = $1 AND deleted_at IS NULL", [diverId])).rows[0];
      if (!diver) return res.status(404).json({ error: "Diver not found" });
      if (diver.org_id !== req.club.org_id) {
        return res.status(400).json({ error: "That diver isn't in your federation." });
      }
      const chosen = await resolvePriceOption(cls.id, body.price_option_id);
      if (chosen && chosen.error) return res.status(400).json({ error: chosen.error });
      const discount = intOrNull(body.discount_cents) || 0;
      if (discount < 0) return res.status(400).json({ error: "Discount can't be negative." });
      if (chosen && discount > chosen.amount_cents) {
        return res.status(400).json({ error: "Discount can't exceed the price." });
      }
      const r = await pool.query(
        `INSERT INTO class_enrolments
            (class_id, diver_user_id, club_id, org_id, status, price_option_id, amount_cents, discount_cents, currency, note, enrolled_by)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [cls.id, diverId, req.club.id, req.club.org_id,
         chosen ? chosen.id : null, chosen ? chosen.amount_cents : null,
         discount, chosen ? chosen.currency : null, cleanName(body.note, 500), req.user.id],
      );
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: req.club.org_id,
        entity_type: "class_enrolment", entity_id: r.rows[0].id, entity_name: cls.name,
        action: "class.enrolment_added", metadata: { class_id: cls.id, diver_id: diverId },
      }).catch(() => {});
      return res.status(201).json({ id: r.rows[0].id });
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "That diver is already enrolled in this class." });
      log.error({ err: err.message }, "[classes] enrol failed");
      return res.status(500).json({ error: "Failed to enrol the diver." });
    }
  });

  // Resolve + validate a price option belongs to the class and is active.
  async function resolvePriceOption(classId, priceOptionId) {
    if (!priceOptionId) return null;
    const po = (await pool.query(
      "SELECT id, amount_cents, currency FROM class_price_options WHERE id = $1 AND class_id = $2 AND active",
      [priceOptionId, classId],
    )).rows[0];
    if (!po) return { error: "That price option isn't available for this class." };
    return po;
  }

  // Club admin updates an enrolment (status / discount / price option).
  router.put("/api/clubs/:id/classes/:classId/enrolments/:enrolId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const enr = (await pool.query(
        "SELECT * FROM class_enrolments WHERE id = $1 AND class_id = $2",
        [req.params.enrolId, cls.id],
      )).rows[0];
      if (!enr) return res.status(404).json({ error: "Enrolment not found" });
      const body = req.body || {};
      let status = enr.status;
      if (body.status !== undefined) {
        if (!["pending", "active", "inactive", "cancelled"].includes(body.status)) {
          return res.status(400).json({ error: "Invalid status." });
        }
        status = body.status;
      }
      let priceOptionId = enr.price_option_id;
      let amount = enr.amount_cents;
      let currency = enr.currency;
      if (body.price_option_id !== undefined) {
        const chosen = await resolvePriceOption(cls.id, body.price_option_id);
        if (chosen && chosen.error) return res.status(400).json({ error: chosen.error });
        priceOptionId = chosen ? chosen.id : null;
        amount = chosen ? chosen.amount_cents : null;
        currency = chosen ? chosen.currency : null;
      }
      let discount = enr.discount_cents;
      if (body.discount_cents !== undefined) {
        discount = intOrNull(body.discount_cents) || 0;
        if (discount < 0) return res.status(400).json({ error: "Discount can't be negative." });
      }
      // Re-check against the RESOLVED amount, even when only the price option
      // changed: switching to a cheaper option could leave a stale discount
      // above the new price.
      if (amount != null && discount > amount) {
        return res.status(400).json({ error: "Discount can't exceed the price." });
      }
      // A 'pending' row may have an in-flight (or abandoned) Stripe checkout
      // for its CURRENT price. Retire it before committing any edit that
      // would make a stale session's completion wrong: leaving 'pending' for
      // any other status (a stale session could re-activate a row the admin
      // just cancelled/paused, or — worse — double-charge a diver whose
      // payment the admin just resolved manually by setting 'active'
      // directly), or changing price/discount while staying 'pending' (a
      // stale session would settle at the OLD price, leaving the payment
      // that actually funded activation mismatched against the edited
      // snapshot). Not needed once the row is already active/inactive/
      // cancelled — there's no live checkout left to race by then.
      if (enr.status === "pending") {
        const priceChanging = body.price_option_id !== undefined && priceOptionId !== enr.price_option_id;
        const discountChanging = body.discount_cents !== undefined && discount !== enr.discount_cents;
        if (status !== "pending" || priceChanging || discountChanging) {
          if ((await retireInFlightClassEnrolmentPayment(enr.id)) === "paid") {
            return res.status(409).json({ error: "This enrolment was just paid for — refresh before making changes." });
          }
        }
      }
      const r = await pool.query(
        `UPDATE class_enrolments
            SET status = $1, price_option_id = $2, amount_cents = $3, currency = $4,
                discount_cents = $5, note = $6, updated_at = now()
          WHERE id = $7 AND class_id = $8
          RETURNING id, status, amount_cents, discount_cents, currency`,
        [status, priceOptionId, amount, currency, discount,
         body.note === undefined ? enr.note : cleanName(body.note, 500),
         req.params.enrolId, cls.id],
      );
      return res.json(r.rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "That diver already has a live enrolment in this class." });
      log.error({ err: err.message }, "[classes] enrolment update failed");
      return res.status(500).json({ error: "Failed to update the enrolment." });
    }
  });

  // Club admin removes an enrolment (cancels it; frees the slot for re-enrolment).
  router.delete("/api/clubs/:id/classes/:classId/enrolments/:enrolId", requireClubAdminOnly(), async (req, res) => {
    try {
      const cls = await loadClass(req.club.id, req.params.classId);
      if (!cls) return res.status(404).json({ error: "Class not found" });
      // Retire any in-flight checkout FIRST — otherwise a diver could complete
      // a stale Stripe session after this cancels, settling a payment for an
      // enrolment nothing on the roster reflects anymore.
      if ((await retireInFlightClassEnrolmentPayment(req.params.enrolId)) === "paid") {
        return res.status(409).json({ error: "This enrolment was just paid for — refresh the roster instead of removing it." });
      }
      const r = await pool.query(
        "UPDATE class_enrolments SET status = 'cancelled', updated_at = now() WHERE id = $1 AND class_id = $2 RETURNING id",
        [req.params.enrolId, cls.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Enrolment not found" });
      await recordAudit(pool, {
        ...auditFromReq(req), org_id: req.club.org_id,
        entity_type: "class_enrolment", entity_id: req.params.enrolId, entity_name: cls.name,
        action: "class.enrolment_removed", metadata: { class_id: cls.id },
      }).catch(() => {});
      return res.json({ message: "Enrolment removed" });
    } catch (err) {
      log.error({ err: err.message }, "[classes] enrolment remove failed");
      return res.status(500).json({ error: "Failed to remove the enrolment." });
    }
  });

  // ---- payouts (club-private — the federation never sees this) ----
  //
  // Net owed to the CLUB per currency: class-enrolment payments collected
  // (fee prorated on partial refunds, clamped >= 0) minus what's already
  // withdrawn. Scoped by recipient_type = 'club' so club_affiliation/
  // accreditation payments (which also carry this club's id, but as the
  // SUBJECT being charged, not the recipient) are never counted here —
  // those pay the federation and are covered by orgBalancesByCurrency.
  async function clubBalancesByCurrency(clubId, db = pool) {
    const collected = (await db.query(
      `SELECT currency, COALESCE(SUM(GREATEST(0,
          CASE status
            WHEN 'paid' THEN amount_cents - platform_fee_cents
            WHEN 'partially_refunded' THEN ROUND(
              (amount_cents - platform_fee_cents)::numeric
                * (amount_cents - COALESCE(refunded_amount_cents, 0)) / NULLIF(amount_cents, 0))
            ELSE 0 END)), 0)::bigint AS net
         FROM payments WHERE club_id = $1 AND recipient_type = 'club' GROUP BY currency`,
      [clubId],
    )).rows;
    const paid = (await db.query(
      `SELECT currency, COALESCE(SUM(amount_cents), 0)::bigint AS n
         FROM payouts WHERE club_id = $1 AND status IN ('pending', 'paid') GROUP BY currency`,
      [clubId],
    )).rows;
    const paidByCur = new Map(paid.map((r) => [r.currency, Number(r.n)]));
    return collected
      .map((r) => ({ currency: r.currency, cents: Number(r.net) - (paidByCur.get(r.currency) || 0) }))
      .filter((b) => b.cents > 0)
      .sort((a, b) => b.cents - a.cents);
  }

  router.get("/api/clubs/:id/payments/status", requireClubAdminOnly(), async (req, res) => {
    try {
      const club = (await pool.query(
        `SELECT payout_account_name, payout_account_details, auto_withdraw_enabled, auto_withdraw_min_cents
           FROM clubs WHERE id = $1`,
        [req.club.id],
      )).rows[0];
      const base = {
        payout_details_set: !!(club.payout_account_name && club.payout_account_details),
        account_name: club.payout_account_name || null,
        auto_withdraw_enabled: !!club.auto_withdraw_enabled,
        auto_withdraw_min_cents: club.auto_withdraw_min_cents ?? null,
      };
      if (!payments || !payments.enabled) return res.json({ enabled: false, ...base, balances: [], balance_cents: 0 });
      const balances = await clubBalancesByCurrency(req.club.id);
      const primary = balances[0] || null;
      return res.json({
        enabled: true, ...base, balances,
        balance_cents: primary ? primary.cents : 0,
        currency: primary ? primary.currency : null,
      });
    } catch (err) {
      log.error({ err: err.message }, "[classes] club payout status failed");
      return res.status(500).json({ error: "Failed to load payout status." });
    }
  });

  router.put("/api/clubs/:id/payout-details", requireClubAdminOnly(), async (req, res) => {
    const name = ((req.body || {}).account_name || "").toString().trim();
    const details = ((req.body || {}).account_details || "").toString().trim();
    if (!name || !details) return res.status(400).json({ error: "Account name and details are required." });
    try {
      await pool.query(
        "UPDATE clubs SET payout_account_name = $1, payout_account_details = $2 WHERE id = $3",
        [name.slice(0, 200), details.slice(0, 500), req.club.id],
      );
      return res.json({ ok: true });
    } catch (err) {
      log.error({ err: err.message }, "[classes] save club payout details failed");
      return res.status(500).json({ error: "Failed to save payout details." });
    }
  });

  router.put("/api/clubs/:id/withdrawal-settings", requireClubAdminOnly(), async (req, res) => {
    const body = req.body || {};
    const enabled = body.auto_withdraw_enabled === true;
    let minCents = null;
    if (enabled) {
      minCents = Math.floor(Number(body.auto_withdraw_min_cents));
      if (!Number.isFinite(minCents) || minCents < 100) {
        return res.status(400).json({ error: "Set an automatic-withdrawal threshold of at least 1.00." });
      }
      if (minCents > 100000000) return res.status(400).json({ error: "That threshold is too large." });
    }
    try {
      await pool.query(
        "UPDATE clubs SET auto_withdraw_enabled = $1, auto_withdraw_min_cents = $2 WHERE id = $3",
        [enabled, minCents, req.club.id],
      );
      return res.json({ ok: true, auto_withdraw_enabled: enabled, auto_withdraw_min_cents: minCents });
    } catch (err) {
      log.error({ err: err.message }, "[classes] save club withdrawal settings failed");
      return res.status(500).json({ error: "Failed to save withdrawal settings." });
    }
  });

  router.get("/api/clubs/:id/withdrawals", requireClubAdminOnly(), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, amount_cents, currency, status, note, created_at, paid_at
           FROM payouts WHERE club_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.club.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] list club withdrawals failed");
      return res.status(500).json({ error: "Failed to load withdrawals." });
    }
  });

  router.post("/api/clubs/:id/withdrawals", requireClubAdminOnly(), async (req, res) => {
    if (!ensurePayments(res)) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const club = (await client.query(
        "SELECT payout_account_name, payout_account_details FROM clubs WHERE id = $1 FOR UPDATE",
        [req.club.id],
      )).rows[0];
      if (!club.payout_account_name || !club.payout_account_details) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Add your payout bank details before withdrawing." });
      }
      const note = ((req.body || {}).note || "").toString().trim().slice(0, 200) || null;
      const balances = await clubBalancesByCurrency(req.club.id, client);
      if (!balances.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "You have no balance to withdraw." });
      }
      const payouts = [];
      for (const b of balances) {
        const row = (await client.query(
          `INSERT INTO payouts (club_id, amount_cents, currency, status, note)
           VALUES ($1, $2, $3, 'pending', $4)
           RETURNING id, amount_cents, currency, status, note, created_at, paid_at`,
          [req.club.id, b.cents, b.currency, note],
        )).rows[0];
        payouts.push(row);
      }
      await client.query("COMMIT");
      return res.status(201).json(payouts);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log.error({ err: err.message }, "[classes] club withdrawal request failed");
      return res.status(err.status || 500).json({ error: err.message || "Withdrawal failed." });
    } finally {
      client.release();
    }
  });

  // ================================================================
  // COACH — read-only view of who's in the club's classes
  // ================================================================
  router.get("/api/coach/classes", verifyToken, async (req, res) => {
    try {
      const roles = req.user.org_roles || [];
      if (!roles.includes("coach") && !req.user.is_system_admin) {
        return res.status(403).json({ error: "Coaches only." });
      }
      const me = (await pool.query("SELECT club_id FROM users WHERE id = $1", [req.user.id])).rows[0];
      const clubId = me && me.club_id;
      if (!clubId) return res.json([]);
      const classes = (await pool.query(
        `SELECT c.id, c.name, c.level, c.schedule, c.capacity, c.active
           FROM classes c WHERE c.club_id = $1 ORDER BY c.active DESC, lower(c.name)`,
        [clubId],
      )).rows;
      if (!classes.length) return res.json([]);
      const enrolments = (await pool.query(
        `SELECT e.class_id, e.status, u.id AS diver_id, u.full_name AS diver_name
           FROM class_enrolments e
           JOIN users u ON u.id = e.diver_user_id
          WHERE e.class_id = ANY($1::uuid[]) AND e.status IN ('active','pending')
          ORDER BY lower(u.full_name)`,
        [classes.map((c) => c.id)],
      )).rows;
      const byClass = new Map(classes.map((c) => [c.id, { ...c, enrolments: [] }]));
      for (const e of enrolments) {
        byClass.get(e.class_id)?.enrolments.push({ diver_id: e.diver_id, diver_name: e.diver_name, status: e.status });
      }
      return res.json([...byClass.values()]);
    } catch (err) {
      log.error({ err: err.message }, "[classes] coach view failed");
      return res.status(500).json({ error: "Failed to load your club's classes." });
    }
  });

  // ================================================================
  // DIVER — own enrolments + browse/self-enrol into own club's classes
  // ================================================================
  router.get("/api/me/classes", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT e.id, e.status, e.amount_cents, e.discount_cents, e.currency, e.enrolled_at,
                c.id AS class_id, c.name AS class_name, c.level, c.schedule,
                cl.name AS club_name, po.label AS price_label
           FROM class_enrolments e
           JOIN classes c ON c.id = e.class_id
           JOIN clubs cl ON cl.id = e.club_id
           LEFT JOIN class_price_options po ON po.id = e.price_option_id
          WHERE e.diver_user_id = $1 AND e.status <> 'cancelled'
          ORDER BY e.enrolled_at DESC`,
        [req.user.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] my classes failed");
      return res.status(500).json({ error: "Failed to load your classes." });
    }
  });

  // Active classes in the diver's OWN club, for self-enrolment. No roster.
  router.get("/api/me/available-classes", verifyToken, async (req, res) => {
    try {
      const me = (await pool.query("SELECT club_id FROM users WHERE id = $1", [req.user.id])).rows[0];
      const clubId = me && me.club_id;
      if (!clubId) return res.json([]);
      const r = await pool.query(
        `SELECT c.id, c.name, c.level, c.schedule, c.capacity,
                COALESCE((SELECT COUNT(*) FROM class_enrolments e
                           WHERE e.class_id = c.id AND e.status IN ('active','pending')), 0)::int AS enrolled,
                EXISTS(SELECT 1 FROM class_enrolments e
                        WHERE e.class_id = c.id AND e.diver_user_id = $2 AND e.status <> 'cancelled') AS already_enrolled,
                ${PRICE_OPTIONS_JSON} AS price_options
           FROM classes c
          WHERE c.club_id = $1 AND c.active
          ORDER BY lower(c.name)`,
        [clubId, req.user.id],
      );
      return res.json(r.rows);
    } catch (err) {
      log.error({ err: err.message }, "[classes] available classes failed");
      return res.status(500).json({ error: "Failed to load available classes." });
    }
  });

  // Diver self-enrols into a class in their own club. Priced classes start
  // 'pending' (payment is coming soon); free classes go straight to 'active'.
  router.post("/api/me/classes/:classId/enrol", verifyToken, async (req, res) => {
    try {
      const me = (await pool.query("SELECT club_id, org_id FROM users WHERE id = $1", [req.user.id])).rows[0];
      if (!me || !me.club_id) return res.status(400).json({ error: "Join a club before enrolling in a class." });
      const cls = (await pool.query(
        "SELECT * FROM classes WHERE id = $1 AND club_id = $2 AND active",
        [req.params.classId, me.club_id],
      )).rows[0];
      if (!cls) return res.status(404).json({ error: "Class not found" });
      const chosen = await resolvePriceOption(cls.id, (req.body || {}).price_option_id);
      if (chosen && chosen.error) return res.status(400).json({ error: chosen.error });
      const anyPrices = (await pool.query(
        "SELECT 1 FROM class_price_options WHERE class_id = $1 AND active LIMIT 1", [cls.id],
      )).rows.length > 0;
      const status = anyPrices ? "pending" : "active";
      const r = await pool.query(
        `INSERT INTO class_enrolments
            (class_id, diver_user_id, club_id, org_id, status, price_option_id, amount_cents, currency, enrolled_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $2)
         RETURNING id, status`,
        [cls.id, req.user.id, me.club_id, me.org_id, status,
         chosen ? chosen.id : null, chosen ? chosen.amount_cents : null, chosen ? chosen.currency : null],
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "You're already enrolled in this class." });
      log.error({ err: err.message }, "[classes] self-enrol failed");
      return res.status(500).json({ error: "Failed to enrol." });
    }
  });

  // The diver pays for their OWN pending enrolment. Never reachable for
  // another diver's enrolment (403) or a non-pending one (409). If a manual
  // discount fully covers the price, there's nothing to charge — activate
  // directly rather than open a $0 Stripe session. The club (not the
  // federation) is the payment's recipient.
  router.post("/api/me/class-enrolments/:enrolId/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    try {
      const enr = (await pool.query(
        `SELECT e.*, c.name AS class_name, o.default_currency, o.platform_fee_bps
           FROM class_enrolments e
           JOIN classes c ON c.id = e.class_id
           JOIN organisations o ON o.id = e.org_id
          WHERE e.id = $1`,
        [req.params.enrolId],
      )).rows[0];
      if (!enr) return res.status(404).json({ error: "Enrolment not found" });
      if (enr.diver_user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
      if (enr.status !== "pending") return res.status(409).json({ error: `This enrolment is ${enr.status}.` });
      const baseAmountCents = (enr.amount_cents || 0) - (enr.discount_cents || 0);
      if (baseAmountCents <= 0) {
        await pool.query("UPDATE class_enrolments SET status = 'active', updated_at = now() WHERE id = $1", [enr.id]);
        return res.json({ status: "active" });
      }
      const currency = enr.currency || enr.default_currency;
      if (!currency) return res.status(409).json({ error: "The federation's currency is not configured." });
      const { chargeAmountCents, applicationFeeCents } = priceCharge({
        baseAmountCents, feeBps: enr.platform_fee_bps, feePayer: "absorb",
      });
      let paymentId;
      try {
        const ins = await pool.query(
          `INSERT INTO payments
              (org_id, payer_user_id, payer_type, subject_type, club_id, recipient_type,
               class_enrolment_id, amount_cents, platform_fee_cents, currency, fee_payer, status)
           VALUES ($1, $2, 'user', 'class_enrolment', $3, 'club', $4, $5, $6, $7, 'absorb', 'pending')
           RETURNING id`,
          [enr.org_id, req.user.id, enr.club_id, enr.id, chargeAmountCents, applicationFeeCents, currency],
        );
        paymentId = ins.rows[0].id;
      } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "You already have a payment in progress for this class." });
        throw e;
      }
      const session = await payments.createCheckoutSession({
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `Class: ${enr.class_name}`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: { payment_id: paymentId, class_enrolment_id: enr.id },
        successUrl: `${APP_BASE_URL}/classes?paid=1`,
        cancelUrl: `${APP_BASE_URL}/classes?canceled=1`,
      });
      await pool.query(
        "UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2",
        [session.id, paymentId],
      );
      return res.json({ url: session.url, payment_id: paymentId });
    } catch (err) {
      log.error({ err: err.message }, "[classes] enrolment checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  return router;
};
