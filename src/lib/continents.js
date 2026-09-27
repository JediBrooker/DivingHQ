// The five continents organisations.continent can hold (migration 037),
// and their names in whatever language the viewer reads.
//
// Rather than ship five more keys to 26 locale files, we lean on
// Intl.DisplayNames with the UN M49 area codes, which every browser we
// support already knows how to name. Used by the records page and the
// scoreboard's record chip.

export const CONTINENTS = ['africa', 'americas', 'asia', 'europe', 'oceania']

const M49 = { africa: '002', americas: '019', asia: '142', europe: '150', oceania: '009' }

export function continentName(key, locale) {
  if (!key) return ''
  const fallback = key.charAt(0).toUpperCase() + key.slice(1)
  if (!M49[key]) return fallback
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'region' }).of(M49[key]) || fallback
  } catch {
    // Very old engines, or a locale tag Intl doesn't like.
    return fallback
  }
}
