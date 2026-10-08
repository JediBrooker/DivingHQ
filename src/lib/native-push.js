// Loaded only in the native app. Preferences contains an installation identity,
// a revoke-only capability and opt-in state, never an account session credential.
import { reactive } from 'vue'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { PushNotifications } from '@capacitor/push-notifications'
import { App } from '@capacitor/app'
import { handleNativeUrl } from './native-platform'

const Settings = registerPlugin('NotificationSettings')
const KEY = 'divinghq.native-push.v1'
const platform = Capacitor.getPlatform()
export const nativePushState = reactive({ permission: 'prompt', enabled: false, configured: null, busy: false, error: '', lastAccepted: null })
let state, identityLoading, auth, receive, setup, lastIdentity, refreshingOwner, generation = 0, token = null, pendingTap = null, registrationWait = null, refreshing = null, registering = null, unregistering = null, sdkOperations = Promise.resolve()
const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('')
async function save() { await Preferences.set({ key: KEY, value: JSON.stringify(state) }) }
async function identity() {
  if (state) return state
  if (!identityLoading) identityLoading = (async () => {
    let loaded
    try { loaded = JSON.parse((await Preferences.get({ key: KEY })).value) } catch { /* new installation */ }
    state = loaded?.id && loaded?.revoke_key ? loaded : { id: crypto.randomUUID(), revoke_key: randomSecret(), enabled: false, owner: null, pendingRevoke: false, pendingUnregister: false, revision: 0 }
    await save()
    return state
  })()
  return identityLoading
}
async function revokePending() {
  if (!state.pendingRevoke) return
  const revision = state.revision
  const res = await fetch('/api/push/native/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.id, revoke_key: state.revoke_key, revision: state.revision }) })
  if (!res.ok) throw new Error('Notification cleanup is waiting for a connection')
  if (state.revision === revision) { state.pendingRevoke = false; await save() }
}
async function resolveNotification(raw, tapped) {
  const id = raw?.data?.notification_id
  if (!id || !/^[\da-f-]{36}$/i.test(id)) return
  if (!auth?.user?.id) { if (tapped) pendingTap = raw; return }
  const owner = auth.user.id, version = generation
  try {
    const row = await auth.apiFetch(`/api/notifications/${id}`)
    if (owner !== auth.user?.id || version !== generation) return
    receive?.(row)
    if (tapped) {
      if (row.category !== 'referee_signoff') await auth.apiFetch(`/api/notifications/${id}/acknowledge`, { method: 'POST' })
      if (owner === auth.user?.id && version === generation) await handleNativeUrl(row.action_url || '/inbox')
    }
  } catch { if (tapped) nativePushState.error = 'This notification has expired or belongs to another account.' }
}
export async function initNativePush(currentAuth, onReceive) {
  auth = currentAuth; receive = onReceive
  if (!setup) setup = (async () => {
    await identity()
    // Listener setup must precede register() and survives route changes.
    // https://capacitorjs.com/docs/apis/push-notifications
    await PushNotifications.addListener('registration', ({ value }) => {
      token = value
      if (registrationWait) { registrationWait.resolve(value); registrationWait = null }
      else if (state.enabled && state.owner === auth.user?.id) syncToken().catch(e => { nativePushState.error = e.message })
    })
    await PushNotifications.addListener('registrationError', () => {
      const error = new Error('The device could not register for notifications. Check your connection and try again.')
      registrationWait?.reject(error); registrationWait = null
      nativePushState.error = error.message
    })
    await PushNotifications.addListener('pushNotificationReceived', n => resolveNotification(n, false))
    await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => resolveNotification(notification, true))
    await App.addListener('appStateChange', ({ isActive }) => { if (isActive) refreshNativePush().catch(() => {}) })
    window.addEventListener('online', () => refreshNativePush().catch(() => {}))
  })()
  await setup
  await refreshNativePush()
}
async function syncToken() {
  if (!token || !state.enabled || state.owner !== auth.user?.id) return
  const owner = auth.user.id, version = generation, revision = state.revision
  const { environment } = await Settings.getPushEnvironment()
  await revokePending()
  if (version !== generation || auth.user?.id !== owner || !state.enabled) return
  await auth.apiFetch('/api/push/native', { method: 'POST', body: JSON.stringify({ id: state.id, revoke_key: state.revoke_key, platform, environment, token, revision, user_id: owner }) })
  if (version !== generation || auth.user?.id !== owner || !state.enabled) {
    await fetch('/api/push/native/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.id, revoke_key: state.revoke_key, revision }) }); return
  }
  nativePushState.enabled = true
}
function queueSdk(operation) {
  const task = sdkOperations.catch(() => {}).then(operation)
  sdkOperations = task
  return task
}
async function finishUnregister() {
  if (!state.pendingUnregister) return
  if (!unregistering) unregistering = queueSdk(async () => {
    const os = await Settings.getNotificationStatus()
    if (os.configured !== false) {
      if (platform === 'android') await Settings.unregisterPush()
      else await PushNotifications.unregister()
    }
    await PushNotifications.removeAllDeliveredNotifications()
    state.pendingUnregister = false
    await save()
  }).finally(() => { unregistering = null })
  return unregistering
}
async function register() {
  await finishUnregister()
  if (!registering) registering = queueSdk(registerOnce).finally(() => { registering = null })
  return registering
}
async function registerOnce() {
  if (!state.enabled || state.owner !== auth?.user?.id) return
  if (platform === 'android') await PushNotifications.createChannel({ id: 'divinghq_updates', name: 'DivingHQ updates', description: 'Meet updates and account notifications', importance: 4, visibility: 0, vibration: true })
  const waiting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { registrationWait = null; reject(new Error('Notification registration timed out. Please try again.')) }, 15000)
    registrationWait = { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } }
  })
  try { await PushNotifications.register() } catch (err) { registrationWait?.reject(err); registrationWait = null }
  await waiting
  await syncToken()
}
export async function refreshNativePush() {
  const owner = auth?.user?.id
  if (refreshing) {
    const previousOwner = refreshingOwner
    await refreshing
    if (owner !== previousOwner && owner === auth?.user?.id) return refreshNativePush()
    return
  }
  refreshingOwner = owner
  refreshing = refreshOnce().finally(() => { refreshing = null })
  return refreshing
}
async function refreshOnce() {
  nativePushState.configured = null
  const owner = auth?.user?.id, version = generation
  const current = () => owner === auth?.user?.id && version === generation
  await identity()
  if (!current()) return
  nativePushState.error = ''
  try {
    await finishUnregister()
    await revokePending()
    const permission = await PushNotifications.checkPermissions()
    const os = await Settings.getNotificationStatus()
    if (!current()) return
    nativePushState.permission = permission.receive === 'granted' && !os.enabled ? 'denied' : permission.receive
    if (!auth?.user?.id) { nativePushState.enabled = false; return }
    const status = await auth.apiFetch(`/api/push/native/${state.id}`)
    const { environment } = await Settings.getPushEnvironment()
    if (!current()) return
    nativePushState.configured = os.configured !== false && !!status.configured?.[platform] && (platform !== 'ios' || status.environments.includes(environment))
    nativePushState.lastAccepted = status.device?.last_accepted_at || null
    nativePushState.enabled = !!(state.enabled && state.owner === auth.user.id && status.device?.enabled && !status.device.revoked_at && status.device.session_active && nativePushState.permission === 'granted')
    if (state.owner && state.owner !== auth.user.id) await disableNativePush()
    if (state.enabled && state.owner === auth.user.id && nativePushState.permission === 'granted' && nativePushState.configured) await register()
    if (pendingTap) { const n = pendingTap; pendingTap = null; await resolveNotification(n, true) }
  } catch (e) { if (current()) { nativePushState.error = e.message; nativePushState.enabled = false } }
}
export async function enableNativePush() {
  nativePushState.busy = true; nativePushState.error = ''
  try {
    if (!auth?.user?.id) throw new Error('Sign in to enable notifications')
    const owner = auth.user.id, version = generation
    await refreshNativePush()
    if (nativePushState.configured === null) throw new Error(nativePushState.error || 'Notification status could not be checked. Check your connection and try again.')
    if (!nativePushState.configured) throw new Error('Notifications are not configured for this platform yet. In-app notifications remain available.')
    const permission = await PushNotifications.requestPermissions()
    nativePushState.permission = permission.receive
    if (permission.receive !== 'granted') throw new Error('Notifications are blocked. Allow them in device settings.')
    if (auth.user?.id !== owner || version !== generation) throw new Error('Account changed. Enable notifications again for this account.')
    if (!(await Settings.getNotificationStatus()).enabled) throw new Error('Notifications are blocked in device settings.')
    if (auth.user?.id !== owner || version !== generation) throw new Error('Account changed. Enable notifications again for this account.')
    state.revision = (state.revision || 0) + 1; state.enabled = true; state.owner = auth.user.id; await save()
    await register()
    if (auth.user?.id !== owner || version !== generation || !state.enabled) throw new Error('Notification setup was cancelled because the account changed.')
    return { ok: true }
  } catch (e) { nativePushState.error = e.message; return { ok: false, reason: e.message } }
  finally { nativePushState.busy = false }
}
export async function disableNativePush() {
  generation++; pendingTap = null; token = null
  await identity()
  state.revision = (state.revision || 0) + 1; state.enabled = false; state.owner = null; state.pendingRevoke = true; state.pendingUnregister = true
  nativePushState.enabled = false
  await save() // durable before any network wait, including offline sign-out
  // Server cleanup proceeds even if the OS SDK is offline. A future enable
  // awaits the durable OS cleanup before creating a replacement token.
  const serverCleanup = revokePending().catch(e => { nativePushState.error = e.message })
  await finishUnregister().catch(e => { nativePushState.error = e.message })
  await serverCleanup
}
export async function nativePushAccountChanged(id) {
  if (id === lastIdentity) return
  lastIdentity = id
  generation++
  const version = generation
  nativePushState.enabled = false
  await identity()
  if (version !== generation) return
  if (state.owner && state.owner !== id) await disableNativePush()
  if (id) await refreshNativePush()
}
export async function testNativePush() {
  return auth.apiFetch(`/api/push/native/${state.id}/test`, { method: 'POST' })
}
export const openNativeNotificationSettings = () => Settings.openNotificationSettings()
