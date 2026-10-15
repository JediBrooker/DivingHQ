// Where the native apps live in the stores. The guide's markdown pages
// spell both links out in full (they're plain markdown), so if either
// ever changes, grep src/guide/content for the old one too.
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=app.divinghq.mobile'
// No country in the path on purpose: Apple sends each visitor on to
// their own storefront. App Store Connect app id 6820469893.
export const APP_STORE_URL = 'https://apps.apple.com/app/id6820469893'

// Which store buttons to show a visitor on the website. A phone only gets
// its own store; anything else (a laptop, say) gets both, since whoever is
// reading may be setting up a club and passing the links on.
// iPadOS pretends to be a Mac, the touch points give it away.
export function storesFor({ userAgent = '', maxTouchPoints = 0 } = {}) {
  const play = { store: 'play', url: PLAY_STORE_URL }
  const apple = { store: 'apple', url: APP_STORE_URL }
  if (/Android/i.test(userAgent)) return [play]
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return [apple]
  return [play, apple]
}
