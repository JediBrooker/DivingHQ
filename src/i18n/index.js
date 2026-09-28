// vue-i18n setup. Locales live in src/locales/{...}.json. Only the
// English fallback is bundled synchronously; every other locale is
// loaded on demand via dynamic import() so Vite emits one ~10–15 KB
// gzipped chunk per language. Without this, all 25 dictionaries (~620 KB
// of JSON) land in the main bundle and blow past Rollup's 500 KB warning.
//
// Boot sequence (see main.js):
//   1. createApp(): synchronous, only `en` is in memory
//   2. await initI18n(): resolves the persisted/browser locale and
//      awaits its chunk before mount, so non-English users never see
//      an English flash on first paint
//   3. app.mount()
//
// Locale persistence, in order:
//   1. localStorage('locale'), a choice made on this device with the
//      switcher, survives sign-out
//   2. users.locale, the signed-in account's saved choice (see
//      adoptAccountLocale), once auth has loaded
//   3. navigator.language, first-visit fallback
//   4. 'en', final fallback
//
// RTL support: setLocale() also sets <html dir="rtl"|"ltr"> based on
// the SUPPORTED_LOCALES entry's `rtl` flag.

import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'

// Dynamic loaders for every non-fallback locale. Vite turns each
// import() into a separate chunk; the vue-i18n plugin still
// pre-compiles them (its `include` glob matches regardless of
// static vs dynamic import), so no runtime `new Function` ever
// runs, which matters for our `script-src 'self'` CSP.
const loaders = {
  es: () => import('@/locales/es.json'),
  fr: () => import('@/locales/fr.json'),
  de: () => import('@/locales/de.json'),
  it: () => import('@/locales/it.json'),
  pt: () => import('@/locales/pt.json'),
  pl: () => import('@/locales/pl.json'),
  cs: () => import('@/locales/cs.json'),
  ru: () => import('@/locales/ru.json'),
  uk: () => import('@/locales/uk.json'),
  fi: () => import('@/locales/fi.json'),
  sv: () => import('@/locales/sv.json'),
  da: () => import('@/locales/da.json'),
  no: () => import('@/locales/no.json'),
  hu: () => import('@/locales/hu.json'),
  hr: () => import('@/locales/hr.json'),
  sr: () => import('@/locales/sr.json'),
  zh: () => import('@/locales/zh.json'),
  ja: () => import('@/locales/ja.json'),
  ko: () => import('@/locales/ko.json'),
  id: () => import('@/locales/id.json'),
  ms: () => import('@/locales/ms.json'),
  tl: () => import('@/locales/tl.json'),
  ar: () => import('@/locales/ar.json'),
  tr: () => import('@/locales/tr.json'),
  el: () => import('@/locales/el.json'),
}

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English',          flag: '🇬🇧' },
  { code: 'es', label: 'Español',          flag: '🇪🇸' },
  { code: 'fr', label: 'Français',         flag: '🇫🇷' },
  { code: 'de', label: 'Deutsch',          flag: '🇩🇪' },
  { code: 'it', label: 'Italiano',         flag: '🇮🇹' },
  { code: 'pt', label: 'Português',        flag: '🇵🇹' },
  { code: 'pl', label: 'Polski',           flag: '🇵🇱' },
  { code: 'cs', label: 'Čeština',          flag: '🇨🇿' },
  { code: 'ru', label: 'Русский',          flag: '🇷🇺' },
  { code: 'uk', label: 'Українська',       flag: '🇺🇦' },
  { code: 'fi', label: 'Suomi',            flag: '🇫🇮' },
  { code: 'sv', label: 'Svenska',          flag: '🇸🇪' },
  { code: 'da', label: 'Dansk',            flag: '🇩🇰' },
  { code: 'no', label: 'Norsk',            flag: '🇳🇴' },
  { code: 'hu', label: 'Magyar',           flag: '🇭🇺' },
  { code: 'hr', label: 'Hrvatski',         flag: '🇭🇷' },
  { code: 'sr', label: 'Српски',           flag: '🇷🇸' },
  { code: 'zh', label: '中文',              flag: '🇨🇳' },
  { code: 'ja', label: '日本語',            flag: '🇯🇵' },
  { code: 'ko', label: '한국어',            flag: '🇰🇷' },
  { code: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms', label: 'Bahasa Melayu',    flag: '🇲🇾' },
  { code: 'tl', label: 'Tagalog',          flag: '🇵🇭' },
  { code: 'ar', label: 'العربية',          flag: '🇸🇦', rtl: true },
  { code: 'tr', label: 'Türkçe',           flag: '🇹🇷' },
  { code: 'el', label: 'Ελληνικά',         flag: '🇬🇷' },
]

export const FALLBACK_LOCALE = 'en'

function detectInitialLocale() {
  try {
    const stored = localStorage.getItem('locale')
    if (stored && SUPPORTED_LOCALES.some(l => l.code === stored)) return stored
  } catch { /* localStorage blocked in some private contexts */ }

  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || ''
  const prefix = nav.split('-')[0].toLowerCase()
  if (SUPPORTED_LOCALES.some(l => l.code === prefix)) return prefix

  return FALLBACK_LOCALE
}

const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  // Always boot with `en` synchronously. initI18n() flips to the
  // detected locale before mount once its chunk has loaded.
  locale: FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  messages: { en },
})

const loaded = new Set([FALLBACK_LOCALE])

async function ensureLoaded(code) {
  if (loaded.has(code)) return
  const loader = loaders[code]
  if (!loader) return
  const mod = await loader()
  i18n.global.setLocaleMessage(code, mod.default)
  loaded.add(code)
}

function applyHtmlAttrs(code) {
  if (typeof document === 'undefined') return
  const entry = SUPPORTED_LOCALES.find(l => l.code === code)
  document.documentElement.setAttribute('lang', code)
  document.documentElement.setAttribute('dir', entry?.rtl ? 'rtl' : 'ltr')
}

// Public setter: every locale change goes through this so the
// dynamic load, localStorage write, and <html lang>/<html dir> sync
// stay in lockstep. Async because non-fallback locales may need a
// network fetch; LocaleSwitcher awaits before clearing it's busy state.
//
// persist:false is for a language nobody picked on this device (the
// browser default at boot, the account's saved one). Only a real choice
// goes in localStorage, since a stored value is exactly what tells
// adoptAccountLocale() to leave the device alone.
export async function setLocale(code, { persist = true } = {}) {
  if (!SUPPORTED_LOCALES.some(l => l.code === code)) return
  await ensureLoaded(code)
  i18n.global.locale.value = code
  if (persist) {
    try { localStorage.setItem('locale', code) } catch { /* ignore */ }
  }
  applyHtmlAttrs(code)
}

// The language saved on the account (users.locale), applied once it's
// known, but only on a device that hasn't picked one itself. So a user
// who chose Español on their laptop gets Español on a fresh phone too,
// while a device-level choice still wins on that device. It isn't
// written to storage: it belongs to the account, so whoever signs in
// next on a shared laptop gets their own, not this one's.
export function adoptAccountLocale(code) {
  if (!code || code === i18n.global.locale.value) return
  try {
    if (localStorage.getItem('locale')) return
  } catch { /* storage blocked, nothing stored to respect */ }
  return setLocale(code, { persist: false })
}

// Awaited by main.js before app.mount(), guarantees the detected
// locale's messages are in memory at first paint. The browser-language
// guess isn't stored. It used to be, on every boot, so by the time auth
// loaded every device looked like it had made a choice and the account's
// language was never adopted anywhere.
export async function initI18n() {
  const code = detectInitialLocale()
  await setLocale(code, { persist: false })
}

// Bootstrap <html lang>/<html dir> immediately so the very first
// frame (still English) has correct attributes. initI18n() will
// overwrite them once the real locale resolves.
applyHtmlAttrs(FALLBACK_LOCALE)

export default i18n
