#!/usr/bin/env bash
#
# reset-db.sh — DESTRUCTIVE full reset of the configured database.
#
# Wipes the ENTIRE `public` schema and rebuilds it from:
#     init.sql  ->  npm run migrate  ->  seed_test_data.sql
#
# Preserves ONLY the 'christianbrooker' account, restored as a SYSTEM
# SUPERUSER (is_system_admin = true; existing password hash + email
# kept; attached to the bootstrap 'Administration' org so the NOT NULL
# users.org_id FK is satisfied). Deletes the default 'admin'/'admin'
# account that init.sql creates.
#
# Connection is resolved exactly like server.js / scripts/migrate.js:
#   DATABASE_URL  (preferred)  else  DB_HOST/DB_USER/DB_PASSWORD/DB_DATABASE/DB_PORT
# read from the repo .env. Vars already set in the shell WIN over .env,
# so a dry-run can target a throwaway DB:  DB_DATABASE=foo ./scripts/reset-db.sh
#
# RUN THIS ON THE SERVER, FROM THE REPO ROOT, AFTER DEPLOYING LATEST CODE.
#   ./scripts/reset-db.sh            # prompts for confirmation
#   FORCE=1 ./scripts/reset-db.sh    # skip the prompt (careful)
#
set -euo pipefail

KEEP_USER="christianbrooker"
ADMIN_USER="admin"
BOOTSTRAP_ORG="00000000-0000-0000-0000-000000000001"   # init.sql 'Administration' org

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

echo "=================================================================="
echo "  DESTRUCTIVE DATABASE RESET"
echo "  Target : $DB_LABEL"
echo "  Wipes  : the ENTIRE public schema (all orgs, users, events, scores)"
echo "  Keeps  : only '$KEEP_USER'  (restored as a system superuser)"
echo "  Rebuild: init.sql -> migrate -> seed_test_data.sql"
echo "=================================================================="

# --- safety: keep-user must exist before we destroy anything ----------
exists="$(psql -tA ${CONN[@]+"${CONN[@]}"} -c "SELECT 1 FROM users WHERE username='${KEEP_USER}' LIMIT 1" 2>/dev/null || true)"
if [[ "$exists" != "1" ]]; then
  echo "ABORT: user '${KEEP_USER}' not found in the target DB."
  echo "       Refusing to wipe a DB that does not contain the keep-account."
  exit 1
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

echo "==> [1/7] Backup -> ${BACKUP}"
pg_dump ${CONN[@]+"${CONN[@]}"} > "$BACKUP"
echo "    $(wc -c < "$BACKUP") bytes"

echo "==> [2/7] Capturing '${KEEP_USER}'"
psql -tA ${CONN[@]+"${CONN[@]}"} -v keep="$KEEP_USER" -v org="$BOOTSTRAP_ORG" > "$KEEP_SQL" <<'SQL'
SELECT format(
  $f$INSERT INTO users (id, username, password, full_name, email, org_id, club_id, is_system_admin, email_verified_at, created_at) VALUES (%L,%L,%L,%L,%L,%L,NULL,true,now(),now());$f$,
  id, username, password, full_name, email, :'org')
FROM users WHERE username = :'keep';
SQL
grep -q "INSERT INTO users" "$KEEP_SQL" || { echo "ABORT: failed to capture '${KEEP_USER}'."; exit 1; }

echo "==> [3/7] Dropping & recreating schema public"
psql_run -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "==> [4/7] Applying init.sql"
psql_run -f init.sql

echo "==> [5/7] Migrating to latest schema"
npm run migrate

echo "==> [6/7] Loading seed_test_data.sql"
psql_run -f seed_test_data.sql

echo "==> [7/7] Restoring '${KEEP_USER}', removing default '${ADMIN_USER}'"
psql_run -f "$KEEP_SQL"
psql_run -c "DELETE FROM users WHERE username='${ADMIN_USER}' AND is_system_admin = true;"
rm -f "$KEEP_SQL"

echo "==> Verification"
psql ${CONN[@]+"${CONN[@]}"} -c "SELECT username, is_system_admin, (email_verified_at IS NOT NULL) AS email_verified, (password IS NOT NULL) AS has_password, org_id FROM users WHERE username IN ('${KEEP_USER}','${ADMIN_USER}') ORDER BY username;"
echo "    organisations: $(psql -tA ${CONN[@]+"${CONN[@]}"} -c 'SELECT count(*) FROM organisations')"
echo "    users:         $(psql -tA ${CONN[@]+"${CONN[@]}"} -c 'SELECT count(*) FROM users')"

echo ""
echo "Done. Backup: ${BACKUP}"
echo "Next: restart the app so it reconnects, e.g.  pm2 restart all --update-env"
