// App-wide event channel (P1 of the meet-day redesign). Replaces the
// two `window.__*` globals (window.__openCommandPalette and
// window.__replayRoleTour) with a module-level pub/sub, so producers
// (AppShell topbar Search, the Cmd-K 'Replay tour' action) and
// subscribers (CommandPalette, RoleTour) never depend on mount order
// and nothing leaks onto `window`.
const openCommandPaletteSubs = new Set()
const replayRoleTourSubs = new Set()

function emit(subs) {
  // Snapshot so a handler that (un)subscribes during emit can't mutate
  // the set we're iterating, a dead subscriber must not break the emit.
  for (const cb of [...subs]) {
    try { cb() } catch { /* swallow: one bad listener shouldn't take down the rest */ }
  }
}

export function onOpenCommandPalette(cb) {
  openCommandPaletteSubs.add(cb)
  return () => openCommandPaletteSubs.delete(cb)
}
export function openCommandPalette() {
  emit(openCommandPaletteSubs)
}

export function onReplayRoleTour(cb) {
  replayRoleTourSubs.add(cb)
  return () => replayRoleTourSubs.delete(cb)
}
export function replayRoleTour() {
  emit(replayRoleTourSubs)
}
