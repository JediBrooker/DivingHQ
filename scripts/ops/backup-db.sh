#!/usr/bin/env bash
#
# Nightly database backup. ops/backups/README.md is the operator's guide
# (install, R2 setup, restore runbook); this is what the script does.
#
#   1. pg_dump -Fc of the app's database into BACKUP_DIR as
#      divinghq-<UTC stamp>.dump. It's written under a temp name and only
#      renamed once `pg_restore --list` can read it back and finds
#      schema_meta in it, so a half-written or wrong dump never counts as
#      a backup and never pushes a good one out of retention.
#   2. Keeps the newest BACKUP_KEEP_LOCAL (14) dumps, deletes older ones.
#      Only files named like ours are ever touched.
#   3. Off-site, when all four R2_* settings are in the .env: encrypts the
#      dump with the passphrase in BACKUP_PASSPHRASE_FILE (AES-256-CBC,
#      PBKDF2, 200k iterations), checks the result decrypts back to the
#      same bytes, and PUTs it to R2 as divinghq/<name>.enc, checking the
#      ETag R2 sends back against the file's MD5. No passphrase file (or
#      an empty one) means no upload and offsite "failed": we never send
#      an unencrypted dump off the box. How long R2 keeps them is a
#      lifecycle rule on the bucket, not this script's job.
#   4. Writes OPS_STATE_DIR/backup.json for GET /api/ops/status:
#      last_attempt_at every run, last_success_at and size_bytes only
#      when the local dump worked, last_ok, offsite ok / failed /
#      not_configured.
#
# Exits non-zero if the local dump or the off-site copy failed. The state
# file still gets written either way, that's how the monitor finds out.
#
# Connection comes from the app's .env (DATABASE_URL, else DB_*), read the
# way server.js reads it, and a variable already set in the environment
# wins, so `DB_DATABASE=other scripts/ops/backup-db.sh` works. Secrets
# never go on a command line or into the log: the DB password travels as
# PGPASSWORD, the R2 key through curl's stdin config.
#
# Settings (environment or .env):
#   BACKUP_DIR              /var/backups/divinghq
#   BACKUP_KEEP_LOCAL       14
#   OPS_STATE_DIR           /var/lib/divinghq
#   BACKUP_PASSPHRASE_FILE  /root/.divinghq-backup-passphrase
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   R2_ENDPOINT             override https://<account>.r2.cloudflarestorage.com
#                           (the tests point it at a local fake)
#   DIVINGHQ_ENV_FILE       which .env to read (default: the repo's)

set -euo pipefail
umask 077
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/ops/common.sh
source "$SCRIPT_DIR/common.sh"
OPS_TAG=backup

ops_load_env "${DIVINGHQ_ENV_FILE:-$REPO_ROOT/.env}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/divinghq}"
BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-14}"
OPS_STATE_DIR="${OPS_STATE_DIR:-/var/lib/divinghq}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/root/.divinghq-backup-passphrase}"
STATE_FILE="$OPS_STATE_DIR/backup.json"
R2_VARS=(R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_AT="$(ops_stamp_to_iso "$STAMP")"
NAME="divinghq-${STAMP}.dump"
FINAL="$BACKUP_DIR/$NAME"

LOCAL_OK=false
OFFSITE=""
SIZE=""
PARTIAL=""
ENC=""
HDRS=""
BODY=""

# How many of the four R2 settings are filled in: 0 is "not configured",
# 4 is "try it", anything between is a mistake worth failing loudly on.
r2_filled() {
  local n=0 v
  for v in "${R2_VARS[@]}"; do [[ -n "${!v:-}" ]] && n=$((n + 1)); done
  echo "$n"
}

finish() {
  local rc=$?
  set +e
  [[ -n "$PARTIAL" ]] && rm -f "$PARTIAL"
  [[ -n "$ENC" ]] && rm -f "$ENC"
  [[ -n "$HDRS" ]] && rm -f "$HDRS"
  [[ -n "$BODY" ]] && rm -f "$BODY"

  # We never got as far as the upload (the dump failed). If R2 is set up
  # that's still a night without an off-site copy.
  if [[ -z "$OFFSITE" ]]; then
    if [[ "$(r2_filled)" == 0 ]]; then OFFSITE=not_configured; else OFFSITE=failed; fi
  fi

  local success_at size
  if [[ "$LOCAL_OK" == true ]]; then
    success_at="$STARTED_AT"
    size="$SIZE"
  else
    success_at="$(ops_prev_iso "$STATE_FILE" last_success_at)"
    size="$(ops_prev_int "$STATE_FILE" size_bytes)"
  fi
  local json
  json="{\"last_attempt_at\":$(ops_json_str "$STARTED_AT"),\"last_success_at\":$(ops_json_str "$success_at"),\"last_ok\":$LOCAL_OK,\"offsite\":$(ops_json_str "$OFFSITE"),\"size_bytes\":$(ops_json_int "$size")}"
  if ! ops_write_state "$STATE_FILE" "$json"; then
    ops_error "couldn't write $STATE_FILE, the status page won't show this run"
    rc=1
  fi

  if [[ "$LOCAL_OK" != true || "$OFFSITE" == failed ]]; then
    [[ $rc -eq 0 ]] && rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    ops_log "done: $NAME, ${SIZE} bytes, offsite $OFFSITE"
  else
    ops_error "backup run finished with problems (local ok: $LOCAL_OK, offsite: $OFFSITE)"
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# curl reads this from stdin (--config -), so the R2 key never shows up in
# `ps`. Inside quotes a curl config file wants \ and " escaped.
r2_curl_auth() {
  local id="${R2_ACCESS_KEY_ID//\\/\\\\}" secret="${R2_SECRET_ACCESS_KEY//\\/\\\\}"
  id="${id//\"/\\\"}"
  secret="${secret//\"/\\\"}"
  printf 'user = "%s:%s"\n' "$id" "$secret"
}

# Why R2 turned the upload down, for the log: the status line plus the
# Code and Message out of its XML error body, e.g. "HTTP 400
# InvalidArgument: Credential access key has length 53, should be 32".
# Nothing else from the body, an S3 error can echo the signed request
# back. The key id and secret get blanked in case a message ever quotes
# them. Prints nothing when there was no HTTP answer at all; curl's own
# --show-error line has already said what went wrong then.
r2_said() {
  local hdrs="$1" body="$2" status code msg out
  status="$(tr -d '\r' < "$hdrs" 2>/dev/null | sed -n 's/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' | tail -n 1)"
  code="$(grep -o '<Code>[^<]*</Code>' "$body" 2>/dev/null | head -n 1 | sed 's/<[^>]*>//g')"
  msg="$(grep -o '<Message>[^<]*</Message>' "$body" 2>/dev/null | head -n 1 | sed 's/<[^>]*>//g')"
  [[ -z "$status$code$msg" ]] && return 0
  out="HTTP ${status:-?}"
  [[ -n "$code" ]] && out+=" $code"
  [[ -n "$msg" ]] && out+=": $msg"
  out="$(printf '%s' "$out" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&apos;/'/g" -e 's/&amp;/\&/g')"
  [[ -n "${R2_SECRET_ACCESS_KEY:-}" ]] && out="${out//"$R2_SECRET_ACCESS_KEY"/<secret>}"
  [[ -n "${R2_ACCESS_KEY_ID:-}" ]] && out="${out//"$R2_ACCESS_KEY_ID"/<key id>}"
  out="$(printf '%s' "$out" | tr -cd '[:print:]' | cut -c1-300)"
  printf ' (R2 said: %s)' "$out"
}

# Encrypt, verify, upload. Called from an `if`, which switches set -e off
# inside it, so every step checks its own status.
r2_upload() {
  local src="$1" first="" endpoint key url want got etag md5
  if [[ ! -f "$BACKUP_PASSPHRASE_FILE" || ! -r "$BACKUP_PASSPHRASE_FILE" ]]; then
    ops_error "R2 is configured but the passphrase file $BACKUP_PASSPHRASE_FILE is missing or unreadable, not uploading (see ops/backups/README.md)"
    return 1
  fi
  IFS= read -r first < "$BACKUP_PASSPHRASE_FILE" || true
  first="${first//[[:space:]]/}"
  if [[ -z "$first" ]]; then
    ops_error "the passphrase file $BACKUP_PASSPHRASE_FILE is empty (openssl reads its first line), not uploading"
    return 1
  fi
  if [[ ${#first} -lt 20 ]]; then
    ops_log "warning: the backup passphrase is short, see ops/backups/README.md for how to make a proper one"
  fi
  if [[ ! "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
    ops_error "R2_BUCKET doesn't look like an R2 bucket name"
    return 1
  fi
  if [[ -z "${R2_ENDPOINT:-}" && ! "$R2_ACCOUNT_ID" =~ ^[A-Za-z0-9]+$ ]]; then
    ops_error "R2_ACCOUNT_ID doesn't look like a Cloudflare account id"
    return 1
  fi
  command -v openssl > /dev/null 2>&1 || { ops_error "openssl isn't installed"; return 1; }
  command -v curl > /dev/null 2>&1 || { ops_error "curl isn't installed"; return 1; }

  ENC="$src.enc"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$src" -out "$ENC" || { ops_error "encryption failed"; return 1; }
  # Prove the passphrase on disk really opens what we're about to ship,
  # before it's the only copy that survives a dead box.
  want="$(openssl dgst -sha256 -r "$src" | cut -d' ' -f1)" || return 1
  got="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$ENC" \
    | openssl dgst -sha256 -r | cut -d' ' -f1)" || { ops_error "the encrypted copy doesn't decrypt"; return 1; }
  if [[ -z "$want" || "$want" != "$got" ]]; then
    ops_error "the encrypted copy doesn't decrypt back to the dump, not uploading"
    return 1
  fi

  endpoint="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
  key="divinghq/$(basename "$ENC")"
  url="${endpoint%/}/${R2_BUCKET}/${key}"
  HDRS="$(mktemp "$BACKUP_DIR/.r2-headers.XXXXXX")" || return 1
  BODY="$(mktemp "$BACKUP_DIR/.r2-body.XXXXXX")" || return 1
  ops_log "uploading $key to R2 bucket $R2_BUCKET ($(wc -c < "$ENC" | tr -d ' ') bytes)"
  # SigV4 the way R2 wants it: provider aws:amz, region "auto", service s3.
  # curl signs a PUT from a file as UNSIGNED-PAYLOAD, which R2 accepts;
  # the ETag check below covers the payload instead. --fail-with-body
  # still fails on a 4xx/5xx but keeps R2's answer, so the log can say why.
  if ! r2_curl_auth | curl --silent --show-error --fail-with-body --config - \
      --aws-sigv4 "aws:amz:auto:s3" \
      --retry 3 --retry-delay 10 --connect-timeout 20 --max-time "${R2_UPLOAD_TIMEOUT:-3600}" \
      --header "Content-Type: application/octet-stream" \
      --upload-file "$ENC" --dump-header "$HDRS" --output "$BODY" \
      "$url"; then
    ops_error "the upload to R2 failed$(r2_said "$HDRS" "$BODY")"
    return 1
  fi
  # For a single PUT, R2 (like S3) answers with the object's MD5 as the
  # ETag. Compare it when it's there.
  etag="$(tr -d '\r' < "$HDRS" | sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//p' | tail -n 1 | tr -d '"')"
  md5="$(openssl dgst -md5 -r "$ENC" | cut -d' ' -f1)"
  if [[ "$etag" =~ ^[0-9a-f]{32}$ ]]; then
    if [[ "$etag" != "$md5" ]]; then
      ops_error "R2 stored something other than what we sent (ETag $etag, ours $md5)"
      return 1
    fi
  else
    ops_log "warning: R2 sent no MD5 ETag, going by the 2xx alone"
  fi
  rm -f "$ENC" "$HDRS" "$BODY"
  ENC=""
  HDRS=""
  BODY=""
  return 0
}

# ---- preflight -------------------------------------------------------
ops_resolve_db
for tool in pg_dump pg_restore; do
  command -v "$tool" > /dev/null 2>&1 || { ops_error "$tool isn't installed (apt install postgresql-client)"; exit 1; }
done
if [[ ! "$BACKUP_KEEP_LOCAL" =~ ^[1-9][0-9]*$ ]]; then
  ops_error "BACKUP_KEEP_LOCAL must be a whole number of dumps, 1 or more"
  exit 1
fi
mkdir -p "$BACKUP_DIR"
ops_lock "$BACKUP_DIR/.divinghq-ops.lock" "${OPS_LOCK_WAIT:-1800}"

# A run that was killed outright (the OOM killer, a reboot mid-dump) never
# got to its EXIT trap, so its half-written dump, encrypted copy or curl
# header / body file is still here. Retention only looks at finished dump names,
# so nothing else would ever delete them, and a few of those a month add
# up. Only ones more than 6 hours old go: without flock (macOS) that keeps
# us off a file another run is still writing.
while IFS= read -r f; do
  rm -f -- "$f" && ops_log "removed $(basename "$f"), left over from a run that didn't finish"
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -mmin +360 \
  \( -name '.divinghq-*.dump.partial' -o -name 'divinghq-*.dump.enc' -o -name '.r2-headers.*' -o -name '.r2-body.*' \))

# ---- 1. dump and verify ----------------------------------------------
ops_log "dumping database $PGDATABASE to $FINAL"
PARTIAL="$BACKUP_DIR/.${NAME}.partial"
pg_dump --format=custom --no-password --lock-wait-timeout=120s --file="$PARTIAL"
# Held in a variable rather than piped into grep -q: grep quitting early
# would SIGPIPE pg_restore and pipefail would call a good dump bad.
TOC="$(pg_restore --list "$PARTIAL")" || { ops_error "pg_restore can't read the dump back"; exit 1; }
if [[ "$TOC" != *" TABLE DATA public schema_meta "* ]]; then
  ops_error "the dump has no schema_meta in it, is DB_DATABASE the app's database?"
  exit 1
fi
mv -f "$PARTIAL" "$FINAL"
PARTIAL=""
SIZE="$(wc -c < "$FINAL" | tr -d ' ')"
LOCAL_OK=true
ops_log "dump ok: $NAME, $SIZE bytes"

# ---- 2. local retention ----------------------------------------------
DUMPS=()
while IFS= read -r f; do DUMPS+=("$f"); done < <(ops_list_dumps "$BACKUP_DIR")
EXTRA=$(( ${#DUMPS[@]} - BACKUP_KEEP_LOCAL ))
if (( EXTRA > 0 )); then
  for (( i = 0; i < EXTRA; i++ )); do
    rm -f -- "${DUMPS[$i]}"
    ops_log "removed old dump $(basename "${DUMPS[$i]}")"
  done
fi

# ---- 3. off-site -------------------------------------------------------
FILLED="$(r2_filled)"
if [[ "$FILLED" == 0 ]]; then
  OFFSITE=not_configured
  ops_log "no R2 settings in .env, keeping local copies only"
elif [[ "$FILLED" != "${#R2_VARS[@]}" ]]; then
  MISSING=""
  for v in "${R2_VARS[@]}"; do [[ -z "${!v:-}" ]] && MISSING="$MISSING $v"; done
  ops_error "R2 is only half set up, missing:$MISSING"
  OFFSITE=failed
elif r2_upload "$FINAL"; then
  OFFSITE=ok
else
  OFFSITE=failed
fi
