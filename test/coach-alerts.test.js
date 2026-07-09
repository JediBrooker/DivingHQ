// Unit tests for the coach-alerts fan-out helper.
//
// The historical bug: the dedupe Map keyed off competitor_id only,
// so when a diver came up again in round 2+ the early-return fired
// and no coach pushes went out for any squad member behind them.
// These tests pin the new (competitor_id|round_number) dedupe key
// so the bug can't sneak back in.
//
// No DB required, we hand-roll a tiny pool stub that returns the
// rows we want for each SQL call in turn.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  maybeNotifyCoachesOfNextDivers,
  resetDedupeForTest,
} = require("../lib/coach-alerts");

// Build a fake pool whose .query() returns canned rows in the
// order the production helper issues them:
//   1) the active diver's display_order
//   2) the candidate squad rows (one push per row)
// We hand back the same shape on every fire so we can compare
// the push.sendNotification call count cleanly.
function makeFakePool() {
  return {
    queryCalls: 0,
    async query(sql /*, params */) {
      this.queryCalls += 1;
      // active diver display_order lookup, short SELECT with
      // `display_order` in the column list
      if (/SELECT\s+display_order/i.test(sql)) {
        return { rows: [{ display_order: 1 }] };
      }
      // candidate squad rows, the big CTE. Return one match so
      // exactly one push is expected per non-deduped invocation
      return {
        rows: [
          {
            competitor_id: "diver-aaa",
            round_number: 1,
            dive_code: "5132D",
            position: "D",
            dives_until: 2,
            coach_id: "coach-zzz",
            dives_ahead: 2,
            coach_name: "Coach Z",
            diver_name: "Diver A",
            country_code: "AUS",
            event_name: "Test Event",
          },
        ],
      };
    },
  };
}

function makeFakePush() {
  const calls = [];
  return {
    calls,
    async sendNotification(userIds, payload) {
      calls.push({ userIds, payload });
    },
  };
}

test("fires for the same competitor in a different round", async () => {
  resetDedupeForTest();
  const pool = makeFakePool();
  const push = makeFakePush();

  // Round 1
  await maybeNotifyCoachesOfNextDivers(
    { pool, push },
    "event-1",
    { competitor_id: "active-diver", round_number: 1 },
  );
  // round 2: same active competitor, new round. The old
  // dedupe key would've skipped this, the round-aware key
  // must not skip
  await maybeNotifyCoachesOfNextDivers(
    { pool, push },
    "event-1",
    { competitor_id: "active-diver", round_number: 2 },
  );

  assert.equal(
    push.calls.length,
    2,
    "Expected two pushes (one per round) — dedupe regressed",
  );
});

test("dedupes identical (competitor_id, round_number) calls", async () => {
  resetDedupeForTest();
  const pool = makeFakePool();
  const push = makeFakePush();

  await maybeNotifyCoachesOfNextDivers(
    { pool, push },
    "event-1",
    { competitor_id: "active-diver", round_number: 3 },
  );
  // operator re-emits state for the same diver/round, must be skipped
  await maybeNotifyCoachesOfNextDivers(
    { pool, push },
    "event-1",
    { competitor_id: "active-diver", round_number: 3 },
  );

  assert.equal(
    push.calls.length,
    1,
    "Expected exactly one push — duplicate state emission leaked through",
  );
});
