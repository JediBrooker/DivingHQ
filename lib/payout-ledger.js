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
// withdrawal books a 'pending' payouts row per currency, then
// executePayouts sends each one as a Stripe Connect transfer to the
// recipient's connected account: success settles the row 'paid', a
// definite refusal from Stripe marks it 'failed' and the balance comes
// back, and anything less certain leaves it 'pending' for
// retryPendingPayouts. There's no manual operator step any more;
// /api/admin/payouts is a read-only monitor.

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
  // The two ledgers only differ in which id column they key on and which
  // recipient_type they count. Both come from this fixed pair, picked by
  // the guard above, so nothing a caller passes is ever spliced into SQL.
  const { col, recipient } = orgId
    ? { col: "org_id", recipient: "org" }
    : { col: "club_id", recipient: "club" };
  const collectedSql = `SELECT currency, COALESCE(SUM(GREATEST(0,
          CASE status
            WHEN 'paid' THEN amount_cents - platform_fee_cents
            WHEN 'partially_refunded' THEN ROUND(
              (amount_cents - platform_fee_cents)::numeric
                * (amount_cents - COALESCE(refunded_amount_cents, 0)) / NULLIF(amount_cents, 0))
            ELSE 0 END)), 0)::bigint AS net
         FROM payments WHERE ${col} = $1 AND recipient_type = '${recipient}' GROUP BY currency`;
  const withdrawnSql = `SELECT currency, COALESCE(SUM(amount_cents), 0)::bigint AS n
         FROM payouts WHERE ${col} = $1 AND status IN ('pending', 'paid') GROUP BY currency`;
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

// Did this transfer attempt certainly not move any money? True when
// Stripe answered and refused (a 4xx, apart from an idempotency clash,
// which means a request under this key may already have gone through),
// or when our own code refused before any request went out (payments
// switched off, an amount the currency can't represent: those carry a
// `status` but no Stripe `type`). A timeout, a dropped connection, a
// 5xx or an error we can't place might have created the transfer.
function transferDefinitelyFailed(err) {
  if (!err) return false;
  if (!err.type && Number(err.status) >= 400 && Number(err.status) < 600) return true;
  if (err.type === "StripeIdempotencyError") return false;
  const sc = Number(err.statusCode);
  return sc >= 400 && sc < 500 && sc !== 409;
}

// Fire the real Stripe transfer for each booked payout and settle it. The
// payout id is the idempotency key (and the transfer_group, so
// retryPendingPayouts can find a transfer that did go through).
//
// Success → 'paid' + stripe_transfer_id. A definite refusal → 'failed',
// and the balance auto-restores since only pending/paid payouts count
// against it. Anything uncertain stays 'pending': still counted against
// the balance, retried later under the same id. Marking those 'failed'
// used to free the money, the next withdrawal booked a new payout (a new
// idempotency key) and a transfer that had in fact gone through was sent
// a second time.
//
// The DB update after a successful transfer sits outside the catch for
// the same reason: that transfer exists whatever the database says, so a
// failed write leaves the row pending for the sweeper, never 'failed'.
//
// Never throws, just returns the settled rows (status 'pending' with an
// `error` for the uncertain ones) so the caller can report per currency.
async function executePayouts(pool, payments, payouts, accountId, { logger = console, description = null } = {}) {
  const settled = [];
  for (const p of payouts) {
    let transfer;
    try {
      transfer = await payments.createTransfer({
        accountId,
        amountCents: p.amount_cents,
        currency: p.currency,
        idempotencyKey: p.id,
        description: description || p.note || "DivingHQ payout",
      });
    } catch (err) {
      if (transferDefinitelyFailed(err)) {
        logger.error?.({ err: err.message, payout: p.id }, "[payout] transfer refused — marking payout failed (balance restored)");
        await pool.query(
          "UPDATE payouts SET status = 'failed' WHERE id = $1 AND status = 'pending'",
          [p.id],
        ).catch(() => {});
        settled.push({ ...p, status: "failed", error: err.message });
      } else {
        logger.error?.({ err: err.message, payout: p.id }, "[payout] transfer outcome unknown — left pending for the retry sweep");
        settled.push({ ...p, status: "pending", error: err.message });
      }
      continue;
    }
    settled.push(await markPayoutPaid(pool, p, transfer.id, logger));
  }
  return settled;
}

// Settle a payout whose transfer exists. Returns the row as it now stands;
// a failed write is logged and the row stays pending (see executePayouts).
async function markPayoutPaid(pool, p, transferId, logger = console) {
  try {
    const r = await pool.query(
      `UPDATE payouts SET status = 'paid', paid_at = now(), stripe_transfer_id = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING id, amount_cents, currency, status, note, created_at, paid_at, stripe_transfer_id`,
      [p.id, transferId],
    );
    return r.rows[0] || { ...p, status: "paid", stripe_transfer_id: transferId };
  } catch (err) {
    logger.error?.({ err: err.message, payout: p.id, transfer: transferId },
      "[payout] transfer sent but the payout row wasn't updated — left pending for the retry sweep");
    return { ...p, status: "pending", error: err.message };
  }
}

// Settle payouts stuck in 'pending': an uncertain transfer error, a failed
// write after a successful transfer, or a process that died between
// booking and sending. Only rows older than `minAgeMinutes` are touched,
// so a withdrawal that's in flight right now is left alone.
//
// For each one we first ask Stripe whether a transfer with this payout's
// group exists (payments.findTransfer) and settle from that. Only when
// Stripe says there's none do we send it again, under the same payout id
// as the idempotency key. If the lookup itself fails the row waits for the
// next sweep. Returns the rows it settled, in executePayouts' shape.
async function retryPendingPayouts({ pool, payments, logger = console, minAgeMinutes = 15, limit = 50 }) {
  const rows = (await pool.query(
    `SELECT p.id, p.amount_cents, p.currency, p.note, p.created_at, p.org_id, p.club_id,
            COALESCE(o.stripe_account_id, c.stripe_account_id) AS account_id
       FROM payouts p
       LEFT JOIN organisations o ON o.id = p.org_id
       LEFT JOIN clubs c ON c.id = p.club_id
      WHERE p.status = 'pending'
        AND p.created_at < now() - make_interval(mins => $1)
      ORDER BY p.created_at
      LIMIT $2`,
    [minAgeMinutes, limit],
  )).rows;
  const settled = [];
  for (const row of rows) {
    const { account_id: accountId, org_id: orgId, club_id: clubId, ...p } = row;
    if (!accountId) continue;
    if (typeof payments.findTransfer === "function") {
      let found;
      try {
        found = await payments.findTransfer({ payoutId: p.id, accountId });
      } catch (err) {
        logger.warn?.({ err: err.message, payout: p.id }, "[payout] couldn't look up the transfer, will try again next sweep");
        continue;
      }
      if (found) {
        settled.push({ ...(await markPayoutPaid(pool, p, found.id, logger)), org_id: orgId, club_id: clubId });
        continue;
      }
    }
    const [out] = await executePayouts(pool, payments, [p], accountId, { logger });
    settled.push({ ...out, org_id: orgId, club_id: clubId });
  }
  return settled;
}

module.exports = {
  balancesByCurrency, orgBalancesByCurrency, clubBalancesByCurrency,
  createWithdrawal, executePayouts, retryPendingPayouts, transferDefinitelyFailed,
};
