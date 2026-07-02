// lib/payout-ledger.js — who is owed what, and how a withdrawal is booked.
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
// withdrawal books a 'pending' payouts row per currency; the actual bank
// transfer is settled out-of-band by the platform operator, who marks
// the row paid/failed via the sysadmin endpoints in routes/payments.js.

// Net owed PER CURRENCY: collected (fee prorated on partial refunds,
// clamped >= 0) minus everything already withdrawn (pending + paid
// payouts). Grouped by currency so money is never summed across
// currencies or paid out in the wrong one. Runs on `db` so it can share
// a transaction / row-lock with a withdrawal insert.
async function balancesByCurrency(db, { orgId = null, clubId = null }) {
  if (!orgId === !clubId) throw new Error("balancesByCurrency needs exactly one of orgId / clubId");
  // recipient_type keeps the two ledgers disjoint: class-enrolment money
  // (recipient 'club') must never count into the federation's balance, and
  // club_affiliation/accreditation money — which carries the club's id as
  // the SUBJECT being charged — must never count into the club's.
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
//   pool        — pg Pool (a fresh client/transaction is taken here)
//   orgId|clubId— exactly one; who is withdrawing
//   note        — free text stored on the payout rows
//   minCents    — only book buckets of at least this size (auto-withdraw
//                 threshold; 0 = everything, the manual behaviour)
//   requireBalance — manual endpoints want a 409 when there's nothing to
//                 withdraw; the auto sweeper treats it as a quiet no-op
//
// Returns the inserted payout rows ([] only when requireBalance=false).
// Throws err.status 409 with a payer-readable message when details are
// missing or (requireBalance) no balance qualifies.
async function createWithdrawal(pool, { orgId = null, clubId = null, note = null, minCents = 0, requireBalance = true }) {
  if (!orgId === !clubId) throw new Error("createWithdrawal needs exactly one of orgId / clubId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = (await client.query(
      orgId
        ? "SELECT payout_account_name, payout_account_details FROM organisations WHERE id = $1 FOR UPDATE"
        : "SELECT payout_account_name, payout_account_details FROM clubs WHERE id = $1 FOR UPDATE",
      [orgId || clubId],
    )).rows[0];
    if (!owner) {
      const err = new Error(orgId ? "Organisation not found" : "Club not found");
      err.status = 404;
      throw err;
    }
    if (!owner.payout_account_name || !owner.payout_account_details) {
      const err = new Error("Add your payout bank details before withdrawing.");
      err.status = 409;
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
      return [];
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
    return payouts;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { balancesByCurrency, orgBalancesByCurrency, clubBalancesByCurrency, createWithdrawal };
