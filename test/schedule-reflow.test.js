// Unit coverage for lib/schedule-reflow.js
//
// SCOPE
// -----
// buildReflowProposal() reads three things from Postgres (the
// matching schedule_block, the noise-floor side-effect stamp, and
// the downstream candidate set) and computes the delta + per-block
// shift in pure JS. The pool here is faked (script-driven), so each
// test hands back exactly the row shape the code expects for each
// of its three queries, in order.
//
// We pin:
//   * delta math: actualEnd - plannedEnd, in ms, rounded to s for
//     the wire payload
//   * noise threshold guard (REFLOW_NOISE_THRESHOLD_MS = 5 min):
//     the design doc explicitly forbids interrupting the operator
//     for sub-5-min drift, and the security audit flagged the
//     short-event no-op path as load-bearing
//   * "never shift earlier": negative deltas return null (an event
//     that ran short doesn't pull subsequent warmups forward)
//   * cascade: every downstream candidate gets the SAME deltaMs
//     added to BOTH starts_at and ends_at (a 5-min slip moves a
//     warmup 5 min, an event 5 min, etc.)
//   * session-scoping: the candidates query filters by
//     completed.session_id, so a block completing in session A
//     CAN'T return candidates from session B even at the same pool
//
// Production path exercised:
//   PATCH /api/events/:id/status (status -> 'Completed' branch) in
//   routes/events/index.js calls buildReflowProposal and ships the
//   result to the Control Room reflow modal.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  REFLOW_NOISE_THRESHOLD_MS,
  stampActualStart,
  buildReflowProposal,
} = require("../lib/schedule-reflow");

// ---------------------------------------------------------------
// Scripted fake client. buildReflowProposal issues up to three
// queries in a fixed order:
//   1) SELECT … FROM schedule_blocks b JOIN sessions s … WHERE b.event_id = $1
//   2) UPDATE schedule_blocks SET actual_end_at = …          (stamp side-effect)
//   3) SELECT … FROM schedule_blocks b LEFT JOIN events e … (downstream candidates)
//
// We dispatch off the SQL text rather than call order, so a test
// that triggers an early return (no block found, no candidates)
// still passes through the right matcher.
// ---------------------------------------------------------------

function makeFakeClient({ blockRow, candidateRows = [], existingActualEndAt = null }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });

      // Block-lookup: matches the FROM schedule_blocks … WHERE
      // b.event_id = $1 LIMIT 1 shape.
      if (/FROM schedule_blocks b\s+JOIN sessions s\s+ON\s+s\.id\s*=\s*b\.session_id\s+WHERE b\.event_id\s*=\s*\$1/i.test(sql)) {
        if (!blockRow) return { rows: [], rowCount: 0 };
        return {
          rows: [{ ...blockRow, actual_end_at: existingActualEndAt }],
          rowCount: 1,
        };
      }

      // Stamp side-effect: UPDATE schedule_blocks SET actual_end_at
      if (/UPDATE schedule_blocks\s+SET actual_end_at/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }

      // Stamp side-effect for actual_start: UPDATE schedule_blocks SET actual_start_at
      if (/UPDATE schedule_blocks\s+SET actual_start_at/i.test(sql)) {
        // Returning a stamped id mirrors prod behaviour.
        return { rows: blockRow ? [{ id: blockRow.id }] : [], rowCount: blockRow ? 1 : 0 };
      }

      // Candidates: filtered by session_id with ORDER BY starts_at.
      if (/WHERE b\.session_id\s*=\s*\$1/i.test(sql)) {
        // Production code filters in SQL by session_id + starts_at >= ends_at
        // + actual_start_at IS NULL. Our fake only honours session_id so
        // the session-scoping test gets the right answer; the other
        // filters are the caller's problem, we just stage rows the SQL
        // would actually return.
        const [sessionId, excludeId, fromTs] = params;
        const filtered = candidateRows.filter(
          (r) => r.session_id === sessionId && r.id !== excludeId,
        );
        return { rows: filtered, rowCount: filtered.length };
      }

      throw new Error("unexpected SQL in fake client: " + sql.slice(0, 80));
    },
  };
}

// Shorthand: 2026-05-18T09:00:00Z + n minutes as an ISO string.
const BASE = Date.parse("2026-05-18T09:00:00Z");
function tPlus(minutes) {
  return new Date(BASE + minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------
// REFLOW_NOISE_THRESHOLD_MS sanity
// ---------------------------------------------------------------

test("REFLOW_NOISE_THRESHOLD_MS is the documented 5-minute floor", () => {
  // The design doc and the route logic both rely on this exact
  // value, so a silent change should fail loudly. Don't want to
  // start bothering operators over 30-second drifts.
  assert.equal(REFLOW_NOISE_THRESHOLD_MS, 5 * 60 * 1000);
});

// ---------------------------------------------------------------
// stampActualStart: small but real side-effect
// ---------------------------------------------------------------

test("stampActualStart: returns null when eventId is falsy and does not query", async () => {
  const client = makeFakeClient({ blockRow: null });
  const out = await stampActualStart(client, null, new Date());
  assert.equal(out, null);
  assert.equal(client.calls.length, 0);
});

test("stampActualStart: passes eventId + at to the idempotent UPDATE", async () => {
  const client = makeFakeClient({
    blockRow: { id: "block-99", session_id: "sess-1", starts_at: tPlus(0), ends_at: tPlus(60), meet_id: "meet-1" },
  });
  const at = new Date(BASE + 10 * 60_000);
  const id = await stampActualStart(client, "event-1", at);
  assert.equal(id, "block-99");
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, ["event-1", at]);
});

// ---------------------------------------------------------------
// buildReflowProposal: no-ops
// ---------------------------------------------------------------

test("buildReflowProposal: no eventId → null", async () => {
  const client = makeFakeClient({ blockRow: null });
  const out = await buildReflowProposal(client, null, new Date());
  assert.equal(out, null);
  assert.equal(client.calls.length, 0, "must short-circuit before any SQL");
});

test("buildReflowProposal: no matching schedule_block → null (older pre-scheduler meets)", async () => {
  const client = makeFakeClient({ blockRow: null });
  const out = await buildReflowProposal(client, "event-orphan", new Date());
  assert.equal(out, null);
  // Just the block-lookup query, no stamp, no candidates.
  assert.equal(client.calls.length, 1);
});

test("buildReflowProposal: delta within noise threshold (±60s) → null, no shift fires", async () => {
  // Planned end at t+30. Actual end at t+30:30 → 30s late → noise.
  const client = makeFakeClient({
    blockRow: {
      id: "block-1",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(30),
      meet_id: "meet-1",
    },
    candidateRows: [{
      id: "block-down",
      session_id: "sess-A",
      label: "Warmup",
      block_type: "warmup",
      starts_at: tPlus(30),
      ends_at: tPlus(45),
      event_name: null,
    }],
  });
  const at = new Date(BASE + 30 * 60_000 + 30_000); // +30s past plan
  const out = await buildReflowProposal(client, "event-1", at);
  assert.equal(out, null, "30-second delta is noise — no proposal");
});

test("buildReflowProposal: event ran SHORT (negative delta) → null (never pull warmups forward)", async () => {
  // Planned end at t+60. Actual end at t+45 → ran 15 min short.
  // The doc explicitly forbids pulling downstream blocks earlier.
  const client = makeFakeClient({
    blockRow: {
      id: "block-1",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(60),
      meet_id: "meet-1",
    },
    candidateRows: [{
      id: "block-down",
      session_id: "sess-A",
      label: "Warmup",
      block_type: "warmup",
      starts_at: tPlus(60),
      ends_at: tPlus(75),
      event_name: null,
    }],
  });
  const at = new Date(BASE + 45 * 60_000);
  const out = await buildReflowProposal(client, "event-1", at);
  assert.equal(out, null, "ran-short must return null");
});

test("buildReflowProposal: no downstream candidates → null (short event with nothing after it)", async () => {
  // A 10-min event runs 7 min late (over noise floor) but there's
  // nothing scheduled after it in the same session. Empty
  // candidate list means there's nothing to propose shifting.
  const client = makeFakeClient({
    blockRow: {
      id: "block-1",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(10),
      meet_id: "meet-1",
    },
    candidateRows: [],
  });
  const at = new Date(BASE + 17 * 60_000); // 7 min late
  const out = await buildReflowProposal(client, "event-1", at);
  assert.equal(out, null);
});

// ---------------------------------------------------------------
// buildReflowProposal: cascade math
// ---------------------------------------------------------------

test("buildReflowProposal: 5+ min overrun → cascades the same delta to every downstream block", async () => {
  // Planned end at t+30. Actual end at t+35 → 5 min late.
  // Three downstream blocks: warmup at t+30, event_start at t+45,
  // event_finish at t+90. All three should slip 5 min later.
  const overrunMin = 5;
  const at = new Date(BASE + (30 + overrunMin) * 60_000);
  const client = makeFakeClient({
    blockRow: {
      id: "block-1",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(30),
      meet_id: "meet-1",
    },
    candidateRows: [
      { id: "down-1", session_id: "sess-A", label: "Warmup",   block_type: "warmup",       starts_at: tPlus(30), ends_at: tPlus(45),  event_name: null },
      { id: "down-2", session_id: "sess-A", label: null,       block_type: "event_start",  starts_at: tPlus(45), ends_at: tPlus(75),  event_name: "10m Men Final" },
      { id: "down-3", session_id: "sess-A", label: "Medals",   block_type: "event_finish", starts_at: tPlus(90), ends_at: tPlus(100), event_name: null },
    ],
  });

  const out = await buildReflowProposal(client, "event-1", at);
  assert.ok(out, "must produce a proposal for a 5+ min overrun");
  assert.equal(out.completed_block_id, "block-1");
  assert.equal(out.session_id, "sess-A");
  assert.equal(out.meet_id, "meet-1");
  assert.equal(out.delta_seconds, overrunMin * 60);
  assert.equal(out.candidates.length, 3);

  // Each candidate must shift by exactly delta on BOTH ends.
  const deltaMs = overrunMin * 60_000;
  for (const cand of out.candidates) {
    const oldStart = Date.parse(cand.old_starts_at);
    const newStart = Date.parse(cand.new_starts_at);
    const oldEnd   = Date.parse(cand.old_ends_at);
    const newEnd   = Date.parse(cand.new_ends_at);
    assert.equal(newStart - oldStart, deltaMs, `${cand.block_id} starts_at should slip by delta`);
    assert.equal(newEnd   - oldEnd,   deltaMs, `${cand.block_id} ends_at should slip by delta`);
  }

  // Label fallback: down-2 has label=null but event_name set, so
  // the proposal label should fall through to the event name.
  const down2 = out.candidates.find((c) => c.block_id === "down-2");
  assert.equal(down2.label, "10m Men Final", "label must fall back to event_name when null");
});

test("buildReflowProposal: candidates are session-scoped — a block in session A doesn't shift session B", async () => {
  // Sessions A and B run at the same pool at the same time.
  // Block in session A overruns by 6 minutes. We give the fake
  // ONE candidate per session and confirm only session A's
  // candidate ends up in the proposal. This pins the WHERE
  // session_id = $1 clause that prevents the reflow from
  // ricocheting across pools.
  const at = new Date(BASE + 36 * 60_000); // 6 min past t+30
  const client = makeFakeClient({
    blockRow: {
      id: "block-A",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(30),
      meet_id: "meet-1",
    },
    candidateRows: [
      { id: "down-A", session_id: "sess-A", label: "A-Warmup", block_type: "warmup", starts_at: tPlus(30), ends_at: tPlus(45), event_name: null },
      // Same pool, parallel session, must NOT appear in the proposal.
      { id: "down-B", session_id: "sess-B", label: "B-Event",  block_type: "event_start", starts_at: tPlus(30), ends_at: tPlus(60), event_name: null },
    ],
  });

  const out = await buildReflowProposal(client, "event-A", at);
  assert.ok(out);
  assert.equal(out.session_id, "sess-A");
  assert.equal(out.candidates.length, 1, "must NOT include the parallel session's block");
  assert.equal(out.candidates[0].block_id, "down-A");

  // Belt and braces: confirm the SQL was parameterised with the
  // completing block's session_id, so the prod query (which uses
  // a real WHERE clause) would've done the same filtering.
  const candidatesCall = client.calls.find(
    (c) => /WHERE b\.session_id\s*=\s*\$1/i.test(c.sql),
  );
  assert.ok(candidatesCall, "should have issued a candidates query");
  assert.equal(candidatesCall.params[0], "sess-A");
});

test("buildReflowProposal: pre-existing actual_end_at is NOT overwritten (operator do-over)", async () => {
  // Re-flip Completed → Live → Completed: actual_end_at should be
  // the FIRST observed end-time (audit truth), not the latest.
  // The mapper only issues the stamp UPDATE when actual_end_at IS
  // NULL, confirmed here by counting queries.
  const at = new Date(BASE + 38 * 60_000);
  const client = makeFakeClient({
    blockRow: {
      id: "block-1",
      session_id: "sess-A",
      starts_at: tPlus(0),
      ends_at: tPlus(30),
      meet_id: "meet-1",
    },
    existingActualEndAt: tPlus(34), // already stamped on first finalise
    candidateRows: [
      { id: "down-1", session_id: "sess-A", label: "Warmup", block_type: "warmup", starts_at: tPlus(30), ends_at: tPlus(45), event_name: null },
    ],
  });

  await buildReflowProposal(client, "event-1", at);
  const stampCalls = client.calls.filter(
    (c) => /UPDATE schedule_blocks\s+SET actual_end_at/i.test(c.sql),
  );
  assert.equal(stampCalls.length, 0, "must NOT re-stamp when actual_end_at is already set");
});
