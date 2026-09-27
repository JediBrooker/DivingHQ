// The support address (SUPPORT_EMAIL on the server), for the contact links on
// the signed-out pages: home, sign-in, the guide, privacy and terms.
//
// It comes from the public GET /api/public-config. One fetch per page load,
// shared by every caller through a module-level ref, since the value can't
// change while the app is open. The ref starts null so a page can hide its
// contact link for the moment it takes to load, rather than flash the hosted
// default on a self-hosted copy that set its own address. If the request
// fails (offline, old server) it settles on the default.
import { ref } from 'vue'

export const DEFAULT_SUPPORT_EMAIL = 'support@divinghq.app'

const supportEmail = ref(null)
let pending = null

export function loadSupportEmail(fetchImpl = globalThis.fetch) {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => fetchImpl('/api/public-config', { credentials: 'same-origin' }))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((cfg) => {
        const addr = cfg && typeof cfg.support_email === 'string' ? cfg.support_email.trim() : ''
        supportEmail.value = addr.includes('@') ? addr : DEFAULT_SUPPORT_EMAIL
      })
      .catch(() => {
        supportEmail.value = DEFAULT_SUPPORT_EMAIL
      })
  }
  return pending
}

export function useSupportEmail() {
  loadSupportEmail()
  return supportEmail
}
