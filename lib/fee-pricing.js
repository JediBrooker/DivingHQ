// lib/fee-pricing.js: pure fee math + price-variant resolution.
//
// No DB, no Stripe, just the rules that turn a fee_definition's price
// variants (fee_prices rows) into the single amount a given payer pays
// right now, and split that amount into the charge total + DivingHQ's
// application fee. Kept pure so it's unit-testable in isolation and so
// the same rules drive both the "what will this cost me?" read
// endpoints and the checkout path (one source of truth for the money).

// Pick the price a payer actually pays from a fee's variants.
//
//   prices:   fee_prices rows for one fee_definition
//   isMember: is the payer an active member of the org?
//   now:      Date (or ISO string) to evaluate time windows against
//
// A variant applies when BOTH hold:
//   * audience matches: 'all', or 'member'/'non_member' matching the
//     payer's membership, AND
//   * now is within [starts_at, ends_at] (a NULL bound is open-ended).
// Among applicable variants the CHEAPEST wins, so a member who also
// catches the early-bird window gets the best of both. Returns null
// when nothing applies (e.g. every window has closed), so the caller
// treats that as "not purchasable right now".
function resolvePrice(prices, { isMember = false, now = new Date() } = {}) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const applicable = (prices || []).filter((p) => {
    const audienceOk =
      p.audience === "all" ||
      (p.audience === "member" && isMember) ||
      (p.audience === "non_member" && !isMember);
    if (!audienceOk) return false;
    if (p.starts_at && t < new Date(p.starts_at).getTime()) return false;
    if (p.ends_at && t > new Date(p.ends_at).getTime()) return false;
    return true;
  });
  if (!applicable.length) return null;
  return applicable.reduce((lo, p) => (p.amount_cents < lo.amount_cents ? p : lo));
}

// DivingHQ's cut, in minor units, rounded to the nearest unit.
function platformFee(amountCents, feeBps) {
  return Math.round((Number(amountCents) * Number(feeBps)) / 10000);
}

// Turn a base (tax-inclusive) price into what the payer is charged and
// the application_fee_amount we attach to the direct charge.
//
//   feePayer 'absorb'        → payer pays the base; the platform fee is
//                              skimmed out of it (federation nets
//                              base − appFee − Stripe's processing fee).
//   feePayer 'pass_to_payer' → the DivingHQ fee is added on top, so the
//                              federation nets ~base (still minus
//                              Stripe's own processing fee, which under
//                              direct charges always falls on the
//                              merchant of record, the federation).
function priceCharge({ baseAmountCents, feeBps, feePayer = "absorb" }) {
  const appFee = platformFee(baseAmountCents, feeBps);
  const chargeAmountCents =
    feePayer === "pass_to_payer" ? baseAmountCents + appFee : baseAmountCents;
  return { chargeAmountCents, applicationFeeCents: appFee };
}

module.exports = { resolvePrice, platformFee, priceCharge };
