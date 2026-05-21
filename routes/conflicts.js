// Conflict-pending resolution endpoint.
//
// Companion to the `conflict_pending` socket event emitted from
// routes/socket.js when two writes target the same row with
// different payloads (e.g., a judge submits 8.0 offline; the
// operator manually enters 8.5 while the judge is still offline;
// the judge reconnects and the outbox tries to land 8.0).
//
// In P1 this is a STUB. The conflict_pending event isn't fired
// from anywhere yet because OFFLINE_CONFLICT_RESOLUTION defaults
// to 'auto' (ON CONFLICT DO UPDATE / last-write-wins). The
// endpoint exists so:
//
//   * The client outbox's resolveConflict() can hit a real URL
//     instead of 404'ing if the flag is flipped mid-test.
//   * The Control Room conflict-review tray (P4 work) has a
//     stable contract to call.
//
// The actual resolution logic — write the chosen value, audit-log
// the loser, clear the conflict marker — lands in P4 alongside the
// schema for tracking pending conflicts (no table for it yet;
// they live in memory and on the outbox's `conflict_info`).
//
// Auth: referee, meet_manager, or org_admin (per DEC-05 in
// docs/offline-inventory.md). Sysadmin always passes via
// requireOrgRole.

const express = require("express");

module.exports = function createConflictsRouter({ pool, requireOrgRole }) {
  if (!pool) throw new Error("createConflictsRouter requires { pool, requireOrgRole }");
  const router = express.Router();

  // POST /api/conflicts/:conflict_id/resolve
  // body: { decision: 'accept_proposed' | 'keep_existing' | 'discard_both' }
  router.post(
    "/api/conflicts/:conflict_id/resolve",
    requireOrgRole(["referee", "meet_manager", "org_admin"]),
    async (req, res) => {
      const { conflict_id } = req.params;
      const decision = req.body?.decision;

      // UUID v4 validation for the conflict id. Keeps malformed
      // paths from hitting Postgres if the next phase tries a
      // direct lookup before validating.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conflict_id)) {
        return res.status(400).json({ error: "conflict_id must be a UUID v4" });
      }

      const validDecisions = ["accept_proposed", "keep_existing", "discard_both"];
      if (!validDecisions.includes(decision)) {
        return res.status(400).json({
          error: `decision must be one of ${validDecisions.join(", ")}`,
        });
      }

      // P1 stub. 501 makes the "not yet wired" semantics explicit
      // to any client that hits this prematurely. P4 will replace
      // the body with the actual write + audit log.
      console.log(
        `[conflicts] resolve stub hit: conflict_id=${conflict_id} ` +
          `decision=${decision} actor=${req.user?.id}`,
      );
      return res.status(501).json({
        error: "Conflict resolution not yet implemented",
        note: "P1 stub. Conflict-pending events do not fire in P1 " +
              "(OFFLINE_CONFLICT_RESOLUTION='auto'). P4 implements the " +
              "resolution + audit-log path.",
        conflict_id,
        decision,
      });
    },
  );

  return router;
};
