// Shared workflow/readiness helpers.
//
// These helpers deliberately return small, UI-shaped objects instead
// of entire event rows. Dashboard and Control Room both need the
// same answers ("what blocks this event from starting?", "what's
// the next action?") and keeping that logic server-side stops the
// persona panels from drifting apart.

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildReadinessFromRow(row) {
  if (!row) return null;

  const status = row.status || "Upcoming";
  const activeDivers = int(row.active_diver_count);
  const incompleteDivers = int(row.incomplete_diver_count);
  const missingDiveRows = int(row.missing_dive_rows);
  const judgeCount = int(row.judge_count);
  const requiredJudges = int(row.number_of_judges);

  const steps = [
    {
      key: "roster",
      label: "Roster has competitors",
      done: activeDivers > 0,
      hint: activeDivers > 0
        ? `${activeDivers} entered`
        : "Add or import divers before meet day",
      to: `/manager?event=${row.id}`,
      owner: "meet_manager",
    },
    {
      key: "dive_lists",
      label: "Dive lists complete",
      done: activeDivers > 0 && incompleteDivers === 0 && missingDiveRows === 0,
      hint: incompleteDivers || missingDiveRows
        ? `${incompleteDivers || missingDiveRows} incomplete`
        : "Waiting for entries",
      to: `/manager?event=${row.id}`,
      owner: "diver",
    },
    {
      key: "panel",
      label: "Judge panel seated",
      done: requiredJudges > 0 && judgeCount >= requiredJudges,
      hint: requiredJudges > 0
        ? `${judgeCount}/${requiredJudges} judges`
        : "Choose a panel size",
      to: `/assign-judges?event=${row.id}`,
      owner: "meet_manager",
    },
    {
      key: "check_in",
      label: "Check-in confirmed",
      done: !!row.check_in_done_at,
      hint: "Mark present, late, or DNS",
      to: `/control?event=${row.id}`,
      owner: "meet_manager",
    },
    {
      key: "order",
      label: "Start order locked",
      done: !!row.dive_order_randomised_at,
      hint: "Randomise or use current order",
      to: `/control?event=${row.id}`,
      owner: "meet_manager",
    },
    {
      key: "sign_off",
      label: "Referee sign-off",
      done: !!row.dive_order_signed_off_at,
      hint: row.pending_signoff_referee_name
        ? `Waiting for ${row.pending_signoff_referee_name}`
        : "Send request or sign off",
      to: `/control?event=${row.id}`,
      owner: "referee",
    },
  ];

  const blockers = steps
    .filter((step) => !step.done)
    .map((step) => ({
      key: step.key,
      label: step.label,
      hint: step.hint,
      to: step.to,
      owner: step.owner,
    }));

  let nextAction = null;
  if (status === "Live") {
    nextAction = {
      key: "run_live",
      label: "Run live event",
      hint: "Open Control Room",
      to: `/control?event=${row.id}`,
      owner: "meet_manager",
      urgency: "live",
    };
  } else if (status === "Completed") {
    nextAction = {
      key: "review_results",
      label: "Review results",
      hint: "Open scoreboard",
      to: `/scoreboard/${row.id}`,
      owner: "meet_manager",
      urgency: "done",
    };
  } else if (blockers.length) {
    nextAction = {
      ...blockers[0],
      key: blockers[0].key,
      urgency: row.entries_close_at && new Date(row.entries_close_at).getTime() < Date.now() + 24 * 60 * 60 * 1000
        ? "soon"
        : "normal",
    };
  } else {
    nextAction = {
      key: "start",
      label: "Start event",
      hint: row.is_rehearsal ? "Dry-run scoring flow" : "Go live",
      to: `/control?event=${row.id}`,
      owner: "meet_manager",
      urgency: "ready",
    };
  }

  return {
    event_id: row.id,
    event_name: row.name,
    status,
    is_rehearsal: !!row.is_rehearsal,
    scheduled_at: row.scheduled_at,
    entries_close_at: row.entries_close_at,
    active_diver_count: activeDivers,
    reserve_count: int(row.reserve_count),
    withdrawn_count: int(row.withdrawn_count),
    judge_count: judgeCount,
    required_judges: requiredJudges,
    check_in_done_at: row.check_in_done_at,
    dive_order_randomised_at: row.dive_order_randomised_at,
    dive_order_signed_off_at: row.dive_order_signed_off_at,
    pending_signoff_referee_name: row.pending_signoff_referee_name || null,
    steps,
    blockers,
    ready: blockers.length === 0,
    next_action: nextAction,
  };
}

const EVENT_READINESS_SELECT = `
  WITH ev AS (
    SELECT e.*
    FROM events e
    WHERE e.id = $1
      AND ($2::boolean OR e.org_id = $3)
  ),
  roster AS (
    SELECT
      cdl.event_id,
      COUNT(DISTINCT cdl.competitor_id)
        FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = FALSE)::int AS active_diver_count,
      COUNT(DISTINCT cdl.competitor_id)
        FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = TRUE)::int AS reserve_count,
      COUNT(DISTINCT cdl.competitor_id)
        FILTER (WHERE cdl.withdrawn_at IS NOT NULL)::int AS withdrawn_count,
      COUNT(*)
        FILTER (WHERE cdl.withdrawn_at IS NULL AND cdl.is_reserve = FALSE AND cdl.dive_id IS NULL)::int AS missing_dive_rows
    FROM competitor_dive_lists cdl
    JOIN ev ON ev.id = cdl.event_id
    GROUP BY cdl.event_id
  ),
  incomplete AS (
    SELECT COUNT(*)::int AS incomplete_diver_count
    FROM (
      SELECT cdl.competitor_id
      FROM competitor_dive_lists cdl
      JOIN ev ON ev.id = cdl.event_id
      WHERE cdl.withdrawn_at IS NULL
        AND cdl.is_reserve = FALSE
      GROUP BY cdl.competitor_id, ev.total_rounds
      HAVING COUNT(*) < ev.total_rounds
          OR COUNT(*) FILTER (WHERE cdl.dive_id IS NULL) > 0
    ) x
  ),
  judges AS (
    SELECT event_id, COUNT(*)::int AS judge_count
    FROM event_judges
    WHERE event_id = $1
    GROUP BY event_id
  ),
  pending_signoff AS (
    SELECT rsr.event_id, u.full_name AS pending_signoff_referee_name
    FROM referee_signoff_requests rsr
    JOIN users u ON u.id = rsr.target_referee_id
    WHERE rsr.event_id = $1
      AND rsr.status = 'pending'
    ORDER BY rsr.created_at DESC
    LIMIT 1
  )
  SELECT ev.id, ev.name, ev.status, ev.number_of_judges,
         ev.scheduled_at, ev.entries_close_at, ev.is_rehearsal,
         ev.check_in_done_at, ev.dive_order_randomised_at,
         ev.dive_order_signed_off_at,
         COALESCE(roster.active_diver_count, 0)::int AS active_diver_count,
         COALESCE(roster.reserve_count, 0)::int AS reserve_count,
         COALESCE(roster.withdrawn_count, 0)::int AS withdrawn_count,
         COALESCE(roster.missing_dive_rows, 0)::int AS missing_dive_rows,
         COALESCE(incomplete.incomplete_diver_count, 0)::int AS incomplete_diver_count,
         COALESCE(judges.judge_count, 0)::int AS judge_count,
         pending_signoff.pending_signoff_referee_name
  FROM ev
  LEFT JOIN roster ON roster.event_id = ev.id
  LEFT JOIN incomplete ON true
  LEFT JOIN judges ON judges.event_id = ev.id
  LEFT JOIN pending_signoff ON pending_signoff.event_id = ev.id
`;

async function getEventReadiness(pool, { eventId, isSystemAdmin, orgId }) {
  const r = await pool.query(EVENT_READINESS_SELECT, [
    eventId,
    !!isSystemAdmin,
    orgId || null,
  ]);
  return buildReadinessFromRow(r.rows[0]);
}

module.exports = {
  buildReadinessFromRow,
  getEventReadiness,
};
