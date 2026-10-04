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
