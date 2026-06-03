<script setup>
/* MeetsBrowser — meets-first browse surface for /scoreboard.
 *
 * Renders the cache banner, the LIVE-now strip (grouped by meet),
 * the two-row filter cluster, and the meets list itself — an
 * accordion where each row is a MEET and expanding it reveals the
 * events inside (styled like the public meet page). Selection of
 * an individual event is emitted as `select(eventId)`; the parent
 * (ScoreboardView) owns the navigation + state pivot into the
 * live-broadcast / recap layouts.
 *
 * Meets-first rationale: the page used to list events flat with a
 * small "part of <meet>" badge. Spectators think in meets ("the
 * Grand Prix"), then drill into a discipline, so the hierarchy is
 * inverted here — meets are the primary unit, events nest under
 * them.
 *
 * State boundary:
 *   * Master event list, derived live-events list, cache flag, and
 *     the filter source data (countries / years / heights / clubs)
 *     all come in as props — the parent loads them once and reuses
 *     them across the list + detail surfaces.
 *   * Filter state (search, country, year, height, club, status,
 *     sort) plus the per-meet expand/collapse state is OWNED here.
 *     None of it is read by the detail surfaces, so it never had a
 *     reason to live on ScoreboardView. localStorage persistence
 *     stays put for `sortBy` so a returning user lands on their
 *     last order.
 */
import { ref, computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { fmtDate } from '@/lib/format'

const props = defineProps({
  events:         { type: Array,   required: true },
  liveEvents:     { type: Array,   required: true },
  meetsFromCache: { type: Boolean, default: false },
  loadingList:    { type: Boolean, default: false },
  clubsList:      { type: Array,   default: () => [] },
  countries:      { type: Array,   default: () => [] },
  years:          { type: Array,   default: () => [] },
  heights:        { type: Array,   default: () => [] },
})

const emit = defineEmits(['select'])

// Filters drive the meets list when no event is selected.
const searchTerm    = ref('')
const countryFilter = ref('')
const yearFilter    = ref('')
const heightFilter  = ref('')
const clubFilter    = ref('')
const statusFilter  = ref('')      // '' | 'Live' | 'Completed'

// Sort preference persists in localStorage so a returning user
// lands on the order they last picked. (The old cards/list view
// toggle is gone — the meets accordion is now the single
// presentation.) `sortBy` controls the meet order applied AFTER
// filtering.
const sortBy = ref(localStorage.getItem('sb_sort_by') || 'recent') // 'recent' | 'oldest' | 'name'
watch(sortBy, (v) => localStorage.setItem('sb_sort_by', v))

// Cascade: when a country is picked, only show its clubs in the
// dropdown. With no country selected we show every club and
// prefix each name with its country code.
const visibleClubs = computed(() => {
  if (!countryFilter.value) return props.clubsList
  return props.clubsList.filter(c => c.country_code === countryFilter.value)
})

const filteredEvents = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return props.events.filter(e => {
    if (statusFilter.value && e.status !== statusFilter.value) return false
    if (countryFilter.value && e.country_code !== countryFilter.value) return false
    if (yearFilter.value && new Date(e.created_at).getFullYear() !== Number(yearFilter.value)) return false
    if (heightFilter.value && e.height !== heightFilter.value) return false
    if (clubFilter.value && !(e.club_ids || []).includes(clubFilter.value)) return false
    if (!term) return true
    return (
      (e.name || '').toLowerCase().includes(term) ||
      (e.meet_name || '').toLowerCase().includes(term) ||
      (e.org_name || '').toLowerCase().includes(term) ||
      (e.country_code || '').toLowerCase().includes(term)
    )
  })
})

const activeFilterCount = computed(() => {
  let n = 0
  if (searchTerm.value.trim()) n++
  if (countryFilter.value)     n++
  if (yearFilter.value)        n++
  if (heightFilter.value)      n++
  if (clubFilter.value)        n++
  if (statusFilter.value)      n++
  return n
})
const filtersActive = computed(() => activeFilterCount.value > 0)

// Stable group key for an event's parent meet. Events with no
// meet_id (rare standalone events) get a per-event "solo" key so
// each becomes its own single-event row.
function meetKeyOf(e) { return e.meet_id ? `meet:${e.meet_id}` : `solo:${e.id}` }

// Group the filtered events into their parent meets. A meet
// surfaces whenever ≥1 of its events survives the active filters,
// and only the surviving events render inside it — so the filter
// cluster stays meaningful in the meets-first layout. Meet-level
// metadata (org, country, dates) is lifted off the first event;
// every event in a meet shares the same host org.
const meetGroups = computed(() => {
  const groups = new Map()
  for (const e of filteredEvents.value) {
    const key = meetKeyOf(e)
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        isSolo: !e.meet_id,
        meetId: e.meet_id || null,
        name: e.meet_name || e.name,
        orgName: e.org_name,
        country: e.country_code,
        startDate: e.meet_start_date || null,
        endDate: e.meet_end_date || null,
        latestMs: 0,
        earliestMs: Infinity,
        latestCreatedAt: null,
        events: [],
      }
      groups.set(key, g)
    }
    g.events.push(e)
    const ms = e.created_at ? new Date(e.created_at).getTime() : 0
    if (ms >= g.latestMs)  { g.latestMs = ms; g.latestCreatedAt = e.created_at || g.latestCreatedAt }
    if (ms <  g.earliestMs) g.earliestMs = ms
  }
  const list = [...groups.values()]
  for (const g of list) {
    g.liveCount = g.events.filter(e => e.status === 'Live').length
    g.completedCount = g.events.length - g.liveCount
    g.isLive = g.liveCount > 0
    // Inner order: live events first, then alphabetical.
    g.events.sort((a, b) => {
      if (a.status === 'Live' && b.status !== 'Live') return -1
      if (b.status === 'Live' && a.status !== 'Live') return  1
      return (a.name || '').localeCompare(b.name || '')
    })
  }
  // Meet order: live meets float to the top (operators landing
  // mid-competition expect "what's on now" first), then the chosen
  // sort applied at the meet level.
  list.sort((a, b) => {
    if (a.isLive && !b.isLive) return -1
    if (b.isLive && !a.isLive) return  1
    if (sortBy.value === 'name') return a.name.localeCompare(b.name)
    return sortBy.value === 'oldest' ? a.earliestMs - b.earliestMs : b.latestMs - a.latestMs
  })
  return list
})

// Year a meet belongs to — its scheduled start, falling back to
// the most recent event's timestamp for meets with no dates set.
function meetYear(g) {
  const src = g.startDate || g.latestCreatedAt
  if (!src) return '—'
  const y = new Date(src).getFullYear()
  return Number.isNaN(y) ? '—' : y
}

// Header date label: the meet's scheduled range when set, else the
// most-recent event date as a fallback.
function meetDateLabel(g) {
  const s = g.startDate, e = g.endDate
  if (s && e && fmtDate(s) !== fmtDate(e)) return `${fmtDate(s)} – ${fmtDate(e)}`
  if (s) return fmtDate(s)
  return fmtDate(g.latestCreatedAt)
}

// Year-group the meets when the archive is large enough that a
// flat list gets hard to scan (≥12 meets across ≥2 years). Below
// that the flat list is friendlier. Mirrors the prior event-list
// behaviour, lifted to the meet level.
const GROUP_THRESHOLD = 12
const groupedMeets = computed(() => {
  const list = meetGroups.value
  if (list.length < GROUP_THRESHOLD) return null
  const groups = new Map()
  for (const g of list) {
    const y = meetYear(g)
    if (!groups.has(y)) groups.set(y, [])
    groups.get(y).push(g)
  }
  if (groups.size < 2) return null
  const oldestFirst = sortBy.value === 'oldest'
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === '—') return 1
      if (b === '—') return -1
      return oldestFirst ? Number(a) - Number(b) : Number(b) - Number(a)
    })
    .map(([year, items]) => ({ year, items }))
})

// Flat render list: interleaves year-header rows with meet rows
// when grouped, or just meet rows when not — so the template can
// render the accordion in a single loop without duplicating the
// (non-trivial) per-meet row markup across the grouped/flat
// branches.
const displayRows = computed(() => {
  if (groupedMeets.value) {
    const rows = []
    for (const yg of groupedMeets.value) {
      rows.push({ type: 'year', key: `y:${yg.year}`, year: yg.year, count: yg.items.length })
      for (const g of yg.items) rows.push({ type: 'meet', key: g.key, meet: g })
    }
    return rows
  }
  return meetGroups.value.map(g => ({ type: 'meet', key: g.key, meet: g }))
})

// LIVE strip, grouped by meet so every live chip shows the meet it
// belongs to. Reads the server-provided live list (unfiltered) —
// the strip is a persistent "what's on right now" affordance,
// independent of the archive filters below it.
const liveByMeet = computed(() => {
  const groups = new Map()
  for (const e of props.liveEvents) {
    const key = meetKeyOf(e)
    let g = groups.get(key)
    if (!g) {
      g = { key, meetId: e.meet_id || null, name: e.meet_name || e.name, country: e.country_code, events: [] }
      groups.set(key, g)
    }
    g.events.push(e)
  }
  return [...groups.values()]
})

// --- Per-meet expand / collapse ---
// Meets start collapsed — the page is a tidy list of meets that
// the user opens on demand (live action is already one tap away in
// the LIVE strip above, and live meets are pinned to the top). The
// only exception is when a filter/search is active: every matching
// meet is forced open so the events that matched are visible
// without an extra click per meet.
const expandedMeets = ref(new Set())
function toggleMeet(key) {
  if (expandedMeets.value.has(key)) expandedMeets.value.delete(key)
  else expandedMeets.value.add(key)
}
function isExpanded(key) {
  return filtersActive.value || expandedMeets.value.has(key)
}

function clearFilters() {
  searchTerm.value    = ''
  countryFilter.value = ''
  yearFilter.value    = ''
  heightFilter.value  = ''
  clubFilter.value    = ''
  statusFilter.value  = ''
}

// CSV export of the currently-filtered meets list. Useful for
// federations doing year-end reporting — pick a year + status
// in the filter, click Export.
function exportMeetsCsv() {
  const headers = [
    'Name', 'Org', 'Country', 'Status', 'Date',
    'Gender', 'Height', 'Type', 'Rounds', 'Judges',
    'Competitors', 'Clubs',
  ]
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = filteredEvents.value.map(e => [
    e.name,
    e.org_name,
    e.country_code || '',
    e.status,
    e.created_at ? new Date(e.created_at).toISOString().slice(0, 10) : '',
    e.gender || '',
    e.height || '',
    e.event_type || 'individual',
    e.total_rounds,
    e.number_of_judges,
    e.competitor_count || 0,
    e.club_count || 0,
  ].map(escape).join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `dive-recorder-meets-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Drop the club filter if the user picks a country whose clubs
// don't include the currently-selected club.
watch(countryFilter, (val) => {
  if (!val || !clubFilter.value) return
  const club = props.clubsList.find(c => c.id === clubFilter.value)
  if (club && club.country_code !== val) clubFilter.value = ''
})
</script>

<template>
  <div class="meets-mode">
    <!-- Cache banner — visible while the meets list was served
         from IndexedDB and the network refresh is in flight.
         Disappears the moment fresh data arrives. -->
    <div v-if="meetsFromCache" class="cache-banner">
      <span class="cache-dot"></span>
      Showing your last cached meets list — refreshing in the background
    </div>

    <!-- LIVE strip — clickable chips grouped under their parent
         meet, so each live event makes clear which meet it belongs
         to (e.g. Men's 3m Springboard sits under "2026 Australian
         Grand Prix"). Each chip jumps straight into that event's
         broadcast layout; the ↗ beside a meet name opens the full
         meet page. -->
    <div v-if="liveByMeet.length" class="live-strip">
      <div class="live-strip-head">
        <span class="live-pulse">● LIVE NOW</span>
        <span class="live-strip-sub">
          {{ liveEvents.length }} broadcasting · click any to watch
        </span>
      </div>
      <div class="live-strip-groups">
        <div v-for="g in liveByMeet" :key="g.key" class="live-meet-group">
          <div class="live-meet-label">
            <span class="live-meet-name">{{ g.name }}</span>
            <span v-if="g.country" class="live-meet-ctry">{{ g.country }}</span>
            <RouterLink
              v-if="g.meetId"
              :to="`/meet/${g.meetId}`"
              class="live-meet-link"
              @click.stop
              v-tip.fixed="'Open the full meet page'"
            >↗</RouterLink>
          </div>
          <div class="live-meet-chips">
            <button
              v-for="ev in g.events"
              :key="ev.id"
              class="live-chip"
              @click="emit('select', ev.id)"
              v-tip="ev.last_diver_name
                ? `Round ${ev.current_round}/${ev.total_rounds} · ${ev.last_diver_name} just scored`
                : `Round ${ev.current_round || 1}/${ev.total_rounds}`"
            >
              <span class="live-chip-dot" aria-hidden="true"></span>
              <span class="live-chip-name">{{ ev.name }}</span>
              <span v-if="ev.current_round" class="live-chip-round">
                R{{ ev.current_round }}/{{ ev.total_rounds }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Filter + tools row 1: search + result count + tools.
         The search input dominates so it's reachable at any
         viewport width; sort + export sit on the right. Filter
         dropdowns get their own row below. -->
    <div v-if="events.length" class="sb-tools">
      <div class="sb-tools-search">
        <input
          class="input sb-search-input"
          type="text"
          v-model="searchTerm"
          placeholder="Search meet, event, host org, country…"
          aria-label="Search meets"
        >
        <span class="sb-result-count">
          {{ meetGroups.length.toLocaleString() }} {{ meetGroups.length === 1 ? 'meet' : 'meets' }}
          · {{ filteredEvents.length.toLocaleString() }} {{ filteredEvents.length === 1 ? 'event' : 'events' }}
        </span>
      </div>
      <div class="sb-tools-right">
        <label class="sb-tool-label">Sort
          <select class="select sb-tool-select" v-model="sortBy">
            <option value="recent">Most recent</option>
            <option value="oldest">Oldest first</option>
            <option value="name">A–Z</option>
          </select>
        </label>
        <button
          v-if="filteredEvents.length"
          class="btn btn-ghost btn-sm"
          @click="exportMeetsCsv"
          v-tip.fixed="'Download the currently-filtered list as CSV'"
        >Export CSV</button>
      </div>
    </div>

    <!-- Filter row 2: secondary dropdowns. Wrap freely on narrow
         viewports rather than squeezing into one cramped line. -->
    <div v-if="events.length" class="sb-filter-row">
      <select class="select sb-filter-select" v-model="statusFilter">
        <option value="">All statuses</option>
        <option value="Live">Live now</option>
        <option value="Completed">Completed</option>
      </select>
      <select class="select sb-filter-select" v-model="countryFilter">
        <option value="">All countries ({{ countries.length }})</option>
        <option v-for="c in countries" :key="c.code" :value="c.code">
          {{ c.code }} — {{ c.org_name }}
        </option>
      </select>
      <select class="select sb-filter-select" v-model="yearFilter">
        <option value="">All years</option>
        <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
      </select>
      <select class="select sb-filter-select" v-model="heightFilter">
        <option value="">All heights</option>
        <option v-for="h in heights" :key="h" :value="h">{{ h }}</option>
      </select>
      <select class="select sb-filter-select" v-model="clubFilter">
        <option value="">All clubs ({{ visibleClubs.length }})</option>
        <option v-for="c in visibleClubs" :key="c.id" :value="c.id">
          {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template><template v-if="!countryFilter"> · {{ c.country_code }}</template>
        </option>
      </select>
      <button v-if="activeFilterCount" class="btn btn-ghost btn-sm" @click="clearFilters">
        Clear ({{ activeFilterCount }})
      </button>
    </div>

    <!-- Empty / loading states -->
    <div v-if="loadingList" class="meets-empty">Loading meets…</div>
    <div v-else-if="!events.length" class="meets-empty">No meets yet — check back when one starts.</div>
    <div v-else-if="!meetGroups.length" class="meets-empty">
      No meets match these filters.
      <button class="btn btn-ghost btn-sm" style="margin-inline-start:0.5rem" @click="clearFilters">Clear</button>
    </div>

    <!-- =========================================================
         MEETS ACCORDION — the primary browse surface. One row per
         meet; the year-section headers (when the archive is large)
         and the meet rows are interleaved into `displayRows` so
         this renders in a single loop. Expanding a meet reveals
         its events as cards (live first), styled like the public
         meet page; clicking an event opens its broadcast / recap.
         Standalone events with no parent meet render as a single
         direct-select row (no body to expand).
         ========================================================= -->
    <div v-else class="meets-acc">
      <template v-for="row in displayRows" :key="row.key">
        <!-- Year section header -->
        <div v-if="row.type === 'year'" class="sb-year-head">
          <span class="sb-year-label">{{ row.year }}</span>
          <span class="sb-year-count">{{ row.count }} {{ row.count === 1 ? 'meet' : 'meets' }}</span>
        </div>

        <!-- Standalone (no-meet) event → one-click direct-select row -->
        <button
          v-else-if="row.meet.isSolo"
          class="meet-acc-solo"
          :class="{ 'is-live': row.meet.isLive }"
          @click="emit('select', row.meet.events[0].id)"
        >
          <span class="meet-acc-caret" aria-hidden="true">→</span>
          <div class="meet-acc-titles">
            <span class="meet-acc-name">{{ row.meet.name }}</span>
            <span class="meet-acc-org">
              {{ row.meet.orgName }}<span v-if="row.meet.country" class="meet-acc-ctry">{{ row.meet.country }}</span>
            </span>
          </div>
          <div class="meet-acc-meta">
            <span v-if="row.meet.isLive" class="meet-acc-livebadge">● LIVE</span>
            <span v-else class="meet-acc-finalbadge">FINAL</span>
            <span v-if="row.meet.latestCreatedAt" class="meet-acc-date">{{ fmtDate(row.meet.latestCreatedAt) }}</span>
          </div>
        </button>

        <!-- Meet accordion row -->
        <div
          v-else
          class="meet-acc"
          :class="{ 'is-live': row.meet.isLive, 'is-open': isExpanded(row.meet.key) }"
        >
          <button
            class="meet-acc-head"
            :aria-expanded="isExpanded(row.meet.key)"
            @click="toggleMeet(row.meet.key)"
          >
            <span class="meet-acc-caret" aria-hidden="true">{{ isExpanded(row.meet.key) ? '▾' : '▸' }}</span>
            <div class="meet-acc-titles">
              <span class="meet-acc-name">{{ row.meet.name }}</span>
              <span class="meet-acc-org">
                {{ row.meet.orgName }}<span v-if="row.meet.country" class="meet-acc-ctry">{{ row.meet.country }}</span>
              </span>
            </div>
            <div class="meet-acc-meta">
              <span v-if="row.meet.liveCount" class="meet-acc-livebadge">● {{ row.meet.liveCount }} LIVE</span>
              <span class="meet-acc-count">{{ row.meet.events.length }} {{ row.meet.events.length === 1 ? 'event' : 'events' }}</span>
              <span v-if="meetDateLabel(row.meet)" class="meet-acc-date">{{ meetDateLabel(row.meet) }}</span>
            </div>
          </button>

          <div v-if="isExpanded(row.meet.key)" class="meet-acc-body">
            <div class="meet-ev-grid">
              <button
                v-for="ev in row.meet.events"
                :key="ev.id"
                :class="['meet-ev-card', ev.status === 'Live' ? 'is-live' : 'is-done']"
                @click="emit('select', ev.id)"
              >
                <div class="meet-ev-top">
                  <span class="meet-ev-name">{{ ev.name }}</span>
                  <span :class="['meet-ev-status', ev.status === 'Live' ? 'live' : 'final']">
                    {{ ev.status === 'Live' ? 'LIVE' : 'FINAL' }}
                  </span>
                </div>
                <div class="meet-ev-tags">
                  <span v-if="ev.gender" class="meet-tag">{{ ev.gender }}</span>
                  <span v-if="ev.height" class="meet-tag">{{ ev.height }}</span>
                  <span class="meet-tag">{{ ev.total_rounds }} rds</span>
                  <span class="meet-tag">{{ ev.number_of_judges }}j</span>
                  <span v-if="ev.event_type === 'synchro_pair'" class="meet-tag meet-tag-cyan">Synchro</span>
                  <span v-else-if="ev.event_type === 'team'" class="meet-tag meet-tag-cyan">Team</span>
                </div>
                <div class="meet-ev-foot">
                  <span v-if="ev.competitor_count" class="meet-ev-divers">
                    {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
                  </span>
                  <span v-if="ev.status === 'Live' && ev.current_round" class="meet-ev-round">
                    R{{ ev.current_round }}/{{ ev.total_rounds }}
                  </span>
                  <span class="meet-ev-cta">{{ ev.status === 'Live' ? 'Watch →' : 'Recap →' }}</span>
                </div>
              </button>
            </div>
            <RouterLink
              v-if="row.meet.meetId"
              :to="`/meet/${row.meet.meetId}`"
              class="meet-acc-pagelink"
              @click.stop
              v-tip.fixed="'Full meet page — schedule, program export, sponsors'"
            >Open full meet page ↗</RouterLink>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* List mode (browsable meets) — no special handling needed
   anymore; .sb-layout defaults to natural document flow. The
   :has(.meets-mode) override is gone with the height:100vh lock
   that required it. */
.meets-mode {
  flex: 1;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 4rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}

/* LIVE strip — clickable chips grouped under their parent meet.
   Each meet gets a small label heading so every live event makes
   clear which meet it belongs to; the chips beneath jump straight
   into a broadcast. Recovers vertical space vs. the old card grid
   while keeping the meet context the flat single-row strip lost. */
.live-strip {
  background: linear-gradient(135deg, rgba(239,68,68,0.10), rgba(239,68,68,0.02));
  border: 1px solid rgba(239,68,68,0.35);
  border-radius: var(--radius-lg);
  padding: 0.75rem 1rem;
  display: flex; flex-direction: column; gap: 0.7rem;
}
.live-strip-head {
  display: flex; align-items: center; gap: 0.6rem;
}
.live-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.25rem 0.65rem;
  background: var(--red); color: white; border-radius: 4px;
  animation: pulse-red 2s infinite;
}
.live-strip-sub {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); letter-spacing: 0.04em;
}
.live-strip-groups {
  display: flex; flex-direction: column; gap: 0.7rem;
}
.live-meet-group {
  display: flex; flex-direction: column; gap: 0.4rem;
}
.live-meet-label {
  display: flex; align-items: center; gap: 0.4rem; min-width: 0;
}
.live-meet-name {
  font-family: var(--font-display); font-size: 11px; font-weight: 900;
  font-style: italic; letter-spacing: 0.04em; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 60vw;
}
.live-meet-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.04em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.3rem; flex-shrink: 0;
}
.live-meet-link {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  color: var(--text-3); text-decoration: none; line-height: 1;
  padding: 0.05rem 0.25rem; border-radius: 3px; flex-shrink: 0;
}
.live-meet-link:hover { color: var(--cyan); background: var(--cyan-dim); }
.live-meet-chips {
  display: flex; gap: 0.5rem; flex-wrap: wrap;
}
.live-chip {
  display: inline-flex; align-items: center; gap: 0.5rem;
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.45);
  border-radius: 999px;
  padding: 0.4rem 0.85rem;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.1s;
  font-family: var(--font-display);
  color: var(--text);
}
.live-chip:hover {
  background: rgba(239,68,68,0.18);
  border-color: var(--red);
  transform: translateY(-1px);
}
.live-chip-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--red);
  animation: pulse-red 1.5s infinite;
  flex-shrink: 0;
}
.live-chip-name {
  font-size: 13px; font-weight: 800; font-style: italic;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 240px;
}
.live-chip-round {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--red);
}

/* Tools row 1: search dominates, sort + view toggle + export
   align right. Two rows total (this + .sb-filter-row) so the
   six-input cram of the prior layout breathes. */
.sb-tools {
  display: flex; align-items: center; gap: 1rem;
  flex-wrap: wrap;
  padding: 0.75rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.sb-tools-search {
  display: flex; align-items: center; gap: 0.85rem;
  flex: 1 1 320px; min-width: 0;
}
.sb-search-input {
  flex: 1 1 auto;
  font-size: 13px; padding: 0.55rem 0.75rem;
}
.sb-result-count {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  flex-shrink: 0;
}
.sb-tools-right {
  display: flex; align-items: center; gap: 0.55rem;
  flex-shrink: 0;
}
.sb-tool-label {
  display: inline-flex; align-items: center; gap: 0.4rem;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3);
}
.sb-tool-select { font-size: 12px; padding: 0.4rem 0.55rem; }

/* Filter row 2: secondary dropdowns. Wrap freely. */
.sb-filter-row {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  padding: 0 0.25rem;
}
.sb-filter-select {
  flex: 0 1 180px;
  font-size: 12px; padding: 0.45rem 0.6rem;
}

/* Year-section headers — interleaved into the accordion flow
   (only shown when ≥12 meets across ≥2 years; small lists stay
   flat). The accordion's own row gap handles spacing; a little
   extra top margin separates a year section from the meets above
   it without doubling the gap before the very first one. */
.sb-year-head {
  display: flex; align-items: baseline; gap: 0.55rem;
  font-family: var(--font-display);
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.35rem;
}
.meets-acc .sb-year-head:not(:first-child) { margin-top: 0.6rem; }
.sb-year-label {
  font-size: 14px; font-weight: 900; font-style: italic;
  color: var(--text); letter-spacing: 0.04em;
}
.sb-year-count {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
}

/* =============================================================
   Meets accordion — one row per meet, expanding to its events.
   ============================================================= */
.meets-acc { display: flex; flex-direction: column; gap: 0.6rem; }

.meet-acc {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color 0.15s, background 0.15s;
}
.meet-acc.is-live           { border-color: rgba(239,68,68,0.40); }
.meet-acc.is-open           { border-color: var(--border-2); }
.meet-acc.is-live.is-open   { border-color: rgba(239,68,68,0.55); }

/* Header row: caret · title block · meta (badges + date). The
   solo (no-meet) standalone row reuses the same grid so the two
   read identically. */
.meet-acc-head,
.meet-acc-solo {
  width: 100%;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.05rem;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: start;
}
.meet-acc-head:hover { background: rgba(6,182,212,0.04); }
.meet-acc.is-live .meet-acc-head:hover { background: rgba(239,68,68,0.04); }

/* Solo standalone-event row is its own bordered card (no body). */
.meet-acc-solo {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 0.15s, background 0.15s;
}
.meet-acc-solo:hover { border-color: var(--cyan); background: rgba(6,182,212,0.04); }
.meet-acc-solo.is-live { border-color: rgba(239,68,68,0.40); }
.meet-acc-solo .meet-acc-caret { color: var(--cyan); }

.meet-acc-caret {
  font-size: 13px; color: var(--text-3);
  font-family: var(--font-display); justify-self: center;
}
.meet-acc.is-live .meet-acc-caret { color: var(--red); }

.meet-acc-titles { min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.meet-acc-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.15;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-acc-org {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-acc-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.meet-acc-meta {
  display: flex; align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  flex-shrink: 0;
}
.meet-acc-livebadge {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.12em; color: white; background: var(--red);
  border-radius: 4px; padding: 0.15rem 0.45rem;
  animation: pulse-red 2s infinite; white-space: nowrap;
}
.meet-acc-finalbadge {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.12em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 4px; padding: 0.15rem 0.45rem; white-space: nowrap;
}
.meet-acc-count { white-space: nowrap; }
.meet-acc-date  { white-space: nowrap; }

/* Expanded body — event cards, live first, like the meet page. */
.meet-acc-body {
  padding: 0 1.05rem 1rem;
  border-top: 1px solid var(--border);
}
.meet-ev-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.7rem;
  margin-top: 0.85rem;
}
.meet-ev-card {
  text-align: start; cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 0.85rem;
  display: flex; flex-direction: column; gap: 0.45rem;
  transition: border-color 0.13s, background 0.13s, transform 0.1s; min-width: 0;
}
.meet-ev-card:hover { border-color: var(--cyan); background: rgba(6,182,212,0.06); transform: translateY(-1px); }
.meet-ev-card.is-live          { border-color: rgba(239,68,68,0.35); }
.meet-ev-card.is-live:hover    { border-color: var(--red); background: rgba(239,68,68,0.06); }
.meet-ev-top {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem;
}
.meet-ev-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 800;
  font-style: italic; color: var(--text); line-height: 1.15;
  flex: 1; min-width: 0;
}
.meet-ev-status {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.16em; padding: 0.12rem 0.4rem; border-radius: 3px;
  flex-shrink: 0;
}
.meet-ev-status.live  { background: var(--red); color: white; animation: pulse-red 2s infinite; }
.meet-ev-status.final { background: var(--surface); color: var(--text-3); border: 1px solid var(--border); }
.meet-ev-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.meet-ev-foot {
  display: flex; align-items: baseline; gap: 0.5rem;
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
}
.meet-ev-round { color: var(--red); font-weight: 700; }
.meet-ev-cta {
  margin-inline-start: auto;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--cyan);
}
.meet-ev-card.is-live .meet-ev-cta { color: var(--red); }

.meet-acc-pagelink {
  display: inline-flex; align-items: center; gap: 0.3rem;
  margin-top: 0.85rem;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--cyan); text-decoration: none;
}
.meet-acc-pagelink:hover { text-decoration: underline; }

/* Shared event-tag chips (gender / height / rounds / synchro…). */
.meet-tag {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--text-3); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.meet-tag-cyan {
  color: var(--cyan); border-color: rgba(6,182,212,0.3);
  background: var(--cyan-dim);
}

/* Event-tag chips inside an expanded meet sit on the sunken
   .meet-ev-card, so flip them to the raised surface for contrast. */
.meet-ev-card .meet-tag { background: var(--surface); }

@media (max-width: 720px) {
  .meet-acc-head,
  .meet-acc-solo { grid-template-columns: 18px minmax(0, 1fr) auto; gap: 0.5rem; padding: 0.75rem 0.85rem; }
  .meet-acc-name { font-size: 14px; }
  .meet-acc-date { display: none; }       /* keep the live badge + count; date is the least useful here */
  .meet-acc-body { padding-inline: 0.85rem; }
  .meet-ev-grid  { grid-template-columns: 1fr; }

  /* iOS Safari auto-zooms whenever an <input>/<select> with
     font-size < 16px receives focus. Bump the meets-browser
     search + tool + filter controls so tapping them on a phone
     doesn't jolt the viewport. */
  .sb-search-input,
  .sb-tool-select,
  .sb-filter-select { font-size: 16px; }
}

.meets-empty {
  font-family: var(--font-mono); font-size: 13px; color: var(--text-3);
  text-align: center; padding: 3rem 1rem;
  background: var(--bg-2); border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
}

/* Stale-cache banner shared with DiverProfileView. */
.cache-banner {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono); font-size: 11px; color: var(--amber);
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.7rem; margin-bottom: 0.5rem;
}
.cache-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--amber); animation: cachePulse 1.2s infinite;
}
@keyframes cachePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
