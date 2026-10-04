// Adapt the app's fetch contract to the native cookie jar. Explicit dependencies
// make origin isolation, response privacy and offline logout testable without a device.
import { nativeApiUrl, safeResponseHeaders } from './native-boundary.mjs'

export function createNativeFetch({ apiOrigin, localBase, fallbackFetch, httpRequest, clearCookies }) {
  const browserFetch = fallbackFetch
  const localOrigin = localBase
  const pending = new Set()
  let signingOut = Promise.resolve()
  let sessionGeneration = 0

  return async (input, options = {}) => {
    const request = new Request(input instanceof Request ? input : new URL(input, localBase), options)
    const target = nativeApiUrl(request.url, localOrigin, apiOrigin)
    if (!target) {
      if (request.headers.has('authorization')) throw new Error('Credentials may only be sent to the configured API')
      return browserFetch(request, { credentials: 'omit' })
    }
    if (new URL(target).pathname === '/api/auth/logout') {
      sessionGeneration += 1
      // The session cookie may survive a failed network logout. Drain requests
      // that can refresh it, then clear the app-owned native jar even offline.
      signingOut = signingOut.then(async () => {
        await Promise.allSettled([...pending])
        await clearCookies()
      })
      await signingOut
      return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
    }
    const generation = sessionGeneration
    await signingOut
    if (request.signal.aborted) throw request.signal.reason || new DOMException('Request aborted', 'AbortError')
    const task = (async () => {
      const headers = Object.fromEntries(request.headers.entries())
      headers['X-DivingHQ-Native'] = '1'
      if (/multipart\/form-data/i.test(request.headers.get('content-type') || '')) {
        throw new Error('File uploads are not yet supported in the native preview; use the website')
      }
      const data = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text()
      const result = await httpRequest({
        url: target, method: request.method, headers, data,
        responseType: 'arraybuffer', disableRedirects: true,
        connectTimeout: 15000, readTimeout: 30000,
      })
      // A login that was already on the wire at logout may still set a cookie.
      // Logout drains it before clearing the jar; never deliver its old identity
      // to a caller that could then saveSession after sign-out.
      if (generation !== sessionGeneration) throw new Error('Session changed while the request was in progress')
      // Never follow API redirects with ambient native cookies. Browser-based
      // checkout/navigation has a separate integration milestone.
      if (result.status >= 300 && result.status < 400) throw new Error('API redirects are not supported in the native app')
      if (result.url && new URL(result.url).origin !== apiOrigin) throw new Error('Unexpected API response origin')
      if (request.signal.aborted) throw request.signal.reason || new DOMException('Request aborted', 'AbortError')
      const responseHeaders = safeResponseHeaders(result.headers)
      const type = Object.entries(responseHeaders).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || ''
      const body = /application\/json/i.test(type) ? JSON.stringify(result.data)
        : Uint8Array.from(atob(result.data || ''), c => c.charCodeAt(0))
      return new Response([204, 205, 304].includes(result.status) || request.method === 'HEAD' ? null : body,
        { status: result.status, headers: responseHeaders })
    })()
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }

}
