// lib/auto-withdraw.js, executes the auto-withdraw preference.
//
// Migrations 076/078 store auto_withdraw_enabled/auto_withdraw_min_cents on
// organisations and clubs, and the payments/classes settings endpoints have
// let admins switch it on since PR #96, but until this sweeper existed
// NOTHING read those columns, so the UI was promising automatic payouts
// that never actually happened. Every sweep books a withdrawal (via
// lib/payout-ledger's locked, per-currency createWithdrawal) for each
// org/club that:
//   * has auto_withdraw_enabled,
//   * has payout bank details on file, and
//   * has at least one currency bucket >= auto_withdraw_min_cents.
// The operator is emailed exactly as for a manual withdrawal request,
// auto-withdraw only automates the ASKING part; the bank transfer is
// still made and settled by the platform operator.
//
// Concurrency-safe against manual withdrawals: createWithdrawal locks the
// recipient row FOR UPDATE and recomputes the balance inside the lock, so
// a sweep racing a manual request just finds nothing left to withdraw.
// start() mirrors lib/idempotency-sweeper (interval timer, unref'd).

const { createWithdrawal, executePayouts } = require("./payout-ledger");
const { recordAudit } = require("./audit");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const STARTUP_DELAY_MS = 30 * 1000;       // let the app finish booting first

// One pass over every auto-withdraw-enabled, payouts-ready org and club.
// Books each due balance and fires the real Stripe transfer immediately.
// Exported so tests can run it directly without timers, `payments` is
// the lib/stripe wrapper (required to execute transfers). Returns
// { payouts: n }.
async function sweepOnce({ pool, payments, logger = console, email = null }) {
  // The 'payments' flag can be flipped either way while this timer is already
  // ticking, so re-check per sweep instead of trusting whatever was true at
  // boot. With payments dark there's nothing to pay out, and the
  // withdrawal-settings endpoints go on saving the preference for later.
  // Explicit === false so a test's fake payments object (no `enabled` at all)
  // still sweeps, which is what every existing caller expects.
  if (payments && payments.enabled === false) return { payouts: 0 };

  let booked = 0;

  const run = async ({ id, orgId, minCents, key }) => {
    const idKey = key === "org" ? { orgId: id } : { clubId: id };
    const { payouts, accountId } = await createWithdrawal(pool, {
      ...idKey, note: "auto-withdrawal", minCents: minCents || 0, requireBalance: false,
    });
    if (!payouts.length) return;
    const settled = payments
      ? await executePayouts(pool, payments, payouts, accountId, { logger })
      : payouts;
    booked += payouts.length;
    recordAudit(pool, {
      org_id: orgId, entity_type: "payout", entity_id: payouts[0].id,
      action: "payout.auto_executed",
      metadata: {
        ...(key === "club" ? { club_id: id } : {}),
        payouts: settled.map((p) => ({ id: p.id, amount_cents: p.amount_cents, currency: p.currency, status: p.status })),
      },
    }).catch(() => {});
    email?.sendPayoutFailedEmail(key === "org" ? { orgId: id, payouts: settled } : { clubId: id, payouts: settled });
  };

  const orgs = (await pool.query(
    `SELECT id, auto_withdraw_min_cents FROM organisations
      WHERE auto_withdraw_enabled AND stripe_account_id IS NOT NULL AND stripe_payouts_enabled`,
  )).rows;
  for (const o of orgs) {
    try { await run({ id: o.id, orgId: o.id, minCents: o.auto_withdraw_min_cents, key: "org" }); }
    catch (err) { logger.warn?.({ err: err.message, org: o.id }, "[auto-withdraw] org sweep failed"); }
  }

  const clubs = (await pool.query(
    `SELECT id, org_id, auto_withdraw_min_cents FROM clubs
      WHERE auto_withdraw_enabled AND stripe_account_id IS NOT NULL AND stripe_payouts_enabled`,
  )).rows;
  for (const c of clubs) {
    try { await run({ id: c.id, orgId: c.org_id, minCents: c.auto_withdraw_min_cents, key: "club" }); }
    catch (err) { logger.warn?.({ err: err.message, club: c.id }, "[auto-withdraw] club sweep failed"); }
  }

  return { payouts: booked };
}

// Kick off the recurring sweep. Call this whenever Stripe is CONFIGURED,
// even if the payments flag is currently off: sweepOnce re-reads the flag
// each pass, so a toggle from the admin screen starts paying out on the
// next tick rather than the next restart.
function start({ pool, payments, logger = console, email = null }) {
  const run = () =>
    sweepOnce({ pool, payments, logger, email })
      .then(({ payouts }) => {
        if (payouts) logger.info?.({ payouts }, "[auto-withdraw] sweep booked payouts");
      })
      .catch((err) => logger.warn?.({ err: err.message }, "[auto-withdraw] sweep failed"));
  const first = setTimeout(run, STARTUP_DELAY_MS);
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { start, sweepOnce, SWEEP_INTERVAL_MS };
