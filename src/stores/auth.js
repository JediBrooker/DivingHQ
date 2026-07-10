import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { idbClear, cachedFetch } from '@/lib/idbCache'
import { fingerprintFromUser } from '@/lib/userFingerprint'

export const useAuthStore = defineStore('auth', () => {
  // The session credential (the JWT) lives in an httpOnly cookie now,
  // the browser sends it automatically and JS can't read it, which
  // closes the XSS token-theft vector the old sessionStorage token left open.
  //
  // What we keep here is only the decoded IDENTITY (id, org_roles,
  // locale...), delivered in the login/refresh response bodies and
  // rehydrated from /api/auth/me on boot. The server re-verifies the
  // cookie on every request, so `user` is display/routing state, never
  // a credential. Tampering with it changes UI hints only, never access.
  const user = ref(null)

  const isLoggedIn = computed(() => !!user.value)

  // Stable per-identity key for scoping client-side caches (idbCache,
  // outbox) so a shared device never serves one user's data to the
  // next person. Derived from the user id now that the token itself is unreadable.
  const fingerprint = computed(() => fingerprintFromUser(user.value))

  // Accept either { user } (the new explicit shape) or a flat payload
  // carrying a top-level id (login/refresh responses still spread the
  // payload for API clients). Any `token` field is ignored, the cookie
  // is the session now.
  function saveSession(data) {
    const next = data?.user || (data && data.id ? data : null)
    if (!next) {
      throw new Error('Cannot save a session without a user identity')
    }
    // Wipe any cached responses owned by the previous identity before
    // swapping in the new one. Keeps disk usage bounded across sign-in/out
    // cycles on a shared device, even though cache keys are per-fingerprint.
    idbClear().catch(() => {})
    user.value = next
  }

  function clearSession() {
    user.value = null
    // Clear the httpOnly cookie server-side since JS can't delete it.
    // Fire-and-forget with keepalive so it still completes even if the
    // caller navigates away (hard redirect to /login) in the same tick.
    try {
      fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {})
    } catch { /* navigation already tore down fetch, cookie still clears server-side */ }
    try { sessionStorage.clear() } catch { /* private mode */ }
    // Belt-and-braces: drop every cached API payload so the next user
    // on a shared device can't be served the previous user's data.
    idbClear().catch(() => {})
  }

  // Rehydrate identity from the httpOnly session cookie on app boot.
  // 401 = anonymous (no cookie, expired, or revoked), that's a normal
  // first-visit state, not an error. Never throws so boot can't be blocked.
  async function fetchMe() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' })
      if (res.ok) {
        const body = await res.json().catch(() => null)
        user.value = body?.user || null
      } else {
        user.value = null
      }
    } catch {
      user.value = null
    }
  }

  function hasRole(role) {
    if (!user.value) return false
    if (user.value.is_system_admin) return true
    return (user.value.org_roles ?? []).includes(role)
  }

  function hasAnyRole(roles) {
    return roles.some(r => hasRole(r))
  }

  // A parent who signs up purely to pay for their child holds no role
  // beyond 'spectator' (that's all registration grants), so role checks
  // on their own would lock them out of the very pages they came for.
  // The server sets this on the login response and /api/auth/me. It
  // gates UI only; every payment endpoint re-checks the guardian link.
  const hasDependents = computed(() => Boolean(user.value?.has_dependents))

  function getHeaders() {
    // No Authorization header any more, the httpOnly session cookie
    // carries the credential and rides along on every same-origin
    // request. Still need Content-Type set for JSON bodies though.
    return { 'Content-Type': 'application/json' }
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      // Send the session cookie on every request.
      credentials: 'same-origin',
      headers: { ...getHeaders(), ...(options.headers ?? {}) },
    })
    // 401 = cookie expired or revoked. Clear the session so the router
    // guard sends the user back to /login instead of every page throwing
    // red errors. Skip the redirect for viewers who weren't signed in to
    // begin with, a 401 there just means a public endpoint is genuinely
    // refusing them, not a session-expiry signal.
    if (res.status === 401 && isLoggedIn.value) {
      clearSession()
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || res.statusText)
    }
    return res.json()
  }

  // Stale-while-revalidate variant of apiFetch. Wraps idbCache's
  // cachedFetch so authenticated reads can serve a cached copy instantly
  // and refresh on the side. Returns { data, fromCache, age }.
  // Per-user cache fingerprint gets passed in explicitly now that the
  // token isn't readable from the Authorization header.
  async function cachedApiFetch(url, opts = {}) {
    const { cache = {}, ...fetchInit } = opts
    const result = await cachedFetch(url, {
      ...fetchInit,
      credentials: 'same-origin',
      headers: { ...getHeaders(), ...(fetchInit.headers ?? {}) },
    }, { ...cache, fingerprint: fingerprint.value })
    return result
  }

  function formatRoles(roles = []) {
    const LABELS = { org_admin:'Org Admin', meet_manager:'Meet Manager', referee:'Referee', judge:'Judge', diver:'Diver', spectator:'Spectator' }
    return roles.map(r => LABELS[r] ?? r).join(' · ')
  }

  return {
    user, isLoggedIn, fingerprint, hasDependents,
    saveSession, clearSession, fetchMe,
    hasRole, hasAnyRole, getHeaders,
    apiFetch, cachedApiFetch,
    formatRoles,
  }
})
