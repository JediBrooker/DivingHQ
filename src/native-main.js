// Install the native boundary before any shared modules can issue API requests.
import { createSocketTicketAuth } from './lib/native-socket.mjs'
import { createNativeFetch } from './lib/native-fetch.mjs'
import { Capacitor, CapacitorHttp, CapacitorCookies } from '@capacitor/core'
import { App } from '@capacitor/app'
import { setNativeRuntime } from './lib/native-platform'
import { validateApiOrigin, nativeLinkPath } from './lib/native-boundary.mjs'

const apiOrigin = validateApiOrigin(import.meta.env.VITE_NATIVE_API_ORIGIN)
if (!Capacitor.isNativePlatform()) throw new Error('Native bundles must run in the iOS or Android app')
window.fetch = createNativeFetch({
  apiOrigin,
  localBase: window.location.href,
  fallbackFetch: window.fetch.bind(window),
  httpRequest: options => CapacitorHttp.request(options),
  clearCookies: () => CapacitorCookies.clearAllCookies(),
})

setNativeRuntime({
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
    const open = (url) => {
      const path = nativeLinkPath(url, apiOrigin)
      if (path && router.resolve(path).matched.length) router.push(path).catch(() => {})
    }
    await App.addListener('appUrlOpen', ({ url }) => open(url))
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        resumeSockets()
        window.dispatchEvent(new Event('focus'))
        if (navigator.onLine) window.dispatchEvent(new Event('online'))
      } else pauseSockets()
    })
    await App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) router.back()
      else App.minimizeApp()
    })
    const launch = await App.getLaunchUrl()
    if (launch?.url) open(launch.url)
  },
})

import('./main.js')
