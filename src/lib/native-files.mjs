// File and navigation boundaries are pure so hostile filenames/URLs can be
// exercised without granting a test runner access to a device's filesystem.
export const MAX_EXPORT_BYTES = 25 * 1024 * 1024
export function safeExportName(value, type = '') {
  const extensions = { 'application/pdf': 'pdf', 'text/csv': 'csv', 'text/calendar': 'ics' }
  const extension = extensions[type.split(';')[0].toLowerCase()]
  if (!extension) throw new Error('This file format cannot be exported')
  const base = String(value || 'DivingHQ').normalize('NFKC').replace(/\.[^.]*$/, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 100) || 'DivingHQ'
  return `${base}.${extension}`
}
export function exportRequestPath(value, localBase, apiOrigin) {
  try {
    if (typeof value !== 'string' || /[\\\x00-\x1f]|%2e|%2f|%5c/i.test(value.split('?')[0])) return null
    const local = new URL(localBase)
    const url = new URL(value, local)
    if (url.username || url.password || /[\\\x00-\x1f]|%2f|%5c/i.test(url.pathname)) return null
    if (!(url.protocol === local.protocol && url.host === local.host) && url.origin !== apiOrigin) return null
    if (!url.pathname.startsWith('/api/')) return null
    if (!/\.(pdf|csv|ics)$/i.test(url.pathname) && !['pdf', 'csv'].includes(url.searchParams.get('format'))) return null
    return `${url.pathname}${url.search}`
  } catch { return null }
}
export function safeExternalUrl(value, publicOrigin) {
  const url = new URL(value, publicOrigin)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only secure HTTPS links can be opened')
  return url.href
}
export function responseExportName(headers, path) {
  const disposition = headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) { try { return decodeURIComponent(encoded) } catch { /* use fallback */ } }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1]
    || new URL(path, 'https://divinghq.app').pathname.split('/').pop()
}
