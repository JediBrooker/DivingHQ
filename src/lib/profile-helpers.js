// Shared helpers for the diver-profile dashboard widgets.
//
// Each widget under src/components/profile-widgets/ imports
// whichever of these it needs. Widget-private helpers (the
// year-over-year delta calc, for instance) live next to their
// widget instead of here.

// Place ordinals ("1st", "21st") come from ordinal() in lib/format.js,
// the same helper the rest of the app uses.

/**
 * CSS class for a place 1/2/3 chip, used by score-trend and
 * recent-form. Returns '' for anything outside the podium.
 */
export function placeColor(n) {
  if (n === 1) return 'place-gold'
  if (n === 2) return 'place-silver'
  if (n === 3) return 'place-bronze'
  return ''
}

/**
 * Horizontal-bar width helper, normalised to the max value in
 * the same `list` for the given numeric `key`. Returns a percent
 * (0–100). Used by height_breakdown, round_stamina, compare_peers.
 */
export function barWidth(value, list, key) {
  if (!list?.length) return 0
  const max = Math.max(...list.map(r => Number(r[key]) || 0))
  if (!max) return 0
  return Math.max(4, (Number(value) / max) * 100)
}
