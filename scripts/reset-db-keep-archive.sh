#!/usr/bin/env bash
#
# reset-db-keep-archive.sh — DESTRUCTIVE reset to a CLEAN-SLATE database.
#
# Like scripts/reset-db.sh, but built for a real production "start from
# scratch" rather than a test-seeded reset. Two differences:
#
#   1. PRESERVES the DiveRecorder archive (the dr_* tables that
#      lib/diverecorder-import.js fills from diverecorder.co.uk). These
#      are dumped before the wipe and restored after the schema is
#      rebuilt. The archive is the expensive-to-refetch part, so the
#      script ABORTS before touching anything if it can't capture it.
#
#   2. DOES NOT load seed_test_data.sql. The rebuilt DB contains only:
#        * the baseline schema (init.sql) at the latest migration,
#        * the dive_directory reference data (from init.sql),
#        * the preserved DiveRecorder archive,
#        * the kept super-admin account.
#      No demo orgs / meets / divers / scores.
#
# Preserves the '$KEEP_USER' account as a SYSTEM SUPERUSER
# (is_system_admin = true; existing password hash + email kept; attached
# to the bootstrap 'Administration' org so the NOT NULL users.org_id FK is
# satisfied). is_system_admin = true alone grants full access — every
# org-role gate in lib/middleware.js short-circuits on it — so no
# user_org_roles row is needed. Deletes the default 'admin'/'admin'
# account that init.sql creates.
#
# Connection is resolved exactly like server.js / scripts/migrate.js:
#   DATABASE_URL  (preferred)  else  DB_HOST/DB_USER/DB_PASSWORD/DB_DATABASE/DB_PORT
# read from the repo .env. Vars already set in the shell WIN over .env,
# so a dry-run can target a throwaway DB:  DB_DATABASE=foo ./scripts/reset-db-keep-archive.sh
#
# RUN THIS ON THE SERVER, FROM THE REPO ROOT, AFTER DEPLOYING LATEST CODE.
#   ./scripts/reset-db-keep-archive.sh            # prompts for confirmation
#   FORCE=1 ./scripts/reset-db-keep-archive.sh    # skip the prompt (careful)
#
set -euo pipefail

KEEP_USER="${KEEP_USER:-christianbrooker}"
ADMIN_USER="admin"
BOOTSTRAP_ORG="00000000-0000-0000-0000-000000000001"   # init.sql 'Administration' org
# DiveRecorder archive tables, parent-first. lib/diverecorder-import.js
# is the only writer; migrations 059/060 are the only schema. The FK
# graph is self-contained (no references out to operational tables).
DR_TABLES=(dr_meets dr_events dr_divers dr_results dr_dives)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- load .env with dotenv semantics (already-set vars win) ------------
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue   # skip comments/blanks
    [[ -n "${!k:-}" ]] && continue                       # don't clobber pre-set
    v="${v%$'\r'}"
    if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
    export "$k=$v"
  done < .env
fi

# --- connection for psql / pg_dump ------------------------------------
if [[ -n "${DATABASE_URL:-}" ]]; then
  CONN=( "$DATABASE_URL" )
  DB_LABEL="(DATABASE_URL)"
else
  : "${DB_USER:?DB_USER not set (and no DATABASE_URL)}"
  : "${DB_DATABASE:?DB_DATABASE not set (and no DATABASE_URL)}"
  export PGHOST="${DB_HOST:-localhost}" PGPORT="${DB_PORT:-5432}"
  export PGUSER="$DB_USER" PGDATABASE="$DB_DATABASE"
  [[ -n "${DB_PASSWORD:-}" ]] && export PGPASSWORD="$DB_PASSWORD"
  CONN=()
  DB_LABEL="$PGDATABASE @ $PGHOST:$PGPORT"
fi
psql_run() { psql -v ON_ERROR_STOP=1 ${CONN[@]+"${CONN[@]}"} "$@"; }
psql_val() { psql -tA ${CONN[@]+"${CONN[@]}"} -c "$1"; }

# --- sum the archive row counts (0 if a table is absent) --------------
archive_total() {
  local t total=0 c
  for t in "${DR_TABLES[@]}"; do
    if [[ "$(psql_val "SELECT to_regclass('public.$t') IS NOT NULL")" == "t" ]]; then
      c="$(psql_val "SELECT count(*) FROM $t")"
      total=$(( total + c ))
    fi
  done
  echo "$total"
}

echo "=================================================================="
echo "  DESTRUCTIVE DATABASE RESET — clean slate, archive preserved"
echo "  Target : $DB_LABEL"
echo "  Wipes  : the ENTIRE public schema (all orgs, users, events, scores)"
echo "  Keeps  : '$KEEP_USER' (system superuser) + the dr_* DiveRecorder archive"
echo "  Rebuild: init.sql -> migrate   (NO seed_test_data.sql)"
echo "=================================================================="

# --- safety: keep-user must exist before we destroy anything ----------
exists="$(psql -tA ${CONN[@]+"${CONN[@]}"} -c "SELECT 1 FROM users WHERE username='${KEEP_USER}' LIMIT 1" 2>/dev/null || true)"
if [[ "$exists" != "1" ]]; then
  echo "ABORT: user '${KEEP_USER}' not found in the target DB."
  echo "       Refusing to wipe a DB that does not contain the keep-account."
  echo "       (Override the username with  KEEP_USER=you ./scripts/reset-db-keep-archive.sh)"
  exit 1
fi

# --- report what the archive holds before we promise to keep it -------
PRE_DR_TOTAL="$(archive_total)"
echo "DiveRecorder archive rows (pre-reset):"
for t in "${DR_TABLES[@]}"; do
  if [[ "$(psql_val "SELECT to_regclass('public.$t') IS NOT NULL")" == "t" ]]; then
    printf '    %-12s %s\n' "$t" "$(psql_val "SELECT count(*) FROM $t")"
  else
    printf '    %-12s %s\n' "$t" "(table absent)"
  fi
done
echo "    -----------"
printf '    %-12s %s\n' "TOTAL" "$PRE_DR_TOTAL"
if [[ "$PRE_DR_TOTAL" -eq 0 ]]; then
  echo "WARNING: the archive is empty. Nothing to preserve there — the dr_*"
  echo "         tables will simply be rebuilt empty. Continue only if that's"
  echo "         expected (e.g. the importer hasn't run yet)."
fi

# --- confirmation ------------------------------------------------------
if [[ "${FORCE:-0}" != "1" ]]; then
  printf "Type exactly  RESET %s  to proceed: " "$KEEP_USER"
  read -r ans
  [[ "$ans" == "RESET ${KEEP_USER}" ]] || { echo "Aborted."; exit 1; }
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="backup-before-reset-${TS}.sql"
KEEP_SQL="/tmp/reset-keep-${KEEP_USER}-${TS}.sql"
ARCHIVE_SQL="/tmp/reset-dr-archive-${TS}.sql"

echo "==> [1/8] Full backup -> ${BACKUP}"
pg_dump ${CONN[@]+"${CONN[@]}"} > "$BACKUP"
echo "    $(wc -c < "$BACKUP") bytes"

echo "==> [2/8] Capturing '${KEEP_USER}'"
psql -tA ${CONN[@]+"${CONN[@]}"} -v keep="$KEEP_USER" -v org="$BOOTSTRAP_ORG" > "$KEEP_SQL" <<'SQL'
SELECT format(
  $f$INSERT INTO users (id, username, password, full_name, email, org_id, club_id, is_system_admin, email_verified_at, created_at) VALUES (%L,%L,%L,%L,%L,%L,NULL,true,now(),now());$f$,
  id, username, password, full_name, email, :'org')
FROM users WHERE username = :'keep';
SQL
grep -q "INSERT INTO users" "$KEEP_SQL" || { echo "ABORT: failed to capture '${KEEP_USER}'."; exit 1; }

echo "==> [3/8] Dumping DiveRecorder archive (data-only) -> ${ARCHIVE_SQL}"
# --data-only: the schema is recreated by migrations 059/060 at step 6.
# pg_dump topologically sorts the -t tables so parents (dr_meets,
# dr_divers) load before children (dr_results, dr_dives) — FK-safe.
# Schema-qualified COPYs, so the restore is search_path-independent.
pg_dump ${CONN[@]+"${CONN[@]}"} --data-only --no-owner --no-privileges \
  -t dr_meets -t dr_events -t dr_divers -t dr_results -t dr_dives \
  > "$ARCHIVE_SQL"
echo "    $(wc -c < "$ARCHIVE_SQL") bytes"
if [[ "$PRE_DR_TOTAL" -gt 0 ]] && ! grep -q "COPY " "$ARCHIVE_SQL"; then
  echo "ABORT: archive had ${PRE_DR_TOTAL} rows but the dump has no COPY data."
  echo "       Refusing to wipe — fix the dump before proceeding."
  exit 1
fi

echo "==> [4/8] Dropping & recreating schema public"
psql_run -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "==> [5/8] Applying init.sql"
psql_run -f init.sql

echo "==> [6/8] Migrating to latest schema (recreates empty dr_* tables)"
npm run migrate

echo "==> [7/8] Restoring DiveRecorder archive"
psql_run -f "$ARCHIVE_SQL"

echo "==> [8/8] Restoring '${KEEP_USER}', removing default '${ADMIN_USER}'"
psql_run -f "$KEEP_SQL"
psql_run -c "DELETE FROM users WHERE username='${ADMIN_USER}' AND is_system_admin = true;"
rm -f "$KEEP_SQL"

echo "==> Verification"
psql ${CONN[@]+"${CONN[@]}"} -c "SELECT username, is_system_admin, (email_verified_at IS NOT NULL) AS email_verified, (password IS NOT NULL) AS has_password, org_id FROM users WHERE username IN ('${KEEP_USER}','${ADMIN_USER}') ORDER BY username;"
echo "    organisations: $(psql_val 'SELECT count(*) FROM organisations')"
echo "    users:         $(psql_val 'SELECT count(*) FROM users')"
POST_DR_TOTAL="$(archive_total)"
echo "    archive rows:  ${POST_DR_TOTAL}  (pre-reset: ${PRE_DR_TOTAL})"
if [[ "$POST_DR_TOTAL" != "$PRE_DR_TOTAL" ]]; then
  echo "    !! ARCHIVE COUNT MISMATCH — inspect before trusting this reset."
  echo "    !! Full backup is at: ${BACKUP}"
fi

echo ""
echo "Done. Backup: ${BACKUP}   Archive dump: ${ARCHIVE_SQL}"
echo "Next: restart the app so it reconnects, e.g.  pm2 restart dive-recorder --update-env"
