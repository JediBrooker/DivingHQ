#!/usr/bin/env bash
#
# Swap a finished SPA build (dist.next/) into dist/, the directory the
# server serves. deploy.sh calls this right before `pm2 restart`, once
# migrate and the tests have passed.
#
# Why not build straight into dist/: vite empties it first, and the
# running server re-reads dist/index.html on every request. So the old
# process served the new shell (and its new chunk names) the moment the
# build started, the chunks open tabs still wanted were gone, and when
# migrate or the tests stopped the deploy it stayed that way.
#
# What it does:
#   * copies the outgoing build's hashed chunks into the new one, as long
#     as they're under a week old. A tab left open on the old build
#     lazy-loads ManagerView-<oldhash>.js after the restart; without the
#     file it gets a 404. Carried files keep their mtime, so each chunk
#     drops out a week after it was built instead of piling up forever.
#   * keeps the outgoing build as dist.prev/ (one level), which is what a
#     rollback to the previous commit wants back.
#   * two renames, microseconds apart, for the switch itself.
#
# Usage: scripts/swap-dist.sh [project-root]   (default: this repo)

set -euo pipefail
cd "${1:-$(dirname "$0")/..}"

if [[ ! -d dist.next ]]; then
  echo "[swap-dist] no dist.next/ to swap in (did the build run?)" >&2
  exit 1
fi

if [[ -d dist/assets ]]; then
  mkdir -p dist.next/assets
  # A plain loop rather than cp -n: GNU cp changed what -n exits with
  # between releases, and a non-zero there would stop the deploy.
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    if [[ ! -e "dist.next/assets/$name" ]]; then
      cp -p "$f" "dist.next/assets/$name"
    fi
  done < <(find dist/assets -maxdepth 1 -type f -mtime -7 -print0)
fi

rm -rf dist.prev
if [[ -d dist ]]; then
  mv dist dist.prev
fi
mv dist.next dist
echo "[swap-dist] dist/ now holds $(cat dist/.build-sha 2>/dev/null || echo 'the new build')"
