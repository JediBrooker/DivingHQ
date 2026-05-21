import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { idbClear, cachedFetch } from '@/lib/idbCache'

const TOKEN_KEY = 'olympic_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(sessionStorage.getItem(TOKEN_KEY))

  const user = computed(() => {
    if (!token.value) return null
    try { return JSON.parse(atob(token.value.split('.')[1])) }
    catch { return null }
  })

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  function saveSession(data) {
    // Wipe any cached responses owned by the previous identity
    // before swapping in the new token. Even though cache keys are
    // per-user-fingerprint now, an explicit clear keeps disk usage
    // bounded across many sign-in/out cycles on the same device.
    idbClear().catch(() => {})
    token.value = data.token
    sessionStorage.setItem(TOKEN_KEY, data.token)
  }

  function clearSession() {
    token.value = null
    sessionStorage.clear()
    // Belt-and-braces: drop every cached API payload. Without this,
    // the next user on a shared device could be served the previous
    // user's cached profile / dashboard / club lists.
    idbClear().catch(() => {})
  }

  function hasRole(role) {
    if (!user.value) return false
    if (user.value.is_system_admin) return true
    return (user.value.org_roles ?? []).includes(role)
  }

  function hasAnyRole(roles) {
    return roles.some(r => hasRole(r))
  }

  function getHeaders() {
    // Only attach Authorization when we actually have a token.
    // Sending "Bearer null" would trigger the 401-on-bad-JWT path
    // on /api/events (and could trip future tightenings elsewhere)
    // — turning a clean public GET into a forced re-login for
    // anonymous spectators. Letting the header drop entirely
    // matches the server-side "no auth header → anonymous" branch.
    const h = { 'Content-Type': 'application/json' }
    if (token.value) h.Authorization = `Bearer ${token.value}`
    return h
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { ...getHeaders(), ...(options.headers ?? {}) },
    })
    // 401 = token expired or revoked. Clear the session so the
    // router guard sends the user back to /login, instead of every
    // page just throwing red errors with a stale-but-present token.
    // Skip the redirect for users who weren't authenticated to
    // begin with (no token) — a 401 there is the public endpoint
    // genuinely refusing them, not a session-expiry signal.
    if (res.status === 401 && token.value) {
      clearSession()
      // Best-effort hash-route redirect. Direct router import would
      // create a circular import in the SPA bundle, so we go through
      // window.location which is fine for a hard "your session ended".
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
  // cachedFetch so authenticated reads can serve a cached copy
  // instantly + refresh on the side. Returns { data, fromCache,
  // age } so the caller can render a "stale, refreshing…" hint.
  //
  // opts shape:
  //   { cache: { maxAgeMs, onUpdate }, ...fetchInit }
  // where cache.maxAgeMs is the hard TTL (omit for infinite SWR)
  // and cache.onUpdate fires when the background revalidation
  // lands. Everything else is passed through to fetch().
  //
  // 401 handling: cachedFetch deletes the cached entry on 401 and
  // returns null. We then clear the local session + redirect to
  // /login — same posture as apiFetch's 401 branch.
  async function cachedApiFetch(url, opts = {}) {
    const { cache = {}, ...fetchInit } = opts
    const result = await cachedFetch(url, {
      ...fetchInit,
      headers: { ...getHeaders(), ...(fetchInit.headers ?? {}) },
    }, cache)
    if (result.data === null && !result.fromCache && token.value) {
      // cachedFetch can return null for any reason (network fail,
      // 401, server error). We can't distinguish 401 from a
      // transient outage without re-fetching, so we DON'T force a
      // redirect here — unlike apiFetch which gets the exact
      // status code. Callers that need strict auth flow stay on
      // apiFetch; cachedApiFetch is for tolerable-stale reads.
    }
    return result
  }

  function formatRoles(roles = []) {
    const LABELS = { org_admin:'Org Admin', meet_manager:'Meet Manager', referee:'Referee', judge:'Judge', diver:'Diver', spectator:'Spectator' }
    return roles.map(r => LABELS[r] ?? r).join(' · ')
  }

  return {
    token, user, isLoggedIn,
    saveSession, clearSession,
    hasRole, hasAnyRole, getHeaders,
    apiFetch, cachedApiFetch,
    formatRoles,
  }
})
