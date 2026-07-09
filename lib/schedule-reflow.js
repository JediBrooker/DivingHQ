// Session-scheduler live re-flow (Phase 4).
//
// docs/session-scheduler.md §6 describes the trigger:
//
//   When the operator marks an event Complete (events.status flips
//   to 'Completed'), find the matching schedule_blocks row, stamp
//   its actual_end_at, compute delta = NOW() - ends_at. If
//   |delta| < 5 min, no-op. Otherwise gather every downstream block
//   in the same session (starts_at >= completed_block.ends_at AND
//   actual_start_at IS NULL) and return them as candidates for the
//   operator-driven reflow modal.
//
// Re-flow only ever shifts things later, an event that ran short
// doesn't pull subsequent warmups forward. Operators still want lead
// time for divers who arrived planning on the original window.
//
// This module is the read-only proposal builder plus the stamping
// side-effect. The write half (atomically shifting the confirmed
// candidates, appending shift-ledger rows, emitting the socket)
// lives in routes/sessions.js, the operator-facing endpoint that the
// Control Room modal POSTs against.
//
// Sub-5-minute noise threshold: the design doc explicitly calls out
// that we shouldn't interrupt the operator for trivial overruns.
// Drift of a minute or two is just a fact of life at any meet, and
// bothering the control room over it would train them to dismiss
// the modal anyway.

// Time threshold below which a delta isn't worth proposing a
// reflow for. Matches docs/session-scheduler.md §6.2.
const REFLOW_NOISE_THRESHOLD_MS = 5 * 60 * 1000;

// Stamp the actual_start_at on the schedule_blocks row that maps
// to this event (if any). Idempotent, only stamps when the column
// is null so a re-flip Live → Live (shouldn't happen, but defends
// against the operator double-clicking) doesn't overwrite the
// original.
//
// Returns the stamped row's id, or null when no schedule_block
// maps to the event (older meets pre-scheduler, or the operator
// never scheduled this particular event).
async function stampActualStart(client, eventId, atDate) {
  if (!eventId) return null;
  const r = await client.query(
    `UPDATE schedule_blocks
        SET actual_start_at = $2,
            updated_at      = now()
      WHERE event_id = $1
        AND actual_start_at IS NULL
      RETURNING id`,
    [eventId, atDate],
  );
  return r.rows[0]?.id || null;
}

// Build the reflow proposal for a just-completed event. Stamps the
// matching block's actual_end_at as a side effect (always, even
// when the delta is below the noise floor, since we want the
// post-meet debrief to see what really happened), then returns
// `null` when no proposal should be shown, or the proposal object
// described in the design doc.
//
// Shape:
//
//   {
//     completed_block_id,
//     delta_seconds,        // positive only, see below
//     candidates: [{ block_id, label, old_starts_at, new_starts_at,
//                    old_ends_at, new_ends_at }, …]
//   }
//
// Returns null when:
//   * the event has no matching schedule_block,
//   * |delta| < REFLOW_NOISE_THRESHOLD_MS,
//   * the event ran SHORT (delta <= 0), §6 explicitly says we
//     don't pull downstream blocks earlier,
//   * there are no candidates (no downstream blocks in the same
//     session that haven't already started).
async function buildReflowProposal(client, eventId, completedAt) {
  if (!eventId) return null;
  const at = completedAt || new Date();

  // Find the matching block. If multiple blocks point to this event
  // (operator weirdness, shouldn't happen in practice but the schema
  // doesn't forbid it), pick the one whose planned window ends
  // nearest to `at`. Most-recently-scheduled gives the most useful
  // reflow anchor when there's ambiguity.
  const blockRes = await client.query(
    `SELECT b.id, b.session_id, b.starts_at, b.ends_at, b.actual_end_at,
            s.meet_id
       FROM schedule_blocks b
       JOIN sessions s ON s.id = b.session_id
      WHERE b.event_id = $1
   ORDER BY ABS(EXTRACT(EPOCH FROM (b.ends_at - $2::timestamptz))) ASC
      LIMIT 1`,
    [eventId, at],
  );
  if (!blockRes.rowCount) {
    return null;
  }
  const completed = blockRes.rows[0];

  // Side-effect: stamp actual_end_at. Only when null so a re-flip
  // (Completed → Live → Completed for an operator do-over) keeps
  // the first observed end-time as the audit truth.
  if (!completed.actual_end_at) {
    await client.query(
      `UPDATE schedule_blocks
          SET actual_end_at = $2,
              updated_at    = now()
        WHERE id = $1`,
      [completed.id, at],
    );
  }

  const plannedEndMs = new Date(completed.ends_at).getTime();
  const actualEndMs = at.getTime();
  const deltaMs = actualEndMs - plannedEndMs;

  // §6.2: sub-5-min delta is ignored. §6 (closing): we never shift
  // earlier, so negative deltas (ran short) also return null.
  if (deltaMs <= 0) return null;
  if (Math.abs(deltaMs) < REFLOW_NOISE_THRESHOLD_MS) return null;

  // Candidates: same session, starts at or after completed.ends_at,
  // hasn't already started. Sorted by start time so the modal lists
  // them in execution order.
  const candidatesRes = await client.query(
    `SELECT b.id, b.label, b.block_type,
            b.starts_at, b.ends_at,
            e.name AS event_name
       FROM schedule_blocks b
  LEFT JOIN events e ON e.id = b.event_id
      WHERE b.session_id = $1
        AND b.id <> $2
        AND b.starts_at >= $3::timestamptz
        AND b.actual_start_at IS NULL
   ORDER BY b.starts_at ASC, b.created_at ASC`,
    [completed.session_id, completed.id, completed.ends_at],
  );
  if (!candidatesRes.rowCount) return null;

  const candidates = candidatesRes.rows.map((row) => {
    const oldStartsMs = new Date(row.starts_at).getTime();
    const oldEndsMs = new Date(row.ends_at).getTime();
    return {
      block_id: row.id,
      label: row.label || row.event_name || row.block_type,
      block_type: row.block_type,
      old_starts_at: new Date(oldStartsMs).toISOString(),
      new_starts_at: new Date(oldStartsMs + deltaMs).toISOString(),
      old_ends_at: new Date(oldEndsMs).toISOString(),
      new_ends_at: new Date(oldEndsMs + deltaMs).toISOString(),
    };
  });

  return {
    completed_block_id: completed.id,
    meet_id: completed.meet_id,
    session_id: completed.session_id,
    delta_seconds: Math.round(deltaMs / 1000),
    candidates,
  };
}

module.exports = {
  REFLOW_NOISE_THRESHOLD_MS,
  stampActualStart,
  buildReflowProposal,
};
