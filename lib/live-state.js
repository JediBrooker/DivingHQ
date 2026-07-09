// Live state shared between the socket engine and the HTTP
// event-status flip handler.
//
// Two pieces:
//   activeDivers  event_id → set_active_diver payload (current
//                 performer per event)
//   meetHolds     event_id → { reason, since } (hold-banner
//                 state per event)
//
// Persisted to the `event_live_state` table (migration 034) so a
// server restart doesn't leak the live meet's state. The in-memory
// maps below are a write-through cache:
//
//   * Reads stay synchronous against the maps (hot path is
//     "judge connects → bring them up to speed").
//   * Writes mutate the map AND fire-and-forget a query that
//     UPSERTs into event_live_state. Errors are logged, not
//     thrown: losing a write to the DB is recoverable, the
//     in-memory map is still consistent for the rest of the session.
//   * On boot, server.js calls init(pool); we SELECT the table
//     and re-populate the maps.
//
// IMPORTANT: this is still a single-instance design. Clustering
// across worker processes would split-brain the in-memory maps;
// the DB write-through doesn't fix that on its own (workers would
// race on the UPSERT and one would lose). Either move reads to
// the DB too (slower hot path) or stay single-instance, see
// ecosystem.config.js for the matching invariant.

const activeDivers = {};
const meetHolds = {};

// Per-event control LEASE: who is currently driving an event from a
// Control Room. event_id -> { socketId, userId }. Advisory (non-blocking):
// set_active_diver stays last-writer-wins so a crashed operator never
// locks an event, but this lets the socket layer warn a second operator
// (or a second window) that they're double-driving the same event.
// In-memory only (like activeDivers), it's transient session state,
// not persisted.
const eventControllers = {};

function getEventController(eventId) {
  return eventControllers[eventId] || null;
}
function setEventController(eventId, ctrl) {
  eventControllers[eventId] = ctrl;
}
// Drop every lease held by a socket (called on disconnect) so the events
// it controlled become free to claim again.
function clearEventControllersBySocket(socketId) {
  for (const eid of Object.keys(eventControllers)) {
    if (eventControllers[eid].socketId === socketId) delete eventControllers[eid];
  }
}

let pool = null;

/**
 * Wire up the persistence layer. Call once on server boot,
 * BEFORE socket handlers attach. Idempotent, re-calls just
 * re-rehydrate everything.
 *
 * @param {import('pg').Pool} poolInstance
 * @returns {Promise<void>}
 */
async function init(poolInstance) {
  pool = poolInstance;
  if (!pool) return;
  try {
    const r = await pool.query(
      `SELECT event_id, active_diver_payload, on_hold_reason, hold_since
       FROM event_live_state`,
    );
    let activeCount = 0, heldCount = 0;
    for (const row of r.rows) {
      if (row.active_diver_payload) {
        activeDivers[row.event_id] = row.active_diver_payload;
        activeCount++;
      }
      if (row.on_hold_reason) {
        meetHolds[row.event_id] = {
          reason: row.on_hold_reason,
          since:  row.hold_since,
        };
        heldCount++;
      }
    }
    if (activeCount || heldCount) {
      console.log(
        `[live-state] rehydrated ${activeCount} active diver(s), ${heldCount} hold(s)`,
      );
    }
  } catch (err) {
    console.error("[live-state] rehydrate failed:", err.message);
  }
}

// ---- Persistence helpers --------------------------------
// All fire-and-forget, errors get logged, not thrown. The in-
// memory map is the operational source of truth for the
// running process; the DB is the restart-survival source.

function persistActiveDiver(eventId, payload) {
  if (!pool || !eventId) return;
  pool.query(
    `INSERT INTO event_live_state (event_id, active_diver_payload, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (event_id) DO UPDATE
       SET active_diver_payload = EXCLUDED.active_diver_payload,
           updated_at = now()`,
    [eventId, payload != null ? JSON.stringify(payload) : null],
  ).catch((err) =>
    console.error("[live-state] persistActiveDiver:", err.message),
  );
}

function persistMeetHold(eventId, hold) {
  if (!pool || !eventId) return;
  pool.query(
    `INSERT INTO event_live_state (event_id, on_hold_reason, hold_since, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (event_id) DO UPDATE
       SET on_hold_reason = EXCLUDED.on_hold_reason,
           hold_since     = EXCLUDED.hold_since,
           updated_at     = now()`,
    [eventId, hold?.reason || null, hold?.since || null],
  ).catch((err) =>
    console.error("[live-state] persistMeetHold:", err.message),
  );
}

function persistClearActiveDiver(eventId) {
  if (!pool || !eventId) return;
  pool.query(
    `UPDATE event_live_state
     SET active_diver_payload = NULL, updated_at = now()
     WHERE event_id = $1`,
    [eventId],
  ).catch((err) =>
    console.error("[live-state] persistClearActiveDiver:", err.message),
  );
}

function persistClearMeetHold(eventId) {
  if (!pool || !eventId) return;
  pool.query(
    `UPDATE event_live_state
     SET on_hold_reason = NULL, hold_since = NULL, updated_at = now()
     WHERE event_id = $1`,
    [eventId],
  ).catch((err) =>
    console.error("[live-state] persistClearMeetHold:", err.message),
  );
}

function persistClearAll(eventId) {
  if (!pool || !eventId) return;
  pool.query(
    `DELETE FROM event_live_state WHERE event_id = $1`,
    [eventId],
  ).catch((err) =>
    console.error("[live-state] persistClearAll:", err.message),
  );
}

module.exports = {
  activeDivers,
  meetHolds,
  eventControllers,
  getEventController,
  setEventController,
  clearEventControllersBySocket,
  init,
  persistActiveDiver,
  persistMeetHold,
  persistClearActiveDiver,
  persistClearMeetHold,
  persistClearAll,
};
