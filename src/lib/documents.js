// Keep one export action across desktop browsers and native share/save sheets.
import { nativeShareBlob, nativeDownload, nativeOpenExternal, nativePrintDocument, isNativeApp, publicAppOrigin } from './native-platform.js'
import { showError } from '../composables/useNotify.js'
export async function saveDocument(blob, filename) {
  try {
    if (isNativeApp()) { await nativeShareBlob(blob, filename); return true }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch (error) { showError(error.message || 'Could not save this file'); return false }
}
export async function openExternal(url, { replace = false } = {}) {
  try {
    if (isNativeApp()) await nativeOpenExternal(url)
    else if (replace) window.location.assign(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) { showError(error.message || 'Could not open this link') }
}
export async function printDocument(options) {
  if (isNativeApp()) return nativePrintDocument(options)
  window.print()
}
export { publicAppOrigin }

export async function saveRemoteDocument(path, filename) {
  if (isNativeApp()) { await nativeDownload(path); return true }
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || response.statusText)
  }
  return saveDocument(await response.blob(), filename)
}
