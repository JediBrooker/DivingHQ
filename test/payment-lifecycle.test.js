// lib/payment-lifecycle.js retireBlocked: the HTTP answer payments.js and
// classes.js give when a cancel / waive / edit runs into a checkout that's
// still in flight. Pure, no DB. The 503 wording is what the SPA shows, so
// it's pinned exactly.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retireBlocked } = require("../lib/payment-lifecycle");

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test("'paid' sends the caller's 409 and stops the handler", () => {
  const res = fakeRes();
  assert.equal(retireBlocked(res, "paid", "This fine has already been paid."), true);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: "This fine has already been paid." });
});

test("'unavailable' is a 503 asking to try again", () => {
  const res = fakeRes();
  assert.equal(retireBlocked(res, "unavailable", "unused"), true);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "Couldn't verify the in-flight payment with Stripe — please try again." });
});

test("'retired' and 'gone' let the change go ahead without responding", () => {
  for (const outcome of ["retired", "gone"]) {
    const res = fakeRes();
    assert.equal(retireBlocked(res, outcome, "unused"), false);
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  }
});
