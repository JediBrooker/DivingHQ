// tn('counts.members', 3) -> "3 members", in the reader's language with
// their language's plural rules. See src/lib/plural.js for why this isn't
// vue-i18n's own pluralisation.
import { useI18n } from 'vue-i18n'
import { translatePlural } from '@/lib/plural'

export function usePlural() {
  const { t, te, locale } = useI18n()
  function tn(base, n, params = {}) {
    return translatePlural(t, te, locale.value, base, n, params)
  }
  return { tn }
}
