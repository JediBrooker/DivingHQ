// The DB-less half of scripts/rehearsal.js: argument parsing, the
// password, the plus-addressed emails and the fixed cast of accounts and
// dive lists. The database half (seed, status, cleanup against Postgres)
// is test/rehearsal.integration.test.js.
//
// This file is in the safe set, so it runs on the production box during
// deploy.sh. It must never open a connection.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const r = require("../scripts/rehearsal");
const { countryByCode } = require("../lib/countries");

test("parseArgs: commands, defaults and the options each one takes", () => {
  assert.deepEqual(r.parseArgs(["seed"]), {
    command: "seed", country: null, email: null, start: null, judges: null, dryRun: false, json: false, help: false,
  });
  const s = r.parseArgs(["seed", "--country", "esh", "--email", "  me@example.com ", "--json"]);
  assert.equal(s.country, "ESH");
  assert.equal(s.email, "me@example.com");
  assert.equal(s.json, true);
  assert.equal(r.parseArgs(["cleanup", "--dry-run"]).dryRun, true);
  assert.equal(r.parseArgs(["--help"]).help, true);

  const bad = [
    [],                                  // no command
    ["deploy"],                          // unknown command
    ["seed", "--country"],               // missing value
    ["seed", "--country", "--json"],     // value swallowed by the next flag
    ["seed", "--force"],                 // unknown option
    ["status", "--email", "a@b.co"],     // email is seed only
    ["cleanup", "--start", "2026-10-04"],
    ["seed", "--dry-run"],               // dry run is cleanup only
    ["seed", "--email", "not-an-email"],
    ["seed", "extra"],
    ["status", "--judges", "3"],         // the panel is seed only
    ["cleanup", "--judges", "3"],
  ];
  for (const argv of bad) {
    assert.throws(() => r.parseArgs(argv), r.UsageError, `expected a usage error for ${JSON.stringify(argv)}`);
  }
});

test("only catalogue countries: signup has to know the country", () => {
  assert.equal(r.parseArgs(["status", "--country", "URY"]).country, "URY");
  // Antarctica is the obvious pick but lib/countries.json leaves the
  // uninhabited territories out, so it's refused like any made-up code.
  for (const code of ["ATA", "BVT", "HMD", "XX", "TST", ""]) {
    assert.throws(() => r.resolveCountry(code), r.UsageError, code);
  }
});

test("the default country is in the catalogue and no other test uses it", () => {
  assert.ok(countryByCode(r.DEFAULT_COUNTRY), "default must be a catalogue code");
  // Tests share one database. A fixture org in the default country would
  // make seed refuse (and cleanup never touches it), so keep it unused.
  const dir = path.join(__dirname);
  const hits = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== "node_modules") walk(p); continue; }
      if (!/\.(js|json|sql|csv)$/.test(f.name) || /rehearsal/.test(f.name)) continue;
      if (new RegExp(`\\b${r.DEFAULT_COUNTRY}\\b`).test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(dir, p));
    }
  };
  walk(dir);
  assert.deepEqual(hits, []);
});

test("emails: plus-addressed copies of the owner's, or example.invalid", () => {
  assert.equal(r.plusAddress("you@example.com", "rehearsal-judge1"), "you+rehearsal-judge1@example.com");
  assert.equal(r.plusAddress("you+diving@example.com", "rehearsal-judge1"), "you+diving-rehearsal-judge1@example.com");
  assert.equal(r.accountEmail(r.JUDGES[0], null), "rehearsal-judge1@example.invalid");
  assert.equal(r.accountEmail(r.ADMIN, "o@x.io"), "o+rehearsal-admin@x.io");
});

test("the password is phone friendly and passes the signup rules", () => {
  for (let i = 0; i < 200; i++) {
    const pw = r.generatePassword();
    assert.match(pw, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    assert.ok(pw.length >= 12 && /[a-z]/.test(pw) && /\d/.test(pw), pw);
  }
  // A draw that comes up all digits, or all letters, gets thrown away and
  // drawn again. Index 0 is 'a', 24 is a digit.
  const seq = [...Array(12).fill(24), ...Array(12).fill(0), ...Array(11).fill(0), 24];
  let i = 0;
  const pw = r.generatePassword(() => {
    if (i >= seq.length) throw new Error("drew past the scripted sequence");
    return seq[i++];
  });
  assert.equal(pw, "aaaa-aaaa-aaa3");
  assert.equal(i, seq.length, "both one-class draws were redone");
});

test("default start is the next quarter hour at least half an hour out", () => {
  const at = (iso) => r.defaultStart(new Date(iso)).toISOString();
  assert.equal(at("2026-10-04T10:07:00Z"), "2026-10-04T10:45:00.000Z");
  assert.equal(at("2026-10-04T10:15:00Z"), "2026-10-04T10:45:00.000Z");
  assert.equal(at("2026-10-04T23:50:00Z"), "2026-10-05T00:30:00.000Z");
  assert.throws(() => r.parseStart("next tuesday-ish"), r.UsageError);
  assert.equal(r.parseStart("2026-10-04T10:00:00Z").toISOString(), "2026-10-04T10:00:00.000Z");
});

test("--start needs its offset, and the meet keeps the day as written", () => {
  // A bare time gets read in the box's zone (UTC on a stock container),
  // which lands the event hours away from where the owner meant it.
  for (const bare of ["2026-10-04T10:00", "2026-10-04", "2026-10-04 10:00+10:00", "2026-13-04T10:00Z"]) {
    assert.throws(() => r.parseStart(bare), r.UsageError, bare);
  }
  const early = "2026-10-04T08:00+10:00";
  assert.equal(r.parseStart(early).toISOString(), "2026-10-03T22:00:00.000Z");
  assert.equal(r.meetDate(early, r.parseStart(early)), "2026-10-04", "the venue's day, not UTC's");
  assert.equal(r.parseStart("2026-10-04T10:00:00.000-03:00").toISOString(), "2026-10-04T13:00:00.000Z");
  assert.equal(r.meetDate(null, new Date(2026, 9, 4, 12)), "2026-10-04");
});

test("accounts: prefixed, unique, the right cast", () => {
  const names = r.ACCOUNTS.map((a) => a.username);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) {
    assert.ok(n.startsWith(r.USER_PREFIX) && n.length <= 50, n);
  }
  assert.equal(r.JUDGES.length, r.EVENT.number_of_judges);
  assert.deepEqual(r.JUDGES.map((j) => j.judge_number), [1, 2, 3, 4, 5]);
  assert.equal(r.DIVERS.filter((d) => d.gender === "female").length, 2);
  assert.equal(r.DIVERS.filter((d) => d.gender === "male").length, 2);
  // Adults, so no guardian flow gets in the way on the day.
  for (const d of r.DIVERS) {
    const age = (Date.now() - Date.parse(d.date_of_birth)) / (365.25 * 24 * 3600 * 1000);
    assert.ok(age >= 18, `${d.username} is ${age.toFixed(1)}`);
  }
  // At least one name the PDF has to print in a non-Latin script.
  assert.ok(r.DIVERS.some((d) => /[^\u0000-ɏ]/.test(d.full_name)));
});

test("dive lists: one per round, a different group each round, round 1 shared per gender", () => {
  for (const d of r.DIVERS) {
    assert.equal(d.dives.length, r.EVENT.total_rounds, d.username);
    const groups = d.dives.map((c) => r.splitDive(c).dive_code[0]);
    assert.equal(new Set(groups).size, groups.length, `${d.username} repeats a group`);
  }
  // The record chip only shows when a dive beats a standing record, so
  // two divers of each gender open with the same dive.
  for (const g of ["female", "male"]) {
    const firsts = r.DIVERS.filter((d) => d.gender === g).map((d) => d.dives[0]);
    assert.equal(new Set(firsts).size, 1, `${g} round 1 should be shared`);
  }
  assert.deepEqual(r.splitDive("5132D"), { dive_code: "5132", position: "D" });
  assert.throws(() => r.splitDive("105"));
});

test("an org is the rehearsal's only with the slug for its own country and unclaimed", () => {
  const org = { slug: "rehearsal-esh", country_code: "ESH", claim_state: "unclaimed" };
  assert.equal(r.isRehearsalOrg(org), true);
  assert.equal(r.isRehearsalOrg({ ...org, country_code: "ESH" }), true);
  assert.equal(r.isRehearsalOrg({ ...org, claim_state: "claimed" }), false);
  assert.equal(r.isRehearsalOrg({ ...org, slug: "rehearsal-ury" }), false);
  assert.equal(r.isRehearsalOrg({ ...org, slug: "country-esh" }), false);
  assert.equal(r.orgSlug("URY"), "rehearsal-ury");
});

test("bind only sends the parameters a statement mentions", () => {
  const ids = { org: "o", users: ["u"], clubs: [], regions: [], meets: [], events: ["e"], all: [], urls: [] };
  const [text, values] = r.bind(
    "DELETE FROM x WHERE a = ANY(@events) OR b = ANY(@users) OR c = ANY(@events::text[]) OR d = @org",
    ids,
  );
  assert.equal(text,
    "DELETE FROM x WHERE a = ANY($1::uuid[]) OR b = ANY($2::uuid[]) OR c = ANY($1::uuid[]::text[]) OR d = $3::uuid");
  assert.deepEqual(values, [["e"], ["u"], "o"]);
  assert.throws(() => r.bind("SELECT @nope", ids), /unknown placeholder/);
});

test("urls hang off APP_BASE_URL, with or without a trailing slash", () => {
  const u = r.urlsFor({ eventId: "E", meetId: "M" }, { APP_BASE_URL: "https://divinghq.app/" });
  assert.equal(u.control_room, "https://divinghq.app/control?event=E");
  assert.equal(u.broadcast, "https://divinghq.app/scoreboard/E/broadcast");
  assert.equal(u.meet, "https://divinghq.app/meet/M");
  assert.equal(r.urlsFor({ eventId: "E", meetId: "M" }, {}).judge, "https://divinghq.app/judge");
  assert.equal(r.describeTarget({ DATABASE_URL: "postgres://u:secret@db.box:5432/diving_app" }), "diving_app on db.box");
  assert.equal(r.describeTarget({ DB_DATABASE: "diving_app" }), "diving_app on localhost");
});

// One person can rehearse with a 3-judge panel (docs/rehearsal.md,
// "Rehearsing alone"). The events table only takes 3, 5, 7, 9 or 11.
test("--judges: the panel sizes the events table takes, default five", () => {
  assert.deepEqual(r.PANEL_SIZES, [3, 5, 7, 9, 11]);
  assert.equal(r.DEFAULT_JUDGES, 5);
  for (const n of r.PANEL_SIZES) assert.equal(r.parseArgs(["seed", "--judges", String(n)]).judges, n);
  for (const bad of ["4", "1", "13", "0", "three", "3.0", "-3", " "]) {
    assert.throws(() => r.parseArgs(["seed", "--judges", bad]), r.UsageError, bad);
  }
  assert.throws(() => r.parseArgs(["seed", "--judges"]), r.UsageError);

  const three = r.judgesFor(3);
  assert.deepEqual(three.map((j) => [j.username, j.judge_number]), [
    ["rehearsal-judge1", 1], ["rehearsal-judge2", 2], ["rehearsal-judge3", 3],
  ]);
  assert.equal(r.accountsFor(3).length, 9);
  assert.deepEqual(r.accountsFor(5).map((a) => a.username), r.ACCOUNTS.map((a) => a.username));
  for (const n of r.PANEL_SIZES) {
    const names = r.accountsFor(n).map((a) => a.username);
    assert.equal(new Set(names).size, names.length, `${n} judges`);
    // Cleanup knows every name seed can make, whatever the panel.
    for (const name of names) assert.ok(r.ACCOUNT_USERNAMES.includes(name), name);
    for (const name of names) assert.ok(name.length <= 50, name);
  }
  assert.equal(r.ACCOUNT_USERNAMES.length, 17);
});

test("the seed report tells you the panel you got", () => {
  const report = (judges) => r.seedReport({
    country: { a3: r.DEFAULT_COUNTRY, name: "Western Sahara" },
    meet_date: "2026-10-04", scheduled_at: "2026-10-04T00:00:00.000Z",
    password: "abcd-efgh-2345", sysadmin_for_referee: "root",
    accounts: r.accountsFor(judges).map((a) => ({ ...a, email: `${a.username}@example.invalid` })),
    dive_lists: r.DIVERS.map((d) => ({ username: d.username, full_name: d.full_name, dives: d.dives })),
    urls: r.urlsFor({ eventId: "E", meetId: "M" }, {}),
  }, "test db");
  const three = report(3);
  assert.match(three, /3 judges, a phone each/);
  assert.match(three, /rehearsal-judge1 to rehearsal-judge3/);
  assert.match(three, /Rehearsing alone/);
  assert.doesNotMatch(three, /rehearsal-judge4/);
  const five = report(5);
  assert.match(five, /5 judges, a phone each/);
  assert.match(five, /rehearsal-judge1 to rehearsal-judge5/);
  assert.doesNotMatch(five, /Rehearsing alone/);
});
