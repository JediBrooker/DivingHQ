// Country codes on organisations (migration 093) and the slug register-org
// makes up now that the form doesn't ask for one. No database needed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const COUNTRIES = require("../lib/countries.json");
const { slugFromName } = require("../routes/auth");

// The migration's alpha-2 -> alpha-3 list was generated from
// lib/countries.json. If someone edits one and not the other, the backfill
// and the live lookup would disagree about what 'WS' means.
test("migration 093's mapping is exactly lib/countries.json", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "093_org_country_codes.sql"), "utf8",
  );
  const pairs = [...sql.matchAll(/\('([A-Z]{2})','([A-Z]{3})'\)/g)].map((m) => `${m[1]}>${m[2]}`);
  const expected = COUNTRIES.map((c) => `${c.a2}>${c.a3}`);
  assert.deepEqual(pairs, expected);
});

// 098 rewrites the entry snapshots (competitor_dive_lists.rep_country) with
// the same mapping, so a country entered as 'WS' doesn't print twice.
test("migration 098's snapshot mapping is exactly lib/countries.json too", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "098_rep_country_alpha3.sql"), "utf8",
  );
  const pairs = [...sql.matchAll(/\('([A-Z]{2})','([A-Z]{3})'\)/g)].map((m) => `${m[1]}>${m[2]}`);
  assert.deepEqual(pairs, COUNTRIES.map((c) => `${c.a2}>${c.a3}`));
  assert.match(sql, /UPDATE public\.competitor_dive_lists c\s+SET rep_country = m\.a3/);
});

test("slugFromName makes a URL-safe slug", () => {
  assert.equal(slugFromName("Diving Australia", "x"), "diving-australia");
  assert.equal(slugFromName("Fédération Française de Natation", "x"), "federation-francaise-de-natation");
  assert.equal(slugFromName("  Diving -- NSW!!  ", "x"), "diving-nsw");
  // Shape register-org has always required of a client-sent slug.
  for (const name of ["Diving Australia", "Øresund Dykning", "A".repeat(200)]) {
    assert.match(slugFromName(name, "fallback"), /^[a-z0-9-]{2,50}$/);
  }
  assert.ok(!slugFromName(`${"a".repeat(49)} b`, "x").endsWith("-"), "no trailing hyphen after the cut");
});

test("slugFromName falls back when nothing Latin survives", () => {
  assert.equal(slugFromName("Федерация прыжков в воду", "org-rus"), "org-rus");
  assert.equal(slugFromName("中国跳水协会", "org-chn"), "org-chn");
  assert.equal(slugFromName("", "org-tst"), "org-tst");
});

test("countryFromStored reads what an organisations row can hold", () => {
  const { countryFromStored, countryByCode } = require("../lib/countries");
  assert.equal(countryFromStored("WSM")?.a3, "WSM");
  assert.equal(countryFromStored("WS ")?.a3, "WSM", "char(3) pads a 2-letter code");
  assert.equal(countryFromStored("ws")?.a3, "WSM");
  assert.equal(countryFromStored("GER"), null, "IOC codes aren't ISO");
  assert.equal(countryFromStored(null), null);
  // User input stays alpha-3 only.
  assert.equal(countryByCode("WS"), null);
});
