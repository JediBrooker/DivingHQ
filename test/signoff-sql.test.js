// lib/signoff-sql.js, the shared "is this sign-off request still live"
// SQL. No database here, the behaviour against real rows is in
// test/signoff-pending.integration.test.js.
//
// The last test is a tripwire. Three readers once had their own copy of
// the pending_signoff CTE and only one remembered expires_at, so a read
// of referee_signoff_requests that spells out status = 'pending' itself
// fails here and points at the helper.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  liveSignoffRequest,
  lapsedSignoffRequest,
  pendingSignoffCte,
} = require("../lib/signoff-sql");

test("live and lapsed split a pending row at expires_at, with no gap", () => {
  assert.equal(liveSignoffRequest(), "rsr.status = 'pending' AND rsr.expires_at > now()");
  assert.equal(lapsedSignoffRequest(), "rsr.status = 'pending' AND rsr.expires_at <= now()");
  assert.equal(liveSignoffRequest("r"), "r.status = 'pending' AND r.expires_at > now()");
  assert.equal(lapsedSignoffRequest("r"), "r.status = 'pending' AND r.expires_at <= now()");
});

test("pendingSignoffCte filters on the live test and joins the caller's events", () => {
  const sql = pendingSignoffCte({ events: "visible_events" });
  assert.match(sql, /^pending_signoff AS \(/);
  assert.ok(sql.includes(`WHERE ${liveSignoffRequest("rsr")}`), sql);
  assert.match(sql, /JOIN visible_events signoff_events ON signoff_events\.id = rsr\.event_id/);
  // One row per event, the newest live request.
  assert.match(sql, /DISTINCT ON \(rsr\.event_id\)/);
  assert.match(sql, /ORDER BY rsr\.event_id, rsr\.created_at DESC/);
  assert.match(sql, /u\.full_name AS pending_signoff_referee_name/);
  assert.match(pendingSignoffCte({ name: "ps", events: "ev" }), /^ps AS \([\s\S]*JOIN ev signoff_events/);
});

test("pendingSignoffCte won't build without an events source", () => {
  assert.throws(() => pendingSignoffCte(), /events/);
  assert.throws(() => pendingSignoffCte({}), /events/);
});

test("nothing reads referee_signoff_requests with a hand-written pending check", () => {
  const root = path.join(__dirname, "..");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(path.join(root, "lib"));
  walk(path.join(root, "routes"));
  walk(path.join(root, "db"));

  const offenders = [];
  for (const file of files) {
    if (file.endsWith(`${path.sep}signoff-sql.js`)) continue;
    const src = fs.readFileSync(file, "utf8");
    // From each FROM referee_signoff_requests to the end of that SQL
    // string (the next backtick). Writes say UPDATE referee_signoff_requests
    // and are left alone: retiring every pending row, lapsed or not, is
    // what they mean to do.
    const re = /FROM\s+referee_signoff_requests\b[^`]*/g;
    let m;
    while ((m = re.exec(src))) {
      if (/status\s*=\s*'pending'/.test(m[0])) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "use liveSignoffRequest / pendingSignoffCte from lib/signoff-sql.js, a pending row can be long expired");
});
