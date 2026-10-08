// Native entry configures these hooks before loading the shared app. Web builds
// keep same-origin requests and browser cookie authentication unchanged.
let runtime = null
export const isNativeApp = () => runtime !== null
export function setNativeRuntime(value) { runtime = value }
export function nativeSocketOptions({ spectator, userId }) {
  return runtime?.socketOptions({ spectator, userId }) || null
}
export async function installNativeLifecycle(router, callbacks) {
  if (runtime) await runtime.installLifecycle(router, callbacks)
}
export const publicAppOrigin = () => runtime?.apiOrigin || window.location.origin
export const nativeShareBlob = (blob, filename) => runtime.shareBlob(blob, filename)
export const nativeOpenExternal = url => runtime.openUrl(url)
export const nativePrintDocument = options => runtime.printDocument(options)
export const handleNativeUrl = url => runtime?.openLink(url) || Promise.resolve(false)
export const clearPendingNativeNavigation = () => runtime?.clearSession()

export const nativeShareUrl = (path, title) => runtime.shareUrl(path, title)
export const nativeDownload = path => runtime.download(path)
