// Country codes on organisations (migration 093). No database needed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const COUNTRIES = require("../lib/countries.json");

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
