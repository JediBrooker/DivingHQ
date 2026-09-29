# shellcheck shell=bash
#
# Helpers shared by scripts/ops/backup-db.sh and scripts/ops/restore-check.sh.
# Sourced, never run. It only defines functions, so sourcing it has no side
# effects (test/ops-scripts.test.js leans on that to test them one by one).
#
# Written for the bash on the box (5.x) and the one macOS still ships (3.2),
# because the tests run the scripts on a dev Mac too. So: no mapfile, no
# ${var,,}, no associative arrays, and empty arrays only through ${a[@]+...}.

# ISO-8601 UTC, second precision. Same format the state files use.
ops_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 20260929T163000Z -> 2026-09-29T16:30:00Z, so a run can take one reading
# of the clock and use it both in a file name and in its state file.
ops_stamp_to_iso() {
  local s="$1"
  printf '%s-%s-%sT%s:%s:%sZ\n' "${s:0:4}" "${s:4:2}" "${s:6:2}" "${s:9:2}" "${s:11:2}" "${s:13:2}"
}

ops_log() { echo "[${OPS_TAG:-ops}] $(ops_now) $*"; }
ops_error() { echo "[${OPS_TAG:-ops}] $(ops_now) ERROR: $*" >&2; }

# Load KEY=value lines from an env file the way dotenv (so the app) reads
# it. A variable that's already set in the environment (even to "") wins,
# which is what lets a test or an operator point one run somewhere else
# (DB_DATABASE=... scripts/ops/backup-db.sh). Inside the file the LAST copy
# of a key wins, like dotenv: someone who appends DB_DATABASE=restored
# after a restore instead of editing the old line has moved the app, and
# the backup has to follow it rather than quietly keep dumping the old
# database. Handles `export KEY=`, quotes, `#` comments (an unquoted value
# stops at the first #, as in dotenv), CRLF and a last line with no
# newline. No variable expansion, same as dotenv.
ops_load_env() {
  local file="$1" line k v q ours=" "
  [[ -f "$file" && -r "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export}"
      line="${line#"${line%%[![:space:]]*}"}"
    fi
    [[ "$line" == *=* ]] || continue
    k="${line%%=*}"
    k="${k%"${k##*[![:space:]]}"}"
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # First sighting decides: set already means the environment had it,
    # so leave it alone every time. Otherwise it's ours from here on and a
    # later line in the file overwrites it.
    if [[ "$ours" != *" $k "* ]]; then
      [[ -n "${!k+x}" ]] && continue
      ours="$ours$k "
    fi
    v="${line#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    if [[ "$v" == \"* || "$v" == \'* ]]; then
      q="${v:0:1}"
      v="${v:1}"
      v="${v%%"$q"*}"
    else
      v="${v%%#*}"
      v="${v%"${v##*[![:space:]]}"}"
    fi
    export "$k=$v"
  done < "$file"
}

ops_urldecode() {
  local s="${1//\\/\\\\}"
  printf '%b' "${s//%/\\x}"
}

# DATABASE_URL -> PG* variables, so pg_dump and friends never get the
# password on their command line (where `ps` would show it). Covers what
# server.js accepts in practice: postgres[ql]://user:pass@host:port/db
# with percent-encoding, [v6] hosts and a few query parameters.
ops_parse_database_url() {
  local url="$1" rest query="" userinfo="" path="" user="" pass="" host="" port="" pair key val
  local pairs=()
  case "$url" in
    postgres://*|postgresql://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  if [[ "$rest" == *\?* ]]; then query="${rest#*\?}"; rest="${rest%%\?*}"; fi
  if [[ "$rest" == */* ]]; then path="${rest#*/}"; rest="${rest%%/*}"; fi
  if [[ "$rest" == *@* ]]; then userinfo="${rest%@*}"; rest="${rest##*@}"; fi
  if [[ -n "$userinfo" ]]; then
    if [[ "$userinfo" == *:* ]]; then user="${userinfo%%:*}"; pass="${userinfo#*:}"; else user="$userinfo"; fi
  fi
  if [[ "$rest" == \[* ]]; then
    host="${rest#[}"; host="${host%%]*}"
    rest="${rest#*]}"; port="${rest#:}"
  elif [[ "$rest" == *:* ]]; then
    host="${rest%:*}"; port="${rest##*:}"
  else
    host="$rest"
  fi
  if [[ -n "$query" ]]; then
    IFS='&' read -r -a pairs <<< "$query"
    for pair in ${pairs[@]+"${pairs[@]}"}; do
      key="${pair%%=*}"; val="${pair#*=}"
      case "$key" in
        host) host="$val" ;;
        port) port="$val" ;;
        user) user="$val" ;;
        password) pass="$val" ;;
        dbname) path="$val" ;;
        sslmode) export PGSSLMODE="$(ops_urldecode "$val")" ;;
        sslrootcert) export PGSSLROOTCERT="$(ops_urldecode "$val")" ;;
      esac
    done
  fi
  [[ -n "$host" ]] && export PGHOST="$(ops_urldecode "$host")"
  [[ -n "$port" ]] && export PGPORT="$(ops_urldecode "$port")"
  [[ -n "$user" ]] && export PGUSER="$(ops_urldecode "$user")"
  [[ -n "$pass" ]] && export PGPASSWORD="$(ops_urldecode "$pass")"
  [[ -n "$path" ]] && export PGDATABASE="$(ops_urldecode "$path")"
  return 0
}

# Point libpq (pg_dump, pg_restore, psql) at the app's database the way
# server.js finds it: DATABASE_URL, else DB_*, each falling back to any
# PG* already in the environment. Leaves the name in PGDATABASE.
ops_resolve_db() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    ops_parse_database_url "$DATABASE_URL" || { ops_error "DATABASE_URL isn't a postgres:// URL"; return 1; }
  else
    [[ -n "${DB_HOST:-}" ]] && export PGHOST="$DB_HOST"
    [[ -n "${DB_PORT:-}" ]] && export PGPORT="$DB_PORT"
    [[ -n "${DB_USER:-}" ]] && export PGUSER="$DB_USER"
    [[ -n "${DB_PASSWORD:-}" ]] && export PGPASSWORD="$DB_PASSWORD"
    [[ -n "${DB_DATABASE:-}" ]] && export PGDATABASE="$DB_DATABASE"
  fi
  if [[ -z "${PGDATABASE:-}" ]]; then
    ops_error "no database name: set DB_DATABASE (or DATABASE_URL) in the app's .env"
    return 1
  fi
  # A dead or firewalled server should fail the run, not hang cron.
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
  export PGAPPNAME="divinghq-${OPS_TAG:-ops}"
  return 0
}

# One run at a time per BACKUP_DIR: a backup never prunes the dump a
# restore check is reading, and cron plus a hand-run can't collide.
# Skipped where flock isn't installed (macOS), the box has util-linux.
ops_lock() {
  local file="$1" wait_s="${2:-1800}"
  command -v flock > /dev/null 2>&1 || return 0
  exec 9> "$file" || return 1
  if ! flock -w "$wait_s" 9; then
    ops_error "another backup or restore check still holds $file after ${wait_s}s"
    return 1
  fi
}

# Write a state file for GET /api/ops/status. Temp file in the same
# directory, then rename, so the server never reads half a file. World
# readable on purpose: nothing secret goes in, and the app may not run as
# the user cron does.
ops_write_state() {
  local file="$1" content="$2" dir tmp
  dir="$(dirname "$file")"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir" && chmod 0755 "$dir" || return 1
  fi
  tmp="$(mktemp "$dir/.$(basename "$file").XXXXXX")" || return 1
  if printf '%s\n' "$content" > "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$file"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# Reads one field back from a state file we wrote earlier (compact JSON,
# our own format, so a regex is enough). Prints nothing if it's missing
# or doesn't look right.
ops_prev_iso() {
  local file="$1" key="$2" v re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
  [[ -r "$file" ]] || return 0
  v="$(sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p" "$file" | head -n 1)"
  [[ "$v" =~ $re ]] && echo "$v"
  return 0
}
ops_prev_int() {
  local file="$1" key="$2" v
  [[ -r "$file" ]] || return 0
  v="$(sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\1/p" "$file" | head -n 1)"
  [[ "$v" =~ ^[0-9]+$ ]] && echo "$v"
  return 0
}

# "x" -> "\"x\"", "" -> null. Only ever handed timestamps and fixed words.
ops_json_str() { if [[ -n "$1" ]]; then printf '"%s"' "$1"; else printf 'null'; fi; }
ops_json_int() { if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi; }

# Is a restored row count believable next to the live one? A backup is at
# most a day or so behind, so rows come and go a little. Fine when the two
# are within RESTORE_CHECK_SLACK_ROWS of each other, or the restored count
# is between RESTORE_CHECK_MIN_PCT and RESTORE_CHECK_MAX_PCT of live. An
# empty restore of a table that has rows is never fine.
ops_counts_close() {
  local live="$1" restored="$2"
  local min_pct="${RESTORE_CHECK_MIN_PCT:-50}" max_pct="${RESTORE_CHECK_MAX_PCT:-200}" slack="${RESTORE_CHECK_SLACK_ROWS:-25}"
  [[ "$live" =~ ^[0-9]+$ && "$restored" =~ ^[0-9]+$ ]] || return 1
  if (( live > 0 && restored == 0 )); then return 1; fi
  local diff=$(( live > restored ? live - restored : restored - live ))
  (( diff <= slack )) && return 0
  (( restored * 100 >= live * min_pct && restored * 100 <= live * max_pct ))
}

# The dump names backup-db.sh writes, and nothing else. Retention and the
# restore check only ever touch files that match.
OPS_DUMP_RE='^divinghq-[0-9]{8}T[0-9]{6}Z\.dump$'

# Prints our dumps in BACKUP_DIR oldest first, one per line. With LC_ALL=C
# the glob sorts by name, and the name is the UTC time.
ops_list_dumps() {
  local dir="$1" f
  for f in "$dir"/divinghq-*.dump; do
    [[ -f "$f" ]] || continue
    [[ "$(basename "$f")" =~ $OPS_DUMP_RE ]] && echo "$f"
  done
  return 0
}
