<script setup>
/* MeetsBrowser — Results Archive list mode for /scoreboard.
 *
 * Renders the cache banner, the LIVE-now strip, the two-row filter
 * cluster, and the meets list itself (card mode w/ optional
 * year-grouped sections, plus a compact list mode). Selection is
 * emitted as `select(eventId)` — the parent (ScoreboardView) owns
 * the navigation + state pivot into the live-broadcast / recap
 * layouts.
 *
 * State boundary:
 *   * Master event list, derived live-events list, cache flag, and
 *     the filter source data (countries / years / heights / clubs)
 *     all come in as props — the parent loads them once and reuses
 *     them across the list + detail surfaces.
 *   * Filter state (search, country, year, height, club, status,
 *     sort, viewMode) is OWNED here. None of it is read by the
 *     detail surfaces, so it never had a reason to live on
 *     ScoreboardView. localStorage persistence stays put for
 *     `viewMode` + `sortBy` so a returning user lands on their
 *     last layout.
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

// View preferences. Persisted in localStorage so a returning
// user lands on the layout they last picked. `viewMode` toggles
// between roomy meet cards and a compact one-row-per-meet list
// (better when scanning hundreds of events). `sortBy` controls
// the order applied AFTER filtering.
const viewMode = ref(localStorage.getItem('sb_view_mode') || 'cards') // 'cards' | 'list'
const sortBy   = ref(localStorage.getItem('sb_sort_by')  || 'recent') // 'recent' | 'oldest' | 'name'
watch(viewMode, (v) => localStorage.setItem('sb_view_mode', v))
watch(sortBy,   (v) => localStorage.setItem('sb_sort_by',  v))

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
      (e.org_name || '').toLowerCase().includes(term) ||
      (e.country_code || '').toLowerCase().includes(term)
    )
  })
})

// Apply the current sort to the filtered event list. Live events
// always rise to the top regardless of sort — operators landing
// on /scoreboard mid-meet expect to see "what's broadcasting now"
// before "what's archived".
const sortedFilteredEvents = computed(() => {
  const list = [...filteredEvents.value]
  list.sort((a, b) => {
    if (a.status === 'Live' && b.status !== 'Live') return -1
    if (b.status === 'Live' && a.status !== 'Live') return  1
    if (sortBy.value === 'name') {
      return (a.name || '').localeCompare(b.name || '')
    }
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0
    return sortBy.value === 'oldest' ? ta - tb : tb - ta
  })
  return list
})

// Group the sorted list by year for display when there are
// enough results that a wall of cards becomes hard to scan
// (≥12 entries, ≥2 distinct years). Below that threshold the
// flat ungrouped list is friendlier.
const GROUP_THRESHOLD = 12
const groupedEvents = computed(() => {
  const list = sortedFilteredEvents.value
  if (list.length < GROUP_THRESHOLD) return null
  const groups = new Map()    // year -> [event]
  for (const e of list) {
    const y = e.created_at ? new Date(e.created_at).getFullYear() : '—'
    if (!groups.has(y)) groups.set(y, [])
    groups.get(y).push(e)
  }
  if (groups.size < 2) return null
  // Sort the year sections themselves — Map insertion order
  // can't be trusted because Live events pinned to the top of
  // `sortedFilteredEvents` may belong to any year, so whichever
  // year's live event appeared first would otherwise dictate
  // section order. Newest first by default; flipped when the
  // user picks "Oldest first". The "—" bucket (events with no
  // created_at) sinks to the bottom.
  const oldestFirst = sortBy.value === 'oldest'
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === '—') return 1
      if (b === '—') return -1
      return oldestFirst ? Number(a) - Number(b) : Number(b) - Number(a)
    })
    .map(([year, items]) => ({ year, items }))
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

    <!-- Compact LIVE strip — horizontal-scrolling row of
         clickable chips. Replaces the old multi-line card grid
         that consumed half the viewport. Each chip jumps
         straight into the broadcast layout. Caps at 8 visible
         chips before horizontal scroll kicks in. -->
    <div v-if="liveEvents.length" class="live-strip">
      <div class="live-strip-head">
        <span class="live-pulse">● LIVE NOW</span>
        <span class="live-strip-sub">
          {{ liveEvents.length }} broadcasting · click any to watch
        </span>
      </div>
      <div class="live-strip-row">
        <button
          v-for="ev in liveEvents"
          :key="ev.id"
          class="live-chip"
          @click="emit('select', ev.id)"
          v-tip="ev.last_diver_name
            ? `Round ${ev.current_round}/${ev.total_rounds} · ${ev.last_diver_name} just scored`
            : `Round ${ev.current_round || 1}/${ev.total_rounds}`"
        >
          <span class="live-chip-dot" aria-hidden="true"></span>
          <span class="live-chip-name">{{ ev.name }}</span>
          <span v-if="ev.country_code" class="live-chip-ctry">{{ ev.country_code }}</span>
          <span v-if="ev.current_round" class="live-chip-round">
            R{{ ev.current_round }}/{{ ev.total_rounds }}
          </span>
        </button>
      </div>
    </div>

    <!-- Filter + tools row 1: search + result count + tools.
         The search input dominates so it's reachable at any
         viewport width; sort + view toggle + export sit on the
         right. Filter dropdowns get their own row below. -->
    <div v-if="events.length" class="sb-tools">
      <div class="sb-tools-search">
        <input
          class="input sb-search-input"
          type="text"
          v-model="searchTerm"
          placeholder="Search meet, host org, country…"
          aria-label="Search meets"
        >
        <span class="sb-result-count">
          {{ filteredEvents.length.toLocaleString() }} of {{ events.length.toLocaleString() }}
          {{ events.length === 1 ? 'meet' : 'meets' }}
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
        <div class="sb-view-toggle" role="group" aria-label="View mode">
          <button
            :class="['sb-view-btn', viewMode === 'cards' ? 'is-active' : '']"
            @click="viewMode = 'cards'"
            v-tip="'Card view'"
            aria-label="Card view"
          >▦</button>
          <button
            :class="['sb-view-btn', viewMode === 'list' ? 'is-active' : '']"
            @click="viewMode = 'list'"
            v-tip="'Compact list view'"
            aria-label="Compact list view"
          >☰</button>
        </div>
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
    <div v-else-if="!filteredEvents.length" class="meets-empty">
      No meets match these filters.
      <button class="btn btn-ghost btn-sm" style="margin-inline-start:0.5rem" @click="clearFilters">Clear</button>
    </div>

    <!-- Card-mode results, optionally year-grouped. -->
    <template v-else-if="viewMode === 'cards'">
      <template v-if="groupedEvents">
        <section v-for="g in groupedEvents" :key="g.year" class="sb-year-group">
          <header class="sb-year-head">
            <span class="sb-year-label">{{ g.year }}</span>
            <span class="sb-year-count">{{ g.items.length }}</span>
          </header>
          <div class="meets-grid">
            <button v-for="ev in g.items" :key="ev.id" class="meet-card" @click="emit('select', ev.id)">
              <div class="meet-card-head">
                <span class="meet-card-name">{{ ev.name }}</span>
                <span v-if="ev.status === 'Live'" class="meet-card-status live">LIVE</span>
                <span v-else class="meet-card-status final">FINAL</span>
              </div>
              <div class="meet-card-org">
                {{ ev.org_name }}<span v-if="ev.country_code" class="meet-card-ctry">{{ ev.country_code }}</span>
              </div>
              <RouterLink
                v-if="ev.meet_id"
                :to="`/meet/${ev.meet_id}`"
                class="meet-card-meetlink"
                @click.stop
                v-tip="`Part of ${ev.meet_name}`"
              >📅 {{ ev.meet_name }}</RouterLink>
              <div class="meet-card-tags">
                <span v-if="ev.gender" class="meet-tag">{{ ev.gender }}</span>
                <span v-if="ev.height" class="meet-tag">{{ ev.height }}</span>
                <span class="meet-tag">{{ ev.total_rounds }} rds</span>
                <span class="meet-tag">{{ ev.number_of_judges }}j</span>
                <span v-if="ev.event_type === 'synchro_pair'" class="meet-tag meet-tag-cyan">Synchro</span>
                <span v-else-if="ev.event_type === 'team'" class="meet-tag meet-tag-cyan">Team</span>
              </div>
              <div class="meet-card-stats">
                <span v-if="ev.competitor_count">
                  {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
                </span>
                <span v-if="ev.club_count">
                  · {{ ev.club_count }} {{ ev.club_count === 1 ? 'club' : 'clubs' }}
                </span>
                <span class="meet-card-date">{{ fmtDate(ev.created_at) }}</span>
              </div>
            </button>
          </div>
        </section>
      </template>
      <div v-else class="meets-grid">
        <button v-for="ev in sortedFilteredEvents" :key="ev.id" class="meet-card" @click="emit('select', ev.id)">
          <div class="meet-card-head">
            <span class="meet-card-name">{{ ev.name }}</span>
            <span v-if="ev.status === 'Live'" class="meet-card-status live">LIVE</span>
            <span v-else class="meet-card-status final">FINAL</span>
          </div>
          <div class="meet-card-org">
            {{ ev.org_name }}<span v-if="ev.country_code" class="meet-card-ctry">{{ ev.country_code }}</span>
          </div>
          <RouterLink
            v-if="ev.meet_id"
            :to="`/meet/${ev.meet_id}`"
            class="meet-card-meetlink"
            @click.stop
            v-tip="`Part of ${ev.meet_name}`"
          >📅 {{ ev.meet_name }}</RouterLink>
          <div class="meet-card-tags">
            <span v-if="ev.gender" class="meet-tag">{{ ev.gender }}</span>
            <span v-if="ev.height" class="meet-tag">{{ ev.height }}</span>
            <span class="meet-tag">{{ ev.total_rounds }} rds</span>
            <span class="meet-tag">{{ ev.number_of_judges }}j</span>
            <span v-if="ev.event_type === 'synchro_pair'" class="meet-tag meet-tag-cyan">Synchro</span>
            <span v-else-if="ev.event_type === 'team'" class="meet-tag meet-tag-cyan">Team</span>
          </div>
          <div class="meet-card-stats">
            <span v-if="ev.competitor_count">
              {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
            </span>
            <span v-if="ev.club_count">
              · {{ ev.club_count }} {{ ev.club_count === 1 ? 'club' : 'clubs' }}
            </span>
            <span class="meet-card-date">{{ fmtDate(ev.created_at) }}</span>
          </div>
        </button>
      </div>
    </template>

    <!-- Compact list view — one row per meet. Faster to scan
         when the federation has hundreds of completed events. -->
    <div v-else class="meets-list">
      <button
        v-for="ev in sortedFilteredEvents"
        :key="ev.id"
        class="meet-row"
        @click="emit('select', ev.id)"
      >
        <span :class="['meet-row-status', ev.status === 'Live' ? 'live' : 'final']">
          {{ ev.status === 'Live' ? 'LIVE' : 'FINAL' }}
        </span>
        <span class="meet-row-name">{{ ev.name }}</span>
        <span class="meet-row-org">
          {{ ev.org_name }}<span v-if="ev.country_code" class="meet-row-ctry">{{ ev.country_code }}</span>
        </span>
        <span class="meet-row-meta">
          <span v-if="ev.height">{{ ev.height }}</span>
          <span v-if="ev.gender"> · {{ ev.gender }}</span>
          <span v-if="ev.event_type === 'synchro_pair'"> · Synchro</span>
          <span v-else-if="ev.event_type === 'team'"> · Team</span>
        </span>
        <span class="meet-row-date">{{ fmtDate(ev.created_at) }}</span>
        <span class="meet-row-arrow" aria-hidden="true">→</span>
      </button>
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

/* Compact LIVE strip — single horizontal row of clickable
   chips. Replaced the prior multi-line card grid; recovers
   significant vertical space while still surfacing every live
   meet. Scrolls horizontally on narrow screens (federations
   running multiple boards in parallel). */
.live-strip {
  background: linear-gradient(135deg, rgba(239,68,68,0.10), rgba(239,68,68,0.02));
  border: 1px solid rgba(239,68,68,0.35);
  border-radius: var(--radius-lg);
  padding: 0.75rem 1rem;
  display: flex; flex-direction: column; gap: 0.55rem;
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
.live-strip-row {
  display: flex; gap: 0.5rem;
  /* Wrap onto multiple lines when there are more chips than fit
     on one row — never scroll horizontally. A federation running
     8 live boards in parallel sees them stack into 2-3 lines
     rather than getting hidden behind a scroll affordance the
     audience would miss. */
  flex-wrap: wrap;
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
.live-chip-ctry {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.04em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
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

.sb-view-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.sb-view-btn {
  background: transparent; border: 0;
  padding: 0.45rem 0.65rem;
  font-size: 13px; line-height: 1;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.sb-view-btn + .sb-view-btn { border-inline-start: 1px solid var(--border); }
.sb-view-btn:hover { color: var(--text); background: var(--bg-3); }
.sb-view-btn.is-active {
  background: rgba(6,182,212,0.12);
  color: var(--cyan);
}

/* Filter row 2: secondary dropdowns. Wrap freely. */
.sb-filter-row {
  display: flex; flex-wrap: wrap; gap: 0.5rem;
  padding: 0 0.25rem;
}
.sb-filter-select {
  flex: 0 1 180px;
  font-size: 12px; padding: 0.45rem 0.6rem;
}

/* Year-grouped sections (only shown when ≥12 results across ≥2
   years — small lists stay flat). */
.sb-year-group { display: flex; flex-direction: column; gap: 0.65rem; margin-bottom: 1.25rem; }
.sb-year-head {
  display: flex; align-items: baseline; gap: 0.55rem;
  font-family: var(--font-display);
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.35rem;
}
.sb-year-label {
  font-size: 14px; font-weight: 900; font-style: italic;
  color: var(--text); letter-spacing: 0.04em;
}
.sb-year-count {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
}

/* Compact list view — one row per meet. Massively faster to
   scan when a federation has hundreds of historical events. */
.meets-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.meet-row {
  display: grid;
  grid-template-columns: 64px 1.6fr 1.2fr 1fr 100px 24px;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.85rem;
  background: var(--surface);
  border: 0; border-bottom: 1px solid var(--border);
  cursor: pointer;
  text-align: start;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  transition: background 0.1s;
}
.meet-row:last-child { border-bottom: 0; }
.meet-row:hover {
  background: rgba(6,182,212,0.05);
  color: var(--text);
}
.meet-row-status {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.12em; padding: 0.2rem 0.4rem;
  border-radius: 3px; text-align: center; flex-shrink: 0;
}
.meet-row-status.live  { background: var(--red); color: white; animation: pulse-red 2s infinite; }
.meet-row-status.final { background: var(--bg-3); color: var(--text-3); }
.meet-row-name {
  font-family: var(--font-display); font-size: 13px; font-weight: 800;
  font-style: italic; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-row-org {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-row-ctry {
  display: inline-block; margin-inline-start: 0.4rem;
  font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.3rem;
}
.meet-row-meta { color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meet-row-date { color: var(--text-3); text-align: end; white-space: nowrap; }
.meet-row-arrow { color: var(--text-3); text-align: end; font-family: var(--font-display); }
.meet-row:hover .meet-row-arrow { color: var(--cyan); }

@media (max-width: 720px) {
  .meet-row {
    grid-template-columns: 56px 1fr 80px;
    grid-template-areas:
      "status name name"
      "status org  date"
      "status meta meta";
    gap: 0.4rem 0.65rem;
    padding: 0.55rem 0.75rem;
  }
  .meet-row-status { grid-area: status; align-self: center; }
  .meet-row-name   { grid-area: name; }
  .meet-row-org    { grid-area: org; }
  .meet-row-date   { grid-area: date; text-align: end; }
  .meet-row-meta   { grid-area: meta; }
  .meet-row-arrow  { display: none; }

  /* iOS Safari auto-zooms whenever an <input>/<select> with
     font-size < 16px receives focus. Bump the meets-browser
     search + tool + filter controls so tapping them on a phone
     doesn't jolt the viewport. */
  .sb-search-input,
  .sb-tool-select,
  .sb-filter-select { font-size: 16px; }
}

/* Meet card grid — like the live cards but neutral colour. */
.meets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.875rem;
}
.meet-card {
  text-align: start; cursor: pointer;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem 1.125rem;
  display: flex; flex-direction: column; gap: 0.5rem;
  transition: all 0.15s; min-width: 0;
}
.meet-card:hover {
  border-color: var(--cyan);
  background: rgba(6,182,212,0.04);
  transform: translateY(-1px);
}
.meet-card-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.5rem;
}
.meet-card-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.15;
  flex: 1; min-width: 0;
}
.meet-card-status {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; padding: 0.15rem 0.45rem; border-radius: 3px;
  flex-shrink: 0;
}
.meet-card-status.live { background: var(--red); color: white; animation: pulse-red 2s infinite; }
.meet-card-status.final { background: var(--bg-3); color: var(--text-3); border: 1px solid var(--border); }
.meet-card-org {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-card-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.meet-card-tags {
  display: flex; flex-wrap: wrap; gap: 0.3rem;
}
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
.meet-card-stats {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: baseline;
}
.meet-card-date { margin-inline-start: auto; }
.meet-card-meetlink {
  display: inline-flex; align-items: center; gap: 0.3rem;
  align-self: flex-start;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.15rem 0.5rem; text-decoration: none;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.meet-card-meetlink:hover { background: var(--cyan); color: var(--bg); }

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
