// routes/features.js, read + toggle the runtime feature flags.
//
//   GET /api/features          public,   { payments: false, classes: false }
//   GET /api/features/admin    sysadmin, adds label/description/who/when
//   PUT /api/features/:key     sysadmin, { enabled: boolean }
//
// The public GET is deliberately open. It mirrors /api/auth/signups-status:
// the router guard and the nav both need to know which areas exist before
// there's a session to speak of, and "does this deployment sell things"
// is not a secret worth an auth round-trip.
//
// Toggling is sysadmin only, never org_admin. These flags are global, so a
// federation admin flipping payments on would be flipping it on for every
// other federation on the box too.

const express = require("express");

module.exports = function createFeaturesRouter({ features, verifyToken, requireSystemAdmin, logger }) {
  if (!features) throw new Error("createFeaturesRouter requires { features, … }");
  const router = express.Router();
  const log = logger || { warn: () => {}, error: () => {} };

  router.get("/api/features", (req, res) => {
    res.json(features.all());
  });

  router.get("/api/features/admin", verifyToken, requireSystemAdmin, async (req, res) => {
    try {
      res.json({ features: await features.list() });
    } catch (err) {
      log.error({ err: err.message }, "[features] admin list failed");
      res.status(500).json({ error: "Could not load feature flags." });
    }
  });

  router.put("/api/features/:key", verifyToken, requireSystemAdmin, async (req, res) => {
    const { key } = req.params;
    if (!features.KEYS.includes(key)) {
      return res.status(404).json({ error: `Unknown feature: ${key}` });
    }
    // Strict boolean. A missing or stringy `enabled` is a client bug, and
    // coercing "false" to true would switch payments on by accident, which
    // is the single worst way to find out your parser is loose.
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "Body must be { enabled: true | false }." });
    }
    try {
      const enabled = await features.set(key, req.body.enabled, {
        actorId: req.user.id,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      res.json({ key, enabled });
    } catch (err) {
      log.error({ err: err.message, key }, "[features] toggle failed");
      res.status(500).json({ error: "Could not update the feature flag." });
    }
  });

  return router;
};
