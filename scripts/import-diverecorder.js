#!/usr/bin/env node
//
// DiveRecorder Meet Explorer archive importer (CLI wrapper).
//
// The pipeline lives in lib/diverecorder-import.js so the same code
// powers the sysadmin "import now" button and the scheduled sync.
// This script is the operator-facing front end for backfills.
//
//   npm run import:diverecorder -- --limit 5 --dry    parse first 5 meets, write nothing
//   npm run import:diverecorder -- --limit 5           import first 5 meets
//   npm run import:diverecorder -- --meet 1000         import a single meet (by mref)
//   npm run import:diverecorder -- --new               only import meets not yet stored
//   npm run import:diverecorder -- --nat GBR,AUS       restrict to these countries
//   npm run import:diverecorder                        full backfill (hours; polite)
//
// Politeness (robots.txt for /meetexplorer/ allows User-agent: *):
// single-threaded with a configurable delay (--delay ms, default
// 800), identifying UA, backoff on 429/5xx, and an on-disk HTML cache
// under scripts/.dr-cache so re-runs/resumes don't re-hit the server.
//
// Connection: same env as scripts/migrate.js — DATABASE_URL or the
// standard libpq vars.

require("dotenv").config();
const { Client } = require("pg");
const { createHttpFetcher, importArchive } = require("../lib/diverecorder-import");
const { COUNTRIES } = require("../lib/diverecorder-parser");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
function opt(n, dflt) {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const DRY_RUN = flag("dry") || flag("dry-run");
const NO_CACHE = flag("no-cache");
const ONLY_NEW = flag("new");
const LIMIT = opt("limit", null) ? Number(opt("limit", null)) : null;
const SINGLE_MEET = opt("meet", null) ? Number(opt("meet", null)) : null;
const DELAY_MS = Number(opt("delay", "800"));
const CONCURRENCY = Math.max(1, Number(opt("concurrency", "1")));
const NAT = opt("nat", null);

async function main() {
  console.log(
    `DiveRecorder importer — ${DRY_RUN ? "DRY RUN" : "WRITE"}; delay ${DELAY_MS}ms; ` +
      `concurrency ${CONCURRENCY}${NO_CACHE ? "; cache off" : ""}${ONLY_NEW ? "; only-new" : ""}`,
  );

  const countries = NAT
    ? COUNTRIES.filter((c) => NAT.split(",").map((s) => s.trim().toUpperCase()).includes(c.nat))
    : COUNTRIES;

  const fetchHtml = createHttpFetcher({
    delayMs: DELAY_MS,
    noCache: NO_CACHE,
    log: (m) => console.log(m),
  });

  const client = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.DB_HOST,
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
          port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        },
  );
  if (!DRY_RUN) await client.connect();

  try {
    await importArchive(DRY_RUN ? { query: async () => ({ rows: [] }) } : client, fetchHtml, {
      onlyNew: ONLY_NEW,
      limitMeets: LIMIT,
      meetRefs: SINGLE_MEET !== null ? [SINGLE_MEET] : null,
      countries,
      dryRun: DRY_RUN,
      concurrency: CONCURRENCY,
      log: (m) => console.log(m),
    });
  } finally {
    if (!DRY_RUN) await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
