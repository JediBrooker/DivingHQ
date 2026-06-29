<script setup>
// DiveRecorder Archive Explorer — public, read-only browse of the
// historical results mined from diverecorder.co.uk into the dr_*
// tables (migrations 059/060, /api/dr-archive/*). Mirrors the
// Scoreboard browse stance: signed-in users get the CRM shell (route
// has meta.appShell), the public get minimal chrome.
//
// Browse views (switched client-side): meets → meet events → event
// results → divesheet, plus a diver search that lists a person's
// results across meets. The meet list filters by country and/or
// date range, matching the source site's own navigation. System
// admins additionally get an "Import" panel to pull newly-published
// meets on demand (the same job the scheduled sync runs).
import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { groupArchiveEvents } from '@/composables/useProgressionGroups'
import MeetEventGrid from '@/components/scoreboard/MeetEventGrid.vue'

const auth = useAuthStore()

// Group a loaded meet's events into progression rows (base
// discipline name + parsed phase → aligned prelim/semi/final
// columns). Best-effort, since DiveRecorder only carries a
// name-parsed phase, not a structural stage link.
function archiveGroup(meetId) {
  return groupArchiveEvents(meetEvents.value[meetId] || [])
}
const isSysAdmin = ref(!!auth.user?.is_system_admin)

const view = ref('meets') // meets | meet | event | result | diver
const loading = ref(false)
const error = ref('')

const meets = ref([])
const countries = ref([])
const filters = ref({ q: '', nat: '', from: '', to: '' })

// Pagination — the API caps each page; we page through with
// offset and expose Prev/Next. hasMore is true when the last page
// came back full (so there's likely another page to fetch).
const PAGE_SIZE = 50
const page = ref(0)          // 0-based
const total = ref(0)         // total meets matching current filters
const hasMore = ref(false)   // fallback when total is unknown
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const rangeStart = computed(() => (meets.value.length ? page.value * PAGE_SIZE + 1 : 0))
const rangeEnd = computed(() => page.value * PAGE_SIZE + meets.value.length)

// Windowed page tokens: first + last + a few around the current page,
// with '…' gaps — e.g. [1, '…', 5, 6, 7, '…', 28]. Keeps the control
// compact even with hundreds of pages.
const pageItems = computed(() => {
  const tp = totalPages.value
  const cur = page.value
  const wanted = new Set([0, tp - 1])
  for (let i = cur - 1; i <= cur + 1; i++) if (i >= 0 && i < tp) wanted.add(i)
  const sorted = [...wanted].filter((n) => n >= 0 && n < tp).sort((a, b) => a - b)
  const items = []
  let prev = -1
  for (const n of sorted) {
    if (prev >= 0 && n - prev > 1) items.push('…')
    items.push(n)
    prev = n
  }
  return items
})
const event = ref(null)      // { event, results }  — event detail view
const diver = ref(null)      // { diver, history }   — diver history view

// Meet accordion — first click expands a meet to reveal its events
// inline (lazy-loaded), mirroring the Scoreboard's meets browser.
const expandedMeets = ref({})  // meetId -> true
const meetEvents = ref({})     // meetId -> events[] (cached after first open)

// Within the event detail (and diver history), a diver row expands
// inline to show that diver's full divesheet (lazy-loaded).
const expandedResults = ref({}) // resultId -> true
const resultDives = ref({})     // resultId -> dives[]

const diverQuery = ref('')
const diverHits = ref([])

// Live meet-name typeahead suggestions (autopopulate as you type).
const meetHits = ref([])

// Date range slider. The track spans every month between the
// archive's earliest and latest meet; two thumbs pick a sub-range.
const months = ref([])       // [{ y, m, iso:'YYYY-MM', label:'Oct 2021' }]
const fromIdx = ref(0)
const toIdx = ref(0)
const sliderReady = computed(() => months.value.length > 1)
const lastIdx = computed(() => Math.max(1, months.value.length - 1))
const fromPct = computed(() => (fromIdx.value / lastIdx.value) * 100)
const toPct = computed(() => (toIdx.value / lastIdx.value) * 100)

// Date-only formatter that does NOT round-trip through a UTC Date
// (the API returns plain 'YYYY-MM-DD', and `new Date('2021-10-23')`
// would shift a day in negative-offset zones).
function fmtDay(s) {
  if (!s) return ''
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return s
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

async function api(path) {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/dr-archive${path}`)
    if (!res.ok) throw new Error(`Request failed (${res.status})`)
    return await res.json()
  } catch (e) {
    error.value = e.message || 'Something went wrong'
    return null
  } finally {
    loading.value = false
  }
}

async function loadCountries() {
  const rows = await api('/countries')
  if (rows) countries.value = rows
}

async function loadMeets() {
  const p = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page.value * PAGE_SIZE),
  })
  const { q, nat, from, to } = filters.value
  if (q.trim()) p.set('q', q.trim())
  if (nat) p.set('nat', nat)
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const rows = await api(`/meets?${p.toString()}`)
  if (rows) {
    meets.value = rows
    hasMore.value = rows.length === PAGE_SIZE
  }
}

// Total count for the current filters (drives the numbered page
// links). Plain fetch — kept off the shared loading spinner so it
// doesn't race the meets fetch. Non-fatal if it fails.
async function loadCount() {
  try {
    const p = new URLSearchParams()
    const { q, nat, from, to } = filters.value
    if (q.trim()) p.set('q', q.trim())
    if (nat) p.set('nat', nat)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    const res = await fetch(`/api/dr-archive/meets-count?${p.toString()}`)
    if (res.ok) total.value = (await res.json()).total ?? 0
  } catch { /* numbered links just won't show */ }
}

// Filter changes reset to the first page and refresh the count;
// Prev/Next/number steps reuse the cached count.
function reloadFirstPage() {
  page.value = 0
  loadCount()
  loadMeets()
}
function scrollToTop() {
  document.querySelector('.dr-archive')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function goToPage(n) {
  if (n === page.value || n < 0 || n >= totalPages.value || loading.value) return
  page.value = n
  loadMeets()
  scrollToTop()
}
function nextPage() {
  if (total.value ? page.value >= totalPages.value - 1 : !hasMore.value) return
  page.value += 1
  loadMeets()
  scrollToTop()
}
function prevPage() {
  if (page.value === 0) return
  page.value -= 1
  loadMeets()
  scrollToTop()
}

function resetFilters() {
  filters.value = { q: '', nat: '', from: '', to: '' }
  meetHits.value = []
  fromIdx.value = 0
  toIdx.value = Math.max(0, months.value.length - 1)
  reloadFirstPage()
}

// Build the month track between two ISO dates (inclusive).
function buildMonths(minIso, maxIso) {
  if (!minIso || !maxIso) return []
  const [y0, m0] = minIso.split('-').map(Number)
  const [y1, m1] = maxIso.split('-').map(Number)
  const out = []
  let y = y0, m = m0
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push({
      y, m,
      iso: `${y}-${String(m).padStart(2, '0')}`,
      label: new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
    })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

async function loadDateRange() {
  const r = await api('/date-range')
  if (!r || !r.min_date || !r.max_date) return
  months.value = buildMonths(r.min_date, r.max_date)
  fromIdx.value = 0
  toIdx.value = Math.max(0, months.value.length - 1)
}

// Map the two thumbs to filters.from (first day of fromMonth) and
// filters.to (last day of toMonth). Only narrows the query when the
// user has actually moved a thumb off the full-range ends.
function applySliderToFilters() {
  const mo = months.value
  if (mo.length < 2) return
  const lo = mo[fromIdx.value]
  const hi = mo[toIdx.value]
  filters.value.from = fromIdx.value > 0 ? `${lo.iso}-01` : ''
  if (toIdx.value < mo.length - 1) {
    const lastDay = new Date(hi.y, hi.m, 0).getDate() // day 0 of next month
    filters.value.to = `${hi.iso}-${String(lastDay).padStart(2, '0')}`
  } else {
    filters.value.to = ''
  }
}

// Keep the two thumbs from crossing, then push to the query (debounced).
let sliderTimer = null
watch([fromIdx, toIdx], ([f, t]) => {
  if (f > t) {
    // snap the thumb that moved past the other back to meet it
    if (f !== t) toIdx.value = f
  }
  applySliderToFilters()
  clearTimeout(sliderTimer)
  sliderTimer = setTimeout(reloadFirstPage, 200)
})

const rangeLabel = computed(() => {
  const mo = months.value
  if (mo.length < 2) return ''
  return `${mo[fromIdx.value]?.label ?? ''} – ${mo[toIdx.value]?.label ?? ''}`
})

// First click on a meet expands it inline (accordion); its events
// are fetched once and cached.
function isMeetOpen(id) { return !!expandedMeets.value[id] }
async function toggleMeet(id) {
  if (expandedMeets.value[id]) { expandedMeets.value[id] = false; return }
  expandedMeets.value[id] = true
  if (!meetEvents.value[id]) {
    const data = await api(`/meets/${id}`)
    if (data) meetEvents.value[id] = data.events
  }
}
// Picking a meet from the typeahead expands it inline and closes the
// suggestion list (the row is already in the filtered accordion).
function pickMeet(id) {
  if (!expandedMeets.value[id]) toggleMeet(id)
  meetHits.value = []
}

// Second click — on an event — opens the event detail (ranked
// results), the same "open the event" step the Scoreboard uses.
async function openEvent(id) {
  const data = await api(`/events/${id}`)
  if (data) { event.value = data; expandedResults.value = {}; view.value = 'event' }
}

// A diver row in a results/history table expands inline to that
// diver's divesheet (lazy-loaded), keeping the accordion feel.
function isResultOpen(id) { return !!expandedResults.value[id] }
async function toggleResult(id) {
  if (expandedResults.value[id]) { expandedResults.value[id] = false; return }
  expandedResults.value[id] = true
  if (!resultDives.value[id]) {
    const data = await api(`/results/${id}`)
    if (data) resultDives.value[id] = data.dives
  }
}

async function searchDivers() {
  const q = diverQuery.value.trim()
  if (q.length < 2) { diverHits.value = []; return }
  const rows = await api(`/divers/search?q=${encodeURIComponent(q)}`)
  if (rows) diverHits.value = rows
}
async function openDiver(id) {
  const data = await api(`/divers/${id}`)
  if (data) { diver.value = data; expandedResults.value = {}; diverHits.value = []; view.value = 'diver' }
}

let searchTimer = null
watch(diverQuery, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(searchDivers, 250)
})

// Meet-name filter autopopulates the list live as the user types
// (no need to press Search), and surfaces quick-jump suggestions.
let meetTimer = null
watch(() => filters.value.q, () => {
  clearTimeout(meetTimer)
  meetTimer = setTimeout(async () => {
    page.value = 0
    loadCount()
    await loadMeets()
    const q = filters.value.q.trim()
    meetHits.value = q.length >= 2 ? meets.value.slice(0, 8) : []
  }, 200)
})

// ----- Sysadmin import panel -----
const importStatus = ref(null)
const importBusy = ref(false)
let statusTimer = null

async function loadImportStatus() {
  if (!isSysAdmin.value) return
  try {
    importStatus.value = await auth.apiFetch('/api/dr-archive/admin/import/status')
  } catch { /* non-fatal */ }
}

async function triggerImport() {
  importBusy.value = true
  error.value = ''
  try {
    await auth.apiFetch('/api/dr-archive/admin/import', {
      method: 'POST',
      body: JSON.stringify({ onlyNew: true }),
    })
    pollStatus()
  } catch (e) {
    error.value = e.message || 'Import failed to start'
  } finally {
    importBusy.value = false
  }
}

function pollStatus() {
  clearInterval(statusTimer)
  loadImportStatus()
  statusTimer = setInterval(async () => {
    await loadImportStatus()
    if (importStatus.value && !importStatus.value.running) {
      clearInterval(statusTimer)
      loadMeets()       // surface any newly imported meets
      loadCountries()
    }
  }, 3000)
}

onMounted(() => {
  loadCount()
  loadMeets()
  loadCountries()
  loadDateRange()
  loadImportStatus()
})
</script>

<template>
  <div class="dr-archive">
    <header class="dr-head">
      <div class="dr-head-text">
        <h1 class="dr-title">Results Archive</h1>
        <p class="dr-sub">Historical diving results imported from DiveRecorder Meet Explorer.</p>
      </div>
      <RouterLink to="/scoreboard" class="btn btn-ghost btn-sm">← Back to Scoreboard &amp; Results</RouterLink>
    </header>

    <p v-if="error" class="dr-error">{{ error }}</p>

    <!-- Sysadmin import panel -->
    <section v-if="isSysAdmin" class="dr-admin">
      <div class="dr-admin-row">
        <div class="dr-admin-copy">
          <span class="dr-admin-title">Import new meets</span>
          <span class="dr-admin-note">Pulls meets not yet stored from DiveRecorder.</span>
        </div>
        <button class="btn btn-primary btn-sm" type="button" :disabled="importBusy || importStatus?.running" @click="triggerImport">
          <span v-if="importStatus?.running" class="dr-spinner" aria-hidden="true"></span>
          {{ importStatus?.running ? 'Importing…' : 'Import now' }}
        </button>
      </div>
      <p v-if="importStatus?.running" class="dr-admin-status">
        Running ({{ importStatus.trigger }}) — discovered {{ importStatus.stats?.discovered ?? 0 }},
        imported {{ importStatus.stats?.meets ?? 0 }} meet(s), {{ importStatus.stats?.results ?? 0 }} result(s)…
      </p>
      <p v-else-if="importStatus?.finishedAt" class="dr-admin-status">
        Last run finished — {{ importStatus.stats?.meets ?? 0 }} new meet(s),
        {{ importStatus.stats?.skipped ?? 0 }} already present.
        <span v-if="importStatus.error" class="dr-error-inline"> Error: {{ importStatus.error }}</span>
      </p>
    </section>

    <!-- Diver search is always available (Explore by Diver) -->
    <div class="dr-search">
      <span class="dr-search-icon" aria-hidden="true">⚲</span>
      <input
        class="input dr-search-input"
        v-model="diverQuery"
        type="search"
        placeholder="Find a diver by name…"
        aria-label="Search divers"
      />
      <ul v-if="diverHits.length" class="dr-hits">
        <li v-for="d in diverHits" :key="d.id">
          <button type="button" @click="openDiver(d.id)">
            <span class="dr-hit-name">{{ d.name }}</span>
            <span class="dr-hit-meta">{{ d.club_name }}</span>
            <span class="badge badge-muted">{{ d.result_count }} result(s)</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- MEETS LIST + filters -->
    <section v-if="view === 'meets'">
      <form class="dr-filter" @submit.prevent="reloadFirstPage">
        <div class="dr-typeahead">
          <input class="input" v-model="filters.q" type="search" placeholder="Filter by meet name…" aria-label="Filter meets" autocomplete="off" />
          <ul v-if="meetHits.length" class="dr-hits dr-hits-inline">
            <li v-for="m in meetHits" :key="m.id">
              <button type="button" @click="pickMeet(m.id)">
                <span class="dr-hit-name">{{ m.name }}</span>
                <span v-if="m.country_name" class="badge badge-green">{{ m.country_name }}</span>
                <span class="dr-hit-meta">{{ fmtDay(m.meet_date) }}</span>
              </button>
            </li>
          </ul>
        </div>
        <select class="select dr-country" v-model="filters.nat" aria-label="Filter by country" @change="reloadFirstPage">
          <option value="">All countries</option>
          <option v-for="c in countries" :key="c.country_code" :value="c.country_code">
            {{ c.country_name }} ({{ c.meet_count }})
          </option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm" @click="resetFilters">Reset</button>
      </form>

      <!-- Two-way date range slider. A rail + accent fill sit behind
           two overlaid range inputs; only the thumbs catch pointer
           events so either end is independently draggable. -->
      <div v-if="sliderReady" class="dr-range">
        <div class="dr-range-head">
          <span class="dr-range-cap">Date range</span>
          <span class="dr-range-label">{{ rangeLabel }}</span>
        </div>
        <div class="dr-range-track">
          <div class="dr-range-rail"></div>
          <div class="dr-range-fill" :style="{ left: fromPct + '%', right: (100 - toPct) + '%' }"></div>
          <input
            class="dr-range-input"
            :style="{ zIndex: fromIdx >= lastIdx ? 6 : 4 }"
            type="range"
            :min="0" :max="months.length - 1" step="1"
            v-model.number="fromIdx"
            aria-label="Range start month"
          />
          <input
            class="dr-range-input"
            type="range"
            :min="0" :max="months.length - 1" step="1"
            v-model.number="toIdx"
            aria-label="Range end month"
          />
        </div>
        <div class="dr-range-ends">
          <span>{{ months[0]?.label }}</span>
          <span>{{ months[months.length - 1]?.label }}</span>
        </div>
      </div>

      <p v-if="loading && !meets.length" class="dr-empty">Loading…</p>
      <p v-else-if="!meets.length" class="dr-empty">No meets found.</p>

      <!-- Meets accordion — first click expands a meet to reveal its
           events inline; clicking an event opens it. Same shape and
           process as the Scoreboard's meets browser. -->
      <div v-else class="meets-acc">
        <div
          v-for="m in meets"
          :key="m.id"
          class="meet-acc"
          :class="{ 'is-open': isMeetOpen(m.id) }"
        >
          <button class="meet-acc-head" :aria-expanded="isMeetOpen(m.id)" @click="toggleMeet(m.id)">
            <span class="meet-acc-caret" aria-hidden="true">{{ isMeetOpen(m.id) ? '▾' : '▸' }}</span>
            <div class="meet-acc-titles">
              <span class="meet-acc-name">{{ m.name }}</span>
              <span v-if="m.country_name" class="meet-acc-org">{{ m.country_name }}</span>
            </div>
            <div class="meet-acc-meta">
              <span class="meet-acc-count">{{ m.event_count }} {{ m.event_count === 1 ? 'event' : 'events' }}</span>
              <span v-if="m.meet_date" class="meet-acc-date">{{ fmtDay(m.meet_date) }}</span>
            </div>
          </button>

          <div v-if="isMeetOpen(m.id)" class="meet-acc-body">
            <p v-if="!meetEvents[m.id]" class="dr-loading-inline">Loading events…</p>
            <!-- One row per discipline; prelim → semi → final grouped
                 into aligned columns (best-effort from the parsed
                 phase). Clicking a stage opens its results. -->
            <MeetEventGrid
              v-else
              :rows="archiveGroup(m.id).rows"
              :max-cols="archiveGroup(m.id).maxCols"
              @select="openEvent"
            />
          </div>
        </div>
      </div>

      <!-- Pagination — server-paged. Prev/Next plus numbered links
           (windowed with … gaps) so the user sees how many pages
           there are and can jump straight to one. -->
      <div v-if="meets.length && (totalPages > 1 || page > 0 || hasMore)" class="dr-pager">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="page === 0 || loading" @click="prevPage">← Prev</button>
        <div v-if="total" class="dr-pages">
          <template v-for="(it, i) in pageItems" :key="i">
            <span v-if="it === '…'" class="dr-page-gap">…</span>
            <button
              v-else
              type="button"
              class="dr-page"
              :class="{ 'is-current': it === page }"
              :aria-current="it === page ? 'page' : undefined"
              :disabled="loading"
              @click="goToPage(it)"
            >{{ it + 1 }}</button>
          </template>
        </div>
        <span v-else class="dr-pager-info">{{ rangeStart }}–{{ rangeEnd }}</span>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="(total ? page >= totalPages - 1 : !hasMore) || loading" @click="nextPage">Next →</button>
      </div>
    </section>

    <!-- EVENT detail → ranked results; each diver row expands to
         their full divesheet inline. -->
    <section v-else-if="view === 'event' && event">
      <button class="btn btn-ghost btn-sm dr-back" type="button" @click="view = 'meets'">← {{ event.event.meet_name }}</button>
      <h2 class="dr-h2">{{ event.event.name }}</h2>
      <p class="dr-crumb">
        {{ event.event.meet_name }}
        <template v-if="event.event.event_date"> · {{ fmtDay(event.event.event_date) }}</template>
      </p>
      <div class="dr-card">
        <table class="dr-table">
          <thead><tr><th></th><th>Rank</th><th>Diver</th><th>Club</th><th class="num">Total</th></tr></thead>
          <tbody>
            <template v-for="r in event.results" :key="r.id">
              <tr class="dr-trow" :class="{ 'is-open': isResultOpen(r.id) }" @click="toggleResult(r.id)">
                <td class="dr-caret-cell"><span class="dr-caret">{{ isResultOpen(r.id) ? '▾' : '▸' }}</span></td>
                <td class="dr-rank">{{ r.rank ?? '—' }}</td>
                <td class="dr-strong">{{ r.diver_name }}</td>
                <td class="dr-muted">{{ r.club_name }}</td>
                <td class="num dr-score">{{ r.total_score ?? '—' }}</td>
              </tr>
              <tr v-if="isResultOpen(r.id)" class="dr-sheet-row">
                <td colspan="5">
                  <p v-if="!resultDives[r.id]" class="dr-loading-inline">Loading divesheet…</p>
                  <table v-else class="dr-subtable">
                    <thead><tr><th>Rnd</th><th>Dive</th><th>Pos</th><th class="num">DD</th><th>Judges</th><th class="num">Points</th><th class="num">Score</th></tr></thead>
                    <tbody>
                      <tr v-for="d in resultDives[r.id]" :key="d.round_number">
                        <td class="dr-rank">{{ d.round_number }}</td>
                        <td class="dr-mono dr-strong">{{ d.dive_code }}</td>
                        <td class="dr-mono">{{ d.position }}</td>
                        <td class="num dr-mono">{{ d.degree_of_difficulty }}</td>
                        <td class="judges"><span v-for="(j, i) in d.judge_scores" :key="i" class="jchip">{{ j }}</span></td>
                        <td class="num dr-mono">{{ d.dive_points }}</td>
                        <td class="num dr-score">{{ d.running_total }}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <!-- DIVER history (from search) → results across meets; each row
         expands to that divesheet inline. -->
    <section v-else-if="view === 'diver' && diver">
      <button class="btn btn-ghost btn-sm dr-back" type="button" @click="view = 'meets'">← All meets</button>
      <h2 class="dr-h2">{{ diver.diver.name }}</h2>
      <p class="dr-crumb">
        {{ diver.diver.club_name }}
        <template v-if="diver.diver.birth_year"> · {{ diver.diver.birth_year }}</template>
      </p>
      <div class="dr-card">
        <table class="dr-table">
          <thead><tr><th></th><th>Date</th><th>Meet</th><th>Event</th><th class="num">Rank</th><th class="num">Total</th></tr></thead>
          <tbody>
            <template v-for="h in diver.history" :key="h.result_id">
              <tr class="dr-trow" :class="{ 'is-open': isResultOpen(h.result_id) }" @click="toggleResult(h.result_id)">
                <td class="dr-caret-cell"><span class="dr-caret">{{ isResultOpen(h.result_id) ? '▾' : '▸' }}</span></td>
                <td class="dr-muted dr-mono">{{ fmtDay(h.event_date) }}</td>
                <td class="dr-strong">{{ h.meet_name }}</td>
                <td>{{ h.event_name }}</td>
                <td class="num dr-rank">{{ h.rank ?? '—' }}</td>
                <td class="num dr-score">{{ h.total_score ?? '—' }}</td>
              </tr>
              <tr v-if="isResultOpen(h.result_id)" class="dr-sheet-row">
                <td colspan="6">
                  <p v-if="!resultDives[h.result_id]" class="dr-loading-inline">Loading divesheet…</p>
                  <table v-else class="dr-subtable">
                    <thead><tr><th>Rnd</th><th>Dive</th><th>Pos</th><th class="num">DD</th><th>Judges</th><th class="num">Points</th><th class="num">Score</th></tr></thead>
                    <tbody>
                      <tr v-for="d in resultDives[h.result_id]" :key="d.round_number">
                        <td class="dr-rank">{{ d.round_number }}</td>
                        <td class="dr-mono dr-strong">{{ d.dive_code }}</td>
                        <td class="dr-mono">{{ d.position }}</td>
                        <td class="num dr-mono">{{ d.degree_of_difficulty }}</td>
                        <td class="judges"><span v-for="(j, i) in d.judge_scores" :key="i" class="jchip">{{ j }}</span></td>
                        <td class="num dr-mono">{{ d.dive_points }}</td>
                        <td class="num dr-score">{{ d.running_total }}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dr-archive { max-width: 1000px; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-12); }

/* Header */
.dr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); margin-bottom: var(--space-5); }
.dr-title {
  margin: 0; font-family: var(--font-display); font-weight: 900; font-style: italic;
  font-size: 26px; letter-spacing: -0.01em; color: var(--fg);
}
.dr-sub { margin: var(--space-1) 0 0; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); }

.dr-error { color: var(--danger-fg); background: var(--danger-bg); border: 1px solid var(--red-100); padding: var(--space-2) var(--space-3); border-radius: var(--radius); font-size: var(--text-sm); }
.dr-error-inline { color: var(--danger-fg); }

/* Sysadmin import panel */
.dr-admin {
  margin: 0 0 var(--space-4); padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface-2); box-shadow: var(--shadow-xs);
}
.dr-admin-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.dr-admin-copy { display: flex; flex-direction: column; gap: 1px; }
.dr-admin-title { font-weight: 600; font-size: var(--text-body); color: var(--fg); }
.dr-admin-note { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); }
.dr-admin-status { margin: var(--space-2) 0 0; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); }
.dr-spinner {
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--fg-on-accent) 40%, transparent);
  border-top-color: var(--fg-on-accent); display: inline-block;
  animation: dr-spin 0.7s linear infinite;
}
@keyframes dr-spin { to { transform: rotate(360deg); } }

/* Diver search */
.dr-search { margin: 0 0 var(--space-4); position: relative; }
.dr-search-icon {
  position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%) rotate(-45deg);
  color: var(--fg-3); font-size: 15px; pointer-events: none;
}
.dr-search-input { padding-left: 2.1rem; }

/* Filter row */
.dr-filter { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; align-items: center; }
.dr-typeahead { position: relative; flex: 1; min-width: 220px; }
.dr-country { flex: 0 1 220px; }

/* Typeahead / suggestion dropdowns */
.dr-hits {
  list-style: none; margin: var(--space-1) 0 0; padding: var(--space-1);
  border: 1px solid var(--border); border-radius: var(--radius);
  max-height: 320px; overflow-y: auto; background: var(--surface);
  box-shadow: var(--shadow-md);
}
.dr-hits-inline { position: absolute; top: 100%; left: 0; right: 0; z-index: 30; }
.dr-hits li button {
  width: 100%; text-align: start; display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); background: none; border: none;
  border-radius: var(--radius-sm); cursor: pointer; color: var(--fg);
}
.dr-hits li button:hover { background: var(--surface-hover); }
.dr-hit-name { font-weight: 600; font-size: var(--text-sm); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-hit-meta { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); white-space: nowrap; }

/* ── Two-way date range slider ──────────────────────────────
   A rail + an accent fill sit behind two overlaid range inputs.
   The inputs are transparent and ignore pointer events except on
   their thumbs, so either end drags independently. */
.dr-range {
  margin: 0 0 var(--space-5); padding: var(--space-3) var(--space-4) var(--space-2);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-lg);
  max-width: 560px;
}
.dr-range-head { display: flex; justify-content: space-between; align-items: baseline; }
.dr-range-cap { font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-3); }
.dr-range-label { font-family: var(--font-display); font-weight: 800; font-size: var(--text-sm); color: var(--accent); }
.dr-range-track { position: relative; height: 34px; }
.dr-range-rail {
  position: absolute; top: 50%; left: 0; right: 0; height: 6px; transform: translateY(-50%);
  background: var(--bg-sunken); border-radius: var(--radius-pill);
}
.dr-range-fill {
  position: absolute; top: 50%; height: 6px; transform: translateY(-50%);
  background: var(--accent); border-radius: var(--radius-pill);
}
.dr-range-input {
  position: absolute; top: 0; left: 0; width: 100%; height: 34px; margin: 0;
  background: none; pointer-events: none; -webkit-appearance: none; appearance: none;
}
.dr-range-input::-webkit-slider-runnable-track { height: 18px; background: transparent; }
.dr-range-input::-moz-range-track { height: 18px; background: transparent; }
.dr-range-input::-webkit-slider-thumb {
  pointer-events: auto; -webkit-appearance: none; appearance: none;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--surface); border: 3px solid var(--accent);
  box-shadow: var(--shadow-sm); cursor: grab;
  transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur) var(--ease);
}
.dr-range-input::-moz-range-thumb {
  pointer-events: auto; width: 18px; height: 18px; border-radius: 50%;
  background: var(--surface); border: 3px solid var(--accent);
  box-shadow: var(--shadow-sm); cursor: grab;
}
.dr-range-input::-webkit-slider-thumb:hover { transform: scale(1.12); }
.dr-range-input:active::-webkit-slider-thumb { cursor: grabbing; box-shadow: var(--shadow-focus); }
.dr-range-input:focus-visible::-webkit-slider-thumb { box-shadow: var(--shadow-focus); }
.dr-range-ends { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-3); }

/* ── Meets accordion (mirrors the Scoreboard meets browser) ── */
.meets-acc { display: flex; flex-direction: column; gap: var(--space-2); }
.meet-acc {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  box-shadow: var(--shadow-xs);
}
.meet-acc:hover { border-color: var(--border-2); box-shadow: var(--shadow-sm); }
.meet-acc.is-open { border-color: var(--border-2); }
.meet-acc-head {
  width: 100%; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4);
  background: none; border: none; cursor: pointer; text-align: start;
}
.meet-acc-head:hover { background: var(--surface-2); }
.meet-acc-caret { font-family: var(--font-display); font-size: 13px; color: var(--fg-3); justify-self: center; }
.meet-acc-titles { min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
.meet-acc-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900; font-style: italic;
  color: var(--fg); line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-acc-org { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); }
.meet-acc-meta { display: flex; align-items: center; gap: var(--space-3); font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); flex-shrink: 0; }
.meet-acc-count, .meet-acc-date { white-space: nowrap; }
.meet-acc-body { padding: 0 var(--space-4) var(--space-4); border-top: 1px solid var(--border); }
.dr-loading-inline { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); padding: var(--space-3) 0; margin: 0; }

/* Pagination controls */
.dr-pager { display: flex; align-items: center; justify-content: center; gap: var(--space-3); margin-top: var(--space-4); flex-wrap: wrap; }
.dr-pager-info { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); min-width: 5rem; text-align: center; }
.dr-pages { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; justify-content: center; }
.dr-page {
  min-width: 2rem; padding: 0.3rem 0.5rem; border-radius: var(--radius-sm);
  background: none; border: 1px solid transparent; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--text-sm); color: var(--accent);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}
.dr-page:hover { background: var(--surface-2); text-decoration: underline; }
.dr-page.is-current {
  background: var(--accent); color: var(--fg-on-accent); border-color: var(--accent);
  font-weight: 700; cursor: default; text-decoration: none;
}
.dr-page:disabled { cursor: default; }
.dr-page-gap { color: var(--fg-3); padding: 0 0.15rem; user-select: none; }

/* Detail headers */
.dr-back { margin-bottom: var(--space-3); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.dr-h2 { margin: 0; font-family: var(--font-display); font-weight: 900; font-style: italic; font-size: 20px; color: var(--fg); }
.dr-crumb { margin: var(--space-1) 0 var(--space-3); font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-3); }

/* Tables inside a card */
.dr-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); overflow: hidden; }
.dr-table { width: 100%; border-collapse: collapse; }
.dr-table th {
  text-align: start; padding: var(--space-2) var(--space-3);
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-3);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}
.dr-table td { padding: 0.55rem var(--space-3); border-bottom: 1px solid var(--border); font-size: var(--text-sm); color: var(--fg-2); vertical-align: middle; }
.dr-table tbody tr:last-child td { border-bottom: none; }
.dr-table .num { text-align: end; }
.dr-mono { font-family: var(--font-mono); }
.dr-strong { font-weight: 600; color: var(--fg); }
.dr-muted { color: var(--fg-3); }
.dr-rank { font-family: var(--font-mono); color: var(--fg-3); width: 3rem; }
.dr-score { font-family: var(--font-mono); font-weight: 700; color: var(--fg); }
.dr-empty { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-3); text-align: center; padding: var(--space-12) var(--space-4); background: var(--surface-2); border: 1px dashed var(--border); border-radius: var(--radius-lg); }

/* Expandable diver rows — click to reveal the divesheet inline. */
.dr-trow { cursor: pointer; transition: background var(--dur) var(--ease); }
.dr-trow:hover { background: var(--surface-2); }
.dr-trow.is-open { background: var(--accent-soft); }
.dr-caret-cell { width: 28px; }
.dr-caret { font-family: var(--font-display); font-size: 12px; color: var(--fg-3); }
.dr-trow.is-open .dr-caret { color: var(--accent); }
.dr-sheet-row > td { padding: 0; background: var(--surface-2); }
.dr-subtable { width: 100%; border-collapse: collapse; }
.dr-subtable th {
  text-align: start; padding: var(--space-1) var(--space-3);
  font-family: var(--font-mono); font-size: 9.5px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-3);
  border-bottom: 1px solid var(--border);
}
.dr-subtable td { padding: 0.4rem var(--space-3); border-bottom: 1px solid var(--border); font-size: var(--text-xs); color: var(--fg-2); }
.dr-subtable tbody tr:last-child td { border-bottom: none; }
.dr-subtable .num { text-align: end; }

/* Judge score chips on the divesheet */
.judges { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.jchip {
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-2);
  background: var(--surface); border: 1px solid var(--accent-soft-2);
  border-radius: var(--radius-sm); padding: 0.05rem 0.4rem;
}

@media (max-width: 560px) {
  .dr-filter { flex-direction: column; align-items: stretch; }
  .dr-country { flex: 1; }
  .meet-acc-head { grid-template-columns: 18px minmax(0, 1fr) auto; gap: var(--space-2); padding: var(--space-3); }
}
</style>
