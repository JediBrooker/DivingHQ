// lib/score-audit.js: the score rule and the audit-row writer every
// score-writing path shares. DB-free.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isValidScore, scoreBodyError, insertScoreAudit } = require("../lib/score-audit");

test("isValidScore: 0 to 10 in half points", () => {
  for (const ok of [0, 0.5, 5, 7.5, 10, "8.5", "0"]) assert.equal(isValidScore(ok), true, String(ok));
  for (const bad of [-0.5, 10.5, 7.25, 3.3, NaN, Infinity, -Infinity, "seven", undefined]) {
    assert.equal(isValidScore(bad), false, String(bad));
  }
});

test("isValidScore: null, blanks, booleans and arrays aren't a 0", () => {
  // Number() turns every one of these into 0, a valid mark. Stored as
  // such, a judge's missing score read as a 0.0 on the scoreboard.
  for (const bad of [null, "", "   ", false, true, [], [7], {}]) {
    assert.equal(isValidScore(bad), false, JSON.stringify(bad));
    assert.equal(scoreBodyError(bad, "score"), "score must be between 0 and 10", JSON.stringify(bad));
  }
});

test("isValidScore is the one lib/middleware hands the socket path", () => {
  // The socket path validates through lib/middleware, the HTTP routes
  // through here. Same function, so the two can't drift apart.
  const mw = require("../lib/middleware")({
    pool: { query: async () => ({ rows: [] }) },
    JWT_SECRET: "x".repeat(40),
  });
  assert.equal(mw.isValidScore, isValidScore);
});

test("scoreBodyError: each route's own wording", () => {
  assert.equal(scoreBodyError(7.5, "score"), null);
  assert.equal(scoreBodyError("10", "Score"), null);
  assert.equal(scoreBodyError(11, "score"), "score must be between 0 and 10");
  assert.equal(scoreBodyError(-1, "Score"), "Score must be between 0 and 10");
  assert.equal(scoreBodyError(undefined, "proposed_score"), "proposed_score must be between 0 and 10");
  assert.equal(scoreBodyError(Infinity, "Score"), "Score must be between 0 and 10");
  assert.equal(scoreBodyError(7.3, "proposed_score"), "proposed_score must be in 0.5 increments");
});

test("insertScoreAudit: one row, unset fields NULL, committed stamp only on request", async () => {
  const calls = [];
  const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await insertScoreAudit(db, {
    scoreId: "s", eventId: "e", competitorId: "c", judgeId: "j", round: 2,
    action: "update", oldScore: 6, newScore: 7, actorId: "a", ip: "127.0.0.1", userAgent: "ua",
  });
  await insertScoreAudit(db, {
    scoreId: "s", eventId: "e", competitorId: "c", judgeId: "j", round: 2,
    action: "insert", newScore: 7, reason: "why", actorLocalTime: "2026-09-28T10:00:00Z", committedNow: true,
  });
  assert.match(calls[0].sql, /INSERT INTO score_audit_log/);
  assert.match(calls[0].sql, /CASE WHEN \$14::boolean THEN now\(\) END/);
  assert.deepEqual(calls[0].params,
    ["s", "e", "c", "j", 2, "update", 6, 7, "a", "127.0.0.1", "ua", null, null, false]);
  assert.deepEqual(calls[1].params,
    ["s", "e", "c", "j", 2, "insert", null, 7, null, null, null, "why", "2026-09-28T10:00:00Z", true]);
});
