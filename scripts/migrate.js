#!/usr/bin/env node
//
// Migration runner.
//
//   npm run migrate               : apply every pending migration
//   npm run migrate -- --dry      : print what would run, don't change anything
//   npm run migrate -- --to 12    : stop after 0NN_*.sql where NN <= 12
//   npm run migrate -- --status   : print the ledger, don't change anything
//   npm run migrate -- --redo 51  : re-apply specific migrations (comma separated)
//
// WHAT RAN IS RECORDED PER FILE
// -----------------------------
// This used to trust a single integer, schema_meta.version: apply every
// 0NN_*.sql with NN greater than it, then stamp the new max. That reads
// fine until you notice it can't distinguish "migration 051 ran" from
// "some other migration stamped the version past 51". Both look the same.
//
// And they diverged for real. init.sql is a snapshot pinned at version
// 53, so a database bootstrapped from it skips files 008..053 entirely.
// When somebody later backported migration 051's table into init.sql
// (commit c86be38), every database created from the *previous* init.sql
// was left without that table permanently, and no amount of
// `npm run migrate` could repair it: 51 <= 53, so the file never ran
// again. See migration 084 for the full autopsy.
//
// So the runner now keeps public.applied_migrations, one row per file,
// with a checksum. Pending is "not in the ledger", not "above a number".
// On first contact with a legacy database the ledger is backfilled from
// schema_meta.version and every backfilled row is marked as such, since
// we're asserting those files ran without ever having watched them.
//
// schema_meta.version is still maintained, because server.js logs it on
// boot and a couple of tests read it. It's a mirror of max(ledger) now,
// not the source of truth.
//
// Re-applying is safe. Every file in migrations/ is written with
// IF NOT EXISTS / ON CONFLICT / guarded DO blocks, and
// scripts/check-schema-drift.js proves it in CI by replaying the lot.
//
// Connection: same env as server.js, DATABASE_URL takes precedence,
// otherwise the standard libpq vars (DB_HOST/DB_USER/DB_PASSWORD/
// DB_NAME/DB_PORT). dotenv is loaded so a dev can `npm run
// migrate` against a .env without exporting anything by hand.

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry") || args.includes("--dry-run");
const STATUS_ONLY = args.includes("--status");
const toIdx = args.indexOf("--to");
const TARGET_VERSION = toIdx >= 0 ? Number(args[toIdx + 1]) : Infinity;
const redoIdx = args.indexOf("--redo");
const REDO = redoIdx >= 0
  ? String(args[redoIdx + 1] || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n))
  : [];

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Pull the version-prefix off "0NN_<name>.sql".
function parseVersion(filename) {
  const m = filename.match(/^(\d+)_.*\.sql$/);
  return m ? Number(m[1]) : null;
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, version: parseVersion(f) }))
    .filter((m) => m.version !== null)
    .sort((a, b) => a.version - b.version)
    .map((m) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), "utf8");
      return { ...m, sql, checksum: checksum(sql) };
    });
}

// The ledger has to exist before we can ask it anything, so it can't
// itself be a migration. Cheap enough to ensure on every run.
async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.applied_migrations (
      version    integer PRIMARY KEY,
      filename   text        NOT NULL,
      checksum   text        NOT NULL,
      backfilled boolean     NOT NULL DEFAULT false,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getLegacyVersion(client) {
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

async function readLedger(client) {
  const r = await client.query(
    "SELECT version, filename, checksum, backfilled FROM public.applied_migrations",
  );
  return new Map(r.rows.map((row) => [row.version, row]));
}

// First run against a database that predates the ledger. We can't know
// which files really ran, only what the old integer claimed, so record
// everything at or below it and flag the rows as assumed rather than
// observed. Migration 084 exists precisely because that assumption was
// wrong for at least one file.
async function backfillLedger(client, migs, legacyVersion) {
  const assumed = migs.filter((m) => m.version <= legacyVersion);
  if (!assumed.length) return 0;
  for (const m of assumed) {
    await client.query(
      `INSERT INTO public.applied_migrations (version, filename, checksum, backfilled)
       VALUES ($1, $2, $3, true) ON CONFLICT (version) DO NOTHING`,
      [m.version, m.file, m.checksum],
    );
  }
  return assumed.length;
}

// Keep schema_meta in step with the ledger. Re-applying an old file
// rewinds schema_meta.version, because each migration stamps its own
// number on the way out, so put it back afterwards.
async function syncSchemaMeta(client) {
  await client.query(`
    UPDATE public.schema_meta
       SET version = (SELECT max(version) FROM public.applied_migrations)
     WHERE id = 1
       AND version <> (SELECT max(version) FROM public.applied_migrations)
  `);
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

async function printStatus(client, migs, ledger) {
  const legacy = await getLegacyVersion(client);
  console.log(`[migrate] schema_meta.version = ${legacy}, ledger holds ${ledger.size} row(s).\n`);
  for (const m of migs) {
    const row = ledger.get(m.version);
    let state;
    if (!row) state = "PENDING";
    else if (row.checksum !== m.checksum) state = row.backfilled ? "backfilled*" : "APPLIED*";
    else state = row.backfilled ? "backfilled" : "applied";
    console.log(`  v${String(m.version).padStart(3, "0")}  ${state.padEnd(12)} ${m.file}`);
  }
  const drifted = migs.filter((m) => {
    const row = ledger.get(m.version);
    return row && row.checksum !== m.checksum;
  });
  if (drifted.length) {
    console.log(
      `\n[migrate] * ${drifted.length} file(s) changed on disk since they were recorded. ` +
        "That's expected for comment-only edits; re-read the diff if it isn't one.",
    );
  }
}

(async () => {
  const client = makeClient();
  await client.connect();
  try {
    const migs = listMigrations();
    await ensureLedger(client);

    let ledger = await readLedger(client);
    if (ledger.size === 0) {
      const legacy = await getLegacyVersion(client);
      if (legacy > 0 && !DRY_RUN && !STATUS_ONLY) {
        const n = await backfillLedger(client, migs, legacy);
        console.log(
          `[migrate] no ledger found. Backfilled ${n} row(s) from schema_meta.version = ${legacy}.`,
        );
        ledger = await readLedger(client);
      } else if (legacy > 0) {
        console.log(
          `[migrate] no ledger found; would backfill from schema_meta.version = ${legacy}.`,
        );
      }
    }

    if (STATUS_ONLY) {
      await printStatus(client, migs, ledger);
      return;
    }

    // Warn about files whose contents moved after they were recorded.
    // Not fatal: this repo does comment sweeps across migrations/, and
    // failing the deploy over a reworded comment would be obnoxious.
    for (const m of migs) {
      const row = ledger.get(m.version);
      if (row && row.checksum !== m.checksum) {
        console.warn(
          `[migrate] warning: ${m.file} changed since it was applied ` +
            `(${row.checksum} -> ${m.checksum}).`,
        );
      }
    }

    let pending;
    if (REDO.length) {
      pending = migs.filter((m) => REDO.includes(m.version));
      const unknown = REDO.filter((v) => !migs.some((m) => m.version === v));
      if (unknown.length) {
        console.error(`[migrate] --redo: no such migration(s): ${unknown.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      console.log(`[migrate] --redo: re-applying ${pending.map((m) => m.file).join(", ")}`);
    } else {
      pending = migs.filter(
        (m) => !ledger.has(m.version) && m.version <= TARGET_VERSION,
      );
    }

    console.log(
      `[migrate] ${pending.length} migration${pending.length === 1 ? "" : "s"} to apply` +
        (DRY_RUN ? " (dry run, no writes)" : "") +
        ".",
    );

    if (!pending.length) {
      console.log("[migrate] up to date.");
      return;
    }

    for (const m of pending) {
      console.log(`[migrate] ${m.file} (v${m.version})`);
      if (DRY_RUN) continue;
      // Each migration file already wraps itself in BEGIN/COMMIT, so
      // running it as one multi-statement query gets us per-file
      // atomicity: if anything fails partway through, the whole file
      // rolls back and we exit non-zero.
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO public.applied_migrations (version, filename, checksum, backfilled, applied_at)
           VALUES ($1, $2, $3, false, now())
           ON CONFLICT (version) DO UPDATE
             SET filename = EXCLUDED.filename,
                 checksum = EXCLUDED.checksum,
                 backfilled = false,
                 applied_at = EXCLUDED.applied_at`,
          [m.version, m.file, m.checksum],
        );
      } catch (err) {
        console.error(`[migrate] FAILED in ${m.file}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
    }

    if (!DRY_RUN) {
      await syncSchemaMeta(client);
      const after = await getLegacyVersion(client);
      console.log(`[migrate] done. schema_meta.version is now ${after}.`);
    }
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error("[migrate] fatal:", err.message);
  process.exit(1);
});
