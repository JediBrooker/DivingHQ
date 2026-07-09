#!/usr/bin/env node
//
// Migration runner.
//
//   npm run migrate            : apply every pending migration
//   npm run migrate -- --dry   : print what would run, don't change anything
//   npm run migrate -- --to 12 : stop after 0NN_*.sql where NN <= 12
//
// Reads schema_meta.version from the target database, then applies
// every migrations/0NN_<name>.sql file with NN > current_version, in
// numeric order, inside its own transaction. Each migration is already
// idempotent (we use IF NOT EXISTS / ON CONFLICT), so if operator
// accidentally triggers a re-run it's just a no-op.
//
// Connection: same env as server.js, DATABASE_URL takes precedence,
// otherwise the standard libpq vars (DB_HOST/DB_USER/DB_PASSWORD/
// DB_NAME/DB_PORT). dotenv is loaded so a dev can `npm run
// migrate` against a .env without exporting anything by hand.

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry") || args.includes("--dry-run");
const toIdx = args.indexOf("--to");
const TARGET_VERSION = toIdx >= 0 ? Number(args[toIdx + 1]) : Infinity;

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Pull the version-prefix off "0NN_<name>.sql".
function parseVersion(filename) {
  const m = filename.match(/^(\d+)_.*\.sql$/);
  return m ? Number(m[1]) : null;
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, version: parseVersion(f) }))
    .filter((m) => m.version !== null)
    .sort((a, b) => a.version - b.version);
}

async function getCurrentVersion(client) {
  // schema_meta gets created by migration 008. On a totally fresh DB
  // (no init.sql, no 008 applied yet) the table just doesn't exist,
  // so we treat that as version 0 and run everything from scratch.
  try {
    const r = await client.query(
      "SELECT version FROM public.schema_meta WHERE id = 1",
    );
    return r.rows[0]?.version ?? 0;
  } catch (err) {
    if (err.code === "42P01" /* undefined_table */) return 0;
    throw err;
  }
}

function makeClient() {
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL });
  }
  return new Client({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port:     process.env.DB_PORT,
  });
}

(async () => {
  const client = makeClient();
  await client.connect();
  try {
    const current = await getCurrentVersion(client);
    const migs = listMigrations();
    const pending = migs.filter(
      (m) => m.version > current && m.version <= TARGET_VERSION,
    );

    console.log(
      `[migrate] schema_meta.version = ${current}. ` +
        `${pending.length} migration${pending.length === 1 ? "" : "s"} pending` +
        (DRY_RUN ? " (dry run — no writes)" : "") +
        ".",
    );

    if (!pending.length) {
      console.log("[migrate] up to date.");
      return;
    }

    for (const m of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), "utf8");
      console.log(`[migrate] ${m.file} (→ v${m.version})`);
      if (DRY_RUN) continue;
      // Each migration file already wraps itself in BEGIN/COMMIT, so
      // running it as one multi-statement query gets us per-file
      // atomicity: if anything fails partway through, the whole file
      // rolls back and we exit non-zero.
      try {
        await client.query(sql);
      } catch (err) {
        console.error(`[migrate] FAILED in ${m.file}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }

    if (!DRY_RUN) {
      const after = await getCurrentVersion(client);
      console.log(`[migrate] schema_meta.version is now ${after}.`);
    }
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error("[migrate] fatal:", err.message);
  process.exit(1);
});
