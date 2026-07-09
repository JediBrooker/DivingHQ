<script setup>
/* Global Cmd-K command palette. Single instance mounted at the
 * app root. Opens on:
 *   - ⌘K / Ctrl-K (anywhere except inside text inputs that haven't
 *     stolen focus, we deliberately fire even from inside inputs
 *     because returning users use Cmd-K mid-typing all the time)
 *   - Manual openPalette() from any view
 *
 * Searches across, in priority order:
 *   1. Static destinations (dashboard, inbox, my profile, …)
 *   2. Events the user has access to (live → upcoming → completed)
 *   3. Clubs in the user's federation
 *   4. Divers (typeahead via /api/users/search?q=)
 *
 * Static + events + clubs come from a single /api/dashboard call
 * that the dashboard already loads on mount; we cache the slice
 * client-side so opening the palette feels instant. Diver search
 * fans out per-keystroke once the query is 2+ chars.
 *
 * Keyboard: ↑/↓ to move, Enter to jump, Esc to close.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { onOpenCommandPalette, replayRoleTour } from '@/composables/useAppChannel'

const router = useRouter()
const auth   = useAuthStore()

const open    = ref(false)

// Lock background scroll while the palette is up so iOS Safari
// can't drift the page underneath while the user is searching.
useBodyScrollLock().lockWhile(open)
const query   = ref('')
const cursor  = ref(0)
const inputEl = ref(null)

// ----- Index ----------------------------------------------------
// Static destinations available to everyone signed in. Role
// gating happens in `availableStaticEntries`.
const STATIC_ENTRIES = [
  { kind:'go', label:'Dashboard',      sub:'Your home',                 to:'/dashboard',     roles:null,           icon:'🏠' },
  { kind:'go', label:'Inbox',          sub:'Notifications + history',   to:'/inbox',         roles:null,           icon:'📬' },
  { kind:'go', label:'My Profile',     sub:'Edit name + password',      to:'/profile',       roles:null,           icon:'👤' },
  { kind:'go', label:'Setup Wizard',   sub:'Replay org-admin walkthrough', to:'/setup',       roles:['org_admin'],  icon:'🛠' },
  { kind:'go', label:'Meet Manager',   sub:'Create + edit events',      to:'/manager',       roles:['org_admin','meet_manager'], icon:'📅' },
  { kind:'go', label:'Control Room',   sub:'Run a live meet',           to:'/control',       roles:['meet_manager','org_admin','referee'], icon:'⚡' },
  { kind:'go', label:'User Manager',   sub:'Roles + coach links',       to:'/users',         roles:['org_admin'],  icon:'👥' },
  { kind:'go', label:'Audit Log',      sub:'Federation activity',       to:'/audit',         roles:['org_admin'],  icon:'📋' },
  { kind:'go', label:'Clubs',          sub:'Federation registry',       to:'/clubs',         roles:['org_admin'],  icon:'🏛' },
  { kind:'go', label:'Teams',          sub:'World Aquatics Team Event entries',   to:'/teams',         roles:['org_admin'],  icon:'🏆' },
  { kind:'go', label:'Dive Directory', sub:'All diving codes + DD',     to:'/dives',         roles:null,           icon:'📖' },
  { kind:'go', label:'Assign Judges',  sub:'Match panels to events',    to:'/assign-judges', roles:['org_admin','meet_manager'], icon:'⚖️' },
  { kind:'go', label:'Replay tour',    sub:'See the role-specific intro again', to:null,    roles:null,           icon:'🎬',
    action: () => {
      replayRoleTour()
    } },
  { kind:'go', label:'Sign Out',       sub:'End your session',          to:null,             roles:null,           icon:'🚪',
    action: () => { auth.clearSession(); router.push('/login') } },
]

// Cached slices populated from /api/dashboard on first open.
const events = ref([])
const clubs  = ref([])
const cachedAt = ref(0)

// Diver search results (live keystroke).
const divers = ref([])
const diverLoading = ref(false)
const diverAbort = ref(null)

// ----- Open / close --------------------------------------------
async function openPalette() {
  open.value  = true
  query.value = ''
  cursor.value = 0
  await nextTick()
  inputEl.value?.focus()
  // Prime cache (events + clubs) once per 60s. Cmd-K should
  // feel instant, so we accept slightly-stale data over a
  // round-trip on every open.
  if (Date.now() - cachedAt.value > 60_000) primeCache()
}

function closePalette() {
  open.value = false
  query.value = ''
  diverAbort.value?.abort()
  diverAbort.value = null
}

async function primeCache() {
  if (!auth.isLoggedIn) return
  try {
    const data = await auth.apiFetch('/api/dashboard')
    events.value = Array.isArray(data.events) ? data.events : []
    clubs.value  = Array.isArray(data.clubs)  ? data.clubs  : []
    cachedAt.value = Date.now()
  } catch { /* silent, palette still works fine with static entries */ }
}

// ----- Keyboard glue -------------------------------------------
function onGlobalKey(e) {
  // Held-key debounce: without this, holding ⌘K or / opens the
  // palette repeatedly until the user lets go.
  if (e.repeat) return

  // Toggle on Cmd/Ctrl-K. Always, even inside inputs (returning
  // users use Cmd-K mid-typing; stealing focus is the point).
  const isMod = e.metaKey || e.ctrlKey
  if (isMod && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value ? closePalette() : openPalette()
    return
  }
  // / shortcut: open palette only when NOT inside an input/textarea.
  if (e.key === '/' && !open.value) {
    const t = e.target
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (!inField) { e.preventDefault(); openPalette() }
  }
}

function onPaletteKey(e) {
  if (e.key === 'Escape')      { e.preventDefault(); closePalette(); return }
  if (e.key === 'ArrowDown')   { e.preventDefault(); cursor.value = Math.min(cursor.value + 1, results.value.length - 1) }
  else if (e.key === 'ArrowUp'){ e.preventDefault(); cursor.value = Math.max(cursor.value - 1, 0) }
  else if (e.key === 'Enter')  { e.preventDefault(); pick(results.value[cursor.value]) }
}

// ----- Search --------------------------------------------------
const availableStaticEntries = computed(() => {
  if (!auth.isLoggedIn) return []
  return STATIC_ENTRIES.filter(e => !e.roles || auth.hasAnyRole(e.roles) || e.label === 'Sign Out')
})

function score(haystack, needle) {
  // Cheap fuzzy: lowercase substring + small bonus when the
  // needle is at a word boundary. Good enough for a few-hundred
  // entry index; saves shipping fuse.js.
  if (!needle) return 1
  const h = (haystack || '').toLowerCase()
  const n = needle.toLowerCase()
  if (h === n) return 100
  if (h.startsWith(n)) return 80
  const wordBoundary = h.split(/[\s/_-]+/).some(w => w.startsWith(n))
  if (wordBoundary) return 60
  if (h.includes(n)) return 40
  // Subsequence match: every char of needle in order
  let i = 0
  for (const ch of h) {
    if (ch === n[i]) i++
    if (i >= n.length) return 20
  }
  return 0
}

const results = computed(() => {
  const q = query.value.trim()
  const out = []
  // 1. Static destinations
  for (const e of availableStaticEntries.value) {
    const s = Math.max(score(e.label, q), score(e.sub || '', q))
    if (s > 0) out.push({ ...e, _score: s })
  }
  // 2. Events
  for (const ev of events.value) {
    const status = (ev.status || '').toLowerCase()
    const sub = `${ev.height || ''} · ${status}`.trim()
    const s = Math.max(score(ev.name || '', q), score(sub, q))
    if (s > 0) out.push({
      kind:'event',
      label: ev.name,
      sub,
      icon: status === 'live' ? '🔴' : (status === 'completed' ? '✓' : '📅'),
      to: status === 'live' ? `/control?event=${ev.id}` :
          status === 'completed' ? `/scoreboard/${ev.id}` :
          `/manager?event=${ev.id}`,
      _score: s,
    })
  }
  // 3. Clubs
  for (const c of clubs.value) {
    const s = Math.max(score(c.name || '', q), score(c.short_code || '', q))
    if (s > 0) out.push({
      kind:'club',
      label: c.name,
      sub: c.short_code || 'Club',
      icon:'🏛',
      to: '/clubs',
      _score: s - 5,    // Slightly de-prioritised vs events
    })
  }
  // 4. Divers (only when q is non-empty, typeahead populates
  //    `divers.value`)
  for (const d of divers.value) {
    out.push({
      kind:'diver',
      label: d.full_name || 'Diver',
      sub: [d.club_name, d.country_code].filter(Boolean).join(' · ') || 'Diver',
      icon:'🤿',
      to: `/profile/${d.id}`,
      _score: 50,
    })
  }
  // Sort and trim
  out.sort((a, b) => b._score - a._score)
  return out.slice(0, 20)
})

// Diver typeahead: debounced fetch as the user types.
let diverDebounce = null
watch(query, (q) => {
  cursor.value = 0
  clearTimeout(diverDebounce)
  diverAbort.value?.abort()
  diverAbort.value = null
  if (!q || q.length < 2 || !auth.isLoggedIn) {
    divers.value = []
    return
  }
  diverDebounce = setTimeout(async () => {
    diverLoading.value = true
    const ctrl = new AbortController()
    diverAbort.value = ctrl
    try {
      // auth.apiFetch routes through the central 401-handler so a
      // stale-token user gets bounced to /login rather than seeing
      // a silently-empty palette.
      divers.value = await auth.apiFetch(
        `/api/divers/search?q=${encodeURIComponent(q)}`,
        { signal: ctrl.signal },
      )
    } catch { /* aborted, 401, or network, just ignore it */ }
    diverLoading.value = false
  }, 180)
})

function pick(entry) {
  if (!entry) return
  closePalette()
  if (typeof entry.action === 'function') {
    entry.action()
  } else if (entry.to) {
    router.push(entry.to)
  }
}

// ----- Mount ---------------------------------------------------
let offOpenChannel = null
onMounted(() => {
  window.addEventListener('keydown', onGlobalKey)
  // Other surfaces (e.g. the topbar Search button) open the palette via
  // the app channel, no window global, no mount-order coupling.
  offOpenChannel = onOpenCommandPalette(openPalette)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  if (offOpenChannel) offOpenChannel()
})
</script>

<template>
  <!-- Teleport defensively (see notes in ConfirmModal). -->
  <Teleport to="body">
  <div v-if="open" class="cmdk-backdrop" @mousedown.self="closePalette" role="dialog" aria-modal="true" aria-label="Quick search">
    <div class="cmdk-shell" @keydown="onPaletteKey">
      <div class="cmdk-input-row">
        <span class="cmdk-prefix" aria-hidden="true">⌘K</span>
        <input
          ref="inputEl"
          v-model="query"
          class="cmdk-input"
          type="text"
          placeholder="Jump to anything — page, event, club, diver…"
          autocomplete="off"
          spellcheck="false"
        >
        <button class="cmdk-close" @click="closePalette" aria-label="Close">✕</button>
      </div>

      <ul v-if="results.length" class="cmdk-results">
        <li
          v-for="(r, i) in results"
          :key="`${r.kind}-${r.label}-${i}`"
          :class="['cmdk-row', { active: i === cursor }]"
          @mouseenter="cursor = i"
          @click="pick(r)"
        >
          <span class="cmdk-row-icon">{{ r.icon }}</span>
          <span class="cmdk-row-text">
            <span class="cmdk-row-label">{{ r.label }}</span>
            <span v-if="r.sub" class="cmdk-row-sub">{{ r.sub }}</span>
          </span>
          <span class="cmdk-row-kind">{{ r.kind === 'go' ? '↵' : r.kind }}</span>
        </li>
      </ul>

      <div v-else-if="query" class="cmdk-empty">
        Nothing matches <strong>“{{ query }}”</strong>. Try a name, event, or page.
      </div>

      <div v-else class="cmdk-hint">
        <kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>Esc</kbd> to close
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.cmdk-backdrop {
  position: fixed; inset: 0;
  background: rgba(2, 6, 18, 0.7);
  /* iOS Safari < 16 / older macOS Safari need the -webkit- prefix. */
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  display: flex; align-items: flex-start; justify-content: center;
  /* dvh: keeps the palette anchored to the *live* viewport so
     it doesn't jitter as iOS Safari's URL bar collapses.
     vh fallback for browsers older than ~Q4-2022. */
  padding-top: 12vh;
  padding-top: 12dvh;
  z-index: 9000;
  animation: cmdk-fade 0.15s ease-out;
}
@keyframes cmdk-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.cmdk-shell {
  width: min(640px, 92vw);
  background: var(--bg-2, #0f172a);
  border: 1px solid var(--border, #1e293b);
  border-radius: var(--radius-lg, 12px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  display: flex; flex-direction: column;
}
.cmdk-input-row {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border, #1e293b);
}
.cmdk-prefix {
  font-family: var(--font-mono, monospace);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-3, #94a3b8);
  background: var(--bg-3, #1e293b);
  padding: 0.2rem 0.45rem;
  border-radius: 4px;
  flex-shrink: 0;
}
.cmdk-input {
  flex: 1 1 auto;
  background: transparent;
  border: 0; outline: 0;
  font-family: var(--font-display, sans-serif);
  font-size: 17px;
  color: var(--text, #f8fafc);
  padding: 0.25rem 0;
}
.cmdk-input::placeholder { color: var(--text-3, #94a3b8); }
.cmdk-close {
  background: transparent; border: 0; color: var(--text-3, #94a3b8);
  font-size: 18px; cursor: pointer; padding: 0.25rem 0.5rem;
  border-radius: 4px;
}
.cmdk-close:hover { color: var(--text, #f8fafc); background: var(--bg-3); }

.cmdk-results {
  list-style: none; margin: 0; padding: 0.4rem;
  max-height: 420px;
  overflow-y: auto;
  /* `overflow-x: clip` stops CSS's promote-to-auto from
     making the list silently horizontally scrollable when a
     long command label exceeds the palette width. */
  overflow-x: clip;
}
.cmdk-row {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius, 6px);
  cursor: pointer;
  transition: background 0.08s;
}
.cmdk-row.active { background: var(--bg-3, #1e293b); }
.cmdk-row-icon { font-size: 18px; flex-shrink: 0; width: 22px; text-align: center; }
.cmdk-row-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cmdk-row-label {
  font-family: var(--font-display, sans-serif);
  font-size: 14px; font-weight: 700;
  color: var(--text, #f8fafc);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cmdk-row-sub {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-3, #94a3b8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cmdk-row-kind {
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-3, #94a3b8);
  text-transform: uppercase; letter-spacing: 0.08em;
  flex-shrink: 0;
}
.cmdk-row.active .cmdk-row-kind { color: var(--cyan, #06b6d4); }

.cmdk-empty, .cmdk-hint {
  padding: 1.25rem 1.25rem 1.5rem;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text-3, #94a3b8);
  text-align: center;
}
.cmdk-empty strong { color: var(--text, #f8fafc); font-weight: 700; }
.cmdk-hint kbd {
  display: inline-block;
  background: var(--bg-3, #1e293b);
  border: 1px solid var(--border, #334155);
  border-radius: 4px;
  padding: 1px 6px;
  margin: 0 2px;
  font-family: inherit; font-size: 10px; font-weight: 700;
  color: var(--text-2, #cbd5e1);
}
</style>
