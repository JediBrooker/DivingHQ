#!/usr/bin/env node
//
// Schema-drift guard.
//
//   node scripts/check-schema-drift.js
//   node scripts/check-schema-drift.js --against divinghq_prod
//
// A DivingHQ database is born from init.sql, a snapshot pinned at
// schema_meta.version = 53, and then has migrations 054 onwards applied
// on top. Which means files 008..053 never run on a fresh install, and
// anything they create has to already be present in init.sql. Nothing
// enforced that. Over time init.sql drifted: it picked up an index no
// migration creates, and it lost three that migrations 025/040/041 do.
//
// This script re-asserts the invariant:
//
//   init.sql + (migrations above its stamp)   ==   init.sql + (every migration)
//
// It builds both databases from scratch in a scratch namespace, reads
// their catalogs, and diffs. Any object one has and the other doesn't is
// drift, and drift is a failure. As a bonus it proves every migration is
// re-runnable, since the right-hand side replays all of them over a
// schema that already contains their objects.
//
// `--against <database>` points the same comparison at a real database:
// build the canonical schema in scratch, then diff a live box against
// it. That's the one to reach for when a long-lived dev or production
// database starts behaving oddly, since those were bootstrapped years
// and several init.sql revisions ago.
//
// KNOWN BLIND SPOT: both sides of the default check start from init.sql,
// so a migration whose CREATE TABLE disagrees with init.sql's version of
// the same table is invisible here. Its CREATE TABLE IF NOT EXISTS is a
// no-op on both sides. Migration 030 vs init.sql's decision_method CHECK
// was exactly that, and it took `--against` on a real database to spot.
// Run that mode against something old before you trust a green default
// run.
//
// Needs CREATEDB. The postgres service user in CI has it; so does a
// local Homebrew superuser. Nothing else in the suite needs that, so
// this runs as its own CI step rather than inside `npm test`.

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const INIT_SQL = path.join(ROOT, "init.sql");

// Unique-ish so a crashed run doesn't wedge the next one. The suffix
// lands inside a CREATE/DROP DATABASE, wich can't take a bind param, so
// strip it down to characters that can't end a statement.
const SUFFIX = String(process.env.DRIFT_SUFFIX || process.pid).replace(/[^a-z0-9_]/gi, "");
const DB_A = `dhq_drift_a_${SUFFIX}`;   // the real bootstrap path
const DB_B = `dhq_drift_b_${SUFFIX}`;   // every migration replayed

const againstIdx = process.argv.indexOf("--against");
const AGAINST = againstIdx >= 0 ? process.argv[againstIdx + 1] : null;

function baseConn(database) {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    u.pathname = `/${database}`;
    return { connectionString: u.toString() };
  }
  return {
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    port:     process.env.DB_PORT,
    database,
  };
}

// The maintenance database we connect to in order to CREATE/DROP the
// scratch ones. `postgres` exists on every install worth the name.
const MAINT_DB = process.env.DRIFT_MAINT_DB || "postgres";

function migrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ file: f, version: Number(f.match(/^(\d+)/)[1]) }))
    .sort((a, b) => a.version - b.version);
}

async function withClient(database, fn) {
  const c = new Client(baseConn(database));
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function recreate(maint, name) {
  await maint.query(`DROP DATABASE IF EXISTS ${name}`);
  await maint.query(`CREATE DATABASE ${name}`);
}

// applied_migrations is the runner's own bookkeeping (scripts/migrate.js
// creates it, no migration does), so it isn't part of the schema under
// comparison. A canonical build never has it; a real database always
// does.
const IGNORED_TABLES = ["applied_migrations"];
const ignoreList = IGNORED_TABLES.map((t) => `'${t}'`).join(", ");

// Catalog snapshot. Deliberately not pg_dump: no binary dependency, and
// the output is already normalised into comparable strings.
const SNAPSHOT_QUERIES = {
  tables: `
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename NOT IN (${ignoreList})`,
  columns: `
    SELECT table_name || '.' || column_name || ' ' || data_type ||
           coalesce(' default ' || column_default, '') ||
           ' ' || is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name NOT IN (${ignoreList})`,
  indexes: `
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename NOT IN (${ignoreList})`,
  constraints: `
    SELECT conrelid::regclass::text || ' ' || conname || ' ' ||
           pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND conrelid::regclass::text NOT IN (${ignoreList})`,
  enums: `
    SELECT t.typname || ' = ' || e.enumlabel
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typnamespace = 'public'::regnamespace`,
};

async function snapshot(database) {
  return withClient(database, async (c) => {
    const out = {};
    for (const [kind, sql] of Object.entries(SNAPSHOT_QUERIES)) {
      const r = await c.query(sql);
      out[kind] = new Set(r.rows.map((row) => Object.values(row)[0]));
    }
    return out;
  });
}

async function applyFile(c, file) {
  await c.query(fs.readFileSync(file, "utf8"));
}

// Print the set difference both ways round. `leftLabel` owns the things
// only `left` has, and so on.
function report(left, right, leftMsg, rightMsg) {
  let problems = 0;
  for (const kind of Object.keys(SNAPSHOT_QUERIES)) {
    for (const x of [...right[kind]].filter((v) => !left[kind].has(v)).sort()) {
      console.error(`[drift] ${kind}: ${rightMsg}\n         ${x}`);
      problems++;
    }
    for (const x of [...left[kind]].filter((v) => !right[kind].has(v)).sort()) {
      console.error(`[drift] ${kind}: ${leftMsg}\n         ${x}`);
      problems++;
    }
  }
  return problems;
}

(async () => {
  const migs = migrations();
  const initSql = fs.readFileSync(INIT_SQL, "utf8");

  const maint = new Client(baseConn(MAINT_DB));
  await maint.connect();
  try {
    await recreate(maint, DB_A);
    if (!AGAINST) await recreate(maint, DB_B);
  } finally {
    await maint.end();
  }

  try {
    // ---- A: the path every real install takes ----------------
    const stamp = await withClient(DB_A, async (c) => {
      await c.query(initSql);
      const r = await c.query("SELECT version FROM public.schema_meta WHERE id = 1");
      const v = r.rows[0]?.version ?? 0;
      for (const m of migs.filter((m) => m.version > v)) {
        await applyFile(c, path.join(MIGRATIONS_DIR, m.file));
      }
      return v;
    });

    const canonical = await snapshot(DB_A);
    let problems = 0;

    if (AGAINST) {
      // ---- audit a real database against the canonical schema ----
      console.log(`[drift] comparing ${AGAINST} against a fresh init.sql + migrations build.\n`);
      const live = await snapshot(AGAINST);
      problems = report(
        live, canonical,
        `${AGAINST} has this, a fresh install doesn't. Probably left over from an older schema:`,
        `MISSING from ${AGAINST}. Run \`npm run migrate\`; if it persists, it needs a repair migration:`,
      );
      if (problems) {
        console.error(`\n[drift] ${AGAINST} differs from canonical in ${problems} place(s).`);
        process.exitCode = 1;
      } else {
        console.log(`[drift] ${AGAINST} matches the canonical schema exactly.`);
      }
      return;
    }

    // ---- B: init.sql, then replay every migration ------------
    // Doubles as the idempotency proof: 008..053 run over a schema
    // that already has their objects, and must not error.
    await withClient(DB_B, async (c) => {
      await c.query(initSql);
      for (const m of migs) {
        try {
          await applyFile(c, path.join(MIGRATIONS_DIR, m.file));
        } catch (err) {
          throw new Error(`${m.file} is not re-runnable: ${err.message}`);
        }
      }
    });

    const replayed = await snapshot(DB_B);

    console.log(
      `[drift] init.sql stamps v${stamp}; ` +
        `A applied ${migs.filter((m) => m.version > stamp).length} tail migration(s), ` +
        `B replayed all ${migs.length}.\n`,
    );

    problems = report(
      canonical, replayed,
      "init.sql has this, no migration creates it:",
      "a migration creates this, a fresh install never gets it:",
    );

    if (problems) {
      console.error(
        `\n[drift] ${problems} difference(s). init.sql and migrations/ disagree about the schema.\n` +
          "        Fix by adding the object to whichever side is missing it, usually a new\n" +
          "        forward migration (see migrations/084_repair_schema_drift.sql).",
      );
      process.exitCode = 1;
    } else {
      // Careful with the wording. Only 008..053 get re-applied over a schema
      // that already holds their objects, because init.sql is pinned at 53.
      // Everything above it ran exactly once just now, so this run says
      // nothing about whether 054+ are re-runnable. Several are not.
      console.log("[drift] no drift. Both bootstrap paths agree, and 008..053 re-ran cleanly over init.sql.");
    }
  } finally {
    const cleanup = new Client(baseConn(MAINT_DB));
    await cleanup.connect();
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${DB_A}`);
      await cleanup.query(`DROP DATABASE IF EXISTS ${DB_B}`);
    } finally {
      await cleanup.end();
    }
  }
})().catch((err) => {
  console.error("[drift] fatal:", err.message);
  process.exit(1);
});
