// The single frontend attention selector (P3 of the meet-day redesign).
//
// ONE client-side derivation of "what needs attention" for an event, so
// the three surfaces that used to compute it independently -- the
// Dashboard attention chip/card/badge (P3), and the ControlViewV2 rail
// marker + Setup blockers strip (P5/P6) -- can never disagree.
//
// Module boundary (deliberate): lib/workflow.js is the CommonJS
// SERVER-side authority for the dashboard bundle's `workflow_actions`
// payload; it cannot be imported by this ESM client and cannot carry
// the client-only blocker extras (offline / conflict / late-arrival).
// So this selector reads INPUTS, not lib/: each caller normalises its
// own source -- the server-derived 6-core readiness (workflow_actions /
// /api/events/:id/readiness) plus client-only extras -- into the shape
// below, and the selector layers them. It owns NO scoring rule.
//
// Pure + DB-less by design (unit-tested in test/use-attention.test.js).
//
// Input shapes:
//   coreReadiness: [{ key, label, done, blocking?, hint?, onFix?, severity? }]
//     the server-derived 6 steps (roster/dive_lists/panel/check_in/
//     order/sign_off). `blocking !== false` means an undone step blocks
//     go-live. This is the count the Dashboard / strip / rail agree on.
//   clientExtras: [{ key, label, blocking?, hint?, onFix?, severity? }]
//     client-only rows (offline / conflict / late-arrival / schedule /
//     synchro / federation). ADDITIVE + non-blocking by default: they
//     surface in blockerRows but never change the 6-core `count`, so a
//     caller's go-live (startBlocked) truth table is invariant to them.

function blocks(row) {
  // A row blocks when it isn't done and isn't explicitly non-blocking.
  return !!row && !row.done && row.blocking !== false
}

// The one mapper every surface consumes.
export function attentionForEvent(coreReadiness = [], clientExtras = []) {
  const coreBlockers = (coreReadiness || []).filter(blocks)
  const extraBlockers = (clientExtras || []).filter(blocks)
  const blockerRows = [...coreBlockers, ...extraBlockers]

  // `count` is the 6-CORE blocker count only -- the go-live-relevant
  // number the chip/card/badge/strip all show. Extras are surfaced via
  // blockerRows/totalCount but never move this number.
  const count = coreBlockers.length
  const totalCount = blockerRows.length

  const urgency = blockerRows.some((r) => r.severity === 'critical')
    ? 'critical'
    : totalCount > 0
      ? 'warn'
      : 'none'

  return {
    kind: totalCount > 0 ? 'blocked' : 'ready',
    urgency,
    count,
    totalCount,
    topBlocker: blockerRows[0] || null,
    blockerRows,
  }
}

// At-most-one marker for the rail row (P5). Precedence: a live event
// shows `live`; otherwise an event with blockers shows `blocker`;
// otherwise an event with a pending next action shows `next-action`;
// otherwise no marker. Never returns more than one.
export function attentionMarker(coreReadiness = [], clientExtras = [], opts = {}) {
  if (opts.live) return { kind: 'live', urgency: 'live' }
  const att = attentionForEvent(coreReadiness, clientExtras)
  if (att.totalCount > 0) return { kind: 'blocker', urgency: att.urgency }
  if (opts.nextAction) return { kind: 'next-action', urgency: 'info' }
  return null
}

// Caller helper: the server's workflow_actions rows already match the
// coreReadiness shape (buildReadinessFromRow -> {key,label,done,hint,...}).
// Pass them straight through; this just guards null/non-arrays so a
// bundle-in-flight (workflowActions === []/undefined) yields an empty,
// zero-count attention rather than NaN.
export function coreFromWorkflowActions(workflowActions) {
  return Array.isArray(workflowActions) ? workflowActions : []
}

// Caller helper for the Dashboard diver chip: an event only contributes
// if the diver is actually entered in it. diverEventIds === null means
// the bundle is still in flight -> treat as "entered" (no blink), matching
// the existing diverIsEntered(null) => true fallback.
export function contributesToDiverChip(eventId, diverEventIds) {
  if (diverEventIds == null) return true
  return diverEventIds.includes(eventId)
}

// P4 (2/2): rank the Dashboard pulse chips into a needs-attention lane so
// the MOST urgent category floats to the top instead of a fixed role
// order. Pure + DB-less (pinned by test/dashboard-attention.test.js).
// Reuses the SAME P3 item urgency markers -- no new semantics:
//   live (0)  > urgent / closing <24h (1) > overdue >7d (2) > rest (3)
export const ATTENTION_RANK = { live: 0, urgent: 1, overdue: 2, none: 3 }

// The rank of a single chip = its most urgent signal. A 'live' chip is
// always rank 0; otherwise the strongest urgency among its items wins.
export function chipUrgencyRank(chip) {
  if (!chip) return ATTENTION_RANK.none
  if (chip.kind === 'live') return ATTENTION_RANK.live
  const urgencies = (chip.items || []).map((i) => i && i.urgency).filter(Boolean)
  if (urgencies.includes('live')) return ATTENTION_RANK.live
  if (urgencies.includes('urgent')) return ATTENTION_RANK.urgent
  if (urgencies.includes('overdue')) return ATTENTION_RANK.overdue
  return ATTENTION_RANK.none
}

// Stable sort by urgency rank; ties keep the source (role) order so the
// lane is deterministic and the count is preserved exactly.
export function rankAttentionChips(chips) {
  return (chips || [])
    .map((chip, i) => ({ chip, i, rank: chipUrgencyRank(chip) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.chip)
}
