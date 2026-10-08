// Pure native transport rules, shared with the build gate and unit tests.
export function validateApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set VITE_NATIVE_API_ORIGIN to an explicit HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash) throw new Error('VITE_NATIVE_API_ORIGIN must be an HTTPS origin without a path or credentials');
  return url.origin;
}

export function nativeApiUrl(value, localBase, apiOrigin) {
  const local = new URL(localBase);
  const url = new URL(value, local);
  if (url.username || url.password) throw new Error('Credentials in URLs are not supported');
  // Custom schemes report an opaque origin ("null"); comparing that value
  // either rejects iOS or accidentally admits every other opaque origin.
  const localApp = url.protocol === local.protocol && url.host === local.host;
  if ((localApp || url.origin === apiOrigin) && url.pathname.startsWith('/api/')) {
    return `${apiOrigin}${url.pathname}${url.search}`;
  }
  return null;
}

export function nativeLinkPath(value, apiOrigin) {
  try {
    const url = new URL(value);
    if (url.origin !== apiOrigin || url.username || url.password || /[\\\x00-\x20]/.test(value) || /%2e|%00|%0a|%0d/i.test(value.split('?')[0]) || url.pathname.startsWith('/api/')
        || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('//')
        || /%2f|%5c|\\/i.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function safeResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !/^set-cookie2?$/i.test(key)));
}
