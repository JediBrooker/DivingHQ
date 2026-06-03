// Unit tests for lib/deadline-gate.js — pure verdict function.
//
// Covers the four-corner cases of (actor before/after deadline) ×
// (server before/after deadline), plus the legacy-no-actor-clock,
// missing-deadline, and future-dated-claim fallbacks.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { evaluateDeadline } = require("../lib/deadline-gate");

// Reference times — all aligned so the math is obvious in failures.
const DEADLINE = new Date("2026-05-22T14:00:00Z");
const BEFORE   = new Date("2026-05-22T13:50:00Z");  // 10 min before
const AFTER    = new Date("2026-05-22T14:10:00Z");  // 10 min after

test("ok: actor + server both before deadline", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: BEFORE,
    serverNow: BEFORE,
  });
  assert.equal(r.verdict, "ok");
});

test("late_review: actor before, server after", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: BEFORE,
    serverNow: AFTER,
  });
  assert.equal(r.verdict, "late_review");
  assert.equal(r.reason, "arrived_after_deadline");
});

test("rejected: actor after deadline (also server, trivially)", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: AFTER,
    serverNow: AFTER,
  });
  assert.equal(r.verdict, "rejected");
  assert.equal(r.reason, "deadline_passed");
});

test("ok: actor exactly at deadline (<=, not <)", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: DEADLINE,
    serverNow: DEADLINE,
  });
  assert.equal(r.verdict, "ok");
});

test("rejected: future-dated claim (>60s ahead of server)", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: new Date(AFTER.getTime() + 120_000),  // 2 min ahead of server
    serverNow: BEFORE,
  });
  assert.equal(r.verdict, "rejected");
  assert.equal(r.reason, "future_dated");
});

test("ok: small clock drift within 60s tolerance", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: new Date(BEFORE.getTime() + 30_000),  // 30s ahead of server, still before deadline
    serverNow: BEFORE,
  });
  assert.equal(r.verdict, "ok");
});

test("legacy: no actor clock + server before deadline → ok", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: null,
    serverNow: BEFORE,
  });
  assert.equal(r.verdict, "ok");
});

test("legacy: no actor clock + server after deadline → rejected", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: null,
    serverNow: AFTER,
  });
  assert.equal(r.verdict, "rejected");
});

test("garbage actor clock falls back to server-only check", () => {
  const r1 = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: "not-a-date",
    serverNow: BEFORE,
  });
  assert.equal(r1.verdict, "ok");

  const r2 = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: "not-a-date",
    serverNow: AFTER,
  });
  assert.equal(r2.verdict, "rejected");
});

test("missing deadline → ok regardless of times", () => {
  const r = evaluateDeadline({
    deadline: null,
    actorLocalTime: AFTER,
    serverNow: AFTER,
  });
  assert.equal(r.verdict, "ok");
});

test("malformed deadline string → ok (fail open)", () => {
  // The strict gate above the deadline check (loadEventForEntries)
  // would have rejected if the event was malformed; here we just
  // don't add a second rejection path.
  const r = evaluateDeadline({
    deadline: "not-a-date",
    actorLocalTime: BEFORE,
    serverNow: AFTER,
  });
  assert.equal(r.verdict, "ok");
});

test("accepts ISO string timestamps for both clocks", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE.toISOString(),
    actorLocalTime: BEFORE.toISOString(),
    serverNow: AFTER,  // Date — caller controls
  });
  assert.equal(r.verdict, "late_review");
});

test("rejected: on-time actor claim but server is past the late-review window", () => {
  // Client claims it submitted 10 min before the deadline, but the
  // request only lands 2 days later — beyond the default 24h window,
  // so the "I was on time" claim is no longer credible.
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: BEFORE,
    serverNow: new Date(DEADLINE.getTime() + 48 * 60 * 60 * 1000),
  });
  assert.equal(r.verdict, "rejected");
  assert.equal(r.reason, "late_review_window_expired");
});

test("late_review still granted just inside the window", () => {
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: BEFORE,
    serverNow: new Date(DEADLINE.getTime() + 23 * 60 * 60 * 1000),  // 23h < 24h default
  });
  assert.equal(r.verdict, "late_review");
});

test("maxLateReviewMs is configurable", () => {
  // A tight 5-min window rejects a server that's 10 min past the
  // deadline even with an on-time actor claim.
  const r = evaluateDeadline({
    deadline: DEADLINE,
    actorLocalTime: BEFORE,
    serverNow: AFTER,  // 10 min past deadline
    maxLateReviewMs: 5 * 60 * 1000,
  });
  assert.equal(r.verdict, "rejected");
  assert.equal(r.reason, "late_review_window_expired");
});
