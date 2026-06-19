import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import i18n, { initI18n } from './i18n'
import { tipDirective } from './directives/tip'
import { useUiStore } from './stores/ui'
import { useAuthStore } from './stores/auth'
// Global styles. Imported here (not via <link> in index.html) so
// Vite content-hashes the output filename — any edit to app.css
// produces a new hashed URL, which makes browser + service-worker
// caches transparent rather than something we have to manually
// bust.
import './styles/app.css'
import './styles/lb-modal.css'

const app = createApp(App)
app.use(createPinia())
// Bind the persisted colour theme as the runtime source of truth.
// index.html's inline script already applied data-theme pre-paint;
// this instantiates the store so later toggles stay in sync.
useUiStore().applyTheme()
app.use(router)
app.use(i18n)
// v-tip — instant tooltip replacement for `title=`. See
// src/directives/tip.js for the rationale (native title has a
// ~500ms browser delay; this swaps it for a CSS-only ::after
// that renders on the first hover frame). Migration patterns:
//   title="static"  →  v-tip="'static'"
//   :title="expr"   →  v-tip="expr"
app.directive('tip', tipDirective)

// Await two things before mounting:
//   * initI18n   — the detected locale's chunk, so non-English users
//                  never see an English flash on first paint (`en` is
//                  bundled synchronously and resolves immediately).
//   * fetchMe    — rehydrate the signed-in identity from the httpOnly
//                  session cookie. The JWT is no longer in JS-readable
//                  storage, so without this probe the router guard
//                  would treat a logged-in user's deep link as
//                  anonymous and bounce them to /login on every reload.
// Both are best-effort and never reject, so a failure can't block boot.
Promise.all([initI18n(), useAuthStore().fetchMe()]).finally(() => app.mount('#app'))

// Register the service worker only in production builds — the
// Vite dev server's HMR conflicts with cached assets. Skips
// silently in older Safari / in-app webviews that don't support
// service workers.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Non-fatal — the app still works without offline support.
  })
}
