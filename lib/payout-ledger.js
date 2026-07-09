// lib/payout-ledger.js: who is owed what, and how a withdrawal is booked.
//
// One home for the payout-ledger math that was previously duplicated
// between routes/payments.js (federation) and routes/classes.js (club),
// so the manual withdrawal endpoints and the auto-withdraw sweeper
// (lib/auto-withdraw.js) can never drift apart on the money rules.
//
// The model (migration 075/078): the PLATFORM collects every charge on
// its own Stripe account; payments.recipient_type says whether the net
// (amount - platform fee, refunds prorated) is owed to the federation
// ('org') or, for class enrolments only, to the club ('club'). A
// withdrawal books a 'pending' payouts row per currency, the actual
// bank transfer gets settled out-of-band by the platform operator, who
// marks the row paid/failed via the sysadmin endpoints in
// routes/payments.js.

// Net owed PER CURRENCY: collected (fee prorated on partial refunds,
// clamped >= 0) minus everything already withdrawn (pending + paid
// payouts). Grouped by currency so money is never summed across
// currencies or paid out in the wrong one. Runs on `db` so it can share
// a transaction / row-lock with withdrawal insert.
async function balancesByCurrency(db, { orgId = null, clubId = null }) {
  if (!orgId === !clubId) throw new Error("balancesByCurrency needs exactly one of orgId / clubId");
  // recipient_type keeps the two ledgers disjoint: class-enrolment money
  // (recipient 'club') must never count into the federation's balance, and
  // club_affiliation/accreditation money (which carries the club's id as
  // the SUBJECT being charged) must never count into the club's.
  const collectedSql = orgId
    ? `SELECT currency, COALESCE(SUM(GREATEST(0,
          CASE status
            WHEN 'paid' THEN amount_cents - platform_fee_cents
            WHEN 'partially_refunded' THEN ROUND(
              (amount_cents - platform_fee_cents)::numeric
                * (amount_cents - COALESCE(refunded_amount_cents, 0)) / NULLIF(amount_cents, 0))
            ELSE 0 END)), 0)::bigint AS net
         FROM payments WHERE org_id = $1 AND recipient_type = 'org' GROUP BY currency`
    : `SELECT currency, COALESCE(SUM(GREATEST(0,
          CASE status
            WHEN 'paid' THEN amount_cents - platform_fee_cents
            WHEN 'partially_refunded' THEN ROUND(
              (amount_cents - platform_fee_cents)::numeric
                * (amount_cents - COALESCE(refunded_amount_cents, 0)) / NULLIF(amount_cents, 0))
            ELSE 0 END)), 0)::bigint AS net
         FROM payments WHERE club_id = $1 AND recipient_type = 'club' GROUP BY currency`;
  const withdrawnSql = orgId
    ? `SELECT currency, COALESCE(SUM(amount_cents), 0)::bigint AS n
         FROM payouts WHERE org_id = $1 AND status IN ('pending', 'paid') GROUP BY currency`
    : `SELECT currency, COALESCE(SUM(amount_cents), 0)::bigint AS n
         FROM payouts WHERE club_id = $1 AND status IN ('pending', 'paid') GROUP BY currency`;
  const id = orgId || clubId;
  const collected = (await db.query(collectedSql, [id])).rows;
  const withdrawn = (await db.query(withdrawnSql, [id])).rows;
  const withdrawnByCur = new Map(withdrawn.map((r) => [r.currency, Number(r.n)]));
  return collected
    .map((r) => ({ currency: r.currency, cents: Number(r.net) - (withdrawnByCur.get(r.currency) || 0) }))
    .filter((b) => b.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

const orgBalancesByCurrency = (orgId, db) => balancesByCurrency(db, { orgId });
const clubBalancesByCurrency = (clubId, db) => balancesByCurrency(db, { clubId });

// Book a withdrawal for a federation or club: lock the recipient row so
// two concurrent requests (manual or auto) can't both read the same
// balance and over-withdraw, recompute the balance inside the lock, and
// insert one 'pending' payout PER CURRENCY.
//
//   pool        : pg Pool (a fresh client/transaction is taken here)
//   orgId|clubId: exactly one; who is withdrawing
//   note        : free text stored on the payout rows
//   minCents    : only book buckets of at least this size (auto-withdraw
//                 threshold; 0 = everything, the manual behaviour)
//   requireBalance: manual endpoints want a 409 when there's nothing to
//                 withdraw; the auto sweeper treats it as a quiet no-op
//
// Returns the inserted payout rows ([] only when requireBalance=false).
// Throws err.status 409 with a payer-readable message when details are
// missing or (requireBalance) no balance qualifies.
// Books the pending payout rows under a row lock, then COMMITs. The actual
// Stripe transfer runs OUTSIDE the lock (executePayouts) so a network
// round-trip never holds a DB lock. Returns { payouts, accountId }, the
// caller passes accountId straight into executePayouts.
async function createWithdrawal(pool, { orgId = null, clubId = null, note = null, minCents = 0, requireBalance = true }) {
  if (!orgId === !clubId) throw new Error("createWithdrawal needs exactly one of orgId / clubId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = (await client.query(
      orgId
        ? "SELECT stripe_account_id, stripe_payouts_enabled FROM organisations WHERE id = $1 FOR UPDATE"
        : "SELECT stripe_account_id, stripe_payouts_enabled FROM clubs WHERE id = $1 FOR UPDATE",
      [orgId || clubId],
    )).rows[0];
    if (!owner) {
      const err = new Error(orgId ? "Organisation not found" : "Club not found");
      err.status = 404;
      throw err;
    }
    // Gate on Connect readiness. The Stripe transfer itself is the final
    // authority (it rejects a not-active account), so this is just UX
    // gating, don't book a payout that can't be sent.
    if (!owner.stripe_account_id || !owner.stripe_payouts_enabled) {
      const err = new Error("Set up your payouts with Stripe before withdrawing.");
      err.status = 409;
      err.code = "payouts_not_set_up";
      throw err;
    }
    const balances = (await balancesByCurrency(client, { orgId, clubId }))
      .filter((b) => b.cents >= (minCents || 0));
    if (!balances.length) {
      if (requireBalance) {
        const err = new Error("You have no balance to withdraw.");
        err.status = 409;
        throw err;
      }
      await client.query("ROLLBACK");
      return { payouts: [], accountId: owner.stripe_account_id };
    }
    const payouts = [];
    for (const b of balances) {
      const row = (await client.query(
        `INSERT INTO payouts (org_id, club_id, amount_cents, currency, status, note)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, amount_cents, currency, status, note, created_at, paid_at`,
        [orgId, clubId, b.cents, b.currency, note],
      )).rows[0];
      payouts.push(row);
    }
    await client.query("COMMIT");
    return { payouts, accountId: owner.stripe_account_id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Fire the real Stripe transfer for each booked payout and settle it. The
// payout id is the idempotency key, so a retried withdrawal never
// double-transfers. Success → 'paid' + stripe_transfer_id; any Stripe error
// → 'failed' (the balance auto-restores, since only pending/paid payouts
// count against it). Never throws, just returns the settled rows so the
// caller can report per-currency outcomes.
async function executePayouts(pool, payments, payouts, accountId, { logger = console, description = null } = {}) {
  const settled = [];
  for (const p of payouts) {
    try {
      const transfer = await payments.createTransfer({
        accountId,
        amountCents: p.amount_cents,
        currency: p.currency,
        idempotencyKey: p.id,
        description: description || p.note || "DivingHQ payout",
      });
      const r = await pool.query(
        `UPDATE payouts SET status = 'paid', paid_at = now(), stripe_transfer_id = $2
          WHERE id = $1 AND status = 'pending'
          RETURNING id, amount_cents, currency, status, note, created_at, paid_at, stripe_transfer_id`,
        [p.id, transfer.id],
      );
      settled.push(r.rows[0] || { ...p, status: "paid", stripe_transfer_id: transfer.id });
    } catch (err) {
      logger.error?.({ err: err.message, payout: p.id }, "[payout] transfer failed — marking payout failed (balance restored)");
      await pool.query(
        "UPDATE payouts SET status = 'failed' WHERE id = $1 AND status = 'pending'",
        [p.id],
      ).catch(() => {});
      settled.push({ ...p, status: "failed", error: err.message });
    }
  }
  return settled;
}

module.exports = {
  balancesByCurrency, orgBalancesByCurrency, clubBalancesByCurrency,
  createWithdrawal, executePayouts,
};
