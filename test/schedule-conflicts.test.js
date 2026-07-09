// Unit coverage for lib/schedule-conflicts.js
//
// SCOPE
// -----
// The detector itself is a single (large) SQL query, the actual
// "two blocks overlap on a shared resource" logic lives in Postgres
// CTEs. What we can pin without a real DB is the JS surface:
//   * fingerprint(ids): pure, sha256-of-sorted-csv. Drives the
//     dismissal-resurfacing scheme: same membership → same hash,
//     ANY membership change → fresh hash and the dismissal stops
//     hiding the conflict.
//   * detectConflicts(meetId, client): input guards, the SQL
//     parameters (meet_id + soft-window minutes), and the row-shape
//     mapping that the /api/meets/:meetId/conflicts route hands to
//     the timeline drawer. We fake the pool to return canned rows
//     in the same shape the detector SQL emits and assert the
//     mapped Conflict objects.
//   * computeResourceFingerprint(client, …): the server-side
//     fingerprint the dismissal route uses so the client can't
//     spoof a stale fingerprint. Dispatches per resource_kind to
//     resourceIdsForPair() and hashes the result.
//
// What we CAN'T pin from JS-only:
//   * the detector SQL's own overlap math, the four UNION ALL arms,
//     the soft-vs-hard severity CASE, since those get exercised by the
//     integration suite (which needs Postgres) and by the the SQL
//     itself. The tests below assert that GIVEN the documented row
//     shape, the JS half does the right thing, which is the
//     contract the route code in routes/sessions.js depends on.
//
// Production paths exercised:
//   GET  /api/meets/:meetId/conflicts        → detectConflicts()
//   POST /api/conflicts/dismiss              → computeResourceFingerprint()
//   internal conflictsTouchingBlock helper   → detectConflicts() result shape

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  detectConflicts,
  computeResourceFingerprint,
  fingerprint,
  SOFT_JUDGE_GAP_MINUTES,
} = require("../lib/schedule-conflicts");

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// Independent reference implementation of the fingerprint so the
// stability tests aren't tautological. If both the production code
// AND this helper change at the same time we'll notice.
function refFingerprint(ids) {
  const sorted = [...ids].sort();
  return crypto.createHash("sha256").update(sorted.join(",")).digest("hex");
}

// Build the wide row shape that DETECTOR_SQL emits. Every column
// the JS mapper reads has a defined value so we catch any column
// the mapper drops or renames.
function detectorRow(overrides = {}) {
  return {
    a_id: "block-a",
    b_id: "block-b",
    resource_kind: "judge",
    resource_ids: ["judge-1"],
    resource_labels: ["Judge One"],
    severity: "hard",
    a_label: "10m Women Prelim",
    a_starts_at: "2026-05-18T09:00:00Z",
    a_ends_at: "2026-05-18T10:00:00Z",
    a_session_id: "sess-1",
    a_block_type: "event_start",
    a_event_id: "event-a",
    a_event_name: "10m Women Prelim",
    a_session_name: "Pool 1 — Morning",
    b_label: "3m Men Prelim",
    b_starts_at: "2026-05-18T09:30:00Z",
    b_ends_at: "2026-05-18T10:30:00Z",
    b_session_id: "sess-2",
    b_block_type: "event_start",
    b_event_id: "event-b",
    b_event_name: "3m Men Prelim",
    b_session_name: "Pool 2 — Morning",
    dismissal_id: null,
    dismissed_fingerprint: null,
    dismissed_at: null,
    dismissed_reason: null,
    ...overrides,
  };
}

// Fake pool that returns canned rows from the *most recent* call.
// The detector issues exactly one .query() per invocation so we
// just hand back whatever was queued.
function makeFakePool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
}

// ---------------------------------------------------------------
// fingerprint(): pure function
// ---------------------------------------------------------------

test("fingerprint: same membership → identical hash (dismissal sticks)", () => {
  const a = fingerprint(["judge-1", "judge-2"]);
  const b = fingerprint(["judge-1", "judge-2"]);
  assert.equal(a, b, "identical input must produce identical fingerprint");
});

test("fingerprint: order-independent — {A,B} == {B,A}", () => {
  const a = fingerprint(["judge-1", "judge-2"]);
  const b = fingerprint(["judge-2", "judge-1"]);
  assert.equal(a, b, "fingerprint must sort ids so AB and BA collapse");
});

test("fingerprint: membership change → different hash (resurfaces dismissal)", () => {
  const a = fingerprint(["judge-1", "judge-2"]);
  const b = fingerprint(["judge-1", "judge-3"]);
  assert.notEqual(a, b, "swapping one id must yield a fresh fingerprint");
});

test("fingerprint: empty / null input is stable and non-throwing", () => {
  assert.equal(typeof fingerprint([]), "string");
  assert.equal(fingerprint([]), fingerprint(null));
  assert.equal(fingerprint([]), fingerprint(undefined));
});

test("fingerprint: matches independent sha256-of-sorted-csv reference", () => {
  const ids = ["c", "a", "b"];
  assert.equal(fingerprint(ids), refFingerprint(ids));
});

test("SOFT_JUDGE_GAP_MINUTES is the documented 15-minute soft window", () => {
  // The constant is part of the public API, the detector SQL is
  // parameterised with it, the docs reference it, and the soft-
  // warning UI label hard-codes "15 minutes". A silent change to
  // this should fail loudly.
  assert.equal(SOFT_JUDGE_GAP_MINUTES, 15);
});

// ---------------------------------------------------------------
// detectConflicts(): input guards
// ---------------------------------------------------------------

test("detectConflicts: empty meetId → [] without touching the pool", async () => {
  const pool = makeFakePool([]);
  const out = await detectConflicts(null, pool);
  assert.deepEqual(out, []);
  assert.equal(pool.calls.length, 0, "must not query when meetId is null");
});

test("detectConflicts: missing pgClient throws a useful message", async () => {
  await assert.rejects(
    () => detectConflicts("meet-1", null),
    /pg client/,
  );
  await assert.rejects(
    () => detectConflicts("meet-1", {}),
    /pg client/,
  );
});

test("detectConflicts: passes meetId + soft-window minutes to the SQL", async () => {
  const pool = makeFakePool([]);
  await detectConflicts("meet-xyz", pool);
  assert.equal(pool.calls.length, 1);
  assert.deepEqual(pool.calls[0].params, ["meet-xyz", String(SOFT_JUDGE_GAP_MINUTES)]);
});

// ---------------------------------------------------------------
// detectConflicts(): row mapping
// ---------------------------------------------------------------

test("detectConflicts: no conflicts → empty array", async () => {
  const pool = makeFakePool([]);
  const out = await detectConflicts("meet-1", pool);
  assert.deepEqual(out, []);
});

test("detectConflicts: board conflict on overlapping blocks → hard severity, both blocks referenced", async () => {
  const pool = makeFakePool([
    detectorRow({
      resource_kind: "board",
      resource_ids: ["board-1m"],
      resource_labels: ["1m Springboard"],
      severity: "hard",
      // overlapping windows: a 9:30-10:30 block crosses a 9:00-10:00 block
      a_starts_at: "2026-05-18T09:00:00Z",
      a_ends_at: "2026-05-18T10:00:00Z",
      b_starts_at: "2026-05-18T09:30:00Z",
      b_ends_at: "2026-05-18T10:30:00Z",
    }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.equal(c.resource_kind, "board");
  assert.equal(c.severity, "hard");
  assert.deepEqual(c.resource_ids, ["board-1m"]);
  assert.equal(c.block_a.id, "block-a");
  assert.equal(c.block_b.id, "block-b");
  // Both windows are preserved so the drawer can show times.
  assert.equal(c.block_a.starts_at, "2026-05-18T09:00:00Z");
  assert.equal(c.block_b.ends_at, "2026-05-18T10:30:00Z");
});

test("detectConflicts: judge on two overlapping events → judge_conflict referencing both events", async () => {
  const pool = makeFakePool([
    detectorRow({
      resource_kind: "judge",
      resource_ids: ["judge-7"],
      resource_labels: ["J. Smith"],
      severity: "hard",
      a_event_id: "event-101",
      a_event_name: "10m Synchro",
      b_event_id: "event-202",
      b_event_name: "3m Mixed",
    }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.equal(c.resource_kind, "judge");
  assert.equal(c.severity, "hard");
  assert.equal(c.block_a.event_id, "event-101");
  assert.equal(c.block_b.event_id, "event-202");
  assert.equal(c.block_a.event_name, "10m Synchro");
  assert.equal(c.block_b.event_name, "3m Mixed");
  assert.deepEqual(c.resource_ids, ["judge-7"]);
});

test("detectConflicts: diver double-booking → diver_conflict with the right user_id", async () => {
  // This is the (now hoisted) diver hot path the security audit
  // flagged. The detector SQL has since been refactored to
  // materialise event_divers once per meet rather than per-pair,
  // but the public Conflict row shape this test pins MUST remain
  // stable so the route + drawer don't break.
  const pool = makeFakePool([
    detectorRow({
      resource_kind: "diver",
      resource_ids: ["diver-uuid-aaa"],
      resource_labels: ["Alex Diver"],
      severity: "hard",
    }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.equal(c.resource_kind, "diver");
  assert.equal(c.severity, "hard");
  assert.deepEqual(c.resource_ids, ["diver-uuid-aaa"]);
  assert.deepEqual(c.resource_labels, ["Alex Diver"]);
});

test("detectConflicts: judge soft-warning < 15min gap → severity 'soft'", async () => {
  // Same judge on two non-overlapping events that are within
  // SOFT_JUDGE_GAP_MINUTES of each other. The SQL marks these
  // 'soft' (severity column in the projection); the JS mapper
  // must propagate that to the Conflict object verbatim so the
  // drawer can colour-code the warning instead of blocking.
  const pool = makeFakePool([
    detectorRow({
      resource_kind: "judge",
      resource_ids: ["judge-7"],
      resource_labels: ["J. Smith"],
      severity: "soft",
      a_starts_at: "2026-05-18T09:00:00Z",
      a_ends_at:   "2026-05-18T09:30:00Z",
      b_starts_at: "2026-05-18T09:40:00Z",  // 10 min gap
      b_ends_at:   "2026-05-18T10:10:00Z",
    }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.equal(c.severity, "soft");
  assert.equal(c.resource_kind, "judge");
});

test("detectConflicts: fingerprint is computed per-row from resource_ids", async () => {
  // The fingerprint field on the returned Conflict is what the
  // dismissal API later stores; it has to match what we'd compute
  // from the same membership set. This pins the contract.
  const pool = makeFakePool([
    detectorRow({
      resource_kind: "judge",
      resource_ids: ["judge-a", "judge-b"],
      resource_labels: ["A", "B"],
    }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.equal(c.fingerprint, refFingerprint(["judge-a", "judge-b"]));
  // And order-independence holds through the mapper too.
  const pool2 = makeFakePool([
    detectorRow({
      resource_kind: "judge",
      resource_ids: ["judge-b", "judge-a"],
      resource_labels: ["B", "A"],
    }),
  ]);
  const [c2] = await detectConflicts("meet-1", pool2);
  assert.equal(c2.fingerprint, c.fingerprint, "order must not change the hash");
});

test("detectConflicts: re-running on the same input produces stable fingerprints (dismissals stick)", async () => {
  const rows = [
    detectorRow({ resource_ids: ["judge-1"], resource_labels: ["J. One"] }),
  ];
  const out1 = await detectConflicts("meet-1", makeFakePool(rows));
  const out2 = await detectConflicts("meet-1", makeFakePool(rows));
  assert.equal(out1[0].fingerprint, out2[0].fingerprint);
});

test("detectConflicts: changing one block's time leaves the fingerprint stable when membership doesn't change", async () => {
  // Resurfacing is keyed on membership, NOT on block times. A
  // rescheduled block with the same judges should keep the same
  // fingerprint so a previously-issued dismissal still applies.
  const base = detectorRow({ resource_ids: ["judge-1"] });
  const moved = detectorRow({
    resource_ids: ["judge-1"],
    a_starts_at: "2026-05-18T11:00:00Z",
    a_ends_at:   "2026-05-18T12:00:00Z",
  });
  const [c1] = await detectConflicts("meet-1", makeFakePool([base]));
  const [c2] = await detectConflicts("meet-1", makeFakePool([moved]));
  assert.equal(c1.fingerprint, c2.fingerprint);
});

test("detectConflicts: membership change → fresh fingerprint (resurfaces a stale dismissal)", async () => {
  // The dismissal scheme in §5: when the membership changes, the
  // fingerprint changes, so the LEFT JOIN against
  // dismissed_conflicts finds a row whose stored fingerprint no
  // longer matches → dismissed=false → conflict resurfaces.
  const before = detectorRow({ resource_ids: ["judge-1"] });
  const after  = detectorRow({ resource_ids: ["judge-2"] });
  const [c1] = await detectConflicts("meet-1", makeFakePool([before]));
  const [c2] = await detectConflicts("meet-1", makeFakePool([after]));
  assert.notEqual(c1.fingerprint, c2.fingerprint);
});

test("detectConflicts: dismissed=true only when the stored fingerprint still matches", async () => {
  const matchingFp = refFingerprint(["judge-1"]);
  const staleFp    = refFingerprint(["judge-99"]);

  // Active dismissal: stored fp matches current membership → hidden.
  const matchPool = makeFakePool([
    detectorRow({
      resource_ids: ["judge-1"],
      dismissal_id: "dis-1",
      dismissed_fingerprint: matchingFp,
      dismissed_at: "2026-05-18T08:00:00Z",
      dismissed_reason: "Two-panel rotation by hand",
    }),
  ]);
  const [matched] = await detectConflicts("meet-1", matchPool);
  assert.equal(matched.dismissed, true);
  assert.equal(matched.dismissal.id, "dis-1");
  assert.equal(matched.dismissal.reason, "Two-panel rotation by hand");

  // Stale dismissal: a dismissed_conflicts row exists but its
  // stored fingerprint no longer matches the current resource set.
  // §5 says these MUST resurface as fresh.
  const stalePool = makeFakePool([
    detectorRow({
      resource_ids: ["judge-1"],
      dismissal_id: "dis-2",
      dismissed_fingerprint: staleFp,
      dismissed_at: "2026-05-17T08:00:00Z",
      dismissed_reason: "old reason",
    }),
  ]);
  const [stale] = await detectConflicts("meet-1", stalePool);
  assert.equal(stale.dismissed, false, "stale fingerprint must NOT hide the conflict");
  assert.equal(stale.dismissal, null);
});

test("detectConflicts: null resource_ids / labels collapse to []", async () => {
  // Postgres can hand back NULL arrays when a FILTER clause drops
  // every member of an array_agg. The mapper has to coerce these
  // to empty arrays so the route never serialises `null` into a
  // .map() the front-end is about to walk.
  const pool = makeFakePool([
    detectorRow({ resource_ids: null, resource_labels: null }),
  ]);
  const [c] = await detectConflicts("meet-1", pool);
  assert.deepEqual(c.resource_ids, []);
  assert.deepEqual(c.resource_labels, []);
});

// ---------------------------------------------------------------
// computeResourceFingerprint(): the dismissal-route helper
// ---------------------------------------------------------------

test("computeResourceFingerprint: judge lookup returns sha256 of the discovered ids", async () => {
  const calls = [];
  const fakeClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      // Mirror the LATERAL/UNION shape: rows of { id }
      return { rows: [{ id: "judge-a" }, { id: "judge-b" }] };
    },
  };
  const fp = await computeResourceFingerprint(fakeClient, {
    blockAId: "block-1",
    blockBId: "block-2",
    resourceKind: "judge",
  });
  assert.equal(fp, refFingerprint(["judge-a", "judge-b"]));
  assert.equal(calls.length, 1);
  // The helper must pass both block ids through so the query can
  // intersect the two event panels, a typo here would silently
  // hash a one-sided membership set and break resurfacing, so worth
  // double-checking if you touch this code.
  assert.deepEqual(calls[0].params, ["block-1", "block-2"]);
});

test("computeResourceFingerprint: missing client throws", async () => {
  await assert.rejects(
    () => computeResourceFingerprint(null, {
      blockAId: "a", blockBId: "b", resourceKind: "judge",
    }),
    /pg client/,
  );
});

test("computeResourceFingerprint: unknown resource_kind hashes the empty set", async () => {
  // The route validates resource_kind before reaching here, but
  // belt-and-braces: an unknown kind shouldn't throw, it should
  // produce a deterministic empty-set fingerprint that obviously
  // won't match any real conflict.
  const fakeClient = { async query() { return { rows: [] }; } };
  const fp = await computeResourceFingerprint(fakeClient, {
    blockAId: "a", blockBId: "b", resourceKind: "not-a-kind",
  });
  assert.equal(fp, refFingerprint([]));
});
