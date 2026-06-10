<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import {
  annotatedScores,
  groupedSynchroScoresForDisplay,
  trimCount,
  synchroGroupDropCount,
  synchroJudgeGroups,
} from '@/composables/useScoreCategories'
import { diveDescription } from '@/composables/useDiveLabel'
import { cachedFetch, idbInvalidate } from '@/lib/idbCache'
import { SCOREBOARD_LIVE_TTL_MS, SCOREBOARD_ARCHIVE_TTL_MS } from '@/lib/cache-policy'
import { fmtDate, ordinal, rankClass } from '@/lib/format'
import DiverIdentity from '@/components/DiverIdentity.vue'
import ScoreHistoryButton from '@/components/ScoreHistoryButton.vue'
import JargonTip from '@/components/JargonTip.vue'
import JudgeRankingTable from '@/components/JudgeRankingTable.vue'
import MeetsBrowser from '@/components/scoreboard/MeetsBrowser.vue'
import SponsorRotation from '@/components/scoreboard/SponsorRotation.vue'

const route  = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { t } = useI18n()
const socket = useSocket({ spectator: true })

// Broadcast / kiosk mode: when the URL ends in /broadcast we
// hide the page chrome (header, dashboard link) so a venue
// projector shows just the standings and active diver. Toggled
// purely via the URL so a meet operator can switch a screen
// into kiosk mode without leaving the page.
const broadcastMode = computed(() => route.params.mode === 'broadcast')

// Stream-overlay mode: ?overlay=1 puts the page into a minimal,
// chroma-key-friendly layout for OBS / streaming software. Hides
// every background colour, header, and panel chrome — just the
// active diver block + a compact top-3. Chroma-key colour is set
// by ?bg=<hex>; defaults to a vivid green (#00ff44) which is the
// standard OBS chroma colour. Operators can pick e.g. ?bg=ff00ff
// for magenta if their lighting pushes a green spill.
const overlayMode = computed(() => route.query.overlay === '1' || route.query.overlay === 'true')
const overlayBg   = computed(() => {
  const raw = String(route.query.bg || '').replace(/^#/, '').trim()
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : '#00ff44'
})

// Browsable list of every Live + Completed meet. Used as the
// landing state of the page; the user picks one and we pivot
// into either the live broadcast layout or the recap layout.
const events = ref([])
const clubsList = ref([])
// Total events sitting in the DiveRecorder results archive — shown
// in the header next to the live/completed operational counts, and
// links through to /results-archive. Null until the count lands.
const archiveTotal = ref(null)
const loadingList = ref(false)
const meetsFromCache = ref(false)

const currentEventId = ref(null)
const currentEvent = computed(() => events.value.find(e => String(e.id) === String(currentEventId.value)) || null)

// Filter state (search / country / year / height / club / status,
// plus the sort + view-mode preferences) and the meets-browsing
// computeds live inside the MeetsBrowser component now — see
// src/components/scoreboard/MeetsBrowser.vue. The parent still
// owns the master `events` list (it's also consumed by the detail
// surfaces) and the derived `liveEvents` array (the header
// summary line "{n} live now" reads it too).

const liveEvents = computed(() => events.value.filter(e => e.status === 'Live'))
const upcomingEvents = computed(() => events.value.filter(e => e.status === 'Upcoming'))
const completedEvents = computed(() => events.value.filter(e => e.status === 'Completed'))

// Up Next: filter the server's queue to skip the current active
// diver (so they don't appear as both "current performer" and
// "up next"). Returns the FULL remaining queue — the panel below
// scrolls when the list overflows ~10 rows. Empty array → panel
// hides.
//
// Also drops the head-of-queue when the centre block is rendering
// it as the "On Deck" placeholder (no live active diver yet) so
// the same diver doesn't appear in both spots.
const upcomingDisplay = computed(() => {
  if (!upcoming.value?.length) return []
  const active = activeDiver.value?.diverName
  const round  = activeDiver.value?.round_number
  let list = upcoming.value
  // Active diver currently mid-dive — exclude their queue row.
  if (active) {
    list = list.filter(u => !(u.full_name === active && u.round_number === round))
  } else {
    // No active diver — the head of the queue is being shown in
    // the centre as "On Deck", so drop it from this list.
    list = list.slice(1)
  }
  return list
})

// Centre-block performer: the live active diver when one is
// announced, otherwise the head of the upcoming queue rendered
// as "On Deck". Keeps the spectator scoreboard from sitting on
// "Waiting..." mid-meet — between rounds, or before the operator
// has clicked Next Diver, the audience can still see who's about
// to dive. Normalised to the shape activeDiver carries so the
// downstream template doesn't branch on data source.
const centrePerformer = computed(() => {
  if (activeDiver.value) {
    return { kind: 'active', ...activeDiver.value }
  }
  const next = upcoming.value?.[0]
  if (next) {
    return {
      kind: 'next',
      round_number: next.round_number,
      competitor_id: next.competitor_id || null,
      partner_id:    next.partner_id    || null,
      diverName:     next.full_name,
      partner_name:  next.partner_name  || null,
      country_code:  next.country_code  || null,
      club_name:     next.club_name     || null,
      team_name:     next.team_name     || null,
      diveCode:      next.dive_code ? `${next.dive_code}${next.position || ''}` : null,
      dd:            next.dd ?? null,
      description:   next.description || null,
      position:      next.position || null,
    }
  }
  return null
})

const countries = computed(() => {
  const seen = new Map()
  for (const e of events.value) {
    if (!e.country_code) continue
    if (!seen.has(e.country_code)) {
      seen.set(e.country_code, { code: e.country_code, org_name: e.org_name })
    }
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
})

const years = computed(() => {
  const set = new Set()
  for (const e of events.value) if (e.created_at) set.add(new Date(e.created_at).getFullYear())
  return [...set].sort((a, b) => b - a)
})

const heights = computed(() => {
  const set = new Set()
  for (const e of events.value) if (e.height) set.add(e.height)
  return [...set]
})

async function fetchJsonArray(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return []
    const body = await r.json()
    return Array.isArray(body) ? body : []
  } catch {
    return []
  }
}
const historyItems = ref([])
const standings = ref([])
const upcoming = ref([])         // next ≤5 dives queued, populated for Live events

// Show-more pagination — Completed Dives defaults to 5 cards
// (most-recent round of a 5-judge meet usually fits a single
// round of dives in view), Up Next stays at a tighter 3-row
// preview because the audience really only needs to see "who's
// next + on deck". Both have a toggle to expand to the full set.
//
// preview / rest split: the toggle button is rendered INSIDE
// the v-for after the last preview entry so it stays at a
// fixed visual position when the list expands — extra entries
// drop down below the button instead of pushing it off-screen.
const HISTORY_PREVIEW_COUNT  = 5
const UP_NEXT_PREVIEW_COUNT  = 3
const historyShowAll = ref(false)
const upNextShowAll  = ref(false)
const historyPreview = computed(() =>
  historyItems.value.slice(0, HISTORY_PREVIEW_COUNT),
)
const upcomingPreview = computed(() =>
  upcomingDisplay.value.slice(0, UP_NEXT_PREVIEW_COUNT),
)
const leaderboardRounds = ref([])     // [{ round_number, rankings: [...] }]
const standingsTab = ref('final')     // 'final' | 'by-round'
const expandedRound = ref(null)       // currently expanded round in by-round view
// Recap density toggle. ON by default → the Final tab shows only
// the final standings (rank · diver · total points), the calm
// audience-facing summary. Toggling it OFF expands every diver
// into their full dive-by-dive scoresheet (dive code, DD, each
// judge's score, dive total). Scoped to the Final tab — the
// By-Round tab is its own cumulative leaderboard.
const finalScoresOnly = ref(true)
const activeDiver = ref(null)
// Per-judge scores arriving live for the active diver, in
// judge_number order. Pushed by score_received, cleared whenever
// state_update broadcasts a new active diver/round. Renders as
// the inline pills under the Current Performer block, replacing
// the older fullscreen score-overlay UX.
const liveJudgeScores = ref([])
// Completed-event archive payload — only populated when the
// selected event has status === 'Completed'. Drives the dive
// breakdown, podium and event-stats panels.
const archiveResults = ref(null)

// Panel for the current event — `[{judge_id, judge_number,
// full_name, country_code, club_code, org_name, club_name}, …]`
// ordered by judge_number. Drives:
//   * tooltips on every score chip ("J3 — Maria Schmidt · GER ·
//     Munich Diving Club. Click to open judge analysis.")
//   * the RouterLink each chip wraps → /judge-profile/<id>
// Populated from /api/scoreboard/:id (live) or /api/archive/:id/
// results (completed). Empty when the panel hasn't been seated
// yet (rare — pre-meet scoreboard) — chips fall back to a
// non-clickable rendering with a "panel not assigned" tooltip.
const eventPanel = ref([])

// O(1) lookup for chip rendering. Built off eventPanel; rebuilt
// whenever the panel ref updates.
const panelByNumber = computed(() => {
  const map = new Map()
  for (const j of eventPanel.value) {
    if (j && j.judge_number != null) map.set(Number(j.judge_number), j)
  }
  return map
})

// Per-dive judge-rank map keyed by `${judge_id}:${competitor_id}:
// Per-dive ranks: ${judge_id}:${competitor_id}:${round_number}.
// Populated eagerly from /api/events/:id/judge-ranking-analysis
// the moment the page loads on a Completed event — so chip
// tooltips have rank context on the FIRST hover (waiting for the
// JRA section to expand would mean the first few hovers fall
// back to identity-only).
//
// The full payload is also passed straight through to the
// JudgeRankingTable component as a prop, so opening the section
// is a zero-network-call expansion. Section UI stays v-if'd
// (mounts only on expand) — the parent owns the data lifecycle.
const judgeRankingPayload = ref(null)
const judgeRankingExpanded = ref(false)
const judgeRankingLoadFailed = ref(false)
const perDiveRanks = computed(() => judgeRankingPayload.value?.per_dive_ranks || {})

async function loadJudgeRankingPayload() {
  if (!currentEventId.value || !isCompleted.value) return
  judgeRankingLoadFailed.value = false
  try {
    const res = await fetch(`/api/events/${currentEventId.value}/judge-ranking-analysis`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    judgeRankingPayload.value = await res.json()
  } catch (err) {
    console.error('[Scoreboard JRA preload]', err.message)
    judgeRankingLoadFailed.value = true
  }
}

// Compose the judge tooltip line shown on every score chip.
// Mentions the click action explicitly so a viewer who's never
// followed the link knows why the chip is interactive.
//
// The optional opts.perDiveRank ({ rank, total_in_round }) adds a
// line like "Ranked this dive 2nd of 12 in round 1" between the
// identity line and the dropped/click-to-open lines — surfaced
// only when the event is Completed and the analysis payload is
// loaded (Live events don't have a stable rank yet).
function judgeTooltip(judge, opts = {}) {
  if (!judge) return 'Judge identity not available'
  const parts = []
  parts.push(`J${judge.judge_number} — ${judge.full_name}`)
  const where = []
  if (judge.country_code) where.push(judge.country_code)
  if (judge.club_code)    where.push(judge.club_code)
  else if (judge.club_name) where.push(judge.club_name)
  else if (judge.org_name) where.push(judge.org_name)
  if (where.length) parts[0] += ` · ${where.join(' · ')}`
  if (opts.perDiveRank && opts.perDiveRank.rank != null) {
    const round = opts.roundNumber
    const tail = round ? ` in round ${round}` : ''
    parts.push(
      `Ranked this dive ${ordinal(opts.perDiveRank.rank)} of `
      + `${opts.perDiveRank.total_in_round}${tail}`,
    )
  }
  if (opts.dropped) parts.push('Dropped by trim rule')
  parts.push('Click to open judge analysis')
  return parts.join('\n')
}

// Look up the per-dive rank for one chip. Returns null when the
// analysis data isn't loaded yet (Live event, or recap section
// not yet expanded) or the chip's judge/competitor/round can't
// be resolved.
function judgePerDiveRank(judge, competitorId, roundNumber) {
  if (!judge || !competitorId || roundNumber == null) return null
  const map = perDiveRanks.value
  if (!map) return null
  return map[`${judge.judge_id}:${competitorId}:${roundNumber}`] || null
}

// Wire the analysis payload into the parent state when the
// JudgeRankingTable component emits its `loaded` event. That
// payload's per_dive_ranks map then enhances every chip tooltip
// on the recap (without a second round-trip).
function onJudgeRankingLoaded(payload) {
  judgeRankingPayload.value = payload
  judgeRankingLoadFailed.value = false
}

// Map a chip's position in the rendered list back to its
// judge_number using the parallel `judge_numbers` array supplied
// by the API. Falls back to (i + 1) when judge_numbers is missing
// (e.g. cached responses pre-dating the rollout) — works for the
// common case of a dense panel.
function judgeNumberAt(judgeNumbers, i) {
  if (Array.isArray(judgeNumbers) && judgeNumbers[i] != null) {
    return Number(judgeNumbers[i])
  }
  return i + 1
}

function judgeForIndex(judgeNumbers, i) {
  return panelByNumber.value.get(judgeNumberAt(judgeNumbers, i)) || null
}

// Map a chip's slot inside a synchro role group back to the
// real judge. groupedSynchroScoresForDisplay emits `scores`
// arrays in role order (Exec A → Exec B → Sync), but the
// underlying panel positions are fixed by the synchro panel size:
// 7/9 use 2/2 exec groups; 11 uses 3/3 exec groups. We re-derive
// the panel position from role + i.
function judgeForSynchro(historyRow, role, i) {
  const numJudges = currentEvent.value?.number_of_judges
  const groups = synchroJudgeGroups(numJudges)
  if (!groups) return null
  const judgeNumber = groups[role]?.[i]
  if (judgeNumber == null) return null
  return panelByNumber.value.get(judgeNumber) || null
}

const isCompleted = computed(() => currentEvent.value?.status === 'Completed')

const latestRound = computed(() => {
  if (!leaderboardRounds.value.length) return null
  return leaderboardRounds.value[leaderboardRounds.value.length - 1]
})

const isTeamEvent = computed(() => archiveResults.value?.event?.event_type === 'team')

// Group the archive's flat dive list. For team events the group
// key is the team name (so the breakdown reads team-by-team with
// each member's dive listed inside). For individual / synchro
// events it stays per-diver as before.
const divesByDiver = computed(() => {
  if (!archiveResults.value) return []
  const teamMode = isTeamEvent.value
  const order = new Map()
  ;(archiveResults.value.standings || []).forEach((s, i) => order.set(s.full_name, i))

  const grouped = new Map()
  for (const d of archiveResults.value.dives || []) {
    const key = teamMode ? (d.team_name || 'Unattached') : d.full_name
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(d)
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => a.round_number - b.round_number)
  }
  return [...grouped.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    .map(([key, dives]) => {
      // Pull partner_id off the matching standings row (the
      // archive standings query exposes it for synchro events).
      // Falls back to scanning the dive rows if standings doesn't
      // surface it for some reason — partner_id from competitor
      // _dive_lists rides on every dive of that diver.
      const standRow = archiveResults.value.standings
        .find(s => s.full_name === key)
      return {
        name: key,
        country: teamMode ? null : (dives[0]?.country_code || null),
        club: teamMode ? null : (dives[0]?.club_name || null),
        partner: teamMode ? null : (dives[0]?.partner_name || null),
        partner_id: teamMode ? null : (standRow?.partner_id || dives.find(d => d.partner_id)?.partner_id || null),
        partner_country: teamMode ? null : (dives[0]?.partner_country || null),
        isTeam: teamMode,
        total: standRow?.total ?? null,
        rank: (order.get(key) ?? -1) + 1,
        dives,
      }
    })
})

// Country medal table — counts gold/silver/bronze per country
// from the archive standings. Only renders when at least two
// distinct countries appear in the result, which is the
// indicator that this was an international meet (ties the
// audience-facing surface to the same threshold the host org's
// event_participating_orgs entry implies). Sort by gold desc,
// silver desc, bronze desc, then total desc as tiebreaker —
// matches how WA + Olympics rank countries.
const countryMedalTable = computed(() => {
  if (!archiveResults.value) return null
  const standings = archiveResults.value.standings || []
  if (!standings.length) return null
  // Derive rank from index — the archive endpoint returns
  // standings already sorted by total descending, but doesn't
  // include a rank column. Without this the medal table was
  // rendering 0/0/0 for every country because s.rank was always
  // undefined. Tied totals share a rank (World Aquatics practice: both
  // divers on the same total get gold), and subsequent ranks
  // skip by the size of the tied group (1, 1, 3).
  let prevTotal = null
  let prevRank  = 0
  const byCountry = new Map()
  for (let i = 0; i < standings.length; i++) {
    const s = standings[i]
    const total = parseFloat(s.total) || 0
    let rank
    if (prevTotal !== null && Math.abs(total - prevTotal) < 1e-9) {
      rank = prevRank
    } else {
      rank = i + 1
      prevRank  = rank
      prevTotal = total
    }
    const code = s.country_code || '—'
    if (!byCountry.has(code)) {
      byCountry.set(code, { code, gold: 0, silver: 0, bronze: 0, total_pts: 0 });
    }
    const row = byCountry.get(code)
    if (rank === 1) row.gold   += 1
    if (rank === 2) row.silver += 1
    if (rank === 3) row.bronze += 1
    row.total_pts += total
  }
  if (byCountry.size < 2) return null
  return [...byCountry.values()].sort((a, b) =>
    b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || b.total_pts - a.total_pts
  )
})

const eventStats = computed(() => {
  if (!archiveResults.value) return null
  const dives = archiveResults.value.dives || []
  const standings = archiveResults.value.standings || []

  let highest = null
  let biggestDD = null
  let perfectTens = 0
  let totalRaw = 0
  let totalCount = 0

  for (const d of dives) {
    const total = parseFloat(d.total_dive_score)
    if (!Number.isNaN(total) && (!highest || total > highest.total)) {
      highest = {
        diver: d.full_name,
        round: d.round_number,
        code: [d.dive_code, d.position].filter(Boolean).join(''),
        total,
      }
    }
    const dd = parseFloat(d.dd)
    if (!Number.isNaN(dd) && (!biggestDD || dd > biggestDD.dd)) {
      biggestDD = {
        diver: d.full_name,
        round: d.round_number,
        code: [d.dive_code, d.position].filter(Boolean).join(''),
        dd,
      }
    }
    const scores = parseScores(d.judge_scores)
    perfectTens += scores.filter(s => s === 10).length
    totalRaw += scores.reduce((a, b) => a + b, 0)
    totalCount += scores.length
  }

  const avgJudgeScore = totalCount ? (totalRaw / totalCount) : null
  const margin = standings.length >= 2
    ? parseFloat(standings[0].total) - parseFloat(standings[1].total)
    : null

  return {
    highest,
    biggestDD,
    perfectTens,
    margin,
    avgJudgeScore,
    totalDives: dives.length,
    competitors: standings.length,
  }
})

// Hold state for the active event — set by Control Room via
// the meet_hold socket event. Surfaces a banner across the top
// of the page while in effect.
const isHeld = ref(false)
const holdReason = ref('')

function selectEvent(id, { pushUrl = true } = {}) {
  currentEventId.value = id
  expandedRound.value = null
  // Clear any stale active-diver state from a previous event so
  // the panel correctly shows "Waiting..." until the server
  // confirms the current performer for this event.
  activeDiver.value = null
  isHeld.value = false
  holdReason.value = ''
  // Reset the show-more pagination state so a freshly opened
  // event lands in the calmer 3-row preview rather than
  // inheriting a previous event's expanded view.
  historyShowAll.value = false
  upNextShowAll.value  = false
  refreshData()
  // Pull the current active diver from the server. socket.io
  // buffers the emit until the connection is up, so this works
  // whether the socket has already connected or not.
  socket.emit('get_active_diver', { event_id: id })
  // Pull the current hold state too — covers the case where the
  // page loads after a hold has already been set.
  socket.emit('get_meet_hold', { event_id: id })
  // Reflect the selection in the URL so the meet is shareable
  // and back-button works. pushUrl=false avoids loops when this
  // is being driven *by* a URL change.
  if (pushUrl && route.params.eventId !== id) {
    router.push({ path: `/scoreboard/${id}` })
  }
}

function resetToEventPicker({ pushUrl = true } = {}) {
  // Invalidate any in-flight refreshData so a late response can't
  // repopulate the panels we're about to clear.
  refreshSeq++
  currentEventId.value = null
  activeDiver.value = null
  historyItems.value = []
  standings.value = []
  upcoming.value = []
  leaderboardRounds.value = []
  expandedRound.value = null
  archiveResults.value = null
  // Reset the judge-ranking section so opening a different event
  // doesn't leak stale ranks into the chip tooltips.
  judgeRankingPayload.value = null
  judgeRankingExpanded.value = false
  judgeRankingLoadFailed.value = false
  if (pushUrl && route.params.eventId) {
    router.push({ path: '/scoreboard' })
  }
}

// Drive the view from the URL. If someone deep-links to
// /scoreboard/<id> or hits Back/Forward, we sync state to match
// without reflecting back into the URL (which would loop).
watch(() => route.params.eventId, (newId) => {
  const id = newId || null
  if (id === currentEventId.value) return
  if (id) selectEvent(id, { pushUrl: false })
  else    resetToEventPicker({ pushUrl: false })
}, { immediate: false })

// Refresh when the current event's status flips. The events
// list arrives via cachedFetch (stale-while-revalidate); the
// initial selectEvent runs against whatever's in IndexedDB,
// which may still say Live for an event that's actually
// Completed by the time the page loads. When the fresh
// /api/archive response lands and rewrites currentEvent.status,
// re-fetch so the SPA swaps from the live broadcast layout into
// the recap (or vice versa) rather than staying on the cached
// view.
watch(() => currentEvent.value?.status, (status, prev) => {
  if (!currentEventId.value) return
  if (status && prev && status !== prev) refreshData()
})

// Stale-response guard for refreshData. Rapid event switching (or
// a status flip mid-flight) can leave an older request's slower
// response landing after a newer one — without the guard it would
// overwrite the newer event's standings/history/archive panels.
// Each call takes a fresh token; writes after an await bail if a
// newer call has started.
let refreshSeq = 0

async function refreshData() {
  if (!currentEventId.value) return
  const seq = ++refreshSeq
  try {
    if (isCompleted.value) {
      // Completed events: 24h SWR cache. The standings never change
      // once Completed is final; socket events (score_corrected)
      // invalidate on the rare admin-edit case.
      const [archiveRes, leaderboardRes] = await Promise.all([
        cachedFetch(
          `/api/archive/${currentEventId.value}/results`,
          { credentials: 'same-origin' },
          { maxAgeMs: SCOREBOARD_ARCHIVE_TTL_MS },
        ),
        cachedFetch(
          `/api/scoreboard/${currentEventId.value}/leaderboard`,
          { credentials: 'same-origin' },
          { maxAgeMs: SCOREBOARD_ARCHIVE_TTL_MS },
        ),
      ])
      if (seq !== refreshSeq) return
      const archive = archiveRes.data || {}
      const leaderboard = leaderboardRes.data || {}
      archiveResults.value = archive
      standings.value = archive.standings || []
      historyItems.value = []
      leaderboardRounds.value = leaderboard.rounds || []
      // Panel comes from the archive payload for completed events.
      eventPanel.value = archive.panel || []
      // Eager-fetch the JRA payload so per-chip tooltips have
      // rank context on first hover. The section UI itself
      // stays v-if'd (lazy mount) — the data lifecycle lives
      // on the parent now so opening the section is a zero-
      // network-call expansion.
      loadJudgeRankingPayload()
    } else {
      archiveResults.value = null
      // Live events don't have a stable Judge Ranking Analysis —
      // clear any payload left over from a flip Completed → Live
      // (rare, but cheap to guard against).
      judgeRankingPayload.value = null
      judgeRankingExpanded.value = false
      // Live events: 5s hard TTL — matches the server-side cache so
      // a spectator that just hit reload never sees data older than
      // the server would have served. Socket-driven invalidation
      // (score_received) busts the entry the moment a new score
      // commits, so real freshness comes from there.
      const [scoreboardRes, leaderboardRes] = await Promise.all([
        cachedFetch(
          `/api/scoreboard/${currentEventId.value}`,
          { credentials: 'same-origin' },
          { maxAgeMs: SCOREBOARD_LIVE_TTL_MS },
        ),
        cachedFetch(
          `/api/scoreboard/${currentEventId.value}/leaderboard`,
          { credentials: 'same-origin' },
          { maxAgeMs: SCOREBOARD_LIVE_TTL_MS },
        ),
      ])
      if (seq !== refreshSeq) return
      const scoreboard = scoreboardRes.data || {}
      const leaderboard = leaderboardRes.data || {}
      historyItems.value = scoreboard.history || []
      standings.value = scoreboard.standings || []
      upcoming.value = scoreboard.upcoming || []
      leaderboardRounds.value = leaderboard.rounds || []
      // Panel comes from the scoreboard payload for live events.
      eventPanel.value = scoreboard.panel || []
    }
    if (expandedRound.value === null && leaderboardRounds.value.length) {
      expandedRound.value = leaderboardRounds.value[leaderboardRounds.value.length - 1].round_number
    }
  } catch (err) {
    console.error('Refresh error', err)
  }
}

// fmtDate imported from @/lib/format — single source of truth.


function movementClass(m) {
  if (m == null) return 'mv-new'
  if (m > 0) return 'mv-up'
  if (m < 0) return 'mv-down'
  return 'mv-flat'
}

function movementSymbol(m) {
  if (m == null) return '•'
  if (m > 0) return `▲${m}`
  if (m < 0) return `▼${Math.abs(m)}`
  return '–'
}

// Record-broken toasts (PB / club / federation) used to pop in
// the top-right of the scoreboard on each new record. Removed —
// they distracted from the live standings panel they overlapped.
// The server still fires record_broken; we just don't render it
// here. If a quieter celebration UX is wanted later, re-listen
// for record_broken and pick a presentation that doesn't sit on
// top of the standings.

// All listeners below go through useSocketEvent so they're torn
// down with the view rather than relying on the spectator pool's
// refcount happening to hit zero.
useSocketEvent(socket, 'state_update', data => {
  // Ignore broadcasts until the user has picked an event, and
  // ignore broadcasts for events other than the current one. This
  // prevents stale state from another event leaking into the
  // panel before the user has picked anything.
  if (!currentEventId.value) return
  if (data.event_id !== currentEventId.value) return
  // Clear the per-judge live pills when the active diver/round
  // changes — the new diver hasn't been scored yet, and the old
  // diver's pills would visually carry over otherwise.
  const sameDive = activeDiver.value
    && activeDiver.value.competitor_id === data.competitor_id
    && Number(activeDiver.value.round_number) === Number(data.round_number)
  if (!sameDive) liveJudgeScores.value = []
  activeDiver.value = data
})

// Per-judge live score updates. Each judge's submit_score is
// broadcast as score_received to every subscriber on the event
// room. We collect them in judge_number order so the SPA's
// inline-under-active-diver display can show the lights coming
// in one at a time and (once the panel is full) shade the high
// + low as dropped under World Aquatics trim rules.
useSocketEvent(socket, 'score_received', data => {
  // Invalidate the client-side scoreboard cache for this event the
  // moment a new score commits. Without this, the 5s SWR TTL would
  // let a freshly-reloaded spectator see standings that lag by up
  // to one scoreboard tick.
  if (data?.event_id) {
    idbInvalidate(`/api/scoreboard/${data.event_id}`).catch(() => {})
  }
  if (!currentEventId.value) return
  if (data.event_id !== currentEventId.value) return
  if (!activeDiver.value) return
  if (data.competitor_id !== activeDiver.value.competitor_id) return
  if (Number(data.round_number) !== Number(activeDiver.value.round_number)) return
  // Same judge resubmitting (rare — referee correction path)
  // overwrites their pill rather than adding a 6th.
  const idx = liveJudgeScores.value.findIndex(s => s.judge_number === data.judge_number)
  const next = { value: Number(data.score), judge_number: data.judge_number }
  if (idx >= 0) liveJudgeScores.value[idx] = next
  else liveJudgeScores.value = [...liveJudgeScores.value, next]
  liveJudgeScores.value.sort((a, b) => a.judge_number - b.judge_number)
})

// On (re)connect, re-request the current active diver if an
// event is already selected. Covers the case where the socket
// drops mid-session and the in-memory state was unchanged on
// the server but our local state went stale.
useSocketEvent(socket, 'connect', () => {
  if (currentEventId.value) {
    socket.emit('get_active_diver', { event_id: currentEventId.value })
    socket.emit('get_meet_hold',    { event_id: currentEventId.value })
  }
})

// Hold-state propagation. The Control Room dispatches meet_hold
// + meet_resume; we set a banner accordingly. Per-event check so
// a hold on a different meet doesn't bleed into this scoreboard.
useSocketEvent(socket, 'meet_held', (data) => {
  if (data.event_id !== currentEventId.value) return
  isHeld.value = true
  holdReason.value = data.reason || ''
})
useSocketEvent(socket, 'meet_resumed', (data) => {
  if (data.event_id !== currentEventId.value) return
  isHeld.value = false
  holdReason.value = ''
})

// Score corrections fired by the Control Room: re-pull the
// scoreboard so totals reflect the amendment. Cheap full-pull
// is fine — score corrections are rare events.
useSocketEvent(socket, 'score_corrected', (data) => {
  if (data.event_id !== currentEventId.value) return
  refreshData()
})

useSocketEvent(socket, 'final_score_announced', () => {
  // Was a 4-second fullscreen overlay. The audience now sees
  // the dive total inline under the active-diver block (computed
  // from the score_received pills × DD), so just trigger a
  // standings refresh and let the inline UI carry the spotlight.
  refreshData()
})

// rankClass + ordinal imported from @/lib/format — single source
// of truth for the podium classes and the "Currently Nth" line.

// Per-judge pills for the current active diver, annotated with
// scoreCategory + dropped-under-trim flag. Reuses the same helper
// the Completed-Dives panel uses, so the chip styling is identical.
const liveAnnotatedScores = computed(() => {
  if (!liveJudgeScores.value.length) return []
  const csv = liveJudgeScores.value.map(s => s.value).join(',')
  return annotatedScores(csv, currentEvent.value?.number_of_judges)
})

// Stable-layout placeholders — generates an array of `number_of_judges`
// tiles ALWAYS (even when no scores have arrived), so the live-judges
// row's height stays constant from the moment a diver becomes active.
// Without this the row started at 0px, then jumped to ~50px the
// instant the first score landed, shoving the catch-up + Up Next
// blocks below it down. Each slot either carries a populated score
// (with World Aquatics category + dropped flag) or renders as a dim "—"
// placeholder; either way the tile dimensions are identical.
const liveJudgeSlots = computed(() => {
  const numJudges = Number(currentEvent.value?.number_of_judges) || 5
  const annotated = liveAnnotatedScores.value
  const slots = []
  for (let i = 0; i < numJudges; i++) {
    const filled = annotated[i]
    if (filled) {
      slots.push({
        filled: true,
        value: filled.value,
        category: filled.category,
        dropped: filled.dropped,
      })
    } else {
      slots.push({ filled: false })
    }
  }
  return slots
})

// Dive total for the active diver — only populated once the full
// panel is in (otherwise we'd be flashing partial sums). Computed
// as (sum of non-dropped scores) × DD.
const liveDiveTotal = computed(() => {
  const annotated = liveAnnotatedScores.value
  const need = Number(currentEvent.value?.number_of_judges) || 5
  if (annotated.length < need) return null
  const dd = parseFloat(activeDiver.value?.dd)
  if (!dd || Number.isNaN(dd)) return null
  const trimSum = annotated
    .filter(j => !j.dropped)
    .reduce((sum, j) => sum + j.value, 0)
  return trimSum * dd
})

// 1-based rank of the active diver in the current standings, or
// null if we can't find them (e.g. before the first refresh).
// Matches by the diverName field that set_active_diver carries.
const activeDiverRank = computed(() => {
  if (!activeDiver.value || !standings.value.length) return null
  const target = activeDiver.value.full_name || activeDiver.value.diverName
  if (!target) return null
  const idx = standings.value.findIndex(s => s.full_name === target)
  return idx >= 0 ? idx + 1 : null
})

// Catch-up projection — mirrors the Control Room indicator. For
// the active diver, computes:
//   * gap to leader (or to runner-up if leading)
//   * average dive total they need across remaining dives
//   * average judge score per kept score those dives need
// DD proxy is the active diver's current dive (we don't have
// the full upcoming roster on the audience scoreboard, just the
// state_update payload that drives the active block). Catch-up
// table mirrors the Control Room — surfaces the average judge
// score needed across the remaining dives to reach 1st / 2nd /
// 3rd, with "not possible" for targets that even straight 10s
// wouldn't catch.
function pairLabel(row) {
  if (!row) return ''
  if (row.partner_name) return `${row.full_name} & ${row.partner_name}`
  return row.full_name || ''
}

function panelMultiplier(numJudges, isSynchro) {
  // Synchro points are (kept grouped score sum) × DD × 0.6.
  // If every judge scored X, the effective multiplier is the
  // number of kept grouped scores × 0.6. This keeps the catch-up
  // projection aligned with calc_synchro_dive_points for 7/9/11.
  if (isSynchro) {
    const groups = synchroJudgeGroups(numJudges)
    if (!groups) return Math.max(1, (parseInt(numJudges) || 5) * 0.6)
    const kept = Object.entries(groups).reduce((sum, [role, judges]) => {
      const drop = synchroGroupDropCount(role, parseInt(numJudges) || 0)
      return sum + Math.max(0, judges.length - drop * 2)
    }, 0)
    return Math.max(1, kept * 0.6)
  }
  const drop = trimCount(numJudges)
  return Math.max(1, (parseInt(numJudges) || 5) - 2 * drop)
}

const activeProjection = computed(() => {
  // Subject — the diver the projection table is computed FOR.
  // We use the active diver when one is on the board, and fall
  // back to the on-deck (next-up) performer otherwise so the
  // catch-up table stays visible BEFORE the diver is officially
  // on the board too. Same shape covers both: round_number, dd,
  // full_name / diverName all come through on each.
  const subject = activeDiver.value
    || (centrePerformer.value?.kind === 'next' ? centrePerformer.value : null)
  if (!subject || !standings.value.length) return null
  const target = subject.full_name || subject.diverName
  if (!target) return null
  const idx = standings.value.findIndex(s => s.full_name === target)
  const leader = standings.value[0]
  if (!leader) return null
  const totalRounds = parseInt(currentEvent.value?.total_rounds) || 0
  const numJudges   = parseInt(currentEvent.value?.number_of_judges) || 5
  const isSynchro   = currentEvent.value?.event_type === 'synchro_pair'
  const ddProxy     = parseFloat(subject.dd) || null
  const remaining   = totalRounds
    ? totalRounds - (parseInt(subject.round_number) || 1) + 1
    : 0
  const mult = panelMultiplier(numJudges, isSynchro)

  // Per-dive contribution if every judge scores X is X × mult ×
  // DD. So gap G across R dives at avg DD D solves to
  // X = G / (mult × D × R). 10 is the ceiling — any X > 10 means
  // straight 10s wouldn't close the gap.
  //
  // The displayed score rounds UP to the next 0.5 because judges
  // can only score in half-point increments — 5.2 isn't a
  // possible judge score, but 5.5 is. Rounded value is what the
  // diver would need from EVERY judge on every remaining dive to
  // mathematically guarantee closing the gap. `possible` stays
  // tied to the raw value so a raw of 9.6 (rounds to 10.0 —
  // straight 10s, achievable) doesn't flip to "not possible".
  function avgJudgeForGap(gap) {
    if (gap <= 0)                   return { score: 0,    possible: true  }
    if (remaining <= 0 || !ddProxy) return { score: null, possible: null  }
    const raw = gap / (mult * ddProxy * remaining)
    const rounded = Math.ceil(raw * 2) / 2
    return { score: rounded, possible: raw <= 10 }
  }

  if (idx === -1) {
    return {
      kind: 'pre',
      activeName: target,
      leaderName: pairLabel(leader),
      leaderTotal: Number(leader.total || 0),
    }
  }

  const me = standings.value[idx]
  const myTotal = Number(me.total || 0)
  const myLabel = pairLabel(me)

  if (idx === 0) {
    const second = standings.value[1]
    if (!second) return { kind: 'unopposed', activeName: myLabel }
    const gap = myTotal - Number(second.total || 0)
    const { score, possible } = avgJudgeForGap(gap)
    return {
      kind: 'lead',
      activeName: myLabel,
      runnerUp: pairLabel(second),
      gap, remaining,
      avgJudge: score, possible,
    }
  }

  // Chase: build a row for each podium rank above the active
  // diver (max 1st / 2nd / 3rd). Beyond #3 the panel gets dense
  // and the spectator-facing scoreboard is supposed to skim, not
  // read deeply.
  const targets = []
  for (const r of [0, 1, 2].filter(r => r < idx)) {
    const opponent = standings.value[r]
    const gap = Number(opponent.total || 0) - myTotal
    const { score, possible } = avgJudgeForGap(gap)
    targets.push({
      rank: r + 1,
      name: pairLabel(opponent),
      gap,
      avgJudge: score,
      possible,
    })
  }
  return {
    kind: 'chase',
    activeName: myLabel,
    currentRank: idx + 1,
    remaining,
    targets,
  }
})

function parseScores(judgeArray) {
  if (!judgeArray) return []
  return judgeArray.split(',').map(s => parseFloat(s))
}

onMounted(async () => {
  loadingList.value = true
  meetsFromCache.value = false
  try {
    // Stale-while-revalidate via IndexedDB. Spectators landing
    // on /scoreboard get an instant render from cache (if they've
    // visited before) and the network refresh updates the list
    // when it lands. Works offline for browsing past meets even
    // if the network is gone — only live state stays unavailable.
    const [evs, cls] = await Promise.all([
      cachedFetch('/api/archive', { credentials: 'same-origin' }, {
        onUpdate(fresh) {
          if (Array.isArray(fresh)) { events.value = fresh; meetsFromCache.value = false }
        },
      }),
      cachedFetch('/api/archive/clubs', { credentials: 'same-origin' }, {
        onUpdate(fresh) { if (Array.isArray(fresh)) clubsList.value = fresh },
      }),
    ])
    if (Array.isArray(evs.data)) {
      events.value = evs.data
      meetsFromCache.value = evs.fromCache
    }
    if (Array.isArray(cls.data)) {
      clubsList.value = cls.data
    }
    // Headline count of the DiveRecorder results archive for the
    // header line. Fire-and-forget — a failure just hides the
    // "N archived" link, it never blocks the live list.
    fetch('/api/dr-archive/stats', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : null))
      .then(s => { if (s && Number.isFinite(s.events)) archiveTotal.value = s.events })
      .catch(() => {})
  } finally {
    loadingList.value = false
  }
  // Bootstrap from a deep-link URL (e.g. /scoreboard/<id>) once
  // the events list has loaded, so currentEvent resolves.
  const initial = route.params.eventId
  if (initial) selectEvent(initial, { pushUrl: false })
})
</script>

<template>
  <div class="sb-layout"
       :class="{ 'broadcast-mode': broadcastMode, 'overlay-mode': overlayMode }"
       :style="overlayMode ? { background: overlayBg } : null">
    <!-- Floating exit button when in broadcast mode — small,
         positioned in the corner, nearly invisible until hover.
         Lets an operator drop back into the normal layout
         without retyping the URL. -->
    <RouterLink
      v-if="broadcastMode && currentEventId"
      :to="`/scoreboard/${currentEventId}`"
      class="broadcast-exit"
      v-tip.fixed="'Exit broadcast mode'"
    >✕</RouterLink>
    <!-- Sponsor rotation tile. Only rendered when the current
         event is part of a meet (event.meet_id is set) — the
         component itself no-ops if the meet has no logos.
         Suppressed on the recap (isCompleted) since sponsor
         branding on a results page reads as gauche. The
         'overlay' placement strips the backplate so OBS chroma
         keying composites cleanly. -->
    <SponsorRotation
      v-if="currentEvent && currentEvent.meet_id && !isCompleted"
      :meet-id="currentEvent.meet_id"
      :placement="overlayMode ? 'overlay' : 'corner'"
    />
    <!-- Connection banner — visible whenever the spectator
         socket has dropped. Live event watchers won't see new
         dives until reconnect, so it's worth surfacing. -->
    <div v-if="!socket.isConnected.value && currentEventId && !isCompleted" class="conn-banner">
      <span class="conn-dot"></span>
      Reconnecting to live feed…
    </div>

    <!-- Meet-hold banner — surfaces when the Control Room has
         paused the meet (video review, judge consultation,
         technical issue). Visible across all spectator devices
         so the audience knows why nothing's happening. -->
    <div v-if="isHeld && currentEventId" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>
    <!-- Header — adapts to list mode (browsing) vs detail mode
         (a single event selected). The detail header doubles as a
         breadcrumb so the user can jump back to the list. Hidden
         entirely in broadcast mode so a venue projector shows
         only the live scoring content. -->
    <div v-if="!broadcastMode" class="sb-header">
      <template v-if="!currentEventId">
        <div class="header-left">
          <span v-if="!auth.isLoggedIn" class="sb-page-title">Scoreboard &amp; Results</span>
          <span v-if="events.length" class="sb-page-sub">
            <span v-if="liveEvents.length" class="sb-page-sub-live">{{ liveEvents.length }} live now</span>
            <span v-if="liveEvents.length && upcomingEvents.length"> · </span>
            <span v-if="upcomingEvents.length" class="sb-page-sub-upcoming">{{ upcomingEvents.length }} upcoming</span>
            <template v-if="liveEvents.length || upcomingEvents.length"> · </template>
            {{ completedEvents.length.toLocaleString() }} completed<template v-if="archiveTotal"> · <RouterLink to="/results-archive" class="sb-page-sub-archive">{{ archiveTotal.toLocaleString() }} archived</RouterLink></template>
          </span>
        </div>
      </template>
      <template v-else>
        <div class="header-left">
          <nav class="sb-crumbs" aria-label="Breadcrumb">
            <button @click="resetToEventPicker" class="sb-crumb-link" type="button">All Meets</button>
            <template v-if="currentEvent?.meet_id">
              <span class="sb-crumb-sep" aria-hidden="true">›</span>
              <RouterLink :to="`/meet/${currentEvent.meet_id}`" class="sb-crumb-link sb-crumb-meet">{{ currentEvent.meet_name }}</RouterLink>
            </template>
            <span class="sb-crumb-sep" aria-hidden="true">›</span>
            <span class="sb-crumb-current">{{ currentEvent?.name || (isCompleted ? 'Event Recap' : 'Broadcast Feed') }}</span>
          </nav>
          <div v-if="isCompleted" class="status-badge done-badge">{{ $t('scoreboard.status_completed') }}</div>
          <div v-else class="status-badge live-badge">{{ $t('scoreboard.status_live') }}</div>
        </div>
      </template>
      <div style="display:flex;gap:0.4rem;align-items:center">
        <!-- Results Archive — historical results mined from
             DiveRecorder. Shown while browsing (list mode) so the
             archive is reachable from the public Scoreboard. -->
        <RouterLink
          v-if="!currentEventId"
          to="/results-archive"
          class="btn btn-ghost btn-sm"
          v-tip.fixed="'Browse historical results imported from DiveRecorder'"
        >📚 Results Archive</RouterLink>
        <!-- Broadcast / kiosk mode toggle. Visible only when an
             event is selected; flips into a chromeless layout
             suitable for a venue projector. -->
        <RouterLink
          v-if="currentEventId && !isCompleted"
          :to="`/scoreboard/${currentEventId}/broadcast`"
          class="btn btn-ghost btn-sm"
          v-tip.fixed="'Open in broadcast / kiosk mode (no page chrome)'"
        >📺 {{ $t('scoreboard.broadcast') }}</RouterLink>
        <a
          v-if="currentEventId && !isCompleted"
          :href="`/scoreboard/${currentEventId}?overlay=1`"
          target="_blank" rel="noopener"
          class="btn btn-ghost btn-sm"
          v-tip.fixed="'Open the chroma-key overlay (for OBS / streaming). Append &bg=ff00ff for a magenta key colour.'"
        >🎬 {{ $t('scoreboard.stream_overlay') }}</a>
        <RouterLink v-if="!auth.isLoggedIn" to="/" class="btn btn-ghost btn-sm">Home</RouterLink>
      </div>
    </div>

    <!-- =========================================================
         LIST MODE — no event selected. Browses every Live and
         Completed meet with the same filter controls the old
         ArchiveView used. The whole list-mode surface (cache
         banner, LIVE strip, filter cluster, results) lives in
         the MeetsBrowser component; the parent just supplies the
         master event list + filter source data and listens for
         a selection.
         ========================================================= -->
    <MeetsBrowser
      v-if="!currentEventId"
      :events="events"
      :live-events="liveEvents"
      :upcoming-events="upcomingEvents"
      :meets-from-cache="meetsFromCache"
      :loading-list="loadingList"
      :clubs-list="clubsList"
      :countries="countries"
      :years="years"
      :heights="heights"
      @select="selectEvent"
    />

    <!-- Body — Live broadcast layout (only when an event is selected
         and it's not completed). The completed branch is handled by
         the <div class="sb-completed"> below. -->
    <div class="sb-body" v-else-if="!isCompleted">
      <!-- Left: History -->
      <div class="sb-col">
        <div class="col-head">Completed Dives</div>
        <div class="col-body">
          <p v-if="!historyItems.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No scores yet</p>
          <!-- Preview cards (always visible) + toggle button +
               rest cards (visible when expanded) — wrapped in a
               single v-for over either the preview or the full
               list, with the toggle injected after the
               (HISTORY_PREVIEW_COUNT)th card. Keeps the toggle
               anchored at a fixed visual position; clicking
               drops the rest of the list down BELOW the
               button. -->
          <template v-for="(h, idx) in (historyShowAll ? historyItems : historyPreview)"
                    :key="`${h.competitor_id}-${h.round_number}`">
          <div class="hist-card">
            <div class="hist-round">Round {{ h.round_number }}{{ currentEvent?.total_rounds ? ` / ${currentEvent.total_rounds}` : '' }}</div>
            <!-- Shared identity block — same source of truth as
                 the Control Room. Lead + synchro partner stack
                 equal-weight, team / club secondary line for
                 non-synchro rows, country / team / club chip top-
                 right alongside the dive total. -->
            <DiverIdentity
              :row="h"
              :competitor-id="h.competitor_id"
              :partner-id="h.partner_id"
              link-profiles
              variant="split"
              class="hist-identity">
              <template #trailing>
                <div class="hist-total">{{ parseFloat(h.total_dive_score).toFixed(1) }}</div>
              </template>
            </DiverIdentity>
            <!-- Dive header: code + DD + description in a single
                 row. Mirrors the Control Room's history card so
                 the audience and the operator see the same shape. -->
            <div class="hist-dive-line">
              <span class="hist-code">{{ h.dive_code ? `${h.dive_code}${h.position || ''}` : '—' }}</span>
              <span v-if="h.dd != null" class="hist-dd">DD {{ parseFloat(h.dd).toFixed(1) }}</span>
              <span v-if="h.description" class="hist-desc">{{ diveDescription(h) }}</span>
            </div>
            <div v-if="h.judge_array" class="hist-scores">
              <template v-if="currentEvent?.event_type === 'synchro_pair'">
                <div v-for="g in (groupedSynchroScoresForDisplay(h.judge_array, currentEvent.number_of_judges) || [])"
                     :key="g.role"
                     :class="['judge-group', `judge-group-${g.role}`]">
                  <span class="judge-group-label">{{ g.label }}</span>
                  <!-- Synchro: each score's judge_number is the
                       N-th member of the role-specific subpanel
                       (Exec A / Exec B / Sync). g.scores is in
                       judge_number order within the role, so we
                       map back via groupedSynchroScoresForDisplay
                       providing the original judge_numbers. The
                       chip's "right" judge_number lives in the
                       parent dive row's judge_numbers array; we
                       index into it by the chip's overall position
                       (computed from role + slot). -->
                  <template v-for="(j, si) in g.scores" :key="si">
                    <RouterLink v-if="judgeForSynchro(h, g.role, si)"
                          :to="`/judge-profile/${judgeForSynchro(h, g.role, si).judge_id}`"
                          :class="['j-score', 'j-link', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                          v-tip="judgeTooltip(judgeForSynchro(h, g.role, si), { dropped: j.dropped })">
                      {{ j.value.toFixed(1) }}
                    </RouterLink>
                    <span v-else
                          :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                          v-tip="j.dropped ? 'Dropped by trim rule' : 'Judge identity not available'">
                      {{ j.value.toFixed(1) }}
                    </span>
                  </template>
                </div>
              </template>
              <template v-else>
                <template v-for="(j, si) in annotatedScores(h.judge_array, currentEvent?.number_of_judges)" :key="si">
                  <RouterLink v-if="judgeForIndex(h.judge_numbers, si)"
                        :to="`/judge-profile/${judgeForIndex(h.judge_numbers, si).judge_id}`"
                        :class="['j-score', 'j-link', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                        v-tip="judgeTooltip(judgeForIndex(h.judge_numbers, si), { dropped: j.dropped })">
                    {{ j.value.toFixed(1) }}
                  </RouterLink>
                  <span v-else
                        :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                        v-tip="j.dropped ? 'Dropped by trim rule' : 'Judge identity not available'">
                    {{ j.value.toFixed(1) }}
                  </span>
                </template>
              </template>
            </div>
          </div>
          <!-- Toggle button rendered INSIDE the v-for after the
               last preview card. Stays at a fixed position when
               clicked: expanding renders the rest of the list
               BELOW the button, not above it. -->
          <button
            v-if="idx === HISTORY_PREVIEW_COUNT - 1
                  && historyItems.length > HISTORY_PREVIEW_COUNT"
            class="hist-toggle"
            @click="historyShowAll = !historyShowAll"
          >
            {{ historyShowAll
                ? `Show fewer ↑`
                : `Show ${historyItems.length - HISTORY_PREVIEW_COUNT} more ↓` }}
          </button>
          </template>
        </div>
      </div>

      <!-- Centre: Active diver. The list of meets is now the page's
           landing state, so we no longer render a separate picker
           here — by the time we render this branch, currentEventId
           is guaranteed to be set. -->
      <div class="sb-col active-centre">
        <div style="width:100%;text-align:center">
          <div v-if="centrePerformer?.round_number" class="sb-round-pill">
            Round {{ centrePerformer.round_number }}<span v-if="currentEvent?.total_rounds"> / {{ currentEvent.total_rounds }}</span>
          </div>
          <!-- Label flips between live ("Current Performer") and
               on-deck ("On Deck — Up Next") so the audience knows
               whether the named diver is actively performing or
               just queued. -->
          <div class="sb-label">
            <template v-if="centrePerformer?.kind === 'active'">Current Performer</template>
            <template v-else-if="centrePerformer?.kind === 'next'">On Deck — Up Next</template>
            <template v-else>Current Performer</template>
          </div>
          <div :class="['sb-name', centrePerformer?.kind === 'next' ? 'sb-name-next' : '']"
               :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <template v-if="centrePerformer?.partner_name">
              <RouterLink v-if="centrePerformer?.competitor_id" :to="`/profile/${centrePerformer.competitor_id}`" class="diver-link">{{ centrePerformer.diverName }}</RouterLink>
              <template v-else>{{ centrePerformer.diverName }}</template>
              <span class="sb-name-amp">&amp;</span>
              <RouterLink v-if="centrePerformer?.partner_id" :to="`/profile/${centrePerformer.partner_id}`" class="diver-link">{{ centrePerformer.partner_name }}</RouterLink>
              <template v-else>{{ centrePerformer.partner_name }}</template>
            </template>
            <template v-else>
              <RouterLink v-if="centrePerformer?.competitor_id" :to="`/profile/${centrePerformer.competitor_id}`" class="diver-link">{{ centrePerformer.diverName }}</RouterLink>
              <template v-else>{{ centrePerformer?.diverName || 'Waiting...' }}</template>
            </template>
          </div>
          <div v-if="centrePerformer?.country_code || centrePerformer?.club_name || centrePerformer?.team_name"
               class="sb-country-line" :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <span v-if="centrePerformer.country_code">{{ centrePerformer.country_code }}</span>
            <span v-if="centrePerformer.team_name" class="sb-team-line">{{ centrePerformer.team_name }}</span>
            <span v-if="centrePerformer.club_name && !centrePerformer.team_name" class="sb-club-line">{{ centrePerformer.club_name }}</span>
          </div>
          <!-- Dive code · DD · description on a single row.
               Was previously two rows (badges + a separate
               .sb-desc beneath); collapsed to one to save a
               row of vertical space and to keep the centre
               column tighter. -->
          <div class="sb-badges" :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <div class="sb-code">{{ centrePerformer?.diveCode || '—' }}</div>
            <div class="sb-dd">{{ centrePerformer?.dd ? `DD ${centrePerformer.dd}` : 'DD —' }}</div>
            <div v-if="centrePerformer?.description" class="sb-desc">{{ diveDescription(centrePerformer) }}</div>
          </div>

          <!-- Live judges' scores for the active diver. Pills are
               styled with the same .j-score / .j-dropped classes
               the Completed-Dives panel uses, so the visual
               vocabulary is consistent. Once the panel is full,
               the high + low pills shade out via .j-dropped and
               the Dive Total appears below.
               STABLE LAYOUT: every block here renders for ANY
               centrePerformer (active OR on-deck) so the layout
               is identical between "On Deck — Diver Alpha" and
               "Current Performer — Diver Alpha (mid-dive)". The
               judge tiles are placeholder "—" pills until scores
               arrive; the dive-total wrapper has a reserved
               min-height; the rank line wraps in a slot div with
               a min-height so its eventual appearance doesn't
               push the catch-up + Up Next blocks below it down. -->
          <div v-if="centrePerformer" class="sb-live-judges">
            <template v-for="(slot, i) in liveJudgeSlots" :key="i">
              <!-- Live chips: each slot's judge_number is i+1 (the
                   panel is dense and ordered). Wrap in a RouterLink
                   when we know who the judge is so spectators can
                   click through to /judge-profile; fall back to a
                   non-clickable span before the panel has loaded. -->
              <RouterLink v-if="panelByNumber.get(i + 1)"
                    :to="`/judge-profile/${panelByNumber.get(i + 1).judge_id}`"
                    :class="['j-score', 'j-link',
                             slot.filled ? `j-${slot.category}` : 'j-empty',
                             slot.dropped ? 'j-dropped' : '']"
                    v-tip="judgeTooltip(panelByNumber.get(i + 1), { dropped: slot.dropped })">
                {{ slot.filled ? slot.value.toFixed(1) : '—' }}
              </RouterLink>
              <span v-else
                    :class="['j-score',
                             slot.filled ? `j-${slot.category}` : 'j-empty',
                             slot.dropped ? 'j-dropped' : '']"
                    v-tip="slot.dropped ? 'Dropped by trim rule' : 'Judge identity not available'">
                {{ slot.filled ? slot.value.toFixed(1) : '—' }}
              </span>
            </template>
          </div>
          <div v-if="centrePerformer" class="sb-live-total-slot">
            <div v-show="liveDiveTotal != null" class="sb-live-total">
              <span class="sb-live-total-label">Dive Total</span>
              <span class="sb-live-total-value">{{ liveDiveTotal != null ? liveDiveTotal.toFixed(1) : '' }}</span>
            </div>
          </div>
          <div v-if="centrePerformer" class="sb-live-rank-slot">
            <div v-show="activeDiver && activeDiverRank" class="sb-live-rank">
              Currently <strong>{{ activeDiverRank ? ordinal(activeDiverRank) : '' }}</strong>
            </div>
          </div>
          <!-- Catch-up projection — table per podium target with
               the average judge score the active diver needs over
               the remaining dives. Caps at 10 (anything above
               reads "Not possible"). Mirrors the Control Room
               panel so the audience and the operator see the
               same chase math. -->
          <div v-if="activeProjection" :class="['sb-projection', `sb-projection-${activeProjection.kind}`]">
            <template v-if="activeProjection.kind === 'chase'">
              <div class="sb-projection-head">
                Catch-up — <strong>{{ activeProjection.remaining }}</strong>
                {{ activeProjection.remaining === 1 ? 'dive' : 'dives' }} left
                · currently {{ ordinal(activeProjection.currentRank) }}
              </div>
              <div v-for="t in activeProjection.targets" :key="t.rank" class="sb-catchup-row">
                <span class="sb-catchup-rank">{{ ordinal(t.rank) }}</span>
                <span class="sb-catchup-name">{{ t.name }}</span>
                <span :class="['sb-catchup-target', t.possible === false ? 'sb-catchup-impossible' : '']">
                  <template v-if="t.avgJudge == null">
                    +{{ t.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="t.possible === false">
                    not possible
                  </template>
                  <template v-else-if="t.avgJudge === 0">
                    already there
                  </template>
                  <template v-else>
                    avg {{ t.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="activeProjection.kind === 'lead'">
              <div class="sb-projection-head">
                Leading by <strong>+{{ activeProjection.gap.toFixed(1) }}</strong>
              </div>
              <div class="sb-catchup-row">
                <span class="sb-catchup-rank">2nd</span>
                <span class="sb-catchup-name">{{ activeProjection.runnerUp }}</span>
                <span :class="['sb-catchup-target', activeProjection.possible === false ? 'sb-catchup-impossible' : '']">
                  <template v-if="activeProjection.avgJudge == null">
                    +{{ activeProjection.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="activeProjection.possible === false">
                    can't overtake
                  </template>
                  <template v-else>
                    needs avg {{ activeProjection.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="activeProjection.kind === 'pre'">
              No completed dives yet. {{ activeProjection.leaderName }} leads at
              <strong>{{ activeProjection.leaderTotal.toFixed(1) }}</strong>.
            </template>
            <template v-else-if="activeProjection.kind === 'unopposed'">
              {{ activeProjection.activeName }} unopposed — only diver entered.
            </template>
          </div>

          <!-- Up Next: each row reads
                 R# · order-in-round · Name · TST · 103B · DD 1.6 · Forward 1½ Somersaults Pike
               so a spectator scanning the panel knows exactly
               who's up, what they're doing, and how hard it is.
               Hidden when the queue is empty (end-of-meet) so we
               don't dangle a blank panel. Filters out the current
               active diver so they're not double-shown.
               At rest only the next 3 dives render — keeps the
               centre column light. A "Show N more" toggle below
               expands to the full upcoming list. -->
          <div v-if="upcomingDisplay.length" class="up-next">
            <div class="up-next-label">
              Up Next · {{ upcomingDisplay.length }} remaining
            </div>
            <div class="up-next-scroll">
              <!-- Same anchored-toggle pattern as the history
                   columns: render the v-for over preview-or-all,
                   inject the toggle button INSIDE the loop after
                   the last preview row so it stays at a fixed
                   position when expanded. -->
              <template v-for="(u, i) in (upNextShowAll ? upcomingDisplay : upcomingPreview)"
                        :key="`${u.competitor_id || u.full_name}-${u.round_number}-${u.round_order || i}`">
              <div class="up-next-row">
                <span class="up-next-rd">R{{ u.round_number }}</span>
                <span class="up-next-pos">{{ u.round_order }}</span>
                <span class="up-next-name">
                  <RouterLink v-if="u.competitor_id"
                              :to="`/profile/${u.competitor_id}`"
                              class="diver-link">{{ u.full_name }}</RouterLink>
                  <template v-else>{{ u.full_name }}</template>
                  <span v-if="u.country_code" class="up-next-ctry">{{ u.country_code }}</span>
                  <template v-if="u.partner_name">
                    <span class="up-next-amp">&amp;</span>
                    <RouterLink v-if="u.partner_id"
                                :to="`/profile/${u.partner_id}`"
                                class="diver-link">{{ u.partner_name }}</RouterLink>
                    <template v-else>{{ u.partner_name }}</template>
                  </template>
                  <span v-if="u.club_name && !u.country_code" class="up-next-club">{{ u.club_name }}</span>
                </span>
                <span v-if="u.dive_code" class="up-next-code">
                  {{ u.dive_code }}<span class="up-next-letter">{{ u.position }}</span>
                </span>
                <span v-if="u.dd" class="up-next-dd">DD {{ parseFloat(u.dd).toFixed(1) }}</span>
                <span v-if="u.description || u.position" class="up-next-desc">
                  {{ diveDescription(u) }}
                </span>
              </div>
              <button
                v-if="i === UP_NEXT_PREVIEW_COUNT - 1
                      && upcomingDisplay.length > UP_NEXT_PREVIEW_COUNT"
                class="up-next-toggle"
                @click="upNextShowAll = !upNextShowAll"
              >
                {{ upNextShowAll
                    ? `Show fewer ↑`
                    : `Show ${upcomingDisplay.length - UP_NEXT_PREVIEW_COUNT} more ↓` }}
              </button>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Standings -->
      <div class="sb-col">
        <div class="col-head">
          <span>{{ $t('scoreboard.standings') }}</span>
          <div class="tabs">
            <button
              :class="['tab', standingsTab === 'final' ? 'tab-active' : '']"
              @click="standingsTab = 'final'"
            >Final</button>
            <button
              :class="['tab', standingsTab === 'by-round' ? 'tab-active' : '']"
              @click="standingsTab = 'by-round'"
            >By Round</button>
          </div>
        </div>
        <div class="col-body">
          <!-- Final view (existing) — augmented with movement vs previous round -->
          <template v-if="standingsTab === 'final'">
            <p v-if="!standings.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No standings yet</p>
            <div v-for="(s, i) in standings" :key="i" class="standing">
              <div :class="['standing-rank', rankClass(i)]">{{ i + 1 }}</div>
              <div class="standing-id">
                <div class="standing-name">
                  <RouterLink v-if="s.competitor_id"
                              :to="`/profile/${s.competitor_id}`"
                              class="diver-link">{{ s.full_name }}</RouterLink>
                  <template v-else>{{ s.full_name }}</template>
                  <span v-if="s.country_code" class="standing-country">{{ s.country_code }}</span>
                </div>
                <div v-if="s.partner_name" class="standing-partner">
                  &amp;
                  <RouterLink v-if="s.partner_id"
                              :to="`/profile/${s.partner_id}`"
                              class="diver-link">{{ s.partner_name }}</RouterLink>
                  <template v-else>{{ s.partner_name }}</template>
                  <span v-if="s.partner_country" class="standing-country">{{ s.partner_country }}</span>
                </div>
                <div v-if="s.club_name" class="standing-club">{{ s.club_name }}</div>
              </div>
              <div class="standing-score">
                <!-- "=" marker when two divers shared the raw total
                     but were separated by the World Aquatics tie-break rule
                     (highest single dive, then second-highest, …).
                     Spectators and coaches see this and understand
                     why two identical totals weren't a literal tie. -->
                <span v-if="s.is_tied_on_total" class="tie-marker"
                      v-tip="'Tied on total — separated by World Aquatics tie-break (highest single dive, then second-highest, etc.)'">=</span>
                {{ parseFloat(s.total).toFixed(1) }}
              </div>
            </div>
          </template>

          <!-- Round-by-round view: cumulative rank with movement arrows -->
          <template v-else>
            <p v-if="!leaderboardRounds.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No rounds completed yet</p>
            <div v-for="round in leaderboardRounds" :key="round.round_number" class="round-block">
              <button
                class="round-head"
                @click="expandedRound = expandedRound === round.round_number ? null : round.round_number"
              >
                <span>Round {{ round.round_number }}</span>
                <span class="round-caret">{{ expandedRound === round.round_number ? '▾' : '▸' }}</span>
              </button>
              <div v-if="expandedRound === round.round_number" class="round-body">
                <div v-for="r in round.rankings" :key="r.competitor_id" class="lb-row">
                  <div :class="['lb-rank', rankClass(r.rank - 1)]">{{ r.rank }}</div>
                  <div :class="['lb-mv', movementClass(r.movement)]">
                    {{ movementSymbol(r.movement) }}
                  </div>
                  <div class="lb-name">
                    <RouterLink v-if="r.competitor_id"
                                :to="`/profile/${r.competitor_id}`"
                                class="diver-link">{{ r.full_name }}</RouterLink>
                    <template v-else>{{ r.full_name }}</template>
                    <span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
                  </div>
                  <div class="lb-cum">{{ r.cumulative_total.toFixed(1) }}</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Body — Completed event recap (only when an event is
         selected and it has finished). Sits next to the live
         body branch above; the v-if chain is:
           !currentEventId  → list mode
           !isCompleted      → live broadcast
           else              → recap below -->
    <div class="sb-completed" v-else-if="isCompleted">
      <!-- Top metadata strip -->
      <div class="meta-strip">
        <div class="meta-left">
          <div class="meta-name">{{ currentEvent?.name }}</div>
          <div class="meta-tags">
            <span v-if="archiveResults?.event?.org_name" class="meta-tag meta-org">{{ archiveResults.event.org_name }}</span>
            <span v-if="currentEvent?.gender" class="meta-tag">{{ currentEvent.gender }}</span>
            <span v-if="currentEvent?.height" class="meta-tag">{{ currentEvent.height }}</span>
            <span v-if="currentEvent?.total_rounds" class="meta-tag">{{ currentEvent.total_rounds }} rounds</span>
            <span v-if="currentEvent?.number_of_judges" class="meta-tag">{{ currentEvent.number_of_judges }} judges</span>
            <span v-if="currentEvent?.created_at" class="meta-tag meta-date">{{ fmtDate(currentEvent.created_at) }}</span>
          </div>
        </div>
        <div class="export-actions">
          <a :href="`/api/events/${currentEventId}/results.pdf`"
             target="_blank" rel="noopener"
             class="btn btn-ghost btn-sm">PDF</a>
          <a :href="`/api/events/${currentEventId}/results.csv`"
             class="btn btn-ghost btn-sm">CSV</a>
          <a :href="`/api/events/${currentEventId}/start-list.pdf`"
             target="_blank" rel="noopener"
             class="btn btn-ghost btn-sm">Start list</a>
        </div>
      </div>

      <!-- End-of-event recap. One centred column so the
           leaderboard sits dead centre on the page rather than
           being flanked by sidebars. Stack order: podium spotlight
           (top 3) → tabbed leaderboard (per-diver dives or
           round-by-round) → meet highlights. -->
      <div class="completed-recap">
        <!-- Podium spotlight: top 3, slightly elevated treatment.
             Each podium-name is a /profile/<id> link when we have
             a competitor_id for that row (individual + synchro
             events). Team rows have NULL competitor_id so the
             team name renders as plain text. -->
        <div v-if="standings.length >= 3" class="podium">
          <div class="podium-step podium-2">
            <div class="podium-medal silver">2</div>
            <div class="podium-name">
              <RouterLink v-if="standings[1].competitor_id"
                          :to="`/profile/${standings[1].competitor_id}`"
                          class="diver-link">{{ standings[1].full_name }}</RouterLink>
              <template v-else>{{ standings[1].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[1].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[1].total).toFixed(1) }}</div>
          </div>
          <div class="podium-step podium-1">
            <div class="podium-medal gold">1</div>
            <div class="podium-name">
              <RouterLink v-if="standings[0].competitor_id"
                          :to="`/profile/${standings[0].competitor_id}`"
                          class="diver-link">{{ standings[0].full_name }}</RouterLink>
              <template v-else>{{ standings[0].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[0].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[0].total).toFixed(1) }}</div>
          </div>
          <div class="podium-step podium-3">
            <div class="podium-medal bronze">3</div>
            <div class="podium-name">
              <RouterLink v-if="standings[2].competitor_id"
                          :to="`/profile/${standings[2].competitor_id}`"
                          class="diver-link">{{ standings[2].full_name }}</RouterLink>
              <template v-else>{{ standings[2].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[2].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[2].total).toFixed(1) }}</div>
          </div>
        </div>

        <!-- Country medal table — only when 2+ distinct countries
             appeared on the standings (i.e. the meet was actually
             international). Shows gold/silver/bronze count per
             country, sorted Olympic-style. -->
        <div v-if="countryMedalTable" class="recap-card medal-card">
          <div class="col-head">
            <span>Country Medal Table</span>
          </div>
          <div class="col-body">
            <div class="medal-grid">
              <div class="medal-head-row">
                <div class="medal-rank">#</div>
                <div class="medal-country">Country</div>
                <div class="medal-cell medal-gold-head">🥇</div>
                <div class="medal-cell medal-silver-head">🥈</div>
                <div class="medal-cell medal-bronze-head">🥉</div>
              </div>
              <div
                v-for="(row, i) in countryMedalTable"
                :key="row.code"
                class="medal-row"
              >
                <div class="medal-rank">{{ i + 1 }}</div>
                <div class="medal-country">{{ row.code }}</div>
                <div class="medal-cell">{{ row.gold }}</div>
                <div class="medal-cell">{{ row.silver }}</div>
                <div class="medal-cell">{{ row.bronze }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Leaderboard card: every diver in rank order with their
             per-dive breakdown (judges' scores, dive code, position,
             DD, dive total). Final tab is the per-diver view; the
             By-Round tab keeps the older round-by-round leaderboard
             with movement arrows. -->
        <div class="recap-card">
          <div class="col-head">
            <span>Final Leaderboard</span>
            <div class="tabs">
              <button
                :class="['tab', standingsTab === 'final' ? 'tab-active' : '']"
                @click="standingsTab = 'final'"
              >Final</button>
              <button
                :class="['tab', standingsTab === 'by-round' ? 'tab-active' : '']"
                @click="standingsTab = 'by-round'"
              >By Round</button>
            </div>
          </div>
          <div class="col-body">
            <template v-if="standingsTab === 'final'">
              <p v-if="!divesByDiver.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No dive data recorded</p>
              <template v-else>
              <!-- Dive-by-dive toggle. ON by default → the recap
                   shows only the final standings (rank · diver ·
                   total). Toggling OFF expands every diver into
                   their full per-dive scoresheet (code, DD, each
                   judge's score, dive total). -->
              <div class="breakdown-toggle-bar">
                <label class="score-toggle">
                  <input type="checkbox" v-model="finalScoresOnly">
                  <span class="score-toggle-track"><span class="score-toggle-thumb"></span></span>
                  <span class="score-toggle-text">Final scores only</span>
                </label>
                <span class="score-toggle-hint">
                  {{ finalScoresOnly
                    ? 'Final standings only — switch off for each diver’s dives'
                    : 'Showing every dive' }}
                </span>
              </div>

              <!-- Default: condensed final standings, one row per
                   diver / pair / team in rank order. -->
              <ol v-if="finalScoresOnly" class="final-standings">
                <li v-for="block in divesByDiver" :key="block.name" class="fs-row">
                  <div class="fs-rank" :class="rankClass(block.rank - 1)">{{ block.rank }}</div>
                  <div class="fs-id">
                    <div class="fs-name">
                      <RouterLink v-if="!block.isTeam && block.dives[0]?.competitor_id"
                                  :to="`/profile/${block.dives[0].competitor_id}`"
                                  class="diver-link">{{ block.name }}</RouterLink>
                      <template v-else>{{ block.name }}</template>
                      <span v-if="block.country" class="diver-country">{{ block.country }}</span>
                      <template v-if="block.partner">
                        <span class="diver-amp">&amp;</span>
                        <RouterLink v-if="block.partner_id"
                                    :to="`/profile/${block.partner_id}`"
                                    class="diver-link">{{ block.partner }}</RouterLink>
                        <template v-else>{{ block.partner }}</template>
                        <span v-if="block.partner_country" class="diver-country">{{ block.partner_country }}</span>
                      </template>
                    </div>
                    <div v-if="block.club" class="fs-club">{{ block.club }}</div>
                  </div>
                  <div class="fs-total" v-if="block.total != null">{{ parseFloat(block.total).toFixed(1) }}</div>
                </li>
              </ol>

              <!-- Toggled off: full per-diver dive-by-dive breakdown. -->
              <template v-else>
              <div v-for="block in divesByDiver" :key="block.name" class="diver-block">
                <div class="diver-head">
                  <div class="diver-rank-badge" :class="rankClass(block.rank - 1)">{{ block.rank }}</div>
                  <div class="diver-id">
                    <div class="diver-id-row">
                      <div class="diver-name">
                        <!-- For team-mode blocks the name is the
                             team, not a single diver — skip the
                             link. For individual + synchro the
                             leader's competitor_id sits on every
                             one of their dive rows. -->
                        <RouterLink v-if="!block.isTeam && block.dives[0]?.competitor_id"
                                    :to="`/profile/${block.dives[0].competitor_id}`"
                                    class="diver-link">{{ block.name }}</RouterLink>
                        <template v-else>{{ block.name }}</template>
                        <span v-if="block.country" class="diver-country">{{ block.country }}</span>
                        <template v-if="block.partner">
                          <span class="diver-amp">&amp;</span>
                          <RouterLink v-if="block.partner_id"
                                      :to="`/profile/${block.partner_id}`"
                                      class="diver-link">{{ block.partner }}</RouterLink>
                          <template v-else>{{ block.partner }}</template>
                          <span v-if="block.partner_country" class="diver-country">{{ block.partner_country }}</span>
                        </template>
                      </div>
                      <div class="diver-total" v-if="block.total != null">{{ parseFloat(block.total).toFixed(1) }} pts</div>
                    </div>
                    <div v-if="block.club" class="diver-club">{{ block.club }}</div>
                  </div>
                </div>
                <div class="dive-table">
                  <div class="dive-row dive-head-row">
                    <div class="dr-round">Rd</div>
                    <div class="dr-code">Dive</div>
                    <div class="dr-dd"><JargonTip term="DD" /></div>
                    <div class="dr-judges">Judge Scores</div>
                    <div class="dr-total">Total</div>
                  </div>
                  <div v-for="d in block.dives" :key="d.round_number + (d.full_name || '')" class="dive-row">
                    <div class="dr-round">R{{ d.round_number }}</div>
                    <div class="dr-code">
                      <span v-if="block.isTeam" class="dr-team-member">
                        <!-- Per-dive team-member name links to
                             that diver's profile so the recap
                             reads as a navigable scoresheet. -->
                        <RouterLink v-if="d.competitor_id"
                                    :to="`/profile/${d.competitor_id}`"
                                    class="diver-link">{{ d.full_name }}</RouterLink>
                        <template v-else>{{ d.full_name }}</template>
                      </span>
                      <span class="dr-code-main">{{ [d.dive_code, d.position].filter(Boolean).join(' ') }}</span>
                      <span v-if="d.description" class="dr-code-desc">{{ diveDescription(d) }}</span>
                    </div>
                    <div class="dr-dd">{{ d.dd != null ? parseFloat(d.dd).toFixed(1) : '—' }}</div>
                    <div class="dr-judges">
                      <template v-if="currentEvent?.event_type === 'synchro_pair'">
                        <div v-for="g in (groupedSynchroScoresForDisplay(d.judge_scores, currentEvent.number_of_judges) || [])"
                             :key="g.role"
                             :class="['judge-group', `judge-group-${g.role}`]">
                          <span class="judge-group-label">{{ g.label }}</span>
                          <template v-for="(j, si) in g.scores" :key="si">
                            <RouterLink v-if="judgeForSynchro(d, g.role, si)"
                                  :to="`/judge-profile/${judgeForSynchro(d, g.role, si).judge_id}`"
                                  :class="['j-score', 'j-link', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                                  v-tip="judgeTooltip(judgeForSynchro(d, g.role, si), { dropped: j.dropped })">
                              {{ j.value.toFixed(1) }}
                            </RouterLink>
                            <span v-else
                                  :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                                  v-tip="j.dropped ? 'Dropped by trim rule' : 'Judge identity not available'">
                              {{ j.value.toFixed(1) }}
                            </span>
                          </template>
                        </div>
                      </template>
                      <template v-else>
                        <template v-for="(j, si) in annotatedScores(d.judge_scores, currentEvent?.number_of_judges)" :key="si">
                          <RouterLink v-if="judgeForIndex(d.judge_numbers, si)"
                                :to="`/judge-profile/${judgeForIndex(d.judge_numbers, si).judge_id}`"
                                :class="['j-score', 'j-link', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                                v-tip="judgeTooltip(judgeForIndex(d.judge_numbers, si), {
                                          dropped: j.dropped,
                                          perDiveRank: judgePerDiveRank(judgeForIndex(d.judge_numbers, si), d.competitor_id, d.round_number),
                                          roundNumber: d.round_number,
                                        })">
                            {{ j.value.toFixed(1) }}
                          </RouterLink>
                          <span v-else
                                :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                                v-tip="j.dropped ? 'Dropped by trim rule' : 'Judge identity not available'">
                            {{ j.value.toFixed(1) }}
                          </span>
                        </template>
                      </template>
                      <!-- Officials-only audit history. Sits at
                           the trailing edge of the judges' chip
                           row (.dr-judges already flex-wraps so
                           the extra pill flows naturally). The
                           component self-gates on org-admin —
                           spectators don't see anything. -->
                      <ScoreHistoryButton
                        v-if="currentEventId && d.competitor_id"
                        :event-id="currentEventId"
                        :competitor-id="d.competitor_id || block.id"
                        :round-number="d.round_number"
                      />
                    </div>
                    <div class="dr-total">
                      {{ parseFloat(d.total_dive_score).toFixed(1) }}
                    </div>
                  </div>
                </div>
              </div>
              </template>
              </template>
            </template>

            <!-- Round-by-round leaderboard with movement arrows -->
            <template v-else>
              <p v-if="!leaderboardRounds.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No round data available</p>
              <div v-for="round in leaderboardRounds" :key="round.round_number" class="round-block">
                <button
                  class="round-head"
                  @click="expandedRound = expandedRound === round.round_number ? null : round.round_number"
                >
                  <span>Round {{ round.round_number }}</span>
                  <span class="round-caret">{{ expandedRound === round.round_number ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedRound === round.round_number" class="round-body">
                  <div v-for="r in round.rankings" :key="r.competitor_id" class="lb-row">
                    <div :class="['lb-rank', rankClass(r.rank - 1)]">{{ r.rank }}</div>
                    <div :class="['lb-mv', movementClass(r.movement)]">
                      {{ movementSymbol(r.movement) }}
                    </div>
                    <div class="lb-id">
                      <div class="lb-name">
                        <RouterLink v-if="r.competitor_id"
                                    :to="`/profile/${r.competitor_id}`"
                                    class="diver-link">{{ r.full_name }}</RouterLink>
                        <template v-else>{{ r.full_name }}</template>
                        <span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
                      </div>
                      <div v-if="r.club_name" class="lb-club">{{ r.club_name }}</div>
                    </div>
                    <div class="lb-cum">{{ r.cumulative_total.toFixed(1) }}</div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Judge Ranking Analysis. Section is collapsed by
             default — the data is already in memory (eager-
             fetched alongside the recap payload so the chip
             tooltips can use it on first hover), so opening the
             section is a zero-network-call expansion. The table
             component takes the payload via prop, no internal
             fetch. Available on every Completed event type —
             individual / synchro_pair / team. -->
        <div v-if="isCompleted" class="recap-card jra-section">
          <button
            class="col-head jra-toggle"
            type="button"
            @click="judgeRankingExpanded = !judgeRankingExpanded">
            <span>Judge Ranking Analysis</span>
            <span class="jra-caret">{{ judgeRankingExpanded ? '▾' : '▸' }}</span>
          </button>
          <div v-if="judgeRankingExpanded" class="col-body">
            <JudgeRankingTable
              :event-id="currentEventId"
              :payload="judgeRankingPayload"
              @loaded="onJudgeRankingLoaded" />
          </div>
        </div>

        <!-- Meet highlights — sits below the leaderboard so it
             doesn't compete for attention with the per-diver
             results. -->
        <div v-if="eventStats" class="stats-panel">
          <div class="stats-head">Meet Highlights</div>
          <div v-if="eventStats.margin != null" class="stat-row">
            <span class="stat-label">Margin of victory</span>
            <span class="stat-value">{{ eventStats.margin.toFixed(2) }}</span>
          </div>
          <div v-if="eventStats.highest" class="stat-row">
            <span class="stat-label">Highest dive total</span>
            <span class="stat-value">{{ eventStats.highest.total.toFixed(1) }}</span>
          </div>
          <div v-if="eventStats.highest" class="stat-sub">
            {{ eventStats.highest.diver }} · R{{ eventStats.highest.round }} · {{ eventStats.highest.code }}
          </div>
          <div v-if="eventStats.biggestDD" class="stat-row">
            <span class="stat-label">Biggest DD attempted</span>
            <span class="stat-value">{{ eventStats.biggestDD.dd.toFixed(1) }}</span>
          </div>
          <div v-if="eventStats.biggestDD" class="stat-sub">
            {{ eventStats.biggestDD.diver }} · R{{ eventStats.biggestDD.round }} · {{ eventStats.biggestDD.code }}
          </div>
          <div class="stat-row">
            <span class="stat-label">Perfect 10s awarded</span>
            <span class="stat-value">{{ eventStats.perfectTens }}</span>
          </div>
          <div v-if="eventStats.avgJudgeScore != null" class="stat-row">
            <span class="stat-label">Avg judge score</span>
            <span class="stat-value">{{ eventStats.avgJudgeScore.toFixed(2) }}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Competitors / dives</span>
            <span class="stat-value">{{ eventStats.competitors }} / {{ eventStats.totalDives }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Score overlay removed — the inline pills + dive total +
         "currently Nth" line under the active diver carry the
         spotlight now. The fullscreen flash was disorienting
         because it hid the rest of the scoreboard for 4s on every
         dive. -->

  </div>
</template>

<style scoped src="./ScoreboardView.css"></style>
