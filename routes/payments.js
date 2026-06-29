// routes/payments.js — Stripe Connect payment endpoints.
//
// Federation onboarding, fee configuration, diver/member checkout, and
// refunds. DivingHQ is the Connect platform; federations are connected
// accounts; charges are DIRECT (federation = merchant of record) with a
// platform application fee. See Migration 066 and lib/stripe.js for the
// fund-flow model and lib/fee-pricing.js for the price + fee math.
//
// Factory pattern (matches the other route modules). The Stripe webhook
// lives in routes/stripe-webhook.js — it needs the raw body, so it
// can't share this JSON-parsed router.
//
// Auth model:
//   * Onboarding + membership-fee config → org_admin of that org.
//   * Event entry-fee config             → requireEventManager.
//   * Read "what will this cost me?"      → optionalAuth (member-aware).
//   * Checkout                           → any signed-in user (the payer).
//   * Refunds                            → org_admin / meet_manager.
// Org-scoped routes use the sysadmin-bypass pattern: sysadmin passes,
// otherwise the URL's org must equal req.user.org_id.

const express = require("express");
const { resolvePrice, priceCharge } = require("../lib/fee-pricing");

const APP_BASE_URL =
  process.env.APP_BASE_URL || process.env.CORS_ORIGIN || "http://localhost:5173";

// Country codes in the DB are ISO 3166-1 alpha-3 (e.g. 'GBR'); Stripe's
// v2 accounts want alpha-2 (e.g. 'gb'). Map the common federation
// nations; the onboarding endpoint also accepts an explicit alpha-2
// `country` in the body to cover anything not listed here.
const ALPHA3_TO_ALPHA2 = {
  GBR: "gb", USA: "us", AUS: "au", CAN: "ca", NZL: "nz", IRL: "ie",
  FRA: "fr", DEU: "de", ESP: "es", ITA: "it", NLD: "nl", SWE: "se",
  NOR: "no", DNK: "dk", CHE: "ch", AUT: "at", BEL: "be", PRT: "pt",
  ZAF: "za", JPN: "jp", SGP: "sg",
};
function alpha3ToAlpha2(code) {
  return code ? ALPHA3_TO_ALPHA2[String(code).toUpperCase()] || null : null;
}

// Validate + normalise an incoming price-variant array. Returns
// { prices } or { error }.
function validatePrices(prices) {
  const AUDIENCES = ["all", "member", "non_member"];
  const out = [];
  for (const p of prices) {
    const amount = Number(p.amount_cents);
    if (!Number.isInteger(amount) || amount < 0) {
      return { error: "Each price needs an integer amount_cents >= 0." };
    }
    const label = String(p.label || "standard").slice(0, 40);
    const audience = AUDIENCES.includes(p.audience) ? p.audience : "all";
    out.push({
      label,
      amount_cents: amount,
      audience,
      starts_at: p.starts_at || null,
      ends_at: p.ends_at || null,
    });
  }
  return { prices: out };
}

// Shape a fee_definition (+ all its variants) for the admin editors,
// which need the full config, not just the buyer's resolved price.
async function feeConfigResponse(db, feeRow) {
  const prices = (
    await db.query(
      `SELECT id, label, amount_cents, audience, starts_at, ends_at
         FROM fee_prices WHERE fee_definition_id = $1 ORDER BY amount_cents`,
      [feeRow.id],
    )
  ).rows;
  return {
    id: feeRow.id,
    currency: feeRow.currency,
    fee_payer: feeRow.fee_payer,
    refund_policy: feeRow.refund_policy,
    refund_deadline: feeRow.refund_deadline,
    membership_period: feeRow.membership_period,
    late_fee_trigger: feeRow.late_fee_trigger,
    prices,
  };
}

module.exports = function createPaymentsRouter({
  pool,
  verifyToken,
  optionalAuth,
  requireOrgRole,
  requireEventManager,
  requireMeetEditor,
  requireClubAdmin,
  logger,
  payments,
}) {
  const router = express.Router();

  // club_affiliation / club_accreditation share all plumbing and differ
  // only by scope + the club_affiliations.kind they grant. One mapper
  // keeps the URL `kind` param and the DB scope in lockstep.
  function clubScope(kind) {
    return kind === "accreditation" ? "club_accreditation" : "club_affiliation";
  }

  // Refuse every payment route cleanly when Stripe isn't configured,
  // rather than 500-ing deeper in.
  function ensurePayments(res) {
    if (!payments.enabled) {
      res.status(503).json({ error: "Payments are not configured on this server." });
      return false;
    }
    return true;
  }

  function ownsOrg(req, orgId) {
    return req.user.is_system_admin || req.user.org_id === orgId;
  }

  // Is this user an active member of the org right now?
  async function isActiveMember(db, orgId, userId) {
    if (!userId) return false;
    const r = await db.query(
      `SELECT 1 FROM memberships
        WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND period_end > now()
        LIMIT 1`,
      [orgId, userId],
    );
    return r.rows.length > 0;
  }

  // Upsert a single active fee_definition (+ replace its price variants)
  // for an (org, scope, + entity/qualifier tuple). The identity tuple is
  // (org, scope, event_id, meet_id, club_id, role_type, discipline, tier)
  // — matching Migration 067's unique index — so e.g. one event can carry
  // a separate entry fee per discipline, and one org a separate membership
  // fee per tier. Runs in one transaction. Returns feeId.
  async function upsertFee({
    orgId, scope, name, body, cleanPrices,
    eventId = null, meetId = null, clubId = null,
    roleType = null, discipline = null, tier = null,
  }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT id FROM fee_definitions
          WHERE org_id = $1 AND scope = $2 AND active
            AND event_id   IS NOT DISTINCT FROM $3
            AND meet_id    IS NOT DISTINCT FROM $4
            AND club_id    IS NOT DISTINCT FROM $5
            AND role_type  IS NOT DISTINCT FROM $6
            AND discipline IS NOT DISTINCT FROM $7
            AND tier       IS NOT DISTINCT FROM $8
          LIMIT 1`,
        [orgId, scope, eventId, meetId, clubId, roleType, discipline, tier],
      );
      const membershipPeriod = scope === "membership" ? body.membership_period || "annual" : null;
      const lateFeeTrigger = body.late_fee_trigger || null;
      const suggested = Array.isArray(body.suggested_amounts) ? body.suggested_amounts : null;
      let feeId;
      if (existing.rows.length) {
        feeId = existing.rows[0].id;
        await client.query(
          `UPDATE fee_definitions
              SET currency = $2,
                  fee_payer = COALESCE($3, fee_payer),
                  refund_policy = COALESCE($4, refund_policy),
                  refund_deadline = $5,
                  membership_period = $6,
                  late_fee_trigger = $7,
                  suggested_amounts = $8
            WHERE id = $1`,
          [feeId, body.currency || null, body.fee_payer || null, body.refund_policy || null,
           body.refund_deadline || null, membershipPeriod, lateFeeTrigger, suggested],
        );
        await client.query("DELETE FROM fee_prices WHERE fee_definition_id = $1", [feeId]);
      } else {
        const ins = await client.query(
          `INSERT INTO fee_definitions
              (org_id, scope, event_id, meet_id, club_id, role_type, discipline, tier,
               name, currency, fee_payer, refund_policy, refund_deadline,
               membership_period, late_fee_trigger, suggested_amounts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11,'absorb'),
                   COALESCE($12,'full'), $13, $14, $15, $16)
           RETURNING id`,
          [orgId, scope, eventId, meetId, clubId, roleType, discipline, tier,
           name, body.currency || null, body.fee_payer || null, body.refund_policy || null,
           body.refund_deadline || null, membershipPeriod, lateFeeTrigger, suggested],
        );
        feeId = ins.rows[0].id;
      }
      for (const p of cleanPrices) {
        await client.query(
          `INSERT INTO fee_prices
              (fee_definition_id, label, amount_cents, audience, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [feeId, p.label, p.amount_cents, p.audience, p.starts_at, p.ends_at],
        );
      }
      await client.query("COMMIT");
      return feeId;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // Resolve an event's late-entry surcharge, if one is configured AND its
  // trigger moment has passed. The late_entry fee is a flat surcharge
  // (audience 'all') added on top of the base entry fee once the chosen
  // event deadline (entries close / dive list locks) is reached. Returns
  // { feeId, surchargeCents, applies, trigger, triggerAt } or null when no
  // late fee exists. `applies` requires the event to actually carry the
  // trigger timestamp and now to be at/after it — mirroring the deadline
  // check in routes/coach.js.
  async function resolveLateFee(db, eventId) {
    const r = await db.query(
      `SELECT fd.id, fd.late_fee_trigger, e.entries_close_at, e.dive_list_locks_at
         FROM fee_definitions fd
         JOIN events e ON e.id = fd.event_id
        WHERE fd.event_id = $1 AND fd.scope = 'late_entry' AND fd.active
        LIMIT 1`,
      [eventId],
    );
    if (!r.rows.length) return null;
    const def = r.rows[0];
    const prices = (await db.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
    const chosen = resolvePrice(prices, { isMember: false });
    if (!chosen) return null;
    const triggerAt = def.late_fee_trigger === "dive_list_locks_at"
      ? def.dive_list_locks_at
      : def.entries_close_at;
    const applies = !!triggerAt && Date.now() >= new Date(triggerAt).getTime();
    return { feeId: def.id, surchargeCents: chosen.amount_cents, applies, trigger: def.late_fee_trigger, triggerAt };
  }

  // Shared checkout core. Resolves the price for the payer, records a
  // pending payment, and opens a Checkout Session on the federation's
  // connected account. An optional `surchargeCents` (the late-entry fee)
  // is added to the resolved base price before the platform-fee math, so
  // the whole charge — base + surcharge — flows through one payment and
  // DivingHQ's cut applies to the total. Returns { url, paymentId } or throws.
  async function startCheckout({ req, org, fee, prices, subjectType, eventId, productName, successUrl, cancelUrl, surchargeCents = 0 }) {
    const userId = req.user.id;
    const member = await isActiveMember(pool, org.id, userId);
    // A payer buying membership isn't a member yet — resolve at the
    // 'all' tier; entry checkout is member-aware.
    const chosen = resolvePrice(prices, { isMember: subjectType === "membership" ? false : member });
    if (!chosen) {
      const err = new Error("This isn't open for purchase right now.");
      err.status = 409;
      throw err;
    }
    const currency = fee.currency || org.default_currency;
    if (!currency) {
      const err = new Error("The federation's currency is not configured.");
      err.status = 409;
      throw err;
    }
    const feeBps = fee.platform_fee_bps != null ? fee.platform_fee_bps : org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: chosen.amount_cents + (surchargeCents || 0),
      feeBps,
      feePayer: fee.fee_payer,
    });

    // If a late surcharge now applies, retire any stale pending payment that
    // was opened (and priced) BEFORE the deadline — otherwise the diver could
    // return to that cheaper, still-valid Checkout session and dodge the
    // surcharge. Expire its Stripe session and free the one-live-payment slot
    // so the fresh, correctly-priced row can be inserted. Same-priced pending
    // rows are left alone (they collide → 409 "in progress", which is right).
    if (surchargeCents > 0 && subjectType === "event_entry") {
      const stale = (await pool.query(
        `SELECT id, stripe_checkout_session, amount_cents FROM payments
          WHERE event_id = $1 AND payer_user_id = $2 AND fee_definition_id = $3
            AND subject_type = 'event_entry' AND status = 'pending'
          LIMIT 1`,
        [eventId, userId, fee.id],
      )).rows[0];
      if (stale && stale.amount_cents < chargeAmountCents) {
        if (stale.stripe_checkout_session) {
          try {
            await payments.expireCheckoutSession({
              connectedAccountId: org.stripe_account_id,
              sessionId: stale.stripe_checkout_session,
            });
          } catch (e) {
            logger.warn({ err: e.message }, "[payments] could not expire stale checkout session");
          }
        }
        await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [stale.id]);
      }
    }

    // Record the pending payment first. The unique partial index blocks
    // a second live entry payment for the same diver+event.
    let paymentId;
    try {
      const ins = await pool.query(
        `INSERT INTO payments
            (org_id, fee_definition_id, payer_user_id, subject_type, event_id,
             amount_cents, platform_fee_cents, currency, fee_payer, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         RETURNING id`,
        [org.id, fee.id, userId, subjectType, eventId || null, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer],
      );
      paymentId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        const err = new Error("You already have a payment in progress or completed for this.");
        err.status = 409;
        throw err;
      }
      throw e;
    }

    try {
      const session = await payments.createCheckoutSession({
        connectedAccountId: org.stripe_account_id,
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: {
          payment_id: paymentId,
          scope: subjectType,
          org_id: org.id,
          user_id: userId,
          ...(eventId ? { event_id: eventId } : {}),
        },
        successUrl,
        cancelUrl,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      return { url: session.url, paymentId };
    } catch (err) {
      // Stripe failed after we inserted the row — release the slot.
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // Club-payer checkout core. A CLUB (not an individual) pays the
  // federation an affiliation/accreditation fee. payer_type='club' with
  // no payer_user_id, so this can't reuse startCheckout (which is the
  // member-aware individual path). The connected account is still the
  // federation's — the club pays the federation, DivingHQ skims its cut.
  async function startClubCheckout({ req, org, club, fee, prices, kind }) {
    const chosen = resolvePrice(prices, { isMember: false });
    if (!chosen) {
      const err = new Error("This isn't open for purchase right now.");
      err.status = 409;
      throw err;
    }
    const currency = fee.currency || org.default_currency;
    if (!currency) {
      const err = new Error("The federation's currency is not configured.");
      err.status = 409;
      throw err;
    }
    const subjectType = clubScope(kind);
    const feeBps = fee.platform_fee_bps != null ? fee.platform_fee_bps : org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: chosen.amount_cents,
      feeBps,
      feePayer: fee.fee_payer,
    });

    // payer_club_id = the paying club; club_id = the subject club (same
    // here). The one-live-club partial index blocks a second live payment
    // for the same club+fee.
    let paymentId;
    try {
      const ins = await pool.query(
        `INSERT INTO payments
            (org_id, fee_definition_id, payer_type, payer_club_id, club_id, subject_type,
             amount_cents, platform_fee_cents, currency, fee_payer, status)
         VALUES ($1, $2, 'club', $3, $3, $4, $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [org.id, fee.id, club.id, subjectType, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer],
      );
      paymentId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        const err = new Error("This club already has a payment in progress or completed for this.");
        err.status = 409;
        throw err;
      }
      throw e;
    }

    try {
      const session = await payments.createCheckoutSession({
        connectedAccountId: org.stripe_account_id,
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `${org.name} club ${kind} — ${club.name}`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: {
          payment_id: paymentId,
          scope: subjectType,
          org_id: org.id,
          club_id: club.id,
          initiated_by: req.user.id,
        },
        successUrl: `${APP_BASE_URL}/clubs/${club.id}?paid=1`,
        cancelUrl: `${APP_BASE_URL}/clubs/${club.id}?canceled=1`,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      return { url: session.url, paymentId };
    } catch (err) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // Resolve the club fee that applies to one club: prefer a club-specific
  // definition, else the org-wide template (club_id NULL). Returns the
  // fee_definitions row or null.
  async function resolveClubFee(db, orgId, scope, clubId) {
    const r = await db.query(
      `SELECT * FROM fee_definitions
        WHERE org_id = $1 AND scope = $2 AND active
          AND (club_id = $3 OR club_id IS NULL)
        ORDER BY club_id NULLS LAST
        LIMIT 1`,
      [orgId, scope, clubId],
    );
    return r.rows[0] || null;
  }

  // ---- Federation onboarding --------------------------------------

  // Begin/continue Stripe onboarding for a federation. Creates the
  // connected account on first call, then returns a fresh hosted
  // onboarding link.
  router.post(
    "/api/orgs/:id/payments/onboard",
    requireOrgRole(["org_admin"]),
    async (req, res) => {
      if (!ensurePayments(res)) return;
      const orgId = req.params.id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
      try {
        const orgRes = await pool.query(
          "SELECT id, name, country_code, default_currency, stripe_account_id FROM organisations WHERE id = $1",
          [orgId],
        );
        if (!orgRes.rows.length) return res.status(404).json({ error: "Organisation not found" });
        const org = orgRes.rows[0];

        let accountId = org.stripe_account_id;
        if (!accountId) {
          const country = (req.body && req.body.country) || alpha3ToAlpha2(org.country_code);
          if (!country) {
            return res.status(400).json({ error: "A 2-letter country code is required to start onboarding." });
          }
          const account = await payments.createConnectedAccount({
            country,
            currency: org.default_currency,
            email: req.user.email,
            orgName: org.name,
          });
          accountId = account.id;
          await pool.query("UPDATE organisations SET stripe_account_id = $1 WHERE id = $2", [accountId, orgId]);
        }
        const link = await payments.createOnboardingLink({ accountId });
        return res.json({ url: link.url });
      } catch (err) {
        logger.error({ err: err.message }, "[payments] onboard failed");
        return res.status(err.status || 500).json({ error: err.message || "Onboarding failed" });
      }
    },
  );

  // Sync + report the federation's payout-readiness.
  router.get(
    "/api/orgs/:id/payments/status",
    requireOrgRole(["org_admin"]),
    async (req, res) => {
      // Coming-soon state: when payments aren't configured, report a
      // clean disabled status (not a 503) so the UI can show a friendly
      // "feature incoming" notice instead of an error.
      if (!payments.enabled) {
        return res.json({ enabled: false, onboarded: false, charges_enabled: false, payouts_enabled: false });
      }
      const orgId = req.params.id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
      try {
        const orgRes = await pool.query(
          "SELECT stripe_account_id FROM organisations WHERE id = $1",
          [orgId],
        );
        if (!orgRes.rows.length) return res.status(404).json({ error: "Organisation not found" });
        const accountId = orgRes.rows[0].stripe_account_id;
        if (!accountId) {
          return res.json({ enabled: true, onboarded: false, charges_enabled: false, payouts_enabled: false });
        }
        const account = await payments.retrieveAccount(accountId);
        // Defensive parse — confirm the exact shape against test mode.
        const card = account?.configuration?.merchant?.capabilities?.card_payments;
        const chargesEnabled = card?.status === "active";
        const payoutsEnabled = chargesEnabled;
        await pool.query(
          "UPDATE organisations SET stripe_charges_enabled = $1, stripe_payouts_enabled = $2 WHERE id = $3",
          [chargesEnabled, payoutsEnabled, orgId],
        );
        return res.json({ enabled: true, onboarded: true, charges_enabled: chargesEnabled, payouts_enabled: payoutsEnabled });
      } catch (err) {
        logger.error({ err: err.message }, "[payments] status failed");
        return res.status(err.status || 500).json({ error: err.message || "Status check failed" });
      }
    },
  );

  // ---- Fee configuration ------------------------------------------

  // Federation sets/updates the entry fee for one event.
  router.put("/api/events/:id/fee", requireEventManager(), async (req, res) => {
    if (!ensurePayments(res)) return;
    const eventId = req.params.id;
    const orgId = req.event.org_id; // stashed by requireEventManager
    const body = req.body || {};
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const discipline = body.discipline ? String(body.discipline).slice(0, 40) : null;
      const feeId = await upsertFee({
        orgId,
        scope: "event_entry",
        eventId,
        discipline,
        name: discipline ? `Entry fee (${discipline})` : "Entry fee",
        body,
        cleanPrices: v.prices,
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set event fee failed");
      return res.status(500).json({ error: "Failed to save the entry fee." });
    }
  });

  // Federation sets/updates its membership fee.
  router.put("/api/orgs/:id/membership-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const tier = body.tier ? String(body.tier).slice(0, 40) : null;
      const feeId = await upsertFee({
        orgId,
        scope: "membership",
        tier,
        name: body.name || (tier ? `Membership (${tier})` : "Membership"),
        body,
        cleanPrices: v.prices,
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set membership fee failed");
      return res.status(500).json({ error: "Failed to save the membership fee." });
    }
  });

  // What will entry to this event cost the caller right now?
  router.get("/api/events/:id/fee", optionalAuth, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query("SELECT org_id FROM events WHERE id = $1", [eventId]);
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const orgId = ev.rows[0].org_id;
      const discipline = req.query.discipline || null;
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE event_id = $1 AND scope = 'event_entry' AND active
            AND discipline IS NOT DISTINCT FROM $2 LIMIT 1`,
        [eventId, discipline],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const member = req.user ? await isActiveMember(pool, orgId, req.user.id) : false;
      const chosen = resolvePrice(prices, { isMember: member });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      // "Submit, then pay": the dive-list entry exists independently; an
      // entry is confirmed once a paid payment exists for this diver.
      const alreadyPaid = req.user
        ? (await pool.query(
            `SELECT 1 FROM payments
              WHERE event_id = $1 AND payer_user_id = $2
                AND subject_type = 'event_entry' AND status = 'paid' LIMIT 1`,
            [eventId, req.user.id],
          )).rows.length > 0
        : false;
      // Late-entry surcharge: surfaced even before it bites so divers can
      // pay early to avoid it; folded into total_cents once it applies.
      const late = await resolveLateFee(pool, eventId);
      const baseCents = chosen ? chosen.amount_cents : 0;
      return res.json({
        fee: {
          currency: def.currency || org?.default_currency || null,
          fee_payer: def.fee_payer,
          refund_policy: def.refund_policy,
          is_member: member,
          already_paid: alreadyPaid,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
          late_fee: late
            ? { surcharge_cents: late.surchargeCents, applies: late.applies, trigger: late.trigger }
            : null,
          total_cents: baseCents + (late && late.applies ? late.surchargeCents : 0),
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read event fee failed");
      return res.status(500).json({ error: "Failed to read the entry fee." });
    }
  });

  // Full entry-fee config (all variants) for the manager's editor.
  router.get("/api/events/:id/fee/config", requireEventManager(), async (req, res) => {
    try {
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE event_id = $1 AND scope = 'event_entry' AND active
            AND discipline IS NOT DISTINCT FROM $2 LIMIT 1`,
        [req.params.id, req.query.discipline || null],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read event fee config failed");
      return res.status(500).json({ error: "Failed to read the entry fee." });
    }
  });

  // ---- Late-entry surcharge ---------------------------------------
  // A flat surcharge added to the entry fee once the chosen trigger moment
  // (entries close / dive list locks) has passed. Configured per event by
  // the event manager, alongside the base entry fee.

  router.put("/api/events/:id/late-fee", requireEventManager(), async (req, res) => {
    if (!ensurePayments(res)) return;
    const eventId = req.params.id;
    const orgId = req.event.org_id; // stashed by requireEventManager
    const body = req.body || {};
    if (!["entries_close_at", "dive_list_locks_at"].includes(body.late_fee_trigger)) {
      return res.status(400).json({ error: "A valid late_fee_trigger is required." });
    }
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      // A late fee is a single FLAT surcharge whose timing is governed by
      // the trigger, NOT by audience tiers or price windows. Force the
      // stored variant to audience 'all' with no window so it can never be
      // silently suppressed at resolve time (resolveLateFee resolves with
      // isMember:false at now — a 'member'/windowed variant would vanish and
      // the diver would dodge the surcharge).
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      // Keep the surcharge in the SAME currency as the base entry fee — they
      // are summed into one charge at checkout. Inherit it when a base fee
      // exists so the two can never diverge.
      const baseCurrency = (await pool.query(
        "SELECT currency FROM fee_definitions WHERE event_id = $1 AND scope = 'event_entry' AND active LIMIT 1",
        [eventId],
      )).rows[0]?.currency;
      const feeBody = baseCurrency ? { ...body, currency: baseCurrency } : body;
      const feeId = await upsertFee({
        orgId,
        scope: "late_entry",
        eventId,
        name: "Late entry fee",
        body: feeBody,
        cleanPrices: [flatPrice],
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set late fee failed");
      return res.status(500).json({ error: "Failed to save the late entry fee." });
    }
  });

  // Full late-fee config (all variants + trigger) for the manager's editor.
  router.get("/api/events/:id/late-fee/config", requireEventManager(), async (req, res) => {
    try {
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE event_id = $1 AND scope = 'late_entry' AND active LIMIT 1",
        [req.params.id],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read late fee config failed");
      return res.status(500).json({ error: "Failed to read the late entry fee." });
    }
  });

  // ---- Meet-level registration fees -------------------------------
  // Enter the whole meet (any events), optionally priced per discipline.
  // requireMeetEditor is role+TOTP only, so each handler also checks the
  // meet belongs to the caller's org (sysadmin bypasses via ownsOrg).

  router.put("/api/meets/:id/fees", requireMeetEditor, async (req, res) => {
    if (!ensurePayments(res)) return;
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
      const body = req.body || {};
      if (!Array.isArray(body.prices) || !body.prices.length) {
        return res.status(400).json({ error: "At least one price variant is required." });
      }
      const v = validatePrices(body.prices);
      if (v.error) return res.status(400).json({ error: v.error });
      const discipline = body.discipline ? String(body.discipline).slice(0, 40) : null;
      const feeId = await upsertFee({
        orgId, scope: "event_entry", meetId, discipline,
        name: discipline ? `Meet registration (${discipline})` : "Meet registration",
        body, cleanPrices: v.prices,
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set meet fee failed");
      return res.status(500).json({ error: "Failed to save the meet registration fee." });
    }
  });

  // Full meet-fee config (all variants) for the manager's editor.
  router.get("/api/meets/:id/fees/config", requireMeetEditor, async (req, res) => {
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      if (!ownsOrg(req, m.rows[0].org_id)) return res.status(403).json({ error: "Forbidden" });
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE meet_id = $1 AND scope = 'event_entry' AND active
            AND discipline IS NOT DISTINCT FROM $2 LIMIT 1`,
        [meetId, req.query.discipline || null],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read meet fee config failed");
      return res.status(500).json({ error: "Failed to read the meet fee." });
    }
  });

  // Diver-facing: what would registering for this meet cost me?
  router.get("/api/meets/:id/fees", optionalAuth, async (req, res) => {
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      const discipline = req.query.discipline || null;
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE meet_id = $1 AND scope = 'event_entry' AND active
            AND discipline IS NOT DISTINCT FROM $2 LIMIT 1`,
        [meetId, discipline],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const member = req.user ? await isActiveMember(pool, orgId, req.user.id) : false;
      const chosen = resolvePrice(prices, { isMember: member });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      const alreadyPaid = req.user
        ? (await pool.query(
            `SELECT 1 FROM payments
              WHERE meet_id = $1 AND payer_user_id = $2
                AND subject_type = 'event_entry' AND status = 'paid' LIMIT 1`,
            [meetId, req.user.id],
          )).rows.length > 0
        : false;
      return res.json({
        fee: {
          currency: def.currency || org?.default_currency || null,
          discipline: def.discipline,
          is_member: member,
          already_paid: alreadyPaid,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read meet fee failed");
      return res.status(500).json({ error: "Failed to read the meet fee." });
    }
  });

  // Full membership-fee config (all variants) for the org admin's editor.
  router.get("/api/orgs/:id/membership-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    try {
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE org_id = $1 AND scope = 'membership' AND active
            AND tier IS NOT DISTINCT FROM $2 LIMIT 1`,
        [orgId, req.query.tier || null],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read membership fee failed");
      return res.status(500).json({ error: "Failed to read the membership fee." });
    }
  });

  // Diver-facing: what would membership (optionally a given tier) cost me?
  // Mirrors GET /api/events/:id/fee — resolved price, no admin gate.
  router.get("/api/orgs/:id/membership", optionalAuth, async (req, res) => {
    const orgId = req.params.id;
    try {
      const tier = req.query.tier || null;
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE org_id = $1 AND scope = 'membership' AND active
            AND tier IS NOT DISTINCT FROM $2 LIMIT 1`,
        [orgId, tier],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      const alreadyMember = req.user
        ? (await pool.query(
            `SELECT 1 FROM memberships
              WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND period_end > now()
                AND tier IS NOT DISTINCT FROM $3 LIMIT 1`,
            [orgId, req.user.id, tier],
          )).rows.length > 0
        : false;
      return res.json({
        fee: {
          currency: def.currency || org?.default_currency || null,
          tier: def.tier,
          already_member: alreadyMember,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read membership (diver) failed");
      return res.status(500).json({ error: "Failed to read membership." });
    }
  });

  // ---- Club affiliation / accreditation fees ----------------------
  // The FEDERATION (org_admin) sets the price its clubs pay; the CLUB
  // (requireClubAdmin — org_admin of the club's org OR a club_admins row)
  // pays it. One org-wide fee per kind (club_id NULL) for this first cut;
  // the schema also allows per-club overrides.

  // Federation sets/updates a club affiliation or accreditation fee.
  router.put("/api/orgs/:id/club-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const scope = clubScope(body.kind);
      const feeId = await upsertFee({
        orgId,
        scope,
        name: body.name || (scope === "club_accreditation" ? "Club accreditation" : "Club affiliation"),
        body,
        cleanPrices: v.prices,
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set club fee failed");
      return res.status(500).json({ error: "Failed to save the club fee." });
    }
  });

  // Full club-fee config (all variants) for the federation's editor.
  router.get("/api/orgs/:id/club-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    try {
      const scope = clubScope(req.query.kind);
      const feeRes = await pool.query(
        `SELECT * FROM fee_definitions
          WHERE org_id = $1 AND scope = $2 AND active AND club_id IS NULL LIMIT 1`,
        [orgId, scope],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read club fee config failed");
      return res.status(500).json({ error: "Failed to read the club fee." });
    }
  });

  // Club-facing: what does affiliation/accreditation cost this club, and
  // is it currently active? Readable by the club's admins and the
  // federation (requireClubAdmin allows both). req.club is stashed by the
  // guard.
  router.get("/api/clubs/:id/affiliation", requireClubAdmin(), async (req, res) => {
    const clubId = req.params.id;
    const orgId = req.club.org_id;
    try {
      const kind = req.query.kind === "accreditation" ? "accreditation" : "affiliation";
      const scope = clubScope(kind);
      const def = await resolveClubFee(pool, orgId, scope, clubId);
      const club = (await pool.query("SELECT name FROM clubs WHERE id = $1", [clubId])).rows[0];
      const current = (await pool.query(
        `SELECT status, period_end FROM club_affiliations
          WHERE org_id = $1 AND club_id = $2 AND kind = $3
            AND status = 'active' AND period_end > CURRENT_DATE
          ORDER BY period_end DESC LIMIT 1`,
        [orgId, clubId, kind],
      )).rows[0];
      if (!def) {
        return res.json({
          fee: { kind, club_name: club?.name || null, active: !!current, period_end: current?.period_end || null, price: null },
          payments_enabled: payments.enabled,
        });
      }
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      return res.json({
        fee: {
          kind,
          club_name: club?.name || null,
          currency: def.currency || org?.default_currency || null,
          active: !!current,
          period_end: current?.period_end || null,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read club affiliation failed");
      return res.status(500).json({ error: "Failed to read the club fee." });
    }
  });

  // ---- Checkout ----------------------------------------------------

  // Diver pays the entry fee for an event.
  router.post("/api/events/:id/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const eventId = req.params.id;
    try {
      const ev = await pool.query("SELECT id, name, org_id FROM events WHERE id = $1", [eventId]);
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const orgId = ev.rows[0].org_id;
      const org = (
        await pool.query(
          `SELECT id, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      if (!org.stripe_account_id || !org.stripe_charges_enabled) {
        return res.status(409).json({ error: "This federation hasn't finished payment setup yet." });
      }
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE event_id = $1 AND scope = 'event_entry' AND active LIMIT 1",
        [eventId],
      );
      if (!feeRes.rows.length) return res.status(409).json({ error: "No entry fee is set for this event." });
      const fee = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;

      // Fold in the late-entry surcharge when the event's deadline has passed.
      const late = await resolveLateFee(pool, eventId);
      const surchargeCents = late && late.applies ? late.surchargeCents : 0;

      const { url, paymentId } = await startCheckout({
        req,
        org,
        fee,
        prices,
        subjectType: "event_entry",
        eventId,
        surchargeCents,
        productName: surchargeCents
          ? `Entry (incl. late fee) — ${ev.rows[0].name}`
          : `Entry — ${ev.rows[0].name}`,
        successUrl: `${APP_BASE_URL}/events/${eventId}?paid=1`,
        cancelUrl: `${APP_BASE_URL}/events/${eventId}?canceled=1`,
      });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] event checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // User pays the federation's membership fee.
  router.post("/api/orgs/:id/membership/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    try {
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      if (!org.stripe_account_id || !org.stripe_charges_enabled) {
        return res.status(409).json({ error: "This federation hasn't finished payment setup yet." });
      }
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE org_id = $1 AND scope = 'membership' AND active LIMIT 1",
        [orgId],
      );
      if (!feeRes.rows.length) return res.status(409).json({ error: "No membership fee is set for this federation." });
      const fee = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;

      const { url, paymentId } = await startCheckout({
        req,
        org,
        fee,
        prices,
        subjectType: "membership",
        eventId: null,
        productName: `${org.name} membership`,
        successUrl: `${APP_BASE_URL}/membership?paid=1`,
        cancelUrl: `${APP_BASE_URL}/membership?canceled=1`,
      });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] membership checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // A club admin pays the federation's affiliation/accreditation fee on
  // behalf of the club. payer_type='club'; the connected account is the
  // federation's.
  router.post("/api/clubs/:id/affiliation/checkout", requireClubAdmin(), async (req, res) => {
    if (!ensurePayments(res)) return;
    const clubId = req.params.id;
    const orgId = req.club.org_id; // stashed by requireClubAdmin
    try {
      const kind = (req.body && req.body.kind) === "accreditation" ? "accreditation" : "affiliation";
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      if (!org.stripe_account_id || !org.stripe_charges_enabled) {
        return res.status(409).json({ error: "This federation hasn't finished payment setup yet." });
      }
      const fee = await resolveClubFee(pool, orgId, clubScope(kind), clubId);
      if (!fee) return res.status(409).json({ error: `No ${kind} fee is set for this federation.` });
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;
      const club = (await pool.query("SELECT id, name FROM clubs WHERE id = $1", [clubId])).rows[0];

      const { url, paymentId } = await startClubCheckout({ req, org, club, fee, prices, kind });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] club checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // ---- Refunds -----------------------------------------------------

  // Federation refunds a payment. refund_application_fee is always true
  // (see lib/stripe.js) so the federation isn't left short DivingHQ's
  // cut. Omit amount_cents for a full refund.
  router.post(
    "/api/payments/:id/refund",
    requireOrgRole(["org_admin", "meet_manager"]),
    async (req, res) => {
      if (!ensurePayments(res)) return;
      const paymentId = req.params.id;
      try {
        const r = await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId]);
        if (!r.rows.length) return res.status(404).json({ error: "Payment not found" });
        const p = r.rows[0];
        if (!ownsOrg(req, p.org_id)) return res.status(403).json({ error: "Forbidden" });
        if (!["paid", "partially_refunded"].includes(p.status)) {
          return res.status(409).json({ error: `Cannot refund a payment that is ${p.status}.` });
        }
        if (!p.stripe_payment_intent) {
          return res.status(409).json({ error: "This payment has no charge to refund yet." });
        }
        const org = (await pool.query("SELECT stripe_account_id FROM organisations WHERE id = $1", [p.org_id])).rows[0];
        const requested = req.body && Number(req.body.amount_cents) > 0 ? Math.floor(Number(req.body.amount_cents)) : undefined;

        const refund = await payments.createRefund({
          connectedAccountId: org.stripe_account_id,
          paymentIntentId: p.stripe_payment_intent,
          amountCents: requested,
        });

        const refunded = Math.min(
          (p.refunded_amount_cents || 0) + (refund.amount || requested || p.amount_cents),
          p.amount_cents,
        );
        const status = refunded >= p.amount_cents ? "refunded" : "partially_refunded";
        await pool.query(
          "UPDATE payments SET status = $1, refunded_amount_cents = $2, refunded_at = now() WHERE id = $3",
          [status, refunded, paymentId],
        );
        return res.json({ status, refunded_amount_cents: refunded });
      } catch (err) {
        logger.error({ err: err.message }, "[payments] refund failed");
        return res.status(err.status || 500).json({ error: err.message || "Refund failed" });
      }
    },
  );

  return router;
};
