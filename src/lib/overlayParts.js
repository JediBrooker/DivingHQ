// What the stream overlay is allowed to show, and who decides.
//
// Two files used to answer "is this URL an overlay?" by comparing
// route.query.overlay against the same three hard-coded strings. Keeping
// those lists in step was nobody's job, and getting it wrong fails quietly
// in both directions: miss it in ScoreboardView and the chroma colour never
// paints, miss it in App.vue and the whole CRM sidebar renders on top of the
// operator's broadcast. resolveOverlay() is now the only place that knows.
//
// LEGACY SPELLINGS ARE FROZEN. ?overlay=1, ?overlay=true and ?overlay=minimal
// are documented in the guide, are copy-pasted into OBS scene collections that
// live on other people's machines, and appear as literal text in all 26 locale
// files. They keep their exact meaning forever. Everything new goes alongside.

// Every block a broadcaster can switch on or off, in the order they stack down
// the centre column. `hook` is the class the CSS hangs the display rule on.
export const OVERLAY_PARTS = [
  { key: 'round',     centre: true,  hook: '.sb-round-pill' },
  { key: 'diver',     centre: true,  hook: '.sb-name' },
  { key: 'dive',      centre: true,  hook: '.sb-badges' },
  { key: 'judges',    centre: true,  hook: '.sb-live-judges' },
  { key: 'total',     centre: true,  hook: '.sb-live-total-slot' },
  { key: 'rank',      centre: true,  hook: '.sb-live-rank-slot' },
  { key: 'catchup',   centre: true,  hook: '.sb-projection' },
  { key: 'upnext',    centre: true,  hook: '.up-next' },
  { key: 'standings', centre: false, hook: '.sb-col-standings' },
  { key: 'history',   centre: false, hook: '.sb-col-history' },
]

export const PART_KEYS = OVERLAY_PARTS.map((p) => p.key)

// Parts that live inside the centre card. If a layout asks for none of them
// the card itself has to go, otherwise the frame carries an empty dark plate.
export const CENTRE_PART_KEYS = OVERLAY_PARTS.filter((p) => p.centre).map((p) => p.key)

const LEGACY_SPELLINGS = new Set(['1', 'true', 'minimal'])

// Named shapes. A preset is nothing but a set of parts with a name on it,
// which is why the picker and the presets are the same feature.
export const OVERLAY_PRESETS = {
  detailed: PART_KEYS.slice(),
  diver:    ['round', 'diver', 'dive'],
  judges:   ['judges'],
}

// Unticking everything in the picker would otherwise hand OBS a blank frame.
const FALLBACK_PARTS = ['round', 'diver', 'dive', 'judges']

// The order the picker offers shapes in, coarsest first.
export const PRESET_ORDER = ['1', 'minimal', 'detailed', 'diver', 'judges', 'custom']

// What each shape LOOKS like, purely so the wireframe can draw it. The two
// legacy shapes are not part-driven and never will be, but they can still be
// described in the same vocabulary, which beats greying the diagram out and
// making the operator guess. Note '1' and 'detailed' hold the same blocks:
// they differ in that detailed puts them on dark plates for use over footage.
export const PRESET_DISPLAY_PARTS = {
  '1':      PART_KEYS.slice(),
  minimal:  ['round', 'diver', 'dive', 'judges', 'total', 'rank', 'standings'],
  detailed: PART_KEYS.slice(),
  diver:    ['round', 'diver', 'dive'],
  judges:   ['judges'],
}

// A preset the operator cannot edit. Changing what these render would reach
// into OBS scenes we do not control.
export function isFrozenPreset(preset) {
  return isLegacyOverlay(preset)
}

export function isLegacyOverlay(value) {
  return LEGACY_SPELLINGS.has(String(value ?? ''))
}

// Allowlisted, deduped, order preserved. The result is interpolated into class
// names, so nothing that isn't a known key may ever come out of here. ?bg has
// been regex-guarded for the same reason since it shipped.
export function parseParts(raw) {
  if (raw == null) return []
  const allowed = new Set(PART_KEYS)
  const out = []
  for (const token of String(raw).split(',')) {
    const key = token.trim().toLowerCase()
    if (allowed.has(key) && !out.includes(key)) out.push(key)
  }
  return out
}

// The single answer. Returns:
//   { active }          is this a chromeless overlay at all?
//   { legacy }          '1' | 'true' | 'minimal', render exactly as before
//   { parts }           the part list, for everything else
// An unrecognised ?overlay= value is deliberately NOT an overlay. Better a
// normal scoreboard than a half-styled one nobody can debug from a stage.
export function resolveOverlay(query) {
  const raw = query && query.overlay
  if (raw == null) return { active: false, legacy: null, parts: null }

  const value = String(raw)
  if (isLegacyOverlay(value)) {
    return { active: true, legacy: value, parts: null }
  }
  if (value === 'custom') {
    const parts = parseParts(query.parts)
    return { active: true, legacy: null, parts: parts.length ? parts : FALLBACK_PARTS.slice() }
  }
  if (Object.prototype.hasOwnProperty.call(OVERLAY_PRESETS, value)) {
    return { active: true, legacy: null, parts: OVERLAY_PRESETS[value].slice() }
  }
  return { active: false, legacy: null, parts: null }
}

// Root-element classes for a resolved overlay. Kept here so the CSS contract
// and the parser can't drift apart.
export function overlayClasses(resolved) {
  if (!resolved || !resolved.active) return {}
  const classes = { 'overlay-mode': true }
  if (resolved.legacy) {
    if (resolved.legacy === 'minimal') classes['overlay-minimal'] = true
    return classes
  }
  classes['overlay-parts'] = true
  for (const key of resolved.parts) classes[`has-${key}`] = true
  if (!resolved.parts.some((k) => CENTRE_PART_KEYS.includes(k))) classes['no-centre'] = true
  return classes
}

// Build the URL the operator pastes into a Browser Source. `preset` is one of
// the legacy spellings, a preset name, or 'custom' (in which case `parts`
// decides). bg is passed through untouched; ScoreboardView validates it.
export function buildOverlayUrl({ origin = '', eventId, preset = '1', parts = [], bg = '' } = {}) {
  if (!eventId) return ''
  const params = new URLSearchParams()
  params.set('overlay', preset)
  if (preset === 'custom' && parts.length) params.set('parts', parts.join(','))
  if (bg) params.set('bg', bg)
  return `${origin}/scoreboard/${eventId}?${params.toString()}`
}
