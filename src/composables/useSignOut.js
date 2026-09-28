// The one sign-out path for an explicit "Sign out" (user menu, Cmd-K).
//
// AppShell and the command palette each had their own copy of
// clearSession() + router.push('/login'), and both left two things
// behind on a shared meet-desk laptop: the previous user's floating
// notification banners, and their web-push subscription, so their
// pushes kept arriving on that device after they'd gone.
//
// Order matters. DELETE /api/push/subscribe needs the session cookie,
// and clearSession() fires the logout that clears it, so the push
// revoke goes first. It's capped so a dead network can't hold the
// sign-out hostage; the server re-points the endpoint anyway when the
// next person on the device subscribes.
import { unsubscribePush, clearNotifications } from './usePush'

const PUSH_REVOKE_WAIT_MS = 1500

export async function signOut(auth, router, to = '/login') {
  let timer = null
  await Promise.race([
    unsubscribePush(auth),
    new Promise((resolve) => { timer = setTimeout(resolve, PUSH_REVOKE_WAIT_MS) }),
  ])
  clearTimeout(timer)
  clearNotifications()
  auth.clearSession()
  if (router) router.push(to)
}
