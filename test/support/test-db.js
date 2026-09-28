// Which database a test run is pointed at, and a refusal if it isn't a
// test database.
//
// The e2e server, the e2e fixtures, `npm test` and the integration suite
// all used to settle this differently: Playwright never read .env and
// defaulted the server to divinghq_test, while the fixtures read .env.
// With .env.example's DB_DATABASE=divinghq that put the server on one
// database and the fixtures on another, and `npm test` straight onto the
// dev database (fixture orgs, flipped feature flags, migration 098
// re-run). Everything now resolves through here, in the same order
// server.js uses, and stops before touching anything that doesn't look
// like a test DB.

const DEFAULT_TEST_DB = "divinghq_test";

// DATABASE_URL wins, then DB_DATABASE, then libpq's PGDATABASE, the same
// precedence as server.js and the fixture pools.
function resolveTestDbName(env = process.env) {
  if (env.DATABASE_URL) {
    try {
      return decodeURIComponent(new URL(env.DATABASE_URL).pathname.replace(/^\//, ""));
    } catch {
      return "";
    }
  }
  return env.DB_DATABASE || env.PGDATABASE || "";
}

// Fill in the documented default when nothing names a database at all, so
// the server and the fixtures can't fall back to different ones.
function applyTestDbDefault(env = process.env) {
  if (!env.DATABASE_URL && !env.DB_DATABASE && !env.PGDATABASE) env.DB_DATABASE = DEFAULT_TEST_DB;
  return resolveTestDbName(env);
}

// "test" anywhere in the name (divinghq_test, divinghq_test_b8, ...).
// ALLOW_NON_TEST_DB=1 is the escape hatch for anyone who knows better.
function assertTestDatabase(env = process.env) {
  const name = resolveTestDbName(env);
  if (env.ALLOW_NON_TEST_DB === "1") return name;
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name || "(unset)"}": the name doesn't say test. ` +
      `These suites create orgs, flip feature flags and re-run migrations. ` +
      `Point DB_DATABASE (or DATABASE_URL) at a test database such as ${DEFAULT_TEST_DB}, ` +
      `or set ALLOW_NON_TEST_DB=1 if you really mean it.`,
    );
  }
  return name;
}

module.exports = { DEFAULT_TEST_DB, resolveTestDbName, applyTestDbDefault, assertTestDatabase };
