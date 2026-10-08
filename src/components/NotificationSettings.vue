<script setup>
import { computed, onMounted, ref } from 'vue'
import { isNativeApp } from '@/lib/native-platform'
import { usePush } from '@/composables/usePush'
const { permission, subscribe, unsubscribe } = usePush()
const native = isNativeApp()
const controller = ref(null)
const state = computed(() => controller.value?.nativePushState)
const busy = ref(false)
const message = ref('')
const browserEnabled = ref(false)
const status = computed(() => {
  if (native) {
    if (!state.value) return 'Checking notification settings…'
    if (state.value.configured === null) return state.value.error ? 'Unable to check notification delivery' : 'Checking notification settings…'
    if (!state.value.configured) return 'Push delivery is not configured yet'
    if (state.value.permission === 'denied') return 'Blocked in device settings'
    return state.value.enabled ? 'On for this device' : 'Off for this device'
  }
  if (permission.value === 'unsupported') return 'Not supported by this browser'
  if (permission.value === 'denied') return 'Blocked in browser settings'
  return browserEnabled.value ? 'On for this browser' : 'Off for this browser'
})
async function run(action) {
  busy.value = true; message.value = ''
  try { await action() } catch (e) { message.value = e.message }
  finally { busy.value = false }
}
async function enable() {
  const result = await subscribe()
  if (!result.ok) message.value = result.reason
  else { browserEnabled.value = true; message.value = 'Notifications enabled.' }
}
async function disable() {
  await unsubscribe(); browserEnabled.value = false
  message.value = state.value?.error || 'Notifications disabled on this device.'
}
async function test() {
  await controller.value.testNativePush()
  message.value = 'Test accepted by the notification service. Look for a DivingHQ notification on this device.'
}
onMounted(async () => {
  if (native) controller.value = await import('@/lib/native-push')
  else if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    browserEnabled.value = !!await reg?.pushManager?.getSubscription()
  }
})
</script>

<template>
  <section aria-labelledby="notification-settings-title" class="notification-settings">
    <div>
      <h2 id="notification-settings-title">Notifications</h2>
      <p>Receive meet updates, requests and account activity when DivingHQ is closed.</p>
    </div>
    <p class="notification-status" role="status">{{ status }}</p>
    <p v-if="native" class="notification-detail">Lock-screen notifications keep details private. Open the app to read them. Notifications pause when you sign out or your session expires.</p>
    <div class="notification-actions">
      <button v-if="!(native ? state?.enabled : browserEnabled)" class="btn btn-primary" :disabled="busy || state?.busy || permission === 'unsupported'" @click="run(enable)">Enable notifications</button>
      <button v-else class="btn btn-ghost" :disabled="busy" @click="run(disable)">Turn off on this device</button>
      <button v-if="native" class="btn btn-ghost" :disabled="busy || !state?.enabled" @click="run(test)">Send test notification</button>
      <button v-if="native" class="btn btn-ghost" :disabled="busy || !controller" @click="run(() => controller.openNativeNotificationSettings())">Device notification settings</button>
      <button v-if="native" class="btn btn-ghost" :disabled="busy || !controller" @click="run(() => controller.refreshNativePush())">Refresh status</button>
    </div>
    <p v-if="message || state?.error" role="status" class="notification-detail">{{ message || state?.error }}</p>
    <p v-if="native && state?.lastAccepted" class="notification-detail">Last accepted by the notification service: {{ new Date(state.lastAccepted).toLocaleString() }}. Delivery depends on your device connection and notification settings.</p>
    <RouterLink to="/inbox" class="notification-inbox">Open notification inbox</RouterLink>
  </section>
</template>
<style scoped>
.notification-settings { display: grid; gap: var(--space-4); }
.notification-settings h2 { margin: 0 0 var(--space-2); }
.notification-settings p { margin: 0; }
.notification-settings p, .notification-detail { color: var(--fg-2); line-height: 1.5; }
.notification-status { font-weight: 600; }
.notification-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.notification-actions .btn { min-height: 44px; }
.notification-inbox { min-height: 44px; display: inline-flex; align-items: center; color: var(--accent); }
</style>
