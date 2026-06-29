// Unit tests for lib/fee-pricing.js — pure price/fee math.
//
// Covers the 15% split (absorb vs pass_to_payer) and price-variant
// resolution across the member/non-member × time-window matrix.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolvePrice, platformFee, priceCharge } = require("../lib/fee-pricing");

const NOW = new Date("2026-07-01T12:00:00Z");

test("platformFee: 15% of £50.00 is £7.50", () => {
  assert.equal(platformFee(5000, 1500), 750);
});

test("platformFee rounds to the nearest minor unit", () => {
  assert.equal(platformFee(333, 1500), 50); // 49.95 → 50
});

test("priceCharge absorb: payer pays the base, fee skimmed out", () => {
  assert.deepEqual(
    priceCharge({ baseAmountCents: 5000, feeBps: 1500, feePayer: "absorb" }),
    { chargeAmountCents: 5000, applicationFeeCents: 750 },
  );
});

test("priceCharge pass_to_payer: the DivingHQ fee is added on top", () => {
  assert.deepEqual(
    priceCharge({ baseAmountCents: 5000, feeBps: 1500, feePayer: "pass_to_payer" }),
    { chargeAmountCents: 5750, applicationFeeCents: 750 },
  );
});

const PRICES = [
  { label: "standard", amount_cents: 5000, audience: "all" },
  { label: "early_bird", amount_cents: 4000, audience: "all", ends_at: "2026-08-01T00:00:00Z" },
  { label: "member", amount_cents: 3500, audience: "member" },
];

test("resolvePrice: a member in the early-bird window gets the cheapest applicable", () => {
  assert.equal(resolvePrice(PRICES, { isMember: true, now: NOW }).label, "member");
});

test("resolvePrice: a non-member is excluded from the member tier", () => {
  assert.equal(resolvePrice(PRICES, { isMember: false, now: NOW }).label, "early_bird");
});

test("resolvePrice: a closed window yields null", () => {
  const closed = [{ label: "x", amount_cents: 100, audience: "all", ends_at: "2026-06-01T00:00:00Z" }];
  assert.equal(resolvePrice(closed, { isMember: false, now: NOW }), null);
});

test("resolvePrice: a not-yet-open window yields null", () => {
  const future = [{ label: "x", amount_cents: 100, audience: "all", starts_at: "2026-09-01T00:00:00Z" }];
  assert.equal(resolvePrice(future, { isMember: false, now: NOW }), null);
});

test("resolvePrice: empty/undefined price list yields null", () => {
  assert.equal(resolvePrice([], { now: NOW }), null);
  assert.equal(resolvePrice(undefined, { now: NOW }), null);
});
