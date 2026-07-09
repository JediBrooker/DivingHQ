// Unit coverage for the venue-state sequence-counter contract.
//
// The Daktronics (and every other venue) bridge subscribes to
// `venue.scoreboard_state` over Socket.IO and treats a sequence
// regression as a re-sync signal. The HTTP snapshot at
// `/api/venue/scoreboard-state/:event_id` must NOT advance the
// per-event counter, otherwise a bridge that boots with HTTP and
// then subscribes via websocket sees phantom gap and ping-pongs
// into a forever-re-sync loop on every reconnect.
//
// These tests stay DB-free: they stub `pool.query` to return
// minimal valid rows, so the function exercises its sequence
// accounting end-to-end without needing Postgres.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScoreboardState,
  resetSequenceForTest,
  pruneSequenceForEvent,
} = require("../lib/venue-state");

// Minimal fake pool, the function issues a handful of queries and
// we just return shapes that satisfy each call site's row access
// without exercising any actual scoring logic.
function makeFakePool() {
  return {
    async query(sql, _params) {
      // First query: event lookup
      if (/FROM events WHERE id = \$1/.test(sql)) {
        return {
          rows: [{
            id: "event-1",
            name: "Test Event",
            height: 3,
            event_type: "individual",
            status: "Live",
            total_rounds: 6,
            number_of_judges: 5,
          }],
        };
      }
      // Active diver / dive lookup
      if (/FROM users u\s+JOIN organisations o ON o.id = u.org_id/.test(sql)) {
        return { rows: [] };
      }
      // Combined rank + leaderboard CTE
      if (/WITH per_dive AS/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const EVENT_ID = "00000000-0000-0000-0000-000000000001";

test("buildScoreboardState advances sequence when stamp=true (default)", async () => {
  resetSequenceForTest();
  const pool = makeFakePool();
  const a = await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  const b = await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  const c = await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  assert.equal(a.sequence, 1, "first emit should be seq 1");
  assert.equal(b.sequence, 2, "second emit should be seq 2");
  assert.equal(c.sequence, 3, "third emit should be seq 3");
});

test("buildScoreboardState with stamp=false returns last emitted seq without advancing", async () => {
  resetSequenceForTest();
  const pool = makeFakePool();

  // First a real stamped emit → seq 1.
  const first = await buildScoreboardState({
    pool, eventId: EVENT_ID, activePayload: null, stamp: true,
  });
  assert.equal(first.sequence, 1);

  // Read-only snapshot between two stamps, must NOT advance.
  // Should report the last emitted value (1), not 2.
  const snap = await buildScoreboardState({
    pool, eventId: EVENT_ID, activePayload: null, stamp: false,
  });
  assert.equal(snap.sequence, 1, "snapshot must not advance the counter");

  // The next stamped emit should be seq 2, which proves the snapshot
  // didn't perturb the underlying counter.
  const second = await buildScoreboardState({
    pool, eventId: EVENT_ID, activePayload: null, stamp: true,
  });
  assert.equal(second.sequence, 2, "post-snapshot stamped emit must be seq 2, not 3");
});

test("buildScoreboardState with stamp=false on a never-streamed event returns 0", async () => {
  resetSequenceForTest();
  const pool = makeFakePool();
  // Bridge boots and pulls a snapshot before the event has ever
  // emitted anything, so we return 0. The bridge will then see the
  // first socket emit at seq 1: no regression, no phantom resync.
  const snap = await buildScoreboardState({
    pool, eventId: EVENT_ID, activePayload: null, stamp: false,
  });
  assert.equal(snap.sequence, 0);
});

test("pruneSequenceForEvent clears the counter for one event without disturbing others", async () => {
  resetSequenceForTest();
  const pool = makeFakePool();
  const OTHER = "00000000-0000-0000-0000-000000000002";

  await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  await buildScoreboardState({ pool, eventId: OTHER,    activePayload: null });

  pruneSequenceForEvent(EVENT_ID);

  // EVENT_ID's counter was pruned → next stamp starts back at 1.
  const next = await buildScoreboardState({ pool, eventId: EVENT_ID, activePayload: null });
  assert.equal(next.sequence, 1);

  // OTHER was untouched → still advancing from 1 to 2.
  const otherNext = await buildScoreboardState({ pool, eventId: OTHER, activePayload: null });
  assert.equal(otherNext.sequence, 2);
});
