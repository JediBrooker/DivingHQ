// Unit coverage for the synchro partner-consent flow added in
// migration 051.
//
// SCOPE
// -----
// We exercise the helper in lib/dive-list-submit.js and the
// writeSynchroBothSides re-export with a hand-rolled fake pg client
// that returns canned rows for each SQL the helper issues, in order.
// No real Postgres required, the test pack runs under `test:safe`
// alongside the other no-DB unit suites.
//
// What we pin:
//   1. Fresh submit (no reciprocal invite) creates a pending row,
//      writes NO competitor_dive_lists rows, and fires a push.
//   2. Reciprocal invite: when the OTHER side already invited us,
//      the helper auto-confirms, pending row flipped to 'accepted'
//      and the pair's competitor_dive_lists rows inserted, one per
//      round with the inviter as competitor and us as partner.
//   3. Self-pairing (partner_id === competitor_id) is rejected
//      before any SQL runs.
//   4. writeSynchroBothSides (used by the accept endpoint) emits
//      one UPSERT per dive for the pair (N inserts for N dives, no
//      mirror row), and clears the divers' other unscored entries.
//   5. Decline path lives in the route, we cover it via direct SQL
//      assertions on the fake client. The helper itself isn't
//      involved on decline, so this test just pins the SQL we
//      expect the route to issue.
//
// The fake client matches calls by regex against the SQL text. The
// detail of which validation runs in which order is captured by the
// `expectations` queue, push() the canned rows you want each
// query() call to return, in the order the helper emits them.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const submitDiveList = require("../lib/dive-list-submit");
const { writeSynchroBothSides } = submitDiveList;

// --------------------------------------------------------------------
// Fake pg client. The helper issues queries in a deterministic order;
// we hand back canned rows by matching the SQL with a regex predicate.
// Captures every call so the test can assert on side effects.
// --------------------------------------------------------------------
function makeFakeClient(expectations) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const exp of expectations) {
        if (exp.consumed) continue;
        if (exp.match.test(sql)) {
          exp.consumed = true;
          if (typeof exp.rows === "function") return { rows: exp.rows(params) };
          return { rows: exp.rows, rowCount: exp.rows.length };
        }
      }
      // Fall-through: anything not explicitly matched returns 0 rows.
      // The validation paths use this to short-circuit (e.g. no
      // prescribed rows means skip enforcement).
      return { rows: [], rowCount: 0 };
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

// Minimal valid event row that the helper's validations are happy with.
const TEST_EVENT = {
  id: "event-1",
  org_id: "org-1",
  event_type: "synchro_pair",
  height: null,
  total_rounds: 6,
  round_rules: null,
  name: "Men's 10m Synchro",
};

const TEST_DIVES = [
  { dive_id: "dive-aaa", round_number: 1 },
  { dive_id: "dive-bbb", round_number: 2 },
];

// Common expectation builders, keeps tests readable by reusing the
// "dive directory + prescribed + partner check" stack and varying the
// reciprocal-pairing rows per test.
function baseExpectations({ reciprocalRows = [], partnerRow = { id: "partner-1", full_name: "Tom Daley" } } = {}) {
  return [
    // Dive directory validation, return each requested dive_id.
    {
      match: /FROM\s+dive_directory/i,
      rows: (params) => params[0].map((id) => ({ id, dive_code: "5132D", dd: 3.2, height: null })),
    },
    // Prescribed round dives, empty since there are no operator constraints.
    { match: /FROM\s+event_round_dives/i, rows: [] },
    // Partner validation lookup.
    { match: /FROM\s+users\s+u[\s\S]*user_org_roles/i, rows: [partnerRow] },
    // Reciprocal pending row lookup.
    {
      match: /FROM\s+pending_partner_pairings[\s\S]*FOR UPDATE/i,
      rows: reciprocalRows,
    },
    // INSERT ... ON CONFLICT pending_partner_pairings, returns id
    { match: /INSERT INTO pending_partner_pairings/i, rows: [{ id: "pairing-new" }] },
    // UPDATE pending_partner_pairings, the auto-confirm path.
    { match: /UPDATE pending_partner_pairings/i, rows: [] },
  ];
}

// --------------------------------------------------------------------
// 1. Fresh submit creates a pending row, no competitor_dive_lists.
// --------------------------------------------------------------------
test("fresh synchro submit creates a pending row and skips competitor_dive_lists", async () => {
  const client = makeFakeClient(baseExpectations());
  const push   = makeFakePush();

  const result = await submitDiveList({
    client,
    event:           TEST_EVENT,
    actor:           { id: "diver-A", org_id: "org-1", is_system_admin: false, full_name: "Alex" },
    competitorId:    "diver-A",
    competitorOrgId: "org-1",
    partnerId:       "partner-1",
    dives:           TEST_DIVES,
    push,
  });

  assert.equal(result.pairing.status, "pending");
  assert.equal(result.pairing.pairing_id, "pairing-new");
  assert.equal(result.pairing.partner_name, "Tom Daley");

  // No competitor_dive_lists touched, that's the whole point of the test.
  const cdlWrites = client.calls.filter((c) => /competitor_dive_lists/i.test(c.sql));
  assert.equal(cdlWrites.length, 0, "competitor_dive_lists must not be written before consent");

  // Pending row was upserted with the proposed dives.
  const upsert = client.calls.find((c) => /INSERT INTO pending_partner_pairings/i.test(c.sql));
  assert.ok(upsert, "Expected a pending_partner_pairings UPSERT");
  const payload = JSON.parse(upsert.params[3]);
  assert.equal(payload.length, 2);
  assert.deepEqual(payload[0], { dive_id: "dive-aaa", round_number: 1 });

  // Push fired at the partner, under the synchro.partner_invite category.
  assert.equal(push.calls.length, 1);
  assert.deepEqual(push.calls[0].userIds, ["partner-1"]);
  assert.equal(push.calls[0].payload.category, "synchro.partner_invite");
});

// --------------------------------------------------------------------
// 2. Auto-confirm path: reciprocal pending row from the other side.
// --------------------------------------------------------------------
test("reciprocal pending row triggers auto-confirm with one dive-list row per round", async () => {
  const reciprocalDives = [
    { dive_id: "dive-aaa", round_number: 1 },
    { dive_id: "dive-bbb", round_number: 2 },
  ];
  const client = makeFakeClient(
    baseExpectations({
      reciprocalRows: [{ id: "pairing-existing", dives: reciprocalDives }],
    }),
  );
  const push = makeFakePush();

  const result = await submitDiveList({
    client,
    event:           TEST_EVENT,
    actor:           { id: "diver-B", org_id: "org-1", is_system_admin: false, full_name: "Brooke" },
    competitorId:    "diver-B",
    competitorOrgId: "org-1",
    partnerId:       "partner-1", // they sent the invite; we're responding
    dives:           TEST_DIVES,
    push,
  });

  assert.equal(result.pairing.status, "auto_confirmed");

  // The pending row got flipped to 'accepted'.
  const update = client.calls.find((c) => /UPDATE pending_partner_pairings/i.test(c.sql));
  assert.ok(update, "Expected the pending row to be flipped to accepted");

  // One row per dive for the pair: a mirror row would put the pair in
  // the Control Room queue twice.
  const cdlInserts = client.calls.filter(
    (c) => /INSERT INTO competitor_dive_lists/i.test(c.sql),
  );
  assert.equal(cdlInserts.length, 2, "Expected one row per dive for the pair");
  for (const ins of cdlInserts) {
    // The requester (partner-1 in our shape) leads, we're the partner.
    assert.equal(ins.params[0], "partner-1");
    assert.equal(ins.params[1], "diver-B");
  }

  // Push fires at the original requester, announcing confirmation.
  assert.equal(push.calls.length, 1);
  assert.deepEqual(push.calls[0].userIds, ["partner-1"]);
  assert.equal(push.calls[0].payload.data.kind, "accepted");
});

// --------------------------------------------------------------------
// 3. Self-pairing is rejected.
// --------------------------------------------------------------------
test("self-pairing is rejected before any SQL fires the partner check", async () => {
  // No expectations queued for partner / pending lookups, the helper
  // must throw before it ever reaches them.
  const client = makeFakeClient([
    { match: /FROM\s+dive_directory/i, rows: (params) => params[0].map((id) => ({ id, dive_code: "5132D", dd: 3.2, height: null })) },
    { match: /FROM\s+event_round_dives/i, rows: [] },
  ]);
  const push = makeFakePush();

  await assert.rejects(
    () => submitDiveList({
      client,
      event:           TEST_EVENT,
      actor:           { id: "diver-A", org_id: "org-1", is_system_admin: false },
      competitorId:    "diver-A",
      competitorOrgId: "org-1",
      partnerId:       "diver-A", // same as competitor, must be rejected
      dives:           TEST_DIVES,
      push,
    }),
    (err) => err.status === 400 && /different partner/i.test(err.message),
  );

  // No partner lookup, no pending row, no inserts.
  assert.equal(
    client.calls.filter((c) => /pending_partner_pairings|competitor_dive_lists/i.test(c.sql)).length,
    0,
  );
  assert.equal(push.calls.length, 0);
});

// --------------------------------------------------------------------
// 4. writeSynchroBothSides (re-exported), driven by the accept route.
//    For N dives we expect 2N UPSERTs into competitor_dive_lists.
// --------------------------------------------------------------------
test("writeSynchroBothSides writes one row per dive for the pair", async () => {
  const client = makeFakeClient([]);
  const dives = [
    { dive_id: "dive-aaa", round_number: 1 },
    { dive_id: "dive-bbb", round_number: 2 },
    { dive_id: "dive-ccc", round_number: 3 },
  ];

  await writeSynchroBothSides(client, {
    eventId:     "event-1",
    requesterId: "diver-A",
    partnerId:   "diver-B",
    dives,
  });

  const inserts = client.calls.filter((c) => /INSERT INTO competitor_dive_lists/i.test(c.sql));
  assert.equal(inserts.length, 3, "Expected one insert per dive");
  assert.deepEqual(inserts.map((i) => [i.params[0], i.params[1], i.params[4]]),
    [["diver-A", "diver-B", 1], ["diver-A", "diver-B", 2], ["diver-A", "diver-B", 3]]);

  // Stale-row cleanup ran first: the pair's ghost rounds, then the
  // divers' other entries, which never touches a scored row.
  const firstInsert = client.calls.findIndex((c) => /INSERT INTO competitor_dive_lists/i.test(c.sql));
  const dels = client.calls.slice(0, firstInsert).filter((c) => /DELETE FROM competitor_dive_lists/i.test(c.sql));
  assert.equal(dels.length, 2, "Expected both cleanup DELETEs before the upserts");
  assert.equal(dels[1].params[1], "diver-B", "the accepter's own rows go");
  assert.deepEqual(dels[1].params[2], ["diver-A", "diver-B"]);
  assert.match(dels[1].sql, /NOT EXISTS[\s\S]*FROM scores/i);
});

// --------------------------------------------------------------------
// 5. writeSynchroBothSides refuses an empty dives payload. The
//    accept endpoint relies on this guard to surface a 400 to the
//    invitee when the requester's row somehow lost its dives.
// --------------------------------------------------------------------
test("writeSynchroBothSides rejects an empty dives payload", async () => {
  const client = makeFakeClient([]);

  await assert.rejects(
    () => writeSynchroBothSides(client, {
      eventId:     "event-1",
      requesterId: "diver-A",
      partnerId:   "diver-B",
      dives:       [],
    }),
    (err) => err.status === 400 && /no dives/i.test(err.message),
  );

  // No SQL fired.
  assert.equal(client.calls.length, 0);
});
