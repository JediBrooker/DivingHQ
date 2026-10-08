import { isNativeApp } from './native-platform'
import { createAwakeController } from './native-poolside.mjs'

const awake = createAwakeController(async () => {
  const { registerPlugin } = await import('@capacitor/core')
  return registerPlugin('NotificationSettings')
})
export async function setPoolsideAwake(enabled) {
  if (isNativeApp()) await awake.set(enabled)
}
export async function poolsideHaptic(pattern) {
  if (isNativeApp()) {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics')
    // A tactile tap confirms the button press, not successful server delivery.
    await Haptics.impact({ style: Array.isArray(pattern) || pattern > 30 ? ImpactStyle.Medium : ImpactStyle.Light })
  } else if (typeof navigator?.vibrate === 'function') navigator.vibrate(pattern || 30)
}
