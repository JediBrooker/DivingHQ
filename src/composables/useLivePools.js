// Per-event live-state map (P5 of the redesign), the concurrent-pool
// engine for ControlViewV2.
//
// Heads up: the old single-pool Control Room kept ONE currentActive /
// scoresThisRound / judgeTiles for the focused event and dropped any socket
// result whose event_id didn't match it. Fine for one pool, but the rail
// can show two Live pools at once, so a score for a NON-focused pool still
// has to update THAT pool's tiles and arm its advance, without touching
// the focused pool or stealing the operator's center.
//
// This composable keys live state by event_id and routes each
// score_received / judge_signal to the matching pool. The frozen
// trim/sync/match math is untouched; this only changes WHERE the
// already-computed result is applied. Pure + DB-less (no socket, no
// fetch, no DOM) so it is unit-tested in test/live-pools.test.js; the
// caller (P6's Live mode) wires the socket in and runs the
// history/advance side-effects off the {allScoresIn} return.
import { reactive } from 'vue'

export function makePoolState() {
  return {
    roster: [], // the live QUEUE for this event (server-ordered: round, order)
    currentIndex: -1, // cursor into roster[]; -1 = nothing active
    currentActive: null, // roster[currentIndex], the live row
    activeInfo: null, // flat display object for the stage header
    scoresThisRound: {}, // judge_id -> numeric score
    judgeTiles: [], // [{ judgeIndex, judgeId, score, scored, signaled }]
    advanceArmed: false, // set when the active dive's last score lands
  }
}

// The flat display object behind a pool's stage header. diveDescription
// (frozen seam #2, src/composables/useDiveLabel.js) is passed in by the
// caller so this stays dependency-free and unit-testable.
export function buildActiveInfo(row, diveDescription) {
  if (!row) return null
  return {
    name: row.full_name,
    country: row.country_code || null,
    code: `${row.dive_code || ''}${row.position || ''}`,
    dd: row.dd != null && row.dd !== '' ? `DD ${row.dd}` : '',
    desc: typeof diveDescription === 'function' ? diveDescription(row) : row.description || '',
    round_number: row.round_number,
    club_name: row.club_name || null,
    club_code: row.club_code || null,
    partner_name: row.partner_name || null,
    partner_country: row.partner_country || null,
    team_name: row.team_name || null,
    team_code: row.team_code || null,
  }
}

// The READY/JUDGING/DIVING precedence ladder (JUDGING wins over DIVING
// wins over READY), unchanged from the old single-pool screen. Kept as a
// pure helper so each LivePoolCard's status computed is unit-testable.
export function deriveStatus({ hasActive, scoresInCount, clockExpired }) {
  if (!hasActive) return 'ready'
  if (scoresInCount > 0) return 'judging'
  if (clockExpired) return 'diving'
  return 'ready'
}

// Move a pool's cursor to roster[idx]: the pure half of "put this diver
// up". Sets the cursor, resolves the active row, clears scores, re-inits
// tiles, builds the header info. The side effects (set_active_diver emit,
// shot clock) stay with the caller.
export function selectDiver(pool, idx, numberOfJudges, diveDescription) {
  if (!pool || !Array.isArray(pool.roster)) return false
  if (idx < 0 || idx >= pool.roster.length) return false
  pool.currentIndex = idx
  pool.currentActive = pool.roster[idx]
  pool.scoresThisRound = {}
  pool.judgeTiles = initJudgeTiles(numberOfJudges)
  pool.activeInfo = buildActiveInfo(pool.currentActive, diveDescription)
  pool.advanceArmed = false
  return true
}

export function initJudgeTiles(n) {
  const tiles = []
  for (let i = 1; i <= (parseInt(n) || 0); i++) {
    tiles.push({ judgeIndex: i, judgeId: null, score: '—', scored: false, signaled: false })
  }
  return tiles
}

// Find the roster row that matches the server's AUTHORITATIVE active-diver
// payload (the set_active_diver shape persisted in event_live_state and
// replayed via state_update / get_active_diver). Match by competitor +
// round, unique within an event (one dive per competitor per round).
// Returns the roster index, or -1 when there is no payload or it can't be
// mapped (roster/payload drift). Pure -> lets ControlViewV2 restore a
// reopened mid-meet pool to the diver who is actually live instead of
// resetting the judges' panel to roster[0]. Unit-tested.
export function rosterIndexForActive(roster, active) {
  if (!Array.isArray(roster) || !active || active.competitor_id == null) return -1
  return roster.findIndex(
    (r) =>
      r &&
      String(r.competitor_id) === String(active.competitor_id) &&
      Number(r.round_number) === Number(active.round_number),
  )
}

// The rows that actually dive, in queue order. /roster returns withdrawn
// and reserve rows too (the Manager draws them as separate bands), and
// stepping through those put a scratched diver or Reserve 1 up on every
// judge's screen. round_order is null for both, which also covers a
// server that predates the is_reserve column.
export function competingQueue(roster) {
  if (!Array.isArray(roster)) return []
  return roster.filter((r) => r && !r.withdrawn_at && !r.is_reserve && r.round_order != null)
}

// Swap a pool onto a freshly fetched roster without losing its place.
// Withdrawals, promotions and late entries change the queue mid-meet, and
// the live diver has to stay live through that. If they're still in the
// queue the cursor just follows them. If they were the one withdrawn, the
// cursor sits just before whoever was next after them, so Next picks up
// from the right spot. currentActive is left alone either way: the dive
// on the blocks keeps its tiles and scores.
export function rebaseQueue(pool, roster) {
  if (!pool) return
  const next = competingQueue(roster)
  const prev = Array.isArray(pool.roster) ? pool.roster : []
  const active = pool.currentActive
  pool.roster = next
  if (!active) return
  const idx = rosterIndexForActive(next, active)
  if (idx >= 0) {
    pool.currentIndex = idx
    return
  }
  const oldIdx = rosterIndexForActive(prev, active)
  for (let i = oldIdx + 1; oldIdx >= 0 && i < prev.length; i++) {
    const at = rosterIndexForActive(next, prev[i])
    if (at >= 0) {
      pool.currentIndex = at - 1
      return
    }
  }
  pool.currentIndex = next.length - 1
}

// Apply a score_received to ONE pool's state. Same matching the old
// single-pool handler did, minus its focused-event short-circuit. Returns
// { matched, allScoresIn } so the caller can run the DOM/event side
// effects (history card, shot clock, auto-advance).
export function applyScore(pool, data, numberOfJudges) {
  const a = pool && pool.currentActive
  if (!a) return { matched: false, allScoresIn: false }
  if (data.event_id !== a.event_id) return { matched: false, allScoresIn: false }
  if (data.competitor_id !== a.competitor_id) return { matched: false, allScoresIn: false }
  if (data.round_number !== a.round_number) return { matched: false, allScoresIn: false }

  if (data.judge_id) pool.scoresThisRound[data.judge_id] = parseFloat(data.score)

  // Tile match: by judge_number, else by judge_id, else first unscored.
  let tile = data.judge_number
    ? pool.judgeTiles.find((t) => t.judgeIndex === parseInt(data.judge_number))
    : pool.judgeTiles.find((t) => t.judgeId === data.judge_id)
  if (!tile) tile = pool.judgeTiles.find((t) => !t.scored)
  if (tile) {
    tile.judgeId = data.judge_id
    tile.scored = true
    tile.score = parseFloat(data.score).toFixed(1)
  }

  const totalJudges = parseInt(numberOfJudges) || 0
  const scoresIn = Object.keys(pool.scoresThisRound).length
  const allScoresIn = totalJudges > 0 && scoresIn >= totalJudges
  if (allScoresIn) pool.advanceArmed = true
  return { matched: true, allScoresIn }
}

// Apply a judge_signal (a judge flagging the referee) to ONE pool's tile.
export function applyJudgeSignal(pool, data) {
  const a = pool && pool.currentActive
  if (!a) return false
  if (data.event_id !== a.event_id) return false
  if (data.competitor_id !== a.competitor_id) return false
  if (Number(data.round_number) !== Number(a.round_number)) return false
  const tile = pool.judgeTiles.find((t) => t.judgeIndex === parseInt(data.judge_number))
  if (tile) tile.signaled = !!data.signaled
  return true
}

// The composable: a reactive event_id -> pool-state map plus a single
// router that applies a socket result to the RIGHT pool by event_id,
// never short-circuiting on the focused pool.
export function useLivePools() {
  const pools = reactive({})

  function poolFor(eventId) {
    if (!pools[eventId]) pools[eventId] = makePoolState()
    return pools[eventId]
  }

  // numberOfJudges may be a value or a (eventId) => n lookup, since each
  // pool can run a different panel size.
  function routeScore(data, numberOfJudges) {
    if (!data || data.event_id == null) return { matched: false, allScoresIn: false }
    const pool = pools[data.event_id]
    if (!pool) return { matched: false, allScoresIn: false }
    const n = typeof numberOfJudges === 'function' ? numberOfJudges(data.event_id) : numberOfJudges
    return applyScore(pool, data, n)
  }

  function routeSignal(data) {
    if (!data || data.event_id == null) return false
    const pool = pools[data.event_id]
    if (!pool) return false
    return applyJudgeSignal(pool, data)
  }

  return { pools, poolFor, routeScore, routeSignal }
}
