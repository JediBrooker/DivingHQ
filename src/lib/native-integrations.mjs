// Native-only implementations. Files stay in the private cache, never in a
// world-readable external directory. The OS share sheet provides Save to Files,
// compatible document viewers and explicit user-selected sharing destinations.
import { Browser } from '@capacitor/browser'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { MAX_EXPORT_BYTES, safeExportName, exportRequestPath, responseExportName, safeExternalUrl } from './native-files.mjs'
import { nativeLinkPath } from './native-boundary.mjs'

const EXPORT_DIR = 'divinghq-exports'
export function createNativeIntegrations({ apiOrigin, localBase, reportError,
  filesystem = Filesystem, browser = Browser, share = Share, request = (...args) => fetch(...args),
  schedule = setTimeout, eventDocument = globalThis.document,
  encode = blob => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.readAsDataURL(blob)
  }),
}) {
  let router = null
  let generation = 0
  let pendingLink = null
  const writes = new Set()
  const cleanExports = () => filesystem.rmdir({ path: EXPORT_DIR, directory: Directory.Cache, recursive: true }).catch(() => {})
  // Launch cleanup also removes files left by a killed process/share target.
  let ready = cleanExports()
  async function clearSession() {
    generation += 1
    pendingLink = null
    ready = ready.then(async () => {
      await Promise.allSettled([...writes])
      await cleanExports()
    })
    await ready
  }
  async function shareBlob(blob, filename, current = generation) {
    if (!blob.size || blob.size > MAX_EXPORT_BYTES) throw new Error('Export must be between 1 byte and 25 MB')
    const name = safeExportName(filename, blob.type)
    await ready
    if (current !== generation) throw new Error('Account changed during export')
    const data = await encode(blob)
    if (current !== generation) throw new Error('Account changed during export')
    const path = `${EXPORT_DIR}/${crypto.randomUUID()}/${name}`
    const writing = filesystem.writeFile({ path, directory: Directory.Cache, data, recursive: true })
    writes.add(writing)
    let file
    try { file = await writing } finally { writes.delete(writing) }
    if (current !== generation) {
      await filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {})
      throw new Error('Account changed during export')
    }
    try { await share.share({ title: name, files: [file.uri], dialogTitle: 'Save or share file' }) }
    catch (error) { if (!/cancel|dismiss/i.test(error?.message || '')) throw error }
    finally {
      // Android recipients may read after the chooser closes. A failed chooser
      // still leaves a private file, so bound its lifetime on every exit path.
      schedule(() => filesystem.rmdir({ path: path.slice(0, path.lastIndexOf('/')), directory: Directory.Cache, recursive: true }).catch(() => {}), 60 * 60 * 1000)
    }
  }
  async function download(value) {
    const path = exportRequestPath(value, localBase, apiOrigin)
    if (!path) throw new Error('Unsupported download link')
    const current = generation
    const response = await request(path, { credentials: 'same-origin', redirect: 'error' })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.error || `Download failed (${response.status})`)
    }
    if (current !== generation) throw new Error('Account changed during download')
    if (Number(response.headers.get('content-length')) > MAX_EXPORT_BYTES) throw new Error('Export exceeds 25 MB')
    const blob = await response.blob()
    if (current !== generation) throw new Error('Account changed during download')
    await shareBlob(blob, responseExportName(response.headers, path), current)
  }
  async function openUrl(value) { await browser.open({ url: safeExternalUrl(value, apiOrigin) }) }
  async function openLink(value) {
    if (typeof value !== 'string') return false
    const absolute = value.startsWith('/') ? `${apiOrigin}${value}` : value
    const path = nativeLinkPath(absolute, apiOrigin)
    if (!path) return false
    if (!router) { pendingLink = path; return true }
    if (!router.resolve(path).matched.some(record => !record.path.includes(':pathMatch'))) return false
    const current = generation
    await browser.close().catch(() => {})
    if (current !== generation) return false
    await router.push(path)
    return true
  }
  function install(value) {
    router = value
    if (pendingLink) { const path = pendingLink; pendingLink = null; openLink(path).catch(reportError) }
    eventDocument.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a[href]')
      if (!anchor || event.defaultPrevented || event.button !== 0) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('#')) return
      const downloadPath = exportRequestPath(href, localBase, apiOrigin)
      let parsed
      try { parsed = new URL(href, localBase) } catch { event.preventDefault(); return }
      const local = new URL(localBase)
      const internal = (parsed.protocol === local.protocol && parsed.host === local.host) || parsed.origin === apiOrigin
      if (downloadPath) { event.preventDefault(); download(downloadPath).catch(reportError) }
      else if (internal && anchor.target === '_blank') {
        event.preventDefault()
        openLink(`${apiOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`).catch(reportError)
      } else if (!internal && parsed.protocol === 'https:') {
        event.preventDefault(); openUrl(href).catch(reportError)
      } else if (['javascript:', 'data:', 'file:', 'http:'].includes(parsed.protocol)) {
        event.preventDefault(); reportError(new Error('This link cannot be opened securely'))
      }
    }, true)
  }
  async function shareUrl(path, title = 'DivingHQ') {
    const url = safeExternalUrl(path, apiOrigin)
    if (!nativeLinkPath(url, apiOrigin)) throw new Error('Only DivingHQ pages can be shared')
    await share.share({ title, url, dialogTitle: title })
  }
  return { shareBlob, shareUrl, download, openUrl, openLink, install, clearSession }
}
