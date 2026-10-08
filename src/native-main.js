// Install the native boundary before any shared modules can issue API requests.
import { createSocketTicketAuth } from './lib/native-socket.mjs'
import { createNativeFetch } from './lib/native-fetch.mjs'
import { Capacitor, CapacitorHttp, CapacitorCookies } from '@capacitor/core'
import { App } from '@capacitor/app'
import { registerPlugin } from '@capacitor/core'
import { createNativeIntegrations } from './lib/native-integrations.mjs'
import { showError } from './composables/useNotify'
import { setNativeRuntime } from './lib/native-platform'
import { validateApiOrigin } from './lib/native-boundary.mjs'

const apiOrigin = validateApiOrigin(import.meta.env.VITE_NATIVE_API_ORIGIN)
if (!Capacitor.isNativePlatform()) throw new Error('Native bundles must run in the iOS or Android app')
window.fetch = createNativeFetch({
  apiOrigin,
  localBase: window.location.href,
  fallbackFetch: window.fetch.bind(window),
  httpRequest: options => CapacitorHttp.request(options),
  clearCookies: () => CapacitorCookies.clearAllCookies(),
})

const integrations = createNativeIntegrations({ apiOrigin, localBase: window.location.href, reportError: error => showError(error.message || 'Could not open this link') })
const DocumentPrinter = registerPlugin('DocumentPrinter')
setNativeRuntime({
  apiOrigin,
  ...integrations,
  printDocument: options => DocumentPrinter.printDocument(options || {}),
  socketOptions({ spectator, userId }) {
    return {
      url: apiOrigin,
      options: {
        transports: ['websocket'],
        auth: spectator || !userId ? { token: 'spectator' } : createSocketTicketAuth({
          userId,
          requestTicket: () => fetch('/api/auth/socket-ticket'),
          onSessionExpired: () => window.dispatchEvent(new CustomEvent('dhq:native-session-expired', { detail: userId })),
        }),
      },
    }
  },
  async installLifecycle(router, { pauseSockets, resumeSockets }) {
    integrations.install(router)
    await App.addListener('appUrlOpen', ({ url }) => integrations.openLink(url).catch(error => showError(error.message)))
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        resumeSockets()
        window.dispatchEvent(new Event('focus'))
        if (navigator.onLine) window.dispatchEvent(new Event('online'))
      } else pauseSockets()
    })
    await App.addListener('backButton', ({ canGoBack }) => {
      if (!window.dispatchEvent(new Event('dhq:back', { cancelable: true }))) return
      if (canGoBack) router.back()
      else App.minimizeApp()
    })
    const launch = await App.getLaunchUrl()
    if (launch?.url) await integrations.openLink(launch.url)
  },
})

import('./main.js')
