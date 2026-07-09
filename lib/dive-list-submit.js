// Shared dive-list submission helper.
//
// Extracted from routes/competitor.js so the diver-self path
// (POST /api/competitor/submit-list) and the coach-on-behalf-of
// path (POST /api/coach/dive-lists/:diver_id) can share every
// validation plus the same UPSERT. Without the extraction, the
// coach endpoint would either duplicate ~150 lines of validation
// or silently skip some of it.
//
// Shape:
//   await submitDiveList({
//     client,       // pg client INSIDE a transaction (caller owns BEGIN/COMMIT)
//     event,        // row from loadEventForEntries(...).event
//     actor,        // { id, org_id, is_system_admin, full_name }, whoever is hitting the endpoint
//     competitorId, // who the list is FOR (=actor.id for self-submit, =linked diver for coach)
//     competitorOrgId, // the competitor's own org (used for participating-orgs check)
//     partnerId,    // optional synchro partner user id
//     dives,        // [{ dive_id, round_number }]
//     push,         // optional push engine (lib/push.js) for synchro notifications
//   })
//
// Returns: { ok: true }
//          | { ok: true, pairing: { status: 'pending', pairing_id, partner_name } }
//          | { ok: true, pairing: { status: 'auto_confirmed', partner_id, partner_name } }
// Throws:  Error with .status (HTTP code) and optionally .violations.
//
// The caller is responsible for the transaction boundary AND for
// emitting the audit log entry (which differs between paths, since
// the coach path includes "coach_id" extra context).
//
// Resubmit semantics: BEFORE the UPSERT loop we DELETE any
// non-withdrawn rows for this (event, competitor) whose
// round_number is NOT in the new `dives` array. So if a previously-
// submitted round isn't in the new list it gets removed, otherwise
// re-submitting with fewer rounds left ghost rounds behind that the
// operator would still see in the live queue. Withdrawn rows
// (withdrawn_at IS NOT NULL) are preserved, the withdraw flow
// already marks them and we don't want to silently un-withdraw on
// resubmit.
//
// Synchro consent (migration 051): a synchro submit no longer
// blindly writes competitor_dive_lists with the requested
// partner_id. The flow is:
//   * If a reciprocal pending row exists (the other diver already
//     invited THIS submitter), auto-confirm: write
//     competitor_dive_lists for both sides, flip the pending row
//     to 'accepted', and return { pairing: { status: 'auto_confirmed', ... } }.
//   * Otherwise upsert a pending_partner_pairings row carrying
//     the proposed dives, fire a push notification at the
//     partner, and return { pairing: { status: 'pending', ... } }.
//     NO competitor_dive_lists rows are written for the requester
//     until the partner accepts, the partner's consent is the
//     gate.

const STATEMENT_DIVE_CONTENT_REF = "WA Article 6.5.1 (Statement of Dives contents)";
const STATEMENT_DIVE_HEIGHT_REF = "WA Article 6.5.1.3 (board/platform height)";
const STATEMENT_DIVE_DD_REF = "WA Article 6.5.1.4 (Degree of Difficulty)";

module.exports = async function submitDiveList({
  client,
  event,
  actor,
  competitorId,
  competitorOrgId,
  partnerId,
  dives,
  push,
  // Offline-resilience (DEC-04). When the outbox client submits
  // a list, actorLocalTime carries the wall-clock moment the
  // diver/coach actually tapped Submit. lateReview is the gate's
  // verdict: true means the submission arrived after the deadline
  // but actorLocalTime claims it was on time. Bit of a gotcha case,
  // so we record it AND flag the rows for referee adjudication.
  actorLocalTime = null,
  lateReview = false,
}) {
  if (!client) throw httpErr(500, "submitDiveList: client required");
  if (!event)  throw httpErr(400, "submitDiveList: event required");
  if (!competitorId) throw httpErr(400, "submitDiveList: competitor required");

  // Multi-federation entry gate. The event's host org is always
  // allowed; a sysadmin can act anywhere; otherwise the
  // competitor's org must be on the participating list.
  if (event.org_id !== competitorOrgId && !actor.is_system_admin) {
    const part = await client.query(
      `SELECT 1 FROM event_participating_orgs
        WHERE event_id = $1 AND org_id = $2`,
      [event.id, competitorOrgId],
    );
    if (!part.rows.length) {
      throw httpErr(403, "Your federation isn't on this event's participating list");
    }
  }
  const eventType = event.event_type || "individual";
  const totalRounds = Number(event.total_rounds) || null;

  // Sanity-check the dives array: must be a non-empty list of
  // {dive_id, round_number} with no duplicate rounds and round
  // numbers within range.
  if (!Array.isArray(dives) || !dives.length) {
    throw httpErr(400, "dives must be a non-empty array");
  }
  const seenRounds = new Set();
  for (const d of dives) {
    const rn = Number(d?.round_number);
    if (!Number.isInteger(rn) || rn < 1) {
      throw httpErr(400, "Each dive needs an integer round_number ≥ 1");
    }
    if (totalRounds && rn > totalRounds) {
      throw httpErr(400, `round_number ${rn} exceeds total_rounds ${totalRounds}`);
    }
    if (seenRounds.has(rn)) {
      throw httpErr(400, `Duplicate round_number ${rn}`);
    }
    seenRounds.add(rn);
    if (!d.dive_id) {
      throw httpErr(400, "Each dive needs a dive_id");
    }
  }

  // Validate every dive_id against the directory at the event's
  // height. Pulls dive_code + dd so the round-rules validator
  // can compute group + DD-sum below.
  const ids = dives.map(d => d.dive_id);
  const heightVal = event.height ? parseFloat(event.height) : null;
  const validIds = await client.query(
    `SELECT id, dive_code, dd, height FROM dive_directory
     WHERE id = ANY($1::uuid[])
       AND ($2::numeric IS NULL OR height = $2)`,
    [ids, heightVal],
  );
  const okMap = new Map(validIds.rows.map(r => [r.id, r]));
  for (const d of dives) {
    if (!okMap.has(d.dive_id)) {
      throw httpErr(400, `dive_id ${d.dive_id} is not in the dive directory at this event's height — ${STATEMENT_DIVE_HEIGHT_REF}`);
    }
  }

  // Prescribed round dives (migration 039).
  const prescribed = await client.query(
    `SELECT round_number, dive_id, height
       FROM event_round_dives
      WHERE event_id = $1`,
    [event.id],
  );
  if (prescribed.rows.length) {
    const byRound = new Map();
    for (const slot of prescribed.rows) byRound.set(slot.round_number, slot);
    const violations = [];
    for (const d of dives) {
      const slot = byRound.get(d.round_number);
      if (!slot) continue;
      if (slot.dive_id && slot.dive_id !== d.dive_id) {
        violations.push(`Round ${d.round_number} is operator-prescribed; submit the assigned dive only — ${STATEMENT_DIVE_CONTENT_REF}`);
        continue;
      }
      if (!slot.dive_id && slot.height != null) {
        const dir = okMap.get(d.dive_id);
        if (dir && Number(dir.height) !== Number(slot.height)) {
          violations.push(`Round ${d.round_number} requires a ${slot.height}m board dive — ${STATEMENT_DIVE_HEIGHT_REF}`);
        }
      }
    }
    if (violations.length) {
      const err = httpErr(400, `Dive list violates the event's prescribed dives — ${STATEMENT_DIVE_CONTENT_REF}`);
      err.violations = violations;
      throw err;
    }
  }

  // Round-rules validation (migration 038).
  if (event.round_rules) {
    const { validateDiveList } = require("./round-rules");
    const enriched = dives.map(d => {
      const dir = okMap.get(d.dive_id);
      return {
        round_number: d.round_number,
        dive_id:      d.dive_id,
        dive_code:    dir?.dive_code,
        dd:           dir?.dd,
      };
    });
    const check = validateDiveList(event.round_rules, enriched);
    if (!check.valid) {
      const err = httpErr(400, "Dive list violates the event's round rules");
      err.violations = check.errors;
      throw err;
    }
  } else if (event.dd_limit_value != null) {
    // Legacy flat DD cap (pre-round_rules events). When an event has
    // no round_rules JSON but carries the older dd_limit_rounds /
    // dd_limit_value pair, the sum of DDs across the first
    // `dd_limit_rounds` rounds must not exceed dd_limit_value. The
    // value was loaded by loadEventForEntries and advertised on the
    // program PDF, but was never enforced on submit, so any event
    // relying on the legacy cap accepted illegal voluntary sheets.
    // Yeah, kinda gross, but that's the bug this whole block closes.
    // Sum semantics + 0.001 tolerance match round-rules.js's
    // section dd_limit handling.
    const capRounds = Number(event.dd_limit_rounds) || 0;
    const cap = Number(event.dd_limit_value);
    if (Number.isFinite(cap) && capRounds > 0) {
      let sum = 0;
      for (const d of dives) {
        if (Number(d.round_number) <= capRounds) {
          const dd = Number(okMap.get(d.dive_id)?.dd);
          if (Number.isFinite(dd)) sum += dd;
        }
      }
      if (sum > cap + 0.001) {
        const err = httpErr(
          400,
          `Total DD ${sum.toFixed(1)} for the first ${capRounds} round${capRounds === 1 ? "" : "s"} exceeds the ${cap.toFixed(1)} limit — ${STATEMENT_DIVE_DD_REF}`,
        );
        err.violations = [`Voluntary DD limit: ${sum.toFixed(1)} > ${cap.toFixed(1)} — ${STATEMENT_DIVE_DD_REF}`];
        throw err;
      }
    }
  }

  // Synchro partner validation. Partner can come from any
  // federation that's been opted onto the event.
  let resolvedPartnerId = null;
  let partnerName       = null;
  if (eventType === "synchro_pair") {
    if (!partnerId || partnerId === competitorId) {
      throw httpErr(400, "A different partner is required for synchronised events");
    }
    const p = await client.query(
      `SELECT u.id, u.full_name FROM users u
       JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
       WHERE u.id = $1 AND u.org_id IN (
               SELECT org_id FROM events WHERE id = $2
               UNION
               SELECT org_id FROM event_participating_orgs WHERE event_id = $2
             )`,
      [partnerId, event.id],
    );
    if (!p.rows.length) {
      throw httpErr(400, "Partner must be a diver in a federation that's eligible to enter this event");
    }
    resolvedPartnerId = partnerId;
    partnerName       = p.rows[0].full_name;
  }

  // -----------------------------------------------------------------
  // SYNCHRO CONSENT GATE (migration 051)
  //
  // For synchro events the partner's consent is required before
  // either side appears in competitor_dive_lists. The submit path
  // forks here:
  //
  //   (a) Reciprocal pending row exists: the OTHER diver already
  //       invited this submitter. Auto-confirm: flip the row to
  //       'accepted' and write competitor_dive_lists for BOTH
  //       divers using the requester's stored proposal.
  //
  //   (b) No reciprocal row: upsert a pending row carrying THIS
  //       submitter's proposal, fire a push at the partner, and
  //       return early. No competitor_dive_lists writes happen.
  // -----------------------------------------------------------------
  if (eventType === "synchro_pair") {
    // (a) Reciprocal invite check. The partner is the requester
    //     in that row; we are the partner. If found, auto-confirm.
    const reciprocal = await client.query(
      `SELECT id, dives FROM pending_partner_pairings
        WHERE event_id     = $1
          AND requester_id = $2
          AND partner_id   = $3
          AND status       = 'pending'
        FOR UPDATE`,
      [event.id, resolvedPartnerId, competitorId],
    );

    if (reciprocal.rows.length) {
      const pairingId      = reciprocal.rows[0].id;
      const requesterDives = reciprocal.rows[0].dives || [];

      // Flip the pending row to accepted.
      await client.query(
        `UPDATE pending_partner_pairings
            SET status       = 'accepted',
                responded_at = NOW()
          WHERE id = $1`,
        [pairingId],
      );

      // Write competitor_dive_lists for BOTH divers using the
      // original requester's proposal. Synchro pairs perform
      // identical lists; the requester's dives are the canonical
      // pair list and the accepter inherits them.
      await writeSynchroBothSides(client, {
        eventId:     event.id,
        requesterId: resolvedPartnerId, // they invited
        partnerId:   competitorId,      // we accepted
        dives:       requesterDives,
      });

      // Notify the original requester that the pair is confirmed.
      if (push && typeof push.sendNotification === "function") {
        push.sendNotification([resolvedPartnerId], {
          category: "synchro.partner_invite",
          title: "Synchro partner confirmed",
          body: `${actor.full_name || "Your partner"} accepted the pairing for ${event.name || "the event"}`,
          data: { event_id: event.id, pairing_id: pairingId, kind: "accepted" },
        }).catch((err) => console.error("[synchro] push failed", err.message));
      }

      return {
        ok: true,
        pairing: {
          status:       "auto_confirmed",
          partner_id:   resolvedPartnerId,
          partner_name: partnerName,
        },
      };
    }

    // (b) No reciprocal invite: record a pending proposal and
    //     notify the partner. Re-submitting (e.g. diver edited
    //     their list before B responded) updates the same row's
    //     dives payload via the UNIQUE conflict.
    const payload = dives.map((d) => ({
      dive_id:      d.dive_id,
      round_number: Number(d.round_number),
    }));
    const upsert = await client.query(
      `INSERT INTO pending_partner_pairings
         (event_id, requester_id, partner_id, dives, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending')
       ON CONFLICT (event_id, requester_id, partner_id) DO UPDATE
         SET dives        = EXCLUDED.dives,
             status       = 'pending',
             created_at   = NOW(),
             responded_at = NULL
       RETURNING id`,
      [event.id, competitorId, resolvedPartnerId, JSON.stringify(payload)],
    );
    const pairingId = upsert.rows[0].id;

    if (push && typeof push.sendNotification === "function") {
      push.sendNotification([resolvedPartnerId], {
        category: "synchro.partner_invite",
        title: "Synchro pairing request",
        body: `${actor.full_name || "A diver"} wants to pair with you for ${event.name || "a synchro event"}`,
        data: { event_id: event.id, pairing_id: pairingId, kind: "invite" },
        action_url: "/competitor",
      }).catch((err) => console.error("[synchro] push failed", err.message));
    }

    return {
      ok: true,
      pairing: {
        status:       "pending",
        pairing_id:   pairingId,
        partner_name: partnerName,
      },
    };
  }

  // -----------------------------------------------------------------
  // INDIVIDUAL EVENT PATH: no partner consent required.
  // -----------------------------------------------------------------

  // Clear stale rounds. If a previous submission had R1..R6 and
  // the diver now submits R1..R5, R6 would linger as a ghost dive
  // in the operator's queue without this. We only delete rows
  // whose round_number isn't in the new array AND that aren't
  // already withdrawn, since withdrawn rows stay marked so the
  // audit trail and operator banner survive the resubmit.
  const newRounds = dives.map((d) => Number(d.round_number));
  await client.query(
    `DELETE FROM competitor_dive_lists
      WHERE event_id      = $1
        AND competitor_id = $2
        AND withdrawn_at  IS NULL
        AND round_number  <> ALL($3::int[])`,
    [event.id, competitorId, newRounds],
  );

  // UPSERT each dive row. Migration 041: confirmed_at stamps when
  // the diver (or their coach, with this change) actively
  // submited the list.
  for (const dive of dives) {
    // actor_local_time + late_arrival_flag flow through every
    // UPSERT. If lateReview is false the flag stays false (default
    // column value); the operator review tray's partial index
    // means non-late rows cost nothing to store.
    //
    // late_arrival_decision defaults to 'pending' on a late row so
    // the tray's WHERE clause finds it. If a row is re-submitted
    // (resubmit semantics above) and the new submission is on
    // time, the flag clears back to false and the decision back to
    // NULL so the tray drops the row.
    await client.query(
      `INSERT INTO competitor_dive_lists
          (competitor_id, partner_id, event_id, dive_id, round_number,
           confirmed_at, actor_local_time,
           late_arrival_flag, late_arrival_decision)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET
          dive_id              = EXCLUDED.dive_id,
          partner_id           = EXCLUDED.partner_id,
          confirmed_at         = NOW(),
          actor_local_time     = EXCLUDED.actor_local_time,
          late_arrival_flag    = EXCLUDED.late_arrival_flag,
          late_arrival_decision = EXCLUDED.late_arrival_decision`,
      [
        competitorId,
        resolvedPartnerId,
        event.id,
        dive.dive_id,
        dive.round_number,
        actorLocalTime,
        lateReview,
        lateReview ? 'pending' : null,
      ],
    );
  }

  return { ok: true, lateReview };
};

// Helper: insert competitor_dive_lists rows for both sides of a
// confirmed synchro pair. Used by the auto-confirm path here and
// by the accept endpoint in routes/competitor.js (re-exported).
//
// Idempotent: the underlying UPSERT keys on
// (event_id, competitor_id, round_number).
async function writeSynchroBothSides(client, { eventId, requesterId, partnerId, dives }) {
  if (!Array.isArray(dives) || !dives.length) {
    throw httpErr(400, "Pending pairing has no dives recorded — submit a fresh list");
  }
  const rounds = dives.map((d) => Number(d.round_number));

  // Clear stale non-withdrawn rows for BOTH divers, see the
  // individual path for the rationale on ghost rounds.
  await client.query(
    `DELETE FROM competitor_dive_lists
      WHERE event_id      = $1
        AND competitor_id = ANY($2::uuid[])
        AND withdrawn_at  IS NULL
        AND round_number  <> ALL($3::int[])`,
    [eventId, [requesterId, partnerId], rounds],
  );

  for (const dive of dives) {
    // Requester's row, partner_id points at the accepter.
    await client.query(
      `INSERT INTO competitor_dive_lists
          (competitor_id, partner_id, event_id, dive_id, round_number, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET
          dive_id      = EXCLUDED.dive_id,
          partner_id   = EXCLUDED.partner_id,
          confirmed_at = NOW()`,
      [requesterId, partnerId, eventId, dive.dive_id, Number(dive.round_number)],
    );
    // Mirror row for the partner, same dives but partner_id flipped.
    await client.query(
      `INSERT INTO competitor_dive_lists
          (competitor_id, partner_id, event_id, dive_id, round_number, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET
          dive_id      = EXCLUDED.dive_id,
          partner_id   = EXCLUDED.partner_id,
          confirmed_at = NOW()`,
      [partnerId, requesterId, eventId, dive.dive_id, Number(dive.round_number)],
    );
  }
}

module.exports.writeSynchroBothSides = writeSynchroBothSides;

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
