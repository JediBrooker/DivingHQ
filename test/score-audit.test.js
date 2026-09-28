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

test("isValidScore: only a number or a numeric string, never something Number() turns into 0", () => {
  // Number(null), Number(''), Number(false) and Number([]) are all 0,
  // Number(true) is 1. A {score: null} used to zero a judge's award.
  for (const bad of [null, "", "  ", false, true, [], [7], {}, "7.5abc", "0x10", "1e1"]) {
    assert.equal(isValidScore(bad), false, JSON.stringify(bad));
  }
  assert.equal(scoreBodyError(null, "Score"), "Score must be between 0 and 10");
  assert.equal(scoreBodyError("", "score"), "score must be between 0 and 10");
  assert.equal(scoreBodyError(false, "proposed_score"), "proposed_score must be between 0 and 10");
  assert.equal(scoreBodyError(true, "Score"), "Score must be between 0 and 10");
  assert.equal(scoreBodyError(" 7.5 ", "Score"), null, "a padded numeric string is still a score");
});

test("isValidScore agrees with lib/middleware's copy", () => {
  // The socket path still validates through lib/middleware. Until that
  // one becomes a re-export, pin that the two can't drift apart.
  const mw = require("../lib/middleware")({
    pool: { query: async () => ({ rows: [] }) },
    JWT_SECRET: "x".repeat(40),
  });
  const samples = [-1, -0.5, 0, 0.25, 0.5, 1, 2.5, 6.75, 9.5, 10, 10.5, 11, NaN, Infinity, "7", "7.5", "x", null, "", false, true, []];
  for (const s of samples) assert.equal(isValidScore(s), mw.isValidScore(s), String(s));
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
