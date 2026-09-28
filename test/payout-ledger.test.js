// Unit tests for lib/payout-ledger's transfer error classification. A
// payout is only marked 'failed' (freeing the balance for a new payout,
// under a new idempotency key) when Stripe certainly didn't move the
// money. Anything else stays pending and is settled later under the same
// payout id. DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transferDefinitelyFailed } = require("../lib/payout-ledger");

const stripeErr = (type, statusCode) => Object.assign(new Error(type), { type, statusCode });

test("a refusal from Stripe is final", () => {
  assert.equal(transferDefinitelyFailed(stripeErr("StripeInvalidRequestError", 400)), true);
  assert.equal(transferDefinitelyFailed(stripeErr("StripePermissionError", 403)), true);
  assert.equal(transferDefinitelyFailed(stripeErr("StripeRateLimitError", 429)), true);
});

test("our own refusals before any request are final", () => {
  const disabled = Object.assign(new Error("off"), { status: 503, code: "payments_disabled" });
  const amount = Object.assign(new Error("not representable"), { status: 400 });
  assert.equal(transferDefinitelyFailed(disabled), true);
  assert.equal(transferDefinitelyFailed(amount), true);
});

test("anything that might have created the transfer is not", () => {
  assert.equal(transferDefinitelyFailed(stripeErr("StripeConnectionError")), false);
  assert.equal(transferDefinitelyFailed(stripeErr("StripeAPIError", 500)), false);
  assert.equal(transferDefinitelyFailed(stripeErr("StripeIdempotencyError", 400)), false);
  assert.equal(transferDefinitelyFailed(stripeErr("StripeInvalidRequestError", 409)), false);
  assert.equal(transferDefinitelyFailed(new Error("socket hang up")), false);
  assert.equal(transferDefinitelyFailed(null), false);
});
