// document.title for every route: "Sign In · DivingHQ", "Privacy Policy ·
// DivingHQ" and so on, instead of a bare "DivingHQ" on every tab, bookmark
// and shared link.
//
// A route opts in with meta.titleKey, an i18n key, so the tab follows the
// user's language. Routes without one get plain "DivingHQ". The home page
// sets meta.brandFirst so it reads "DivingHQ · Diving competition software…",
// the way people expect a landing page to. A view that knows something
// better than its route (a guide topic's own title) calls setPageTitle()
// itself once it has loaded.
//
// Kept free of Vue and the router so node:test can import it directly.

export const APP_NAME = 'DivingHQ'

export function formatTitle(part, { brandFirst = false } = {}) {
  const text = typeof part === 'string' ? part.trim() : ''
  if (!text) return APP_NAME
  return brandFirst ? `${APP_NAME} · ${text}` : `${text} · ${APP_NAME}`
}

// `t` is vue-i18n's translate. A key that's missing comes back as the key
// itself, which would put "auth.login.title" in the tab, so treat that as
// no title at all.
export function routeTitle(route, t) {
  const meta = (route && route.meta) || {}
  let part = ''
  if (meta.titleKey && typeof t === 'function') {
    const translated = t(meta.titleKey)
    if (translated && translated !== meta.titleKey) part = translated
  }
  return formatTitle(part, { brandFirst: !!meta.brandFirst })
}

export function setPageTitle(part, opts) {
  if (typeof document !== 'undefined') document.title = formatTitle(part, opts)
}
