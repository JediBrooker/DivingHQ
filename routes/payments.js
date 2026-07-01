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

  // Roles an official can be accredited for. Matches fee_definitions.role_type
  // (migration 067) and the org_roles the app issues. Allowlisted so a fee or
  // checkout can't be created for an arbitrary role string.
  const OFFICIAL_ROLES = ["judge", "referee", "coach", "meet_manager"];

  // Entry-penalty kinds. The scope/subject_type IS the kind. Admin-issued
  // debits (entry_charges), settled out-of-band by the entrant or waived.
  const PENALTY_KINDS = ["scratch", "no_show"];
  function penaltyLabel(kind) {
    return kind === "no_show" ? "No-show penalty" : "Scratch penalty";
  }

  // Meet-level access purchases (a signed-in buyer pays the federation).
  const ACCESS_KINDS = ["spectator_ticket", "livestream", "programme"];
  const ACCESS_LABELS = {
    spectator_ticket: "Spectator ticket",
    livestream: "Livestream access",
    programme: "Programme",
  };

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

  // Balance (minor units) the platform still owes a federation: net of all
  // collected payments (fee prorated on partial refunds, clamped >= 0) minus
  // everything already withdrawn (pending + paid payouts). Runs on `db` so it
  // can share a transaction / row-lock with a withdrawal insert.
  async function orgBalancesByCurrency(orgId, db = pool) {
    // Net owed PER CURRENCY: collected (fee prorated on partial refunds,
    // clamped >= 0) minus what's already withdrawn, grouped by currency so a
    // federation that took payments in more than one currency is never summed
    // into one meaningless number or paid out in the wrong currency.
    const collected = (await db.query(
      `SELECT currency, COALESCE(SUM(GREATEST(0,
          CASE status
            WHEN 'paid' THEN amount_cents - platform_fee_cents
            WHEN 'partially_refunded' THEN ROUND(
              (amount_cents - platform_fee_cents)::numeric
                * (amount_cents - COALESCE(refunded_amount_cents, 0)) / NULLIF(amount_cents, 0))
            ELSE 0 END)), 0)::bigint AS net
         FROM payments WHERE org_id = $1 GROUP BY currency`,
      [orgId],
    )).rows;
    const paid = (await db.query(
      `SELECT currency, COALESCE(SUM(amount_cents), 0)::bigint AS n
         FROM payouts WHERE org_id = $1 AND status IN ('pending', 'paid') GROUP BY currency`,
      [orgId],
    )).rows;
    const paidByCur = new Map(paid.map((r) => [r.currency, Number(r.n)]));
    return collected
      .map((r) => ({ currency: r.currency, cents: Number(r.net) - (paidByCur.get(r.currency) || 0) }))
      .filter((b) => b.cents > 0)
      .sort((a, b) => b.cents - a.cents);
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
  async function startCheckout({ req, org, fee, prices, subjectType, eventId, meetId = null, productName, successUrl, cancelUrl, surchargeCents = 0 }) {
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
            (org_id, fee_definition_id, payer_user_id, subject_type, event_id, meet_id,
             amount_cents, platform_fee_cents, currency, fee_payer, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING id`,
        [org.id, fee.id, userId, subjectType, eventId || null, meetId || null, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer],
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
          ...(meetId ? { meet_id: meetId } : {}),
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

  // Resolve the org-wide accreditation fee for a role (meet_id NULL = annual,
  // org-wide). Returns the fee_definitions row or null.
  async function resolveOfficialFee(db, orgId, roleType) {
    const r = await db.query(
      `SELECT * FROM fee_definitions
        WHERE org_id = $1 AND scope = 'official_accreditation' AND active
          AND role_type = $2 AND meet_id IS NULL
        LIMIT 1`,
      [orgId, roleType],
    );
    return r.rows[0] || null;
  }

  // Official self-pays the federation for a role accreditation. payer_type
  // 'official_role' carries the role on the payment (payer_role_type), and the
  // one-live-official index blocks a second live payment for the same
  // user+role+fee. Connected account is the federation's.
  async function startOfficialCheckout({ req, org, fee, prices, roleType }) {
    const userId = req.user.id;
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
    const feeBps = fee.platform_fee_bps != null ? fee.platform_fee_bps : org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: chosen.amount_cents,
      feeBps,
      feePayer: fee.fee_payer,
    });

    let paymentId;
    try {
      const ins = await pool.query(
        `INSERT INTO payments
            (org_id, fee_definition_id, payer_type, payer_user_id, payer_role_type, subject_type,
             amount_cents, platform_fee_cents, currency, fee_payer, status)
         VALUES ($1, $2, 'official_role', $3, $4, 'official_accreditation', $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [org.id, fee.id, userId, roleType, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer],
      );
      paymentId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        const err = new Error("You already have a payment in progress or completed for this accreditation.");
        err.status = 409;
        throw err;
      }
      throw e;
    }

    try {
      const session = await payments.createCheckoutSession({
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `${org.name} ${roleType} accreditation`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: {
          payment_id: paymentId,
          scope: "official_accreditation",
          org_id: org.id,
          user_id: userId,
          role_type: roleType,
        },
        successUrl: `${APP_BASE_URL}/accreditation?paid=1`,
        cancelUrl: `${APP_BASE_URL}/accreditation?canceled=1`,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      return { url: session.url, paymentId };
    } catch (err) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // The entrant pays an owed scratch/no-show charge. Unlike the other
  // checkouts the amount is the SNAPSHOT taken at issuance (entry_charges
  // .amount_cents), not a re-resolved price — the debit is fixed when issued.
  // Links the new payment back onto the charge; the webhook marks it paid.
  async function startChargeCheckout({ req, org, charge, fee }) {
    const userId = req.user.id;
    const currency = fee.currency || org.default_currency;
    if (!currency) {
      const err = new Error("The federation's currency is not configured.");
      err.status = 409;
      throw err;
    }
    const feeBps = fee.platform_fee_bps != null ? fee.platform_fee_bps : org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: charge.amount_cents,
      feeBps,
      feePayer: fee.fee_payer,
    });

    let paymentId;
    try {
      const ins = await pool.query(
        `INSERT INTO payments
            (org_id, fee_definition_id, payer_user_id, subject_type, event_id,
             amount_cents, platform_fee_cents, currency, fee_payer, entry_charge_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING id`,
        [org.id, fee.id, userId, charge.kind, charge.event_id, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer, charge.id],
      );
      paymentId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        const err = new Error("You already have a payment in progress or completed for this charge.");
        err.status = 409;
        throw err;
      }
      throw e;
    }

    try {
      const session = await payments.createCheckoutSession({
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `${penaltyLabel(charge.kind)} — ${org.name}`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: {
          payment_id: paymentId,
          scope: charge.kind,
          org_id: org.id,
          user_id: userId,
          event_id: charge.event_id,
          entry_charge_id: charge.id,
        },
        successUrl: `${APP_BASE_URL}/charges?paid=1`,
        cancelUrl: `${APP_BASE_URL}/charges?canceled=1`,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      // Link the payment onto the charge so the webhook can settle it.
      await pool.query("UPDATE entry_charges SET payment_id = $1 WHERE id = $2", [paymentId, charge.id]);
      return { url: session.url, paymentId };
    } catch (err) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // A signed-in supporter donates a chosen amount to the federation. The
  // amount is buyer-picked (a preset or custom), not a fixed fee_price, so
  // this doesn't resolve a price. No one-live guard — repeat donations are
  // fine.
  async function startDonationCheckout({ req, org, fee, amountCents }) {
    const userId = req.user.id;
    const currency = fee.currency || org.default_currency;
    if (!currency) {
      const err = new Error("The federation's currency is not configured.");
      err.status = 409;
      throw err;
    }
    const feeBps = fee.platform_fee_bps != null ? fee.platform_fee_bps : org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: amountCents,
      feeBps,
      feePayer: fee.fee_payer,
    });
    const ins = await pool.query(
      `INSERT INTO payments
          (org_id, fee_definition_id, payer_user_id, subject_type,
           amount_cents, platform_fee_cents, currency, fee_payer, status)
       VALUES ($1, $2, $3, 'donation', $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [org.id, fee.id, userId, chargeAmountCents, applicationFeeCents, currency, fee.fee_payer],
    );
    const paymentId = ins.rows[0].id;
    try {
      const session = await payments.createCheckoutSession({
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `Donation to ${org.name}`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: { payment_id: paymentId, scope: "donation", org_id: org.id, user_id: userId },
        successUrl: `${APP_BASE_URL}/donate?paid=1`,
        cancelUrl: `${APP_BASE_URL}/donate?canceled=1`,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      return { url: session.url, paymentId };
    } catch (err) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // The fined person pays their own fine (payer_user_id = liable_user_id).
  // The amount is fixed on the fine row (referee-set), not a fee_price, and
  // fines carry no fee_definition. One-live guard is per-fine (fine_id).
  async function startFineCheckout({ req, org, fine }) {
    const userId = req.user.id;
    const currency = fine.currency || org.default_currency;
    if (!currency) {
      const err = new Error("The federation's currency is not configured.");
      err.status = 409;
      throw err;
    }
    const feeBps = org.platform_fee_bps;
    const { chargeAmountCents, applicationFeeCents } = priceCharge({
      baseAmountCents: fine.amount_cents,
      feeBps,
      feePayer: "absorb",
    });
    let paymentId;
    try {
      const ins = await pool.query(
        `INSERT INTO payments
            (org_id, payer_user_id, liable_user_id, subject_type,
             amount_cents, platform_fee_cents, currency, fee_payer, fine_id, status)
         VALUES ($1, $2, $2, 'fine', $3, $4, $5, 'absorb', $6, 'pending')
         RETURNING id`,
        [org.id, userId, chargeAmountCents, applicationFeeCents, currency, fine.id],
      );
      paymentId = ins.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        const err = new Error("You already have a payment in progress or completed for this fine.");
        err.status = 409;
        throw err;
      }
      throw e;
    }
    try {
      const session = await payments.createCheckoutSession({
        currency,
        chargeAmountCents,
        applicationFeeCents,
        productName: `Fine — ${org.name}`,
        customerEmail: req.user.email,
        clientReferenceId: paymentId,
        metadata: { payment_id: paymentId, scope: "fine", org_id: org.id, user_id: userId, fine_id: fine.id },
        successUrl: `${APP_BASE_URL}/charges?paid=1`,
        cancelUrl: `${APP_BASE_URL}/charges?canceled=1`,
      });
      await pool.query("UPDATE payments SET stripe_checkout_session = $1 WHERE id = $2", [session.id, paymentId]);
      await pool.query("UPDATE fines SET payment_id = $1 WHERE id = $2", [paymentId, fine.id]);
      return { url: session.url, paymentId };
    } catch (err) {
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId]);
      throw err;
    }
  }

  // ---- Payout setup (platform is merchant of record) --------------
  // Federations/clubs don't onboard with Stripe. They give us payout bank
  // details; the platform collects on its own account and pays them out. The
  // balance owed = net (amount - our 15%) of their paid payments, minus what
  // we've already paid out.

  // Payout status + balance owed for a federation.
  router.get("/api/orgs/:id/payments/status", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    try {
      const org = (await pool.query(
        `SELECT payout_account_name, payout_account_details, default_currency,
                auto_withdraw_enabled, auto_withdraw_min_cents
           FROM organisations WHERE id = $1`,
        [orgId],
      )).rows[0];
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      const base = {
        payout_details_set: !!(org.payout_account_name && org.payout_account_details),
        account_name: org.payout_account_name || null,
        currency: org.default_currency || null,
        auto_withdraw_enabled: !!org.auto_withdraw_enabled,
        auto_withdraw_min_cents: org.auto_withdraw_min_cents ?? null,
      };
      // Coming-soon: report payout + auto-withdraw settings (they don't need
      // Stripe) but no balance until payments are switched on.
      if (!payments.enabled) return res.json({ enabled: false, ...base, balances: [], balance_cents: 0 });
      const balances = await orgBalancesByCurrency(orgId);
      const primary = balances[0] || null;
      return res.json({
        enabled: true,
        ...base,
        // Per-currency amounts owed; the UI renders each in its own currency.
        balances,
        // Convenience for the common single-currency case: the largest bucket.
        balance_cents: primary ? primary.cents : 0,
        currency: primary ? primary.currency : base.currency,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] payout status failed");
      return res.status(err.status || 500).json({ error: err.message || "Status check failed" });
    }
  });

  // Federation saves its payout bank details.
  router.put("/api/orgs/:id/payout-details", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const name = ((req.body || {}).account_name || "").toString().trim();
    const details = ((req.body || {}).account_details || "").toString().trim();
    if (!name || !details) return res.status(400).json({ error: "Account name and details are required." });
    try {
      await pool.query(
        "UPDATE organisations SET payout_account_name = $1, payout_account_details = $2 WHERE id = $3",
        [name.slice(0, 200), details.slice(0, 500), orgId],
      );
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] save payout details failed");
      return res.status(500).json({ error: "Failed to save payout details." });
    }
  });

  // Federation saves its automatic-withdrawal preference. Savable any time
  // (even in coming-soon mode) so it's ready when payments go live — the
  // auto-payout job reads these columns then. A threshold (minor units) is
  // required when enabled.
  router.put("/api/orgs/:id/withdrawal-settings", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    const enabled = body.auto_withdraw_enabled === true;
    let minCents = null;
    if (enabled) {
      minCents = Math.floor(Number(body.auto_withdraw_min_cents));
      if (!Number.isFinite(minCents) || minCents < 100) {
        return res.status(400).json({ error: "Set an automatic-withdrawal threshold of at least 1.00." });
      }
      if (minCents > 100000000) {
        return res.status(400).json({ error: "That threshold is too large." });
      }
    }
    try {
      await pool.query(
        "UPDATE organisations SET auto_withdraw_enabled = $1, auto_withdraw_min_cents = $2 WHERE id = $3",
        [enabled, minCents, orgId],
      );
      return res.json({ ok: true, auto_withdraw_enabled: enabled, auto_withdraw_min_cents: minCents });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] save withdrawal settings failed");
      return res.status(500).json({ error: "Failed to save withdrawal settings." });
    }
  });

  // Federation's withdrawal (payout) history — most recent first.
  router.get("/api/orgs/:id/withdrawals", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    try {
      const r = await pool.query(
        `SELECT id, amount_cents, currency, status, note, created_at, paid_at
           FROM payouts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [orgId],
      );
      return res.json(r.rows);
    } catch (err) {
      logger.error({ err: err.message }, "[payments] list withdrawals failed");
      return res.status(500).json({ error: "Failed to load withdrawals." });
    }
  });

  // Federation requests a withdrawal of its owed balance. Only meaningful once
  // payments are live (nothing to withdraw while dormant, so ensurePayments
  // 503s). The org row is locked FOR UPDATE so two concurrent requests can't
  // both read the same balance and over-withdraw. Records one pending
  // payout PER CURRENCY; the actual bank transfer is settled out-of-band.
  router.post("/api/orgs/:id/withdrawals", requireOrgRole(["org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = (await client.query(
        "SELECT payout_account_name, payout_account_details FROM organisations WHERE id = $1 FOR UPDATE",
        [orgId],
      )).rows[0];
      if (!org) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Organisation not found" });
      }
      if (!org.payout_account_name || !org.payout_account_details) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Add your payout bank details before withdrawing." });
      }
      const note = ((req.body || {}).note || "").toString().trim().slice(0, 200) || null;
      const balances = await orgBalancesByCurrency(orgId, client);
      if (!balances.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "You have no balance to withdraw." });
      }
      // One pending payout per currency, each stamped with ITS own currency
      // and amount — never a cross-currency sum booked in the wrong currency.
      const payouts = [];
      for (const b of balances) {
        const row = (await client.query(
          `INSERT INTO payouts (org_id, amount_cents, currency, status, note)
           VALUES ($1, $2, $3, 'pending', $4)
           RETURNING id, amount_cents, currency, status, note, created_at, paid_at`,
          [orgId, b.cents, b.currency, note],
        )).rows[0];
        payouts.push(row);
      }
      await client.query("COMMIT");
      return res.status(201).json(payouts);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error({ err: err.message }, "[payments] withdrawal request failed");
      return res.status(err.status || 500).json({ error: err.message || "Withdrawal failed." });
    } finally {
      client.release();
    }
  });

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

  // ---- Scratch / no-show penalty fees -----------------------------
  // Per-event flat penalties an admin can issue against an entrant who
  // withdraws (scratch) or doesn't show (no_show). Configured here; issued +
  // collected via the entry-charges endpoints below.

  router.put("/api/events/:id/penalty-fee", requireEventManager(), async (req, res) => {
    if (!ensurePayments(res)) return;
    const eventId = req.params.id;
    const orgId = req.event.org_id; // stashed by requireEventManager
    const body = req.body || {};
    if (!PENALTY_KINDS.includes(body.kind)) {
      return res.status(400).json({ error: "A valid penalty kind is required." });
    }
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      // Flat penalty (audience 'all', no window) — like late fees, a
      // member/windowed variant would silently vanish at resolve time.
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      const feeId = await upsertFee({
        orgId,
        scope: body.kind,
        eventId,
        name: penaltyLabel(body.kind),
        body,
        cleanPrices: [flatPrice],
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set penalty fee failed");
      return res.status(500).json({ error: "Failed to save the penalty fee." });
    }
  });

  // Full penalty-fee config (all variants) for the manager's editor.
  router.get("/api/events/:id/penalty-fee", requireEventManager(), async (req, res) => {
    if (!PENALTY_KINDS.includes(req.query.kind)) {
      return res.status(400).json({ error: "A valid penalty kind is required." });
    }
    try {
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE event_id = $1 AND scope = $2 AND active LIMIT 1",
        [req.params.id, req.query.kind],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read penalty fee config failed");
      return res.status(500).json({ error: "Failed to read the penalty fee." });
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

  // ---- Meet access (spectator ticket / livestream / programme) -----
  // Meet-level purchases a signed-in buyer makes. Federation sets a flat
  // price per kind; the buyer pays the federation. One purchase per buyer
  // per meet per kind (multi-quantity is a later feature). NOTE: requires a
  // signed-in buyer — anonymous/guest checkout would need a new payer type.

  // Federation sets/updates a meet access fee for one kind.
  router.put("/api/meets/:id/access-fee", requireMeetEditor, async (req, res) => {
    if (!ensurePayments(res)) return;
    const meetId = req.params.id;
    const body = req.body || {};
    if (!ACCESS_KINDS.includes(body.kind)) {
      return res.status(400).json({ error: "A valid access kind is required." });
    }
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
      if (!Array.isArray(body.prices) || !body.prices.length) {
        return res.status(400).json({ error: "At least one price variant is required." });
      }
      const v = validatePrices(body.prices);
      if (v.error) return res.status(400).json({ error: v.error });
      // Flat price (audience 'all', no window) — access isn't member-tiered.
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      const feeId = await upsertFee({
        orgId, scope: body.kind, meetId,
        name: `${ACCESS_LABELS[body.kind]} (meet)`,
        body, cleanPrices: [flatPrice],
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set meet access fee failed");
      return res.status(500).json({ error: "Failed to save the access fee." });
    }
  });

  // Full access-fee config (all variants) for the manager's editor.
  router.get("/api/meets/:id/access-fee", requireMeetEditor, async (req, res) => {
    const meetId = req.params.id;
    if (!ACCESS_KINDS.includes(req.query.kind)) {
      return res.status(400).json({ error: "A valid access kind is required." });
    }
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      if (!ownsOrg(req, m.rows[0].org_id)) return res.status(403).json({ error: "Forbidden" });
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = $2 AND active LIMIT 1",
        [meetId, req.query.kind],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, feeRes.rows[0]), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read meet access config failed");
      return res.status(500).json({ error: "Failed to read the access fee." });
    }
  });

  // Buyer-facing: what does this meet access cost, and have I already bought it?
  router.get("/api/meets/:id/access", optionalAuth, async (req, res) => {
    const meetId = req.params.id;
    if (!ACCESS_KINDS.includes(req.query.kind)) {
      return res.status(400).json({ error: "A valid access kind is required." });
    }
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = $2 AND active LIMIT 1",
        [meetId, req.query.kind],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      const alreadyPaid = req.user
        ? (await pool.query(
            `SELECT 1 FROM payments
              WHERE meet_id = $1 AND payer_user_id = $2 AND subject_type = $3 AND status = 'paid' LIMIT 1`,
            [meetId, req.user.id, req.query.kind],
          )).rows.length > 0
        : false;
      return res.json({
        fee: {
          kind: req.query.kind,
          currency: def.currency || org?.default_currency || null,
          already_paid: alreadyPaid,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read meet access failed");
      return res.status(500).json({ error: "Failed to read the access fee." });
    }
  });

  // A signed-in buyer purchases meet access (ticket / stream / programme).
  router.post("/api/meets/:id/access/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const meetId = req.params.id;
    const kind = (req.query && req.query.kind) || (req.body && req.body.kind);
    if (!ACCESS_KINDS.includes(kind)) {
      return res.status(400).json({ error: "A valid access kind is required." });
    }
    try {
      const m = await pool.query("SELECT id, name, org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = $2 AND active LIMIT 1",
        [meetId, kind],
      );
      if (!feeRes.rows.length) return res.status(409).json({ error: `No ${ACCESS_LABELS[kind].toLowerCase()} is on sale for this meet.` });
      const fee = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;

      const { url, paymentId } = await startCheckout({
        req,
        org,
        fee,
        prices,
        subjectType: kind,
        meetId,
        productName: `${ACCESS_LABELS[kind]} — ${m.rows[0].name}`,
        successUrl: `${APP_BASE_URL}/meets/${meetId}?paid=1`,
        cancelUrl: `${APP_BASE_URL}/meets/${meetId}?canceled=1`,
      });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] meet access checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // ---- Meet bundle (discounted whole-meet package) ----------------
  // A federation offers a discounted price to enter a chosen SET of the
  // meet's events at once. On payment the webhook expands the bundle into a
  // paid event_entry for each included event, so the diver counts as entered.

  // Federation sets the bundle price + which events it covers.
  router.put("/api/meets/:id/bundle", requireMeetEditor, async (req, res) => {
    if (!ensurePayments(res)) return;
    const meetId = req.params.id;
    const body = req.body || {};
    if (!Array.isArray(body.event_ids) || !body.event_ids.length) {
      return res.status(400).json({ error: "Select at least one event for the bundle." });
    }
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
      // Only events that actually belong to this meet can be bundled.
      const validEvents = (await pool.query(
        "SELECT id FROM events WHERE meet_id = $1 AND id = ANY($2::uuid[])",
        [meetId, body.event_ids],
      )).rows.map((r) => r.id);
      if (!validEvents.length) return res.status(400).json({ error: "None of those events belong to this meet." });
      const v = validatePrices(body.prices);
      if (v.error) return res.status(400).json({ error: v.error });
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      const feeId = await upsertFee({
        orgId, scope: "meet_bundle", meetId,
        name: "Meet bundle", body, cleanPrices: [flatPrice],
      });
      // Replace the bundle's event set atomically.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM meet_bundle_items WHERE fee_definition_id = $1", [feeId]);
        for (const evId of validEvents) {
          await client.query(
            "INSERT INTO meet_bundle_items (fee_definition_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [feeId, evId],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      return res.json({ id: feeId, event_ids: validEvents });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set meet bundle failed");
      return res.status(500).json({ error: "Failed to save the meet bundle." });
    }
  });

  // Full bundle config (price + selected event ids) for the manager's editor.
  router.get("/api/meets/:id/bundle/config", requireMeetEditor, async (req, res) => {
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      if (!ownsOrg(req, m.rows[0].org_id)) return res.status(403).json({ error: "Forbidden" });
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = 'meet_bundle' AND active LIMIT 1",
        [meetId],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, event_ids: [], payments_enabled: payments.enabled });
      const eventIds = (await pool.query(
        "SELECT event_id FROM meet_bundle_items WHERE fee_definition_id = $1",
        [feeRes.rows[0].id],
      )).rows.map((r) => r.event_id);
      return res.json({
        fee: await feeConfigResponse(pool, feeRes.rows[0]),
        event_ids: eventIds,
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read bundle config failed");
      return res.status(500).json({ error: "Failed to read the meet bundle." });
    }
  });

  // Buyer-facing: bundle price + the events it covers + already-bought flag.
  router.get("/api/meets/:id/bundle", optionalAuth, async (req, res) => {
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = 'meet_bundle' AND active LIMIT 1",
        [meetId],
      );
      if (!feeRes.rows.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      const events = (await pool.query(
        `SELECT e.id, e.name FROM meet_bundle_items mbi
           JOIN events e ON e.id = mbi.event_id
          WHERE mbi.fee_definition_id = $1
          ORDER BY e.name`,
        [def.id],
      )).rows;
      // A bundle with no events (half-configured) reads as no bundle, so the
      // public card hides itself rather than offering an empty purchase.
      if (!events.length) return res.json({ fee: null, payments_enabled: payments.enabled });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      const alreadyPaid = req.user
        ? (await pool.query(
            `SELECT 1 FROM payments
              WHERE meet_id = $1 AND payer_user_id = $2 AND subject_type = 'meet_bundle' AND status = 'paid' LIMIT 1`,
            [meetId, req.user.id],
          )).rows.length > 0
        : false;
      return res.json({
        fee: {
          currency: def.currency || org?.default_currency || null,
          already_paid: alreadyPaid,
          events,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read meet bundle failed");
      return res.status(500).json({ error: "Failed to read the meet bundle." });
    }
  });

  // A signed-in diver buys the whole-meet bundle.
  router.post("/api/meets/:id/bundle/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const meetId = req.params.id;
    try {
      const m = await pool.query("SELECT id, name, org_id FROM meets WHERE id = $1", [meetId]);
      if (!m.rows.length) return res.status(404).json({ error: "Meet not found" });
      const orgId = m.rows[0].org_id;
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE meet_id = $1 AND scope = 'meet_bundle' AND active LIMIT 1",
        [meetId],
      );
      if (!feeRes.rows.length) return res.status(409).json({ error: "No bundle is on sale for this meet." });
      const fee = feeRes.rows[0];
      // Guard against a half-configured bundle (fee saved but no event set,
      // e.g. a crash between the fee upsert and the items write) — an item-less
      // bundle would take money and grant nothing.
      const itemCount = (await pool.query(
        "SELECT COUNT(*)::int AS n FROM meet_bundle_items WHERE fee_definition_id = $1", [fee.id],
      )).rows[0].n;
      if (!itemCount) return res.status(409).json({ error: "This bundle has no events yet." });
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;

      const { url, paymentId } = await startCheckout({
        req, org, fee, prices,
        subjectType: "meet_bundle",
        meetId,
        productName: `Meet bundle — ${m.rows[0].name}`,
        successUrl: `${APP_BASE_URL}/meets/${meetId}?paid=1`,
        cancelUrl: `${APP_BASE_URL}/meets/${meetId}?canceled=1`,
      });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] meet bundle checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
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

  // ---- Donations --------------------------------------------------
  // A federation accepts fundraising donations with optional preset amounts;
  // any signed-in supporter donates a chosen amount. Org-level; the amount is
  // buyer-picked, so there's no fixed fee_price (upsertFee with no prices).

  const MIN_DONATION_CENTS = 100;
  // Upper bound so an oversized amount is a clean 400, not an int4-overflow
  // 500. £1,000,000 leaves headroom under int4 max even once a pass-to-payer
  // fee is added on top.
  const MAX_DONATION_CENTS = 100000000;

  // Federation configures donations (currency + suggested preset amounts).
  router.put("/api/orgs/:id/donation", requireOrgRole(["org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    // Sanitise presets to positive integer minor-unit amounts (max 8).
    const suggested = Array.isArray(body.suggested_amounts)
      ? body.suggested_amounts
          .map((n) => Math.floor(Number(n)))
          .filter((n) => Number.isInteger(n) && n >= MIN_DONATION_CENTS)
          .slice(0, 8)
      : [];
    try {
      const feeId = await upsertFee({
        orgId,
        scope: "donation",
        name: "Donation",
        body: { currency: body.currency, suggested_amounts: suggested, fee_payer: body.fee_payer },
        cleanPrices: [],
      });
      return res.json({ id: feeId, suggested_amounts: suggested });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set donation failed");
      return res.status(500).json({ error: "Failed to save donation settings." });
    }
  });

  // Public: is this federation accepting donations, and what presets?
  router.get("/api/orgs/:id/donation", optionalAuth, async (req, res) => {
    const orgId = req.params.id;
    try {
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE org_id = $1 AND scope = 'donation' AND active LIMIT 1",
        [orgId],
      );
      if (!feeRes.rows.length) return res.json({ donation: null, payments_enabled: payments.enabled });
      const def = feeRes.rows[0];
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      return res.json({
        donation: {
          currency: def.currency || org?.default_currency || null,
          suggested_amounts: def.suggested_amounts || [],
          min_amount_cents: MIN_DONATION_CENTS,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read donation failed");
      return res.status(500).json({ error: "Failed to read donation settings." });
    }
  });

  // A supporter donates a chosen amount.
  router.post("/api/orgs/:id/donate/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    const amountCents = Math.floor(Number((req.body || {}).amount_cents));
    if (!Number.isInteger(amountCents) || amountCents < MIN_DONATION_CENTS || amountCents > MAX_DONATION_CENTS) {
      return res.status(400).json({ error: "Please enter a valid donation amount." });
    }
    try {
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      const feeRes = await pool.query(
        "SELECT * FROM fee_definitions WHERE org_id = $1 AND scope = 'donation' AND active LIMIT 1",
        [orgId],
      );
      if (!feeRes.rows.length) return res.status(409).json({ error: "This federation isn't accepting donations." });

      const { url, paymentId } = await startDonationCheckout({ req, org, fee: feeRes.rows[0], amountCents });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] donation checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // ---- Fines (disciplinary, referee-issued, appealable) -----------
  // A referee (or org_admin) issues a fine against a person; the person pays
  // or appeals it; an org_admin adjudicates the appeal (upheld => waived,
  // dismissed => back to owed). Paying is blocked while an appeal is pending.

  const FINE_MIN_CENTS = 100;
  const FINE_MAX_CENTS = 100000000;

  // Shape a fine row for the API (no raw internals).
  function fineOut(f) {
    return {
      id: f.id, amount_cents: f.amount_cents, currency: f.currency, reason: f.reason,
      status: f.status, appeal_status: f.appeal_status, appeal_reason: f.appeal_reason,
      event_id: f.event_id, issued_at: f.issued_at,
      liable_user_id: f.liable_user_id, liable_name: f.liable_name,
      issued_by_name: f.issued_by_name,
    };
  }

  // Retire any in-flight checkout for a fine before appealing/waiving it, so a
  // still-open Stripe session can't settle a fine that's no longer owed.
  // Returns "paid" if the linked payment already completed (caller should 409).
  // Requires fine.{payment_id, org_id}.
  async function retireInFlightFinePayment(fine) {
    if (!fine.payment_id) return null;
    const p = (await pool.query("SELECT id, status, stripe_checkout_session FROM payments WHERE id = $1", [fine.payment_id])).rows[0];
    if (!p) return null;
    if (p.status === "paid") return "paid";
    if (p.status === "pending") {
      // Expire on the PLATFORM account (we're the merchant of record) so the
      // payer can't complete a session for a fine that's no longer owed.
      if (payments.enabled && p.stripe_checkout_session) {
        try {
          await payments.expireCheckoutSession({ sessionId: p.stripe_checkout_session });
        } catch (e) {
          logger.warn({ err: e.message }, "[payments] could not expire in-flight fine session");
        }
      }
      await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [p.id]);
    }
    return null;
  }

  // Referee / org_admin issues a fine against a person in their org.
  router.post("/api/fines", requireOrgRole(["referee", "org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const body = req.body || {};
    const amountCents = Math.floor(Number(body.amount_cents));
    if (!Number.isInteger(amountCents) || amountCents < FINE_MIN_CENTS || amountCents > FINE_MAX_CENTS) {
      return res.status(400).json({ error: "A valid fine amount is required." });
    }
    if (!body.liable_user_id) return res.status(400).json({ error: "Who the fine is for is required." });
    const reason = (body.reason || "").toString().trim();
    if (!reason) return res.status(400).json({ error: "A reason for the fine is required." });
    try {
      const liable = (await pool.query("SELECT id, org_id FROM users WHERE id = $1", [body.liable_user_id])).rows[0];
      if (!liable) return res.status(404).json({ error: "Person not found." });
      const orgId = liable.org_id;
      if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "You can only fine people in your own federation." });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      const currency = org?.default_currency;
      if (!currency) return res.status(409).json({ error: "The federation's currency is not configured." });
      let eventId = null;
      if (body.event_id) {
        const ev = (await pool.query("SELECT id FROM events WHERE id = $1 AND org_id = $2", [body.event_id, orgId])).rows[0];
        if (!ev) return res.status(400).json({ error: "That event isn't in this federation." });
        eventId = ev.id;
      }
      const ins = await pool.query(
        `INSERT INTO fines (org_id, liable_user_id, issued_by, event_id, amount_cents, currency, reason, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'owed') RETURNING id`,
        [orgId, body.liable_user_id, req.user.id, eventId, amountCents, currency, reason],
      );
      return res.json({ id: ins.rows[0].id, amount_cents: amountCents });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] issue fine failed");
      return res.status(500).json({ error: "Failed to issue the fine." });
    }
  });

  // Referee / org_admin lists their org's fines.
  router.get("/api/fines", requireOrgRole(["referee", "org_admin"]), async (req, res) => {
    try {
      const isSys = req.user.is_system_admin;
      const rows = (await pool.query(
        `SELECT f.*, lu.full_name AS liable_name, iu.full_name AS issued_by_name
           FROM fines f
           JOIN users lu ON lu.id = f.liable_user_id
           LEFT JOIN users iu ON iu.id = f.issued_by
          WHERE ($2::boolean OR f.org_id = $1)
          ORDER BY f.issued_at DESC`,
        [req.user.org_id, isSys],
      )).rows;
      return res.json({ fines: rows.map(fineOut), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] list fines failed");
      return res.status(500).json({ error: "Failed to list fines." });
    }
  });

  // The person's own fines (to pay or appeal).
  router.get("/api/me/fines", verifyToken, async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT f.*, lu.full_name AS liable_name, iu.full_name AS issued_by_name
           FROM fines f
           JOIN users lu ON lu.id = f.liable_user_id
           LEFT JOIN users iu ON iu.id = f.issued_by
          WHERE f.liable_user_id = $1 AND f.status IN ('owed', 'appealed')
          ORDER BY f.issued_at DESC`,
        [req.user.id],
      )).rows;
      return res.json({ fines: rows.map(fineOut), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read my fines failed");
      return res.status(500).json({ error: "Failed to read your fines." });
    }
  });

  // The fined person appeals an owed fine.
  router.post("/api/fines/:id/appeal", verifyToken, async (req, res) => {
    const reason = ((req.body || {}).reason || "").toString().trim();
    if (!reason) return res.status(400).json({ error: "An appeal reason is required." });
    try {
      const f = (await pool.query("SELECT id, org_id, liable_user_id, status, payment_id FROM fines WHERE id = $1", [req.params.id])).rows[0];
      if (!f) return res.status(404).json({ error: "Fine not found" });
      if (f.liable_user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
      if (f.status !== "owed") return res.status(409).json({ error: `Cannot appeal a fine that is ${f.status}.` });
      // Don't let an appeal race an in-flight checkout — retire it, or block
      // the appeal if the payment already settled.
      if ((await retireInFlightFinePayment(f)) === "paid") {
        return res.status(409).json({ error: "This fine has already been paid." });
      }
      await pool.query(
        "UPDATE fines SET status = 'appealed', appeal_status = 'pending', appeal_reason = $2 WHERE id = $1 AND status = 'owed'",
        [req.params.id, reason],
      );
      return res.json({ status: "appealed" });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] appeal fine failed");
      return res.status(500).json({ error: "Failed to file the appeal." });
    }
  });

  // An org_admin adjudicates a pending appeal.
  router.post("/api/fines/:id/appeal/review", requireOrgRole(["org_admin"]), async (req, res) => {
    const decision = (req.body || {}).decision;
    if (!['upheld', 'dismissed'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'upheld' or 'dismissed'." });
    }
    try {
      const f = (await pool.query("SELECT id, org_id, status, issued_by FROM fines WHERE id = $1", [req.params.id])).rows[0];
      if (!f) return res.status(404).json({ error: "Fine not found" });
      if (!ownsOrg(req, f.org_id)) return res.status(403).json({ error: "Forbidden" });
      // Separation of duties: the issuer can't adjudicate their own fine.
      if (f.issued_by === req.user.id && !req.user.is_system_admin) {
        return res.status(403).json({ error: "You cannot review an appeal on a fine you issued." });
      }
      if (f.status !== "appealed") return res.status(409).json({ error: `No pending appeal on a fine that is ${f.status}.` });
      // Upheld = the appeal succeeds => the fine is waived. Dismissed = it
      // stands => back to owed.
      const newStatus = decision === "upheld" ? "waived" : "owed";
      await pool.query(
        "UPDATE fines SET status = $2, appeal_status = $3, appeal_reviewed_by = $4 WHERE id = $1 AND status = 'appealed'",
        [req.params.id, newStatus, decision, req.user.id],
      );
      return res.json({ status: newStatus, appeal_status: decision });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] review appeal failed");
      return res.status(500).json({ error: "Failed to review the appeal." });
    }
  });

  // Referee / org_admin waives a fine (owed or under appeal).
  router.post("/api/fines/:id/waive", requireOrgRole(["referee", "org_admin"]), async (req, res) => {
    try {
      const f = (await pool.query("SELECT id, org_id, status, payment_id FROM fines WHERE id = $1", [req.params.id])).rows[0];
      if (!f) return res.status(404).json({ error: "Fine not found" });
      if (!ownsOrg(req, f.org_id)) return res.status(403).json({ error: "Forbidden" });
      if (!['owed', 'appealed'].includes(f.status)) {
        return res.status(409).json({ error: `Cannot waive a fine that is ${f.status}.` });
      }
      // Kill any in-flight checkout so the person can't pay a waived fine.
      if ((await retireInFlightFinePayment(f)) === "paid") {
        return res.status(409).json({ error: "This fine has already been paid — refund it instead of waiving." });
      }
      await pool.query("UPDATE fines SET status = 'waived' WHERE id = $1 AND status IN ('owed', 'appealed')", [req.params.id]);
      return res.json({ status: "waived" });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] waive fine failed");
      return res.status(500).json({ error: "Failed to waive the fine." });
    }
  });

  // The fined person pays an owed fine (blocked while under appeal).
  router.post("/api/fines/:id/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    try {
      const fine = (await pool.query("SELECT * FROM fines WHERE id = $1", [req.params.id])).rows[0];
      if (!fine) return res.status(404).json({ error: "Fine not found" });
      if (fine.liable_user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
      if (fine.status !== "owed") return res.status(409).json({ error: `This fine is ${fine.status}.` });
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [fine.org_id],
        )
      ).rows[0];
      const { url, paymentId } = await startFineCheckout({ req, org, fine });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] fine checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
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
      // A club fee is a single FLAT price — the payer is a CLUB, never a
      // "member", so audience tiers / time windows are meaningless and would
      // only let the fee silently vanish at resolve time (resolveClubFee
      // resolves isMember:false at now). Force audience 'all', no window.
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      const feeId = await upsertFee({
        orgId,
        scope,
        name: body.name || (scope === "club_accreditation" ? "Club accreditation" : "Club affiliation"),
        body,
        cleanPrices: [flatPrice],
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

  // ---- Official / coach accreditation fees ------------------------
  // The FEDERATION (org_admin) sets a per-role accreditation price; an
  // OFFICIAL self-pays it. Org-wide annual for this cut (meet_id NULL); the
  // schema also allows per-meet passes. One flat price per role.

  // Federation sets/updates the accreditation fee for a role.
  router.put("/api/orgs/:id/official-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const body = req.body || {};
    if (!OFFICIAL_ROLES.includes(body.role_type)) {
      return res.status(400).json({ error: "A valid role_type is required." });
    }
    if (!Array.isArray(body.prices) || !body.prices.length) {
      return res.status(400).json({ error: "At least one price variant is required." });
    }
    const v = validatePrices(body.prices);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      // A flat per-role price (audience 'all', no window) — accreditation
      // isn't member-tiered, and a member/windowed variant would silently
      // vanish at resolve time (resolveOfficialFee resolves isMember:false).
      const flatPrice = { ...v.prices[0], audience: "all", starts_at: null, ends_at: null };
      const feeId = await upsertFee({
        orgId,
        scope: "official_accreditation",
        roleType: body.role_type,
        name: `${body.role_type} accreditation`,
        body,
        cleanPrices: [flatPrice],
      });
      return res.json({ id: feeId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] set official fee failed");
      return res.status(500).json({ error: "Failed to save the accreditation fee." });
    }
  });

  // Full accreditation-fee config (all variants) for the federation's editor.
  router.get("/api/orgs/:id/official-fee", requireOrgRole(["org_admin"]), async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    if (!OFFICIAL_ROLES.includes(req.query.role_type)) {
      return res.status(400).json({ error: "A valid role_type is required." });
    }
    try {
      const def = await resolveOfficialFee(pool, orgId, req.query.role_type);
      if (!def) return res.json({ fee: null, payments_enabled: payments.enabled });
      return res.json({ fee: await feeConfigResponse(pool, def), payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read official fee config failed");
      return res.status(500).json({ error: "Failed to read the accreditation fee." });
    }
  });

  // Official-facing: what does accreditation for this role cost me, and am I
  // currently accredited? Scoped to the caller's own org.
  router.get("/api/orgs/:id/official-accreditation", verifyToken, async (req, res) => {
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const roleType = req.query.role_type;
    if (!OFFICIAL_ROLES.includes(roleType)) {
      return res.status(400).json({ error: "A valid role_type is required." });
    }
    try {
      const def = await resolveOfficialFee(pool, orgId, roleType);
      const current = (await pool.query(
        `SELECT status, period_end FROM official_accreditations
          WHERE org_id = $1 AND user_id = $2 AND role_type = $3 AND meet_id IS NULL
            AND status = 'active' AND (period_end IS NULL OR period_end > CURRENT_DATE)
          ORDER BY period_end DESC NULLS LAST LIMIT 1`,
        [orgId, req.user.id, roleType],
      )).rows[0];
      if (!def) {
        return res.json({
          fee: { role_type: roleType, active: !!current, period_end: current?.period_end || null, price: null },
          payments_enabled: payments.enabled,
        });
      }
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [def.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      const org = (await pool.query("SELECT default_currency FROM organisations WHERE id = $1", [orgId])).rows[0];
      return res.json({
        fee: {
          role_type: roleType,
          currency: def.currency || org?.default_currency || null,
          active: !!current,
          period_end: current?.period_end || null,
          price: chosen ? { amount_cents: chosen.amount_cents, label: chosen.label } : null,
        },
        payments_enabled: payments.enabled,
      });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read official accreditation failed");
      return res.status(500).json({ error: "Failed to read the accreditation fee." });
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

  // An official self-pays the federation for a role accreditation.
  router.post("/api/orgs/:id/official-accreditation/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    const orgId = req.params.id;
    if (!ownsOrg(req, orgId)) return res.status(403).json({ error: "Forbidden" });
    const roleType = (req.query && req.query.role_type) || (req.body && req.body.role_type);
    if (!OFFICIAL_ROLES.includes(roleType)) {
      return res.status(400).json({ error: "A valid role_type is required." });
    }
    try {
      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [orgId],
        )
      ).rows[0];
      if (!org) return res.status(404).json({ error: "Organisation not found" });
      const fee = await resolveOfficialFee(pool, orgId, roleType);
      if (!fee) return res.status(409).json({ error: `No ${roleType} accreditation fee is set for this federation.` });
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;

      const { url, paymentId } = await startOfficialCheckout({ req, org, fee, prices, roleType });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] official checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // ---- Entry charges (scratch / no-show debits) -------------------
  // Admin issues a charge against an entrant; it sits 'owed' until the
  // entrant pays it or an admin waives it. The amount is snapshotted from
  // the configured penalty fee at issuance, so a later fee change doesn't
  // move an already-issued debit.

  // Issue a scratch / no-show charge against an entrant.
  router.post("/api/events/:id/entry-charges", requireEventManager(), async (req, res) => {
    const eventId = req.params.id;
    const orgId = req.event.org_id; // stashed by requireEventManager
    const body = req.body || {};
    if (!PENALTY_KINDS.includes(body.kind)) {
      return res.status(400).json({ error: "A valid penalty kind is required." });
    }
    if (!body.entrant_user_id) {
      return res.status(400).json({ error: "entrant_user_id is required." });
    }
    try {
      const entrant = (await pool.query(
        "SELECT id FROM users WHERE id = $1 AND org_id = $2",
        [body.entrant_user_id, orgId],
      )).rows[0];
      if (!entrant) return res.status(404).json({ error: "Entrant not found in this organisation." });

      const fee = (await pool.query(
        "SELECT * FROM fee_definitions WHERE event_id = $1 AND scope = $2 AND active LIMIT 1",
        [eventId, body.kind],
      )).rows[0];
      if (!fee) return res.status(409).json({ error: `No ${body.kind === "no_show" ? "no-show" : "scratch"} fee is set for this event.` });
      const prices = (await pool.query("SELECT * FROM fee_prices WHERE fee_definition_id = $1", [fee.id])).rows;
      const chosen = resolvePrice(prices, { isMember: false });
      if (!chosen) return res.status(409).json({ error: "The penalty fee has no usable price." });

      let chargeId;
      try {
        const ins = await pool.query(
          `INSERT INTO entry_charges
              (org_id, event_id, entrant_user_id, kind, fee_definition_id, amount_cents, triggered_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'owed')
           RETURNING id`,
          [orgId, eventId, body.entrant_user_id, body.kind, fee.id, chosen.amount_cents, req.user.id],
        );
        chargeId = ins.rows[0].id;
      } catch (e) {
        if (e.code === "23505") {
          return res.status(409).json({ error: "This entrant already owes a charge of this kind for this event." });
        }
        throw e;
      }
      return res.json({ id: chargeId, amount_cents: chosen.amount_cents });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] issue entry charge failed");
      return res.status(500).json({ error: "Failed to issue the charge." });
    }
  });

  // List an event's entry charges (admin view).
  router.get("/api/events/:id/entry-charges", requireEventManager(), async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT ec.id, ec.kind, ec.amount_cents, ec.status, ec.triggered_at,
                ec.entrant_user_id, u.full_name AS entrant_name,
                fd.currency
           FROM entry_charges ec
           JOIN users u ON u.id = ec.entrant_user_id
           LEFT JOIN fee_definitions fd ON fd.id = ec.fee_definition_id
          WHERE ec.event_id = $1
          ORDER BY ec.triggered_at DESC`,
        [req.params.id],
      )).rows;
      return res.json({ charges: rows, payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] list entry charges failed");
      return res.status(500).json({ error: "Failed to list charges." });
    }
  });

  // Waive an owed charge (admin). Gated by org role + same-org check.
  router.post("/api/entry-charges/:id/waive", requireOrgRole(["org_admin", "meet_manager"]), async (req, res) => {
    try {
      const charge = (await pool.query(
        "SELECT id, org_id, status, payment_id FROM entry_charges WHERE id = $1",
        [req.params.id],
      )).rows[0];
      if (!charge) return res.status(404).json({ error: "Charge not found" });
      if (!ownsOrg(req, charge.org_id)) return res.status(403).json({ error: "Forbidden" });
      if (charge.status !== "owed") {
        return res.status(409).json({ error: `Cannot waive a charge that is ${charge.status}.` });
      }
      // Kill any in-flight checkout for this charge BEFORE waiving — otherwise
      // the entrant could complete a still-valid Stripe session and pay a
      // debit that's been waived (money captured, charge says 'waived', no
      // refund). Expire the session + fail the pending payment. A payment
      // that's already 'paid' means the charge would be 'paid' (settled by
      // the webhook), so the status guard above already blocked it.
      if (charge.payment_id) {
        const p = (await pool.query(
          "SELECT id, status, stripe_checkout_session FROM payments WHERE id = $1",
          [charge.payment_id],
        )).rows[0];
        if (p && p.status === "paid") {
          return res.status(409).json({ error: "This charge has already been paid — refund it instead of waiving." });
        }
        if (p && p.status === "pending") {
          // Expire on the PLATFORM account (merchant of record).
          if (payments.enabled && p.stripe_checkout_session) {
            try {
              await payments.expireCheckoutSession({ sessionId: p.stripe_checkout_session });
            } catch (e) {
              logger.warn({ err: e.message }, "[payments] could not expire session on waive");
            }
          }
          const upd = await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'", [p.id]);
          if (upd.rowCount === 0) {
            // The payment left 'pending' between our read and the update — if
            // the webhook just settled it, don't waive a now-paid charge.
            const fresh = (await pool.query("SELECT status FROM payments WHERE id = $1", [p.id])).rows[0];
            if (fresh && fresh.status === "paid") {
              return res.status(409).json({ error: "A payment just completed for this charge — refund it instead of waiving." });
            }
          }
        }
      }
      await pool.query("UPDATE entry_charges SET status = 'waived' WHERE id = $1 AND status = 'owed'", [req.params.id]);
      return res.json({ status: "waived" });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] waive charge failed");
      return res.status(500).json({ error: "Failed to waive the charge." });
    }
  });

  // Diver-facing: the charges I currently owe (across all my events).
  router.get("/api/me/charges", verifyToken, async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT ec.id, ec.kind, ec.amount_cents, ec.status, ec.event_id,
                e.name AS event_name, fd.currency
           FROM entry_charges ec
           JOIN events e ON e.id = ec.event_id
           LEFT JOIN fee_definitions fd ON fd.id = ec.fee_definition_id
          WHERE ec.entrant_user_id = $1 AND ec.status = 'owed'
          ORDER BY ec.triggered_at DESC`,
        [req.user.id],
      )).rows;
      return res.json({ charges: rows, payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read my charges failed");
      return res.status(500).json({ error: "Failed to read your charges." });
    }
  });

  // A member's own payment history — every payment they made (club-paid
  // rows are excluded; those belong to club billing). Read-only; drives the
  // Payment History page + its CSV/PDF export. Returns raw fields so the SPA
  // localises the description/status client-side (fully i18n).
  router.get("/api/me/payments", verifyToken, async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT p.id, p.created_at, p.paid_at, p.subject_type, p.status,
                p.amount_cents, p.currency, p.payer_role_type,
                e.name  AS event_name,
                m.name  AS meet_name,
                f.reason AS fine_reason,
                fd.tier AS membership_tier,
                fd.name AS fee_name
           FROM payments p
           LEFT JOIN events e           ON e.id  = p.event_id
           LEFT JOIN meets  m           ON m.id  = p.meet_id
           LEFT JOIN fines  f           ON f.id  = p.fine_id
           LEFT JOIN fee_definitions fd ON fd.id = p.fee_definition_id
          WHERE p.payer_user_id = $1
            AND COALESCE(p.payer_type, 'user') <> 'club'
          ORDER BY p.created_at DESC
          LIMIT 500`,
        [req.user.id],
      )).rows;
      return res.json({ payments: rows, payments_enabled: payments.enabled });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] read my payments failed");
      return res.status(500).json({ error: "Failed to read your payment history." });
    }
  });

  // The entrant pays one of their owed charges.
  router.post("/api/entry-charges/:id/checkout", verifyToken, async (req, res) => {
    if (!ensurePayments(res)) return;
    try {
      const charge = (await pool.query("SELECT * FROM entry_charges WHERE id = $1", [req.params.id])).rows[0];
      if (!charge) return res.status(404).json({ error: "Charge not found" });
      if (charge.entrant_user_id !== req.user.id) return res.status(403).json({ error: "Forbidden" });
      if (charge.status !== "owed") return res.status(409).json({ error: `This charge is ${charge.status}.` });

      const org = (
        await pool.query(
          `SELECT id, name, default_currency, platform_fee_bps, stripe_account_id, stripe_charges_enabled
             FROM organisations WHERE id = $1`,
          [charge.org_id],
        )
      ).rows[0];
      const fee = (await pool.query("SELECT * FROM fee_definitions WHERE id = $1", [charge.fee_definition_id])).rows[0];
      if (!fee) return res.status(409).json({ error: "The penalty fee is no longer configured." });

      const { url, paymentId } = await startChargeCheckout({ req, org, charge, fee });
      return res.json({ url, payment_id: paymentId });
    } catch (err) {
      logger.error({ err: err.message }, "[payments] charge checkout failed");
      return res.status(err.status || 500).json({ error: err.message || "Checkout failed" });
    }
  });

  // ---- Refunds -----------------------------------------------------

  // Refund a payment on the platform account (DivingHQ is the merchant of
  // record). There's no Stripe fee reversal — the platform's cut lives in our
  // payout ledger, so a refund just reduces what the federation/club is owed
  // (the balance query prorates the retained fee on partial refunds). Omit
  // amount_cents for a full refund.
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
        const requested = req.body && Number(req.body.amount_cents) > 0 ? Math.floor(Number(req.body.amount_cents)) : undefined;

        const refund = await payments.createRefund({
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
        // A fully-refunded meet_bundle must un-grant the per-event entries it
        // expanded into (the amount-0 event_entry rows carrying the bundle's
        // fee_definition_id), so the diver stops counting as entered.
        if (status === "refunded" && p.subject_type === "meet_bundle") {
          await pool.query(
            `UPDATE payments SET status = 'refunded', refunded_at = now()
              WHERE payer_user_id = $1 AND fee_definition_id = $2
                AND subject_type = 'event_entry' AND amount_cents = 0 AND status = 'paid'`,
            [p.payer_user_id, p.fee_definition_id],
          );
        }
        // A fully-refunded fine goes back to 'owed' so it's still trackable.
        if (status === "refunded" && p.subject_type === "fine" && p.fine_id) {
          await pool.query(
            "UPDATE fines SET status = 'owed', payment_id = NULL WHERE id = $1 AND status = 'paid'",
            [p.fine_id],
          );
        }
        return res.json({ status, refunded_amount_cents: refunded });
      } catch (err) {
        logger.error({ err: err.message }, "[payments] refund failed");
        return res.status(err.status || 500).json({ error: err.message || "Refund failed" });
      }
    },
  );

  return router;
};
