#!/usr/bin/env bash
#
# Deploy script. Run from the box hosting the live service.
#
# Order is intentional:
#   pull → install → build → migrate → test → swap → restart → health-check
#   (then the background i18n auto-translate, step 8)
#
#   * Build runs BEFORE migrate so a code-side failure (broken
#     syntax, TDZ, missing import, build error) surfaces before we
#     touch the DB. It builds into dist.next/, not dist/: the running
#     server reads dist/ on every request, so building in place handed
#     the old process the new SPA (and deleted the chunks open tabs
#     needed) for the whole migrate + test window, and for good when a
#     later step stopped the deploy. scripts/swap-dist.sh moves it into
#     place right before the restart.
#   * Tests run AFTER migrate, because new code usually queries the
#     columns its own migration adds (step 4 has the details).
#   * Migrate runs BEFORE restart so the new code starts against
#     the new schema. Most migrations are additive (ADD COLUMN,
#     CREATE INDEX, etc.) so the OLD code keeps working against the
#     new schema until the restart. Not all of them: one that
#     reshapes something the old code writes through (094 swapped
#     the records_* unique keys) breaks it for that whole window,
#     tests included. Those are listed in scripts/migration-compat.js
#     and this script stops before migrating unless you've switched
#     on maintenance mode and passed --allow-breaking.
#   * Health check at the end fails the deploy script (non-zero
#     exit) if the service didn't actually come back up. CI / cron
#     wrappers will see the failure.
#   * Once the pull has landed, how the run ended goes into
#     OPS_STATE_DIR/deploy.json (ok + commit) for GET /api/ops/status,
#     so the outside monitor sees a failed deploy too. See "Ops state".
#
# No-new-commits behaviour:
#   When `git pull` is a no-op (HEAD didn't move), the install /
#   build / migrate / test steps are SKIPPED (nothing changed on
#   the code side; running them would just be heat) but the pm2
#   restart + health check STILL RUN. This lets `./deploy.sh`
#   double as a "reload the running process" command, useful
#   after editing .env files, rotating log directories, or
#   bouncing the process for any reason. If you don't want the
#   restart in this case, pass `--no-restart-if-noop`.
#
# Usage:
#     ./deploy.sh                       : full deploy, fail closed on any error
#     ./deploy.sh --skip-tests          : emergency hotfix path; tests skipped
#     ./deploy.sh --no-restart-if-noop  : exit early if there are no new commits
#                                         (legacy behaviour from before May 2026)
#     ./deploy.sh --allow-breaking      : go ahead with a migration the running
#                                         code can't live with (put the site in
#                                         maintenance mode at /admin/features first)
#     ./deploy.sh --dry                 : print every step, change nothing

set -euo pipefail
cd "$(dirname "$0")"

# ---- Config ---------------------------------------------------
# Adjust these to match your environment.
PM2_PROCESS_NAME="dive-recorder"
HEALTH_URL="http://127.0.0.1:3000/api/health"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-10}"   # max time to wait for the service to come up

# ---- Args -----------------------------------------------------
SKIP_TESTS=0
DRY_RUN=0
NO_RESTART_IF_NOOP=0
ALLOW_BREAKING=0
# Set when this run applied a migration the previous code can't run
# against, which changes what a failed health check should tell you.
BREAKING_APPLIED=0
# Set when this run swapped a new SPA into dist/. Only then is dist.prev/
# the build that matches PREV_SHA; after a plain restart it's some older
# deploy's, and the rollback hint mustn't tell anyone to put it live.
SWAPPED_DIST=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --allow-breaking) ALLOW_BREAKING=1 ;;
    --dry|--dry-run) DRY_RUN=1 ;;
    --no-restart-if-noop) NO_RESTART_IF_NOOP=1 ;;
    *) echo "[deploy] unknown arg: $arg"; exit 2 ;;
  esac
done

# ---- Helpers --------------------------------------------------
step() { echo "[deploy] $(date -u +%FT%TZ) — $*"; }
# run is called as `run cmd arg1 arg2 …`, each argument is a
# separate token, no shell-string parsing. Previously this used
# `eval "$@"` which worked becuase every call site passed a single
# pre-split string, but eval-on-arguments is the kind of pattern
# that quietly turns into a code-injection sink the day someone
# adds an interpolated variable. Pass tokens, not strings.
run()  {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "          DRY: $*"
  else
    "$@"
  fi
}
# Stamps a finished build with the commit it came from, so a later run
# can tell whether a leftover dist.next/ matches what it's restarting.
record_build_sha() { git rev-parse HEAD > dist.next/.build-sha; }

# ---- Ops state ------------------------------------------------
# GET /api/ops/status (routes/ops-status.js) reports the last deploy
# from OPS_STATE_DIR/deploy.json, and the EXIT trap below writes it:
# ok true with the commit when the run reaches the end, ok false (still
# naming the commit it tried) when anything after the pull stops it,
# Ctrl-C included. Nothing is recorded before the pull lands, on a
# --no-restart-if-noop exit, or ever in --dry mode. A state dir we can't
# write to is a warning, it never fails a deploy or changes its exit code.
#
# OPS_STATE_DIR comes from the shell or .env like the ops scripts read it,
# /var/lib/divinghq otherwise. Only that one line of .env is read here,
# last copy wins and `export ` in front is fine, both as dotenv has it,
# or this would write deploy.json somewhere the app never looks.
env_file_value() {
  [[ -f .env ]] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 \
    | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//' | tr -d "\"'\r"
}
OPS_STATE_DIR="${OPS_STATE_DIR:-$(env_file_value OPS_STATE_DIR || true)}"
OPS_STATE_DIR="${OPS_STATE_DIR:-/var/lib/divinghq}"
DEPLOY_SHA=""   # the commit this run is deploying, set once the pull lands
HEALTH_TMP=""   # the health check's temp file, cleaned up on the way out
write_deploy_state() {
  local ok="$1" tmp=""
  if mkdir -p "$OPS_STATE_DIR" 2>/dev/null \
    && tmp="$(mktemp "$OPS_STATE_DIR/.deploy.json.XXXXXX" 2>/dev/null)" \
    && printf '{"last_at":"%s","ok":%s,"sha":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$DEPLOY_SHA" > "$tmp" \
    && chmod 0644 "$tmp" \
    && mv -f "$tmp" "$OPS_STATE_DIR/deploy.json"; then
    return 0
  fi
  [[ -n "$tmp" ]] && rm -f "$tmp"
  echo "[deploy] warning: couldn't write ${OPS_STATE_DIR}/deploy.json, the status page won't show this deploy"
  return 0
}
on_exit() {
  local rc=$?
  set +e
  [[ -n "$HEALTH_TMP" ]] && rm -f "$HEALTH_TMP"
  if [[ $DRY_RUN -eq 0 && -n "$DEPLOY_SHA" ]]; then
    if [[ $rc -eq 0 ]]; then write_deploy_state true; else write_deploy_state false; fi
  fi
  exit "$rc"
}
trap on_exit EXIT
# Without these a Ctrl-C or a kill mid-deploy wouldn't be recorded.
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- Preflight ------------------------------------------------
# Capture the current commit so a rollback is one git command.
# Prints to stdout for the deploy log.
PREV_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
step "starting deploy from ${PREV_SHA}"

# ---- 1. Pull --------------------------------------------------
# --ff-only refuses non-fast-forward merges so a manually-edited
# file on the box can't silently produce a merge commit.
#
# Auto-reset package-lock.json if it's the only dirty file (a bit
# hacky, but it works). npm install (sometimes run accidentally on
# the server, sometimes by tools like pm2-logrotate) mutates the
# lockfile, which then blocks `git pull --ff-only` even though no
# real edit was made. We're strict about everything ELSE: any
# other dirty file means someone made a real change on the box,
# and we refuse to pull rather than silently lose it.
DIRTY="$(git status --porcelain | awk '{print $2}')"
if [[ -n "$DIRTY" ]]; then
  if [[ "$DIRTY" == "package-lock.json" ]]; then
    step "resetting auto-modified package-lock.json"
    run git checkout -- package-lock.json
  else
    echo "[deploy] FAILED — local changes to files other than package-lock.json:"
    echo "$DIRTY" | sed 's/^/  /'
    echo "[deploy] Stash, commit, or revert these before deploying."
    exit 1
  fi
fi

step "git pull --ff-only"
run git fetch --quiet
run git pull --ff-only

NEW_SHA="$(git rev-parse --short HEAD)"
# Detect the no-op case (pull was a fast-forward to the same SHA).
# Dry-run never pulls, so HEAD won't have moved, but we still want
# to show every downstream step that WOULD have run, so don't
# treat dry-run as a no-op.
NOOP=0
if [[ $DRY_RUN -eq 0 && "$PREV_SHA" == "$NEW_SHA" ]]; then
  NOOP=1
  if [[ $NO_RESTART_IF_NOOP -eq 1 ]]; then
    step "no new commits + --no-restart-if-noop — exiting"
    exit 0
  fi
  step "no new commits — skipping install/build/migrate/test, will still restart"
else
  step "advancing ${PREV_SHA} → ${NEW_SHA}"
fi
# From here on the run is recorded in deploy.json, whichever way it ends.
if [[ $DRY_RUN -eq 0 ]]; then DEPLOY_SHA="$(git rev-parse HEAD)"; fi

# Steps 2-5 only run when there are NEW commits. With no new
# commits the on-disk bundle, dependency tree, schema, and tests
# are already what's running, so re-running them would just be
# heat. We still fall through to the pm2 restart + health check
# below so `./deploy.sh` can double as a "reload the running
# process" command after .env / log-rotation / runtime tweaks.
if [[ $NOOP -eq 0 ]]; then
  # ---- 2. Install dependencies --------------------------------
  # npm ci is faster, deterministic, and fails loud if package.json
  # and package-lock.json drift. We keep dev deps (Vite is a dev
  # dep that the build step needs).
  step "npm ci"
  run npm ci

  # ---- 3. Build SPA -------------------------------------------
  # Build BEFORE migrate so a broken build doesn't leave the DB
  # advanced past code we can't ship.
  #
  # Heap bump (gotcha we hit for real): the precompiled vue-i18n
  # dictionaries (25 locales × ~988 keys = 24,700 AST nodes baked
  # into the bundle) push Vite's memory ceiling on small VPSes. The
  # default Node heap (~512 MB on a 1 GB box) ran out partway
  # through transforming socket.io-client during a 2026-05-18
  # deploy. 4 GB is generous headroom and only allocates lazily,
  # the build process won't actually use it all unless the bundle
  # keeps growing. Override via NODE_OPTIONS in the shell env if
  # you want a different cap.
  #
  # Into dist.next/, see the note at the top. A leftover from a deploy
  # that stopped part way is thrown away first.
  step "npm run build (into dist.next/)"
  run rm -rf dist.next
  run env NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}" npm run build -- --outDir dist.next
  run record_build_sha

  # ---- 4. Apply pending migrations ----------------------------
  # --dry first so the deploy log shows exactly what's about to
  # run before the writes happen. The runner records every file it
  # applies in public.applied_migrations and skips those, so an
  # accidental re-run is a no-op.
  #
  # Migrate runs BEFORE tests because new code commonly adds
  # columns its own logic queries; running the test suite against
  # a DB one schema version behind would 500 on those queries.
  # An additive migration leaves the running PM2 process serving
  # correctly against the new schema until restart at step 6. One
  # listed in scripts/migration-compat.js doesn't (094 made every
  # record write of the old code fail, silently, during a live
  # meet), so that needs maintenance mode on for the window and an
  # explicit --allow-breaking. Maintenance mode is an in-memory flag
  # of the running process, flip it from /admin/features, not SQL.
  step "migrate (compatibility check)"
  if [[ $DRY_RUN -eq 0 ]]; then
    set +e
    npm run --silent migrate -- --check-breaking
    compat=$?
    set -e
    if [[ $compat -eq 3 ]]; then
      if [[ $ALLOW_BREAKING -eq 0 ]]; then
        echo "[deploy] STOPPED — a pending migration breaks the code that's running now (above)."
        echo "[deploy]   1. Switch on Maintenance mode at /admin/features, so nothing is scored"
        echo "[deploy]      against the new schema by the old process."
        echo "[deploy]   2. Re-run: ./deploy.sh --allow-breaking"
        echo "[deploy]   3. After the health check passes, switch maintenance mode off."
        echo "[deploy] If tests or the health check fail after that, roll FORWARD: the previous"
        echo "[deploy] code can't run against the new schema and there's no down migration."
        exit 1
      fi
      BREAKING_APPLIED=1
    elif [[ $compat -ne 0 ]]; then
      echo "[deploy] FAILED — migration compatibility check exited ${compat}."
      exit 1
    fi
  else
    echo "          DRY: npm run migrate -- --check-breaking"
  fi
  step "migrate (preview)"
  run npm run migrate -- --dry
  step "migrate (apply)"
  run npm run migrate

  # ---- 5. Tests -----------------------------------------------
  # `test:safe` runs every test/*.test.js except the integration
  # ones (integration.test.js and *.integration.test.js, see
  # scripts/run-tests.js), because those create real orgs / users /
  # events and would pollute the production DB on every deploy.
  # What's left is unit tests plus a few read-only DB checks, e.g.
  #   * syntax.test.js       boot test + parse + schema_version pin
  #   * calc.test.js         World Aquatics scoring vs Postgres UDF
  #   * score-trim.test.js   trim-rule parity
  # They catch the kind of regression a deploy would otherwise ship
  # blind.
  #
  # For full integration coverage, run `npm test` against a
  # DEDICATED test database (createdb divinghq_test, point
  # DB_DATABASE at it), never against the production DB.
  if [[ $SKIP_TESTS -eq 0 ]]; then
    # SKIP_I18N_STUCK_CHECK=1: the deploy-time background
    # translator (section 8 below) fills in any keys that landed
    # as English placeholders. The OTHER three i18n-parity
    # subtests (structural, no-extras, placeholder integrity)
    # still run, only the UX-quality stuck-count subtest is
    # deferred. See test/i18n-parity.test.js for the full
    # explanation.
    step "npm run test:safe"
    run env SKIP_I18N_STUCK_CHECK=1 npm run test:safe
  else
    step "tests skipped (--skip-tests)"
  fi
fi

# ---- 6. Swap in the new SPA, restart service -------------------
# The new build goes live here and not earlier, and then only because
# migrate and the tests passed. The old process serves it for the second
# or so until the restart below, which is fine: the new API is about to
# be there.
#
# A no-op run (nothing new pulled) can still find a dist.next/ that a
# stopped run built from this very commit. The restart below boots that
# commit's server code, so its SPA goes in with it rather than leaving
# the older one next to the newer API.
if [[ $NOOP -eq 0 ]]; then
  step "swap dist.next/ into dist/"
  run scripts/swap-dist.sh
  SWAPPED_DIST=1
elif [[ -f dist.next/.build-sha && "$(cat dist.next/.build-sha)" == "$(git rev-parse HEAD)" ]]; then
  step "swap dist.next/ (built from $(git rev-parse --short HEAD) by an earlier run) into dist/"
  run scripts/swap-dist.sh
  SWAPPED_DIST=1
fi

# Named process, not "all", so other PM2 processes on this box
# (cron workers, side services) aren't disturbed.
#
# --update-env tells PM2 to re-read the process's environment
# (including .env via PM2's dotenv) instead of reusing whatever
# shell env was in scope when `pm2 start` first booted the
# process. Without it, edits to .env (rotated JWT_SECRET, new
# OPENAI_API_KEY for the translator, etc.) silently fail to
# take effect after a deploy until someone notices the process
# is still using the old values. Pay the re-read on every
# deploy, it's free when nothing changed, and it removes a class
# of "why isn't the new env var live?" debugging session.
step "pm2 restart ${PM2_PROCESS_NAME} --update-env"
run pm2 restart "${PM2_PROCESS_NAME}" --update-env

# ---- 7. Health check ------------------------------------------
# Poll /api/health until it returns 200 or HEALTH_TIMEOUT_S
# passes. The endpoint also issues a trivial DB query, so a 503
# means the process bound the port but the pool can't talk to
# Postgres, which is equally unsafe to declare "deployed".
step "health check (timeout ${HEALTH_TIMEOUT_S}s)"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "          DRY: would curl ${HEALTH_URL}"
  exit 0
fi

# Hardened temp file: a fixed path under /tmp is a symlink-race
# target for any local user on the deploy box. mktemp gives us a
# fresh O_EXCL-style path each run, and on_exit (the EXIT trap up top,
# which also writes deploy.json) cleans up on both the happy path and an
# aborted exit.
HEALTH_TMP="$(mktemp -t deploy-health.XXXXXX)" || {
  echo "[deploy] FAILED — mktemp could not allocate a temp file"
  exit 1
}

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
HEALTHY=0
while true; do
  if curl --fail --silent --show-error --max-time 3 "${HEALTH_URL}" > "$HEALTH_TMP" 2>/dev/null; then
    schema=$(grep -oE '"schema_version":[0-9]+' "$HEALTH_TMP" || echo 'schema_version:?')
    step "ok — ${schema}"
    HEALTHY=1
    break
  fi
  if (( $(date +%s) >= deadline )); then
    echo "[deploy] FAILED — ${HEALTH_URL} did not return 200 within ${HEALTH_TIMEOUT_S}s."
    if [[ $BREAKING_APPLIED -eq 1 ]]; then
      echo "[deploy] Do NOT roll back to ${PREV_SHA}: this run applied a migration that code"
      echo "[deploy] can't run against (scripts/migration-compat.js). Fix forward and restart."
    elif [[ $SWAPPED_DIST -eq 1 ]]; then
      echo "[deploy] To roll back: git reset --hard ${PREV_SHA} && rm -rf dist && mv dist.prev dist && pm2 restart ${PM2_PROCESS_NAME}"
      echo "[deploy] (dist.prev/ is the SPA that was live before this run; its .build-sha says which commit.)"
      echo "[deploy] (note: the migrations applied in this run are additive and safe to leave)."
    else
      # Plain restart, dist/ wasn't touched: it already matches the code,
      # and dist.prev/ belongs to an older deploy.
      echo "[deploy] To roll back: git reset --hard ${PREV_SHA} && pm2 restart ${PM2_PROCESS_NAME}"
      echo "[deploy] (dist/ was left as it was; don't restore dist.prev/, it's from an earlier deploy.)"
    fi
    exit 1
  fi
  sleep 1
done

# ---- 8. Background i18n auto-translate -----------------------
# Fire-and-forget. The translator can take 12+ minutes on a cold
# locale set (24 locales × ~30s of API time per locale), so doing
# it inline would massively inflate deploy duration for something
# that doesn't gate the live service. Instead:
#
#   * Probe + (if needed) translate run AFTER health check passes,
#     in a backgrounded subshell that's `disown`ed so it survives
#     this script exiting.
#   * Output goes to /tmp/divinghq-translate-<sha>-<ts>.log so you
#     can `tail -f` it from another shell. Each deploy gets its own
#     file, old logs accumulate, prune them with logrotate or
#     cron if that becomes an issue.
#   * Skipped entirely on no-op deploys (no code change → no new
#     keys could have been added) and on dry-run. The box never ends
#     up on a dirty or diverged main: a translator that dies
#     mid-flight has its partial writes discarded, and a push-back
#     that fails (or races a PR merged on origin) resets to the
#     commit we just built. Stuck keys are simply re-derived on a
#     later deploy, so nothing is permanently lost.
#   * Skipped silently if neither OPENAI_API_KEY nor
#     ANTHROPIC_API_KEY is set in .env, same gate as the inline
#     version had.
#
# The deploy-side test gate (section 5) defers the english-stuck
# subtest of test/i18n-parity.test.js via SKIP_I18N_STUCK_CHECK=1,
# trusting this step to fix any stuck keys post-deploy.
if [[ $HEALTHY -eq 1 && $NOOP -eq 0 && $DRY_RUN -eq 0 ]]; then
  TRANSLATE_LOG="/tmp/divinghq-translate-${NEW_SHA}-$(date -u +%Y%m%dT%H%M%SZ).log"
  step "translate: backgrounded (log: ${TRANSLATE_LOG})"
  (
    # Source .env inside the subshell so the dotenv-style file
    # populates this process's env. The translator (node) also
    # reads .env via the dotenv it require()s at startup, but we
    # need the bash-side check for the OPENAI_API_KEY gate below.
    if [[ -f .env ]]; then
      set -a
      # shellcheck disable=SC1091
      source .env
      set +a
    fi

    log() { echo "[translate-bg] $(date -u +%FT%TZ) — $*"; }

    if [[ -z "${OPENAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
      log "skipped (no OPENAI_API_KEY or ANTHROPIC_API_KEY in .env)"
      exit 0
    fi

    log "probing for english-stuck keys"
    # --dry-run is free (no API call). Sum the per-locale stuck counts.
    STUCK_TOTAL=$(node scripts/translate-locales.js --dry-run 2>&1 \
      | awk '/english-stuck/ {for (i=1;i<=NF;i++) if ($i=="english-stuck") {gsub("[^0-9]","",$(i-1)); print $(i-1)}}' \
      | awk '{s+=$1} END {print s+0}')

    if [[ "${STUCK_TOTAL:-0}" -le 0 ]]; then
      log "nothing stuck, exiting"
      exit 0
    fi

    log "${STUCK_TOTAL} stuck key(s) total — running translator"
    if ! npm run translate; then
      log "WARNING — translator failed; discarding partial writes to keep the next deploy clean"
      git checkout -- src/locales/ 2>/dev/null || true
      exit 0
    fi

    # Sanity check: only commit if there's something to commit (the
    # translator may have decided every stuck value was a
    # legitimate cognate or proper noun and chosen to leave it stuck).
    if git diff --quiet src/locales/; then
      log "stuck keys were legitimate cognates (no diff to commit)"
      exit 0
    fi

    log "auto-committing fresh translations"
    # Remember exactly what we built/migrated/restarted so we can
    # always snap back to it. The box must never be left on a main
    # that diverges from origin (breaks the next `git pull --ff-only`)
    # or runs ahead of what we built (makes the next deploy a no-op
    # that silently skips build + migrate). Both states wedge future
    # deploys, which is precisely how this box wedged before.
    BUILT_SHA="$(git rev-parse HEAD)"
    git add src/locales/
    # Don't sign the commit (no GPG on the deploy box); use a clear
    # marker so the auto-commit is easy to spot in git log.
    if ! git commit -m "i18n: auto-fill stuck keys on deploy ($(date -u +%FT%TZ))"; then
      log "WARNING — git commit failed"
      exit 0
    fi

    # Only ever push a clean fast-forward. Fetch first so the
    # ancestry test below sees the real state of origin/main.
    git fetch --quiet origin main || true
    if git merge-base --is-ancestor origin/main HEAD; then
      # origin/main hasn't moved since we built → our commit
      # fast-forwards it. Push it.
      if git push origin HEAD:main 2>&1; then
        log "pushed to origin/main"
      else
        # Almost always missing push credentials on the box (HTTPS
        # remote with no token, or a deploy key without write access).
        # Reset so we don't strand a local commit that diverges main
        # and wedges the next deploy. Fix push auth (add a deploy key
        # with write access) and this branch stops firing.
        log "WARNING — push to origin/main failed (check push credentials); resetting to ${BUILT_SHA} to stay deployable"
        git reset --hard "$BUILT_SHA"
      fi
    else
      # origin/main advanced while we were translating (a PR merged
      # mid-run). Don't try to absorb those commits here, rebasing
      # them in would leave the running build behind its own working
      # tree, and the no-op next deploy would skip building/migrating
      # them. Defer: drop our commit and snap back to what we built,
      # the next deploy pulls + rebuilds the new code, and the
      # translator re-fills these keys on top of it.
      log "origin/main moved during translate — deferring to next deploy; resetting to ${BUILT_SHA}"
      git reset --hard "$BUILT_SHA"
    fi
  ) >"$TRANSLATE_LOG" 2>&1 </dev/null &
  disown
fi

exit 0
