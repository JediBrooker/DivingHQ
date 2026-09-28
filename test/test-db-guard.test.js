// test/support/test-db.js: every test entry point resolves the database
// the same way and won't run against one that isn't a test DB.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveTestDbName, applyTestDbDefault, assertTestDatabase } = require("./support/test-db");

test("DATABASE_URL beats DB_DATABASE beats PGDATABASE, like server.js", () => {
  assert.equal(resolveTestDbName({ DATABASE_URL: "postgres://u:p@h:5432/divinghq_test", DB_DATABASE: "divinghq" }), "divinghq_test");
  assert.equal(resolveTestDbName({ DB_DATABASE: "divinghq_test_b8", PGDATABASE: "other" }), "divinghq_test_b8");
  assert.equal(resolveTestDbName({ PGDATABASE: "divinghq_test" }), "divinghq_test");
});

test("nothing set means divinghq_test, for the server and the fixtures alike", () => {
  const env = {};
  assert.equal(applyTestDbDefault(env), "divinghq_test");
  assert.equal(env.DB_DATABASE, "divinghq_test");
  const withUrl = { DATABASE_URL: "postgres://h/divinghq_test" };
  applyTestDbDefault(withUrl);
  assert.equal(withUrl.DB_DATABASE, undefined, "a DATABASE_URL already names one");
});

test("refuses the dev database .env.example points at, unless told otherwise", () => {
  assert.throws(() => assertTestDatabase({ DB_DATABASE: "divinghq" }), /Refusing to run tests against database "divinghq"/);
  assert.throws(() => assertTestDatabase({ DATABASE_URL: "postgres://h/divinghq" }), /divinghq/);
  assert.throws(() => assertTestDatabase({}), /\(unset\)/);
  assert.equal(assertTestDatabase({ DB_DATABASE: "divinghq_test_b8" }), "divinghq_test_b8");
  assert.equal(assertTestDatabase({ DB_DATABASE: "divinghq", ALLOW_NON_TEST_DB: "1" }), "divinghq");
});
