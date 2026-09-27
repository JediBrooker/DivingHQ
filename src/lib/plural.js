// Count-aware strings, without vue-i18n's pipe syntax.
//
// Our locale values can't contain '|' (vue-i18n reads it as plural
// branches, and the translate tooling refuses it), and vue-i18n's
// built-in plural choice only knows "one or other" unless every locale
// ships its own rule, which is how Russian ended up with "Участников: {n}"
// to dodge the grammar. So a counted string gets one key per CLDR plural
// category, base_zero through base_other, and Intl.PluralRules for the
// reader's language picks between them: 1 участник, 3 участника, 5 участников.
//
// Every locale carries all six keys so the parity test stays a plain
// "same keys everywhere" check. Languages that don't use a category just
// repeat their "other" wording in it (English never picks _two, Arabic does).

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

// Our 'pt' is European Portuguese, but a bare 'pt' gets Brazil's rules,
// where 0 is "one": a club with no members read "0 membro".
const PLURAL_TAGS = { pt: 'pt-PT' }

export function pluralCategory(locale, n) {
  try {
    return new Intl.PluralRules(PLURAL_TAGS[locale] || locale).select(n)
  } catch {
    // Unknown tag or an ancient engine: English rules are a fine guess.
    return n === 1 ? 'one' : 'other'
  }
}

// t and te are vue-i18n's; { n } is merged into params for the message.
// Falls back to base_other if a category key is somehow missing, so a
// half-added string degrades to a slightly wrong plural, never a raw key.
export function translatePlural(t, te, locale, base, n, params = {}) {
  const key = `${base}_${pluralCategory(locale, n)}`
  return t(te(key) ? key : `${base}_other`, { ...params, n })
}
