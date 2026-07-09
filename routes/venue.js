// Venue integration routes.
//
//   GET /api/venue/scoreboard-state/:event_id
//     One-shot snapshot of the canonical venue scoreboard_state
//     payload. Same shape as the `venue.scoreboard_state` socket
//     event (see lib/venue-state.js). Useful for:
//       - Bridges that prefer HTTP polling over websockets
//       - Bridge boot: load initial state without waiting for the
//         next state-changing event
//       - Diagnostics / debugging from the operator's laptop
//
// Public: no auth gate. The same data already lives on /scoreboard/:id;
// venue bridges typically run inside the venue's own LAN, so exposing
// the payload here is intentional.
//
// Mount via:
//   app.use(require('./routes/venue')({ pool }))

const express = require("express");
const { buildScoreboardState } = require("../lib/venue-state");

module.exports = function createVenueRouter({ pool }) {
  if (!pool) throw new Error("createVenueRouter requires { pool }");
  const router = express.Router();

  // Load the in-memory live state at request time so the snapshot
  // reflects the current active diver + hold reason. lib/live-state
  // owns the cache, we just read from it without a DB hit.
  const liveState = require("../lib/live-state");

  router.get("/api/venue/scoreboard-state/:event_id", async (req, res) => {
    const { event_id } = req.params;
    try {
      const activePayload = liveState.activeDivers[event_id] || null;
      const onHoldReason  = liveState.meetHolds[event_id]?.reason || null;
      // HTTP snapshot is read-only, DO NOT advance the per-event
      // sequence counter here. The bridge boots off this HTTP fetch
      // then subscribes to socket emits; if this read bumped the
      // counter, the very next socket emit would land at sequence+2
      // instead of sequence+1, tripping the bridge's regression guard
      // into a phantom re-sync on every reconnect. Worth remembering
      // if you're ever tempted to unify the read paths.
      const state = await buildScoreboardState({
        pool, eventId: event_id, activePayload, onHoldReason,
        stamp: false,
      });
      if (!state) return res.status(404).json({ error: "Event not found" });
      res.json(state);
    } catch (err) {
      console.error("[Venue State Error]", err.message);
      res.status(500).json({ error: "Failed to build scoreboard state" });
    }
  });

  return router;
};
