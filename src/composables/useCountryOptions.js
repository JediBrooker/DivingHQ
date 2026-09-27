// Country pickers: sign-up, register-org, and the sysadmin's "this org has
// no country" fix-up in User Manager all offer the same list.
//
// It's lib/countries.json, the file the server validates against, so a
// picker can't offer a code the API then refuses. Names come from
// Intl.DisplayNames in the reader's own language where the browser knows
// them, otherwise the English name stored in the JSON.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import COUNTRIES from '../../lib/countries.json'

const BY_A3 = new Map(COUNTRIES.map(c => [c.a3, c]))

// Is this a code signups can find an org by? char(3) columns come back
// padded, hence the trim.
export function isKnownCountry(code) {
  return typeof code === 'string' && BY_A3.has(code.trim().toUpperCase())
}

export function useCountryOptions() {
  const { locale } = useI18n()

  const countryOptions = computed(() => {
    let dn = null
    try { dn = new Intl.DisplayNames([locale.value, 'en'], { type: 'region' }) } catch { /* old browser */ }
    return COUNTRIES
      .map(c => ({ code: c.a3, name: (dn && dn.of(c.a2)) || c.name }))
      .sort((a, b) => a.name.localeCompare(b.name, locale.value))
  })

  function countryName(code) {
    const want = typeof code === 'string' ? code.trim().toUpperCase() : ''
    return countryOptions.value.find(c => c.code === want)?.name || ''
  }

  return { countryOptions, countryName }
}
