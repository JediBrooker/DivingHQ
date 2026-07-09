// Unit coverage for the Daktronics venue bridge formatter.
//
// These tests stay hardware-free. The bridge runtime can write to
// UDP/TCP/serial, but the contract we actually need to lock down is
// the stable field mapping and frame rendering from
// venue.scoreboard_state.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFixedLayout,
  flattenScoreboardState,
  formatFixedRtdFrame,
  formatJsonFrame,
  rtdPortForSource,
} = require("../lib/daktronics-bridge");
const { parseArgs } = require("../scripts/venue-daktronics-bridge");

const sampleState = {
  schema_version: 1,
  sequence: 42,
  emitted_at: "2026-05-17T13:42:31.000Z",
  event_id: "event-1",
  event: {
    id: "event-1",
    name: "Women's 3m Springboard",
    height: 3,
    event_type: "individual",
    status: "Live",
    round: 2,
    total_rounds: 5,
    on_hold: false,
    on_hold_reason: null,
  },
  active_diver: {
    competitor_id: "diver-1",
    name: "Anaïs Example",
    partner_name: null,
    country_code: "fra",
    club_code: "Paris",
    lane: null,
    display_order: 7,
  },
  active_dive: {
    code: "205B",
    position: "B",
    dd: 3.0,
    description: "Back 2 1/2 Somersault Pike",
  },
  scores: [7.5, 8.0, null, 8.5, 8.0],
  dive_total: null,
  running_total: 181.25,
  current_rank: 2,
  field_size: 16,
  leaderboard: [
    { rank: 1, name: "Leader One", country_code: "AUS", total: 190.5 },
    { rank: 2, name: "Anaïs Example", country_code: "FRA", total: 181.25 },
  ],
};

test("derives Daktronics ERTD ports from the data source value", () => {
  assert.equal(rtdPortForSource(0), 21000);
  assert.equal(rtdPortForSource(4), 21040);
  assert.throws(() => rtdPortForSource(-1), /ERTD source/);
});

test("flattens venue state into stable Daktronics field names", () => {
  const fields = flattenScoreboardState(sampleState);
  assert.equal(fields.event_name, "Women's 3m Springboard");
  assert.equal(fields.diver_name, "Anais Example");
  assert.equal(fields.country_code, "FRA");
  assert.equal(fields.club_code, "PARIS");
  assert.equal(fields.judge_1_score, "7.5");
  assert.equal(fields.judge_3_score, "");
  assert.equal(fields.running_total, "181.25");
  assert.equal(fields.leader_2_name, "Anais Example");
});

test("renders a deterministic fixed-width ASCII RTD frame", () => {
  const layout = buildFixedLayout({ maxJudges: 5, topN: 2 });
  const expectedLength = layout.reduce((sum, field) => sum + field.width, 0);
  const frame = formatFixedRtdFrame(sampleState, {
    maxJudges: 5,
    topN: 2,
    newline: "none",
  });
  const text = frame.toString("ascii");

  assert.equal(text.length, expectedLength);
  assert.match(text, /Women's 3m Springboard/);
  assert.match(text, /Anais Example/);
  assert.match(text, /205B/);
  assert.match(text, /Leader One/);
  assert.doesNotMatch(text, /Anaïs/);
});

test("renders newline-delimited JSON fields for Data Studio-style ingestion", () => {
  const frame = formatJsonFrame(sampleState, { newline: "lf", maxJudges: 5, topN: 2 });
  assert.match(frame.toString("utf8"), /\n$/);
  const parsed = JSON.parse(frame.toString("utf8"));
  assert.equal(parsed.event_status, "Live");
  assert.equal(parsed.judge_3_score, "");
  assert.equal(parsed.leader_1_total, "190.50");
});

test("CLI argument parsing defaults to safe stdout and computes ERTD port", () => {
  const args = parseArgs(
    ["--event-id", "event-1", "--transport", "udp", "--data-source", "4"],
    {},
  );
  assert.equal(args.appUrl, "http://127.0.0.1:3000");
  assert.equal(args.eventId, "event-1");
  assert.equal(args.transport, "udp");
  assert.equal(args.port, 21040);
  assert.equal(args.format, "rtd");
});
