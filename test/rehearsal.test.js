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
    command: "seed", country: null, email: null, start: null, dryRun: false, json: false, help: false,
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
