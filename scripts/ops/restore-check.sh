#!/usr/bin/env bash
#
# Weekly proof that the backups restore. ops/backups/README.md has the
# operator's side; this is what it does:
#
#   1. Picks the newest divinghq-*.dump in BACKUP_DIR (what backup-db.sh
#      leaves there).
#   2. Drops and recreates a scratch database, RESTORE_CHECK_DB
#      (divinghq_restore_check), and pg_restores the dump into it in one
#      transaction, stopping at the first error.
#   3. Compares it with the live database: schema_meta.version has to
#      match, and the row counts of a few core tables have to be close
#      (ops_counts_close in common.sh says what close means).
#   4. Drops the scratch database again, whatever happened, and writes
#      OPS_STATE_DIR/restore-check.json ({ last_run_at, ok }) for
#      GET /api/ops/status.
#
# It only ever drops the scratch database. It refuses to start when the
# scratch name is the live database's, and it won't drop anything whose
# name doesn't say restore_check, so a typo in RESTORE_CHECK_DB can't
# take out a real database.
#
# The app's database role needs CREATEDB for step 2 (or run it as a role
# that has it). The README has the one-line grant.
#
# A version mismatch usually means a deploy migrated the live database
# after the dump was taken. Run backup-db.sh and then this again.
#
# Exits non-zero when the check fails. Same connection rules and settings
# as backup-db.sh, plus:
#   RESTORE_CHECK_DB           divinghq_restore_check
#   RESTORE_CHECK_MIN_PCT      50   restored rows at least this % of live
#   RESTORE_CHECK_MAX_PCT      200  and at most this %
#   RESTORE_CHECK_SLACK_ROWS   25   ...unless the two are this close anyway

set -euo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$SCRIPT_DIR/common.sh"
OPS_TAG=restore-check

ops_load_env "${DIVINGHQ_ENV_FILE:-$REPO_ROOT/.env}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/divinghq}"
OPS_STATE_DIR="${OPS_STATE_DIR:-/var/lib/divinghq}"
SCRATCH="${RESTORE_CHECK_DB:-divinghq_restore_check}"
STATE_FILE="$OPS_STATE_DIR/restore-check.json"
# The tables the counts are compared on. Every install has rows in them.
TABLES=(users organisations meets events scores)

STARTED_AT="$(ops_now)"
OK=false
SCRATCH_CREATED=0
LIVE_DB=""

# Quiet about "database ... does not exist, skipping" and the like.
psql_q() { PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
psql_val() { psql -X -tA -v ON_ERROR_STOP=1 "$@"; }

finish() {
  local rc=$?
  set +e
  if [[ $SCRATCH_CREATED -eq 1 ]]; then
    if psql_q -d "$LIVE_DB" -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)"; then
      ops_log "dropped scratch database $SCRATCH"
    else
      ops_error "couldn't drop the scratch database $SCRATCH, drop it by hand"
      OK=false
    fi
  fi
  if ! ops_write_state "$STATE_FILE" "{\"last_run_at\":$(ops_json_str "$STARTED_AT"),\"ok\":$OK}"; then
    ops_error "couldn't write $STATE_FILE, the status page won't show this run"
    rc=1
  fi
  [[ "$OK" != true && $rc -eq 0 ]] && rc=1
  if [[ $rc -eq 0 ]]; then ops_log "restore check passed"; else ops_error "restore check FAILED"; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---- preflight -------------------------------------------------------
ops_resolve_db
LIVE_DB="$PGDATABASE"
if [[ "$(lower "$SCRATCH")" == "$(lower "$LIVE_DB")" ]]; then
  ops_error "RESTORE_CHECK_DB ($SCRATCH) is the live database, refusing"
  exit 1
fi
if [[ ! "$SCRATCH" =~ ^[a-z_][a-z0-9_]{0,62}$ || "$SCRATCH" != *restore_check* ]]; then
  ops_error "RESTORE_CHECK_DB must be a plain lowercase name containing restore_check (got $SCRATCH), refusing"
  exit 1
fi
for tool in pg_restore psql; do
  command -v "$tool" > /dev/null 2>&1 || { ops_error "$tool isn't installed (apt install postgresql-client)"; exit 1; }
done
[[ -d "$BACKUP_DIR" ]] || { ops_error "no backup directory at $BACKUP_DIR, has backup-db.sh run?"; exit 1; }
ops_lock "$BACKUP_DIR/.divinghq-ops.lock" "${OPS_LOCK_WAIT:-3600}"

DUMP="$(ops_list_dumps "$BACKUP_DIR" | tail -n 1)"
if [[ -z "$DUMP" ]]; then
  ops_error "no divinghq-*.dump in $BACKUP_DIR to check"
  exit 1
fi
ops_log "checking $(basename "$DUMP") against the live database $LIVE_DB"

can_create="$(psql_val -d "$LIVE_DB" -c "SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user")"
if [[ "$can_create" != t ]]; then
  ops_error "the database role can't create databases; grant it CREATEDB (ops/backups/README.md)"
  exit 1
fi

# ---- restore -----------------------------------------------------------
SCRATCH_CREATED=1
psql_q -d "$LIVE_DB" -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" -c "CREATE DATABASE \"$SCRATCH\""
ops_log "restoring into $SCRATCH"
pg_restore --no-owner --no-privileges --single-transaction --exit-on-error --dbname="$SCRATCH" "$DUMP"

# ---- compare -------------------------------------------------------------
VERSION_SQL="SELECT version FROM public.schema_meta WHERE id = 1"
live_version="$(psql_val -d "$LIVE_DB" -c "$VERSION_SQL")"
restored_version="$(psql_val -d "$SCRATCH" -c "$VERSION_SQL")"
if [[ -z "$restored_version" || "$restored_version" != "$live_version" ]]; then
  ops_error "schema version: restored ${restored_version:-none}, live ${live_version:-none}. If a deploy migrated since the dump, run backup-db.sh and check again."
  exit 1
fi
ops_log "schema version $live_version matches"

COUNT_SQL="SELECT concat_ws(' '"
for t in "${TABLES[@]}"; do COUNT_SQL="$COUNT_SQL, (SELECT count(*) FROM public.$t)"; done
COUNT_SQL="$COUNT_SQL)"
read -r -a live_counts <<< "$(psql_val -d "$LIVE_DB" -c "$COUNT_SQL")"
read -r -a restored_counts <<< "$(psql_val -d "$SCRATCH" -c "$COUNT_SQL")"
bad=0
for i in "${!TABLES[@]}"; do
  live="${live_counts[$i]:-}"
  restored="${restored_counts[$i]:-}"
  if ops_counts_close "$live" "$restored"; then
    ops_log "${TABLES[$i]}: live ${live}, restored ${restored}"
  else
    ops_error "${TABLES[$i]}: live ${live:-?}, restored ${restored:-?}, too far apart"
    bad=1
  fi
done
[[ $bad -eq 0 ]] || exit 1

OK=true
