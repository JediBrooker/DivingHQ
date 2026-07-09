#!/usr/bin/env bash
#
# Verification script: exercises a few routes that should
# route to the replica + a few that should stay on the writer,
# then reports which DB each connection went through.
#
# How it works: pg's connection string accepts an
# `application_name` parameter. Set distinct names on the two
# pools (writer = "dive-recorder-writer", reader =
# "dive-recorder-reader") and we can can tell from pg_stat_activity
# which side of the wiring the connection landed on.
#
# Run from the ops/postgres-replica directory:
#     cd ops/postgres-replica && ./verify.sh
#
# Defaults to http://127.0.0.1:3000, override with HOST.
# Defaults to the local divinghq DB (override with DB_*).

set -euo pipefail

HOST="${HOST:-http://127.0.0.1:3000}"
DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-${USER}}"
DB_DATABASE="${DB_DATABASE:-divinghq_test}"

echo "Verifying read-replica wiring at $HOST"
echo "Comparing to primary at $DB_HOST/$DB_DATABASE"
echo

# ---- 1. Health check is on the writer ------------------------
echo "--- /api/health (should hit writer) ---"
curl -s "$HOST/api/health" | head -c 80; echo
echo

# ---- 2. Archive list is on the replica (when configured) ----
echo "--- /api/archive (should hit replica when DATABASE_READ_URL set) ---"
curl -s "$HOST/api/archive" -o /dev/null -w "HTTP %{http_code} %{size_download}B\n"
echo

# ---- 3. Snapshot pg_stat_activity to see who connected ------
#
# We look for distinct application_name values that the app
# sets on its two pools. If the writer-only deployment is in
# effect, there'll be one application_name, with a replica
# wired up, there'll be two (writer + reader).
echo "--- pg_stat_activity application_name groupings ---"
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_DATABASE" -tA -c "
  SELECT application_name, COUNT(*) AS conns,
         COALESCE(state, 'closed') AS state
  FROM pg_stat_activity
  WHERE application_name LIKE 'dive-recorder%'
  GROUP BY application_name, state
  ORDER BY application_name, state;
" 2>/dev/null || echo "(psql unavailable; install postgresql-client to run this check)"

echo
echo "Expected when DATABASE_READ_URL is set:"
echo "  - both 'dive-recorder-writer' and 'dive-recorder-reader' rows"
echo "  - reader rows hit only after touching /api/archive,"
echo "    /api/divers/:id/profile, /api/divers/:id/analytics"
echo
echo "Expected when DATABASE_READ_URL is unset:"
echo "  - only 'dive-recorder-writer' rows; the 'reader' alias"
echo "    is the same Pool object so pg_stat_activity collapses"
echo "    them under one application_name"
