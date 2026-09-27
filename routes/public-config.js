// routes/public-config.js, the handful of deployment settings the SPA needs
// before anyone has signed in.
//
//   GET /api/public-config   public, { support_email }
//
// Open for the same reason /api/features and /api/auth/signups-status are:
// the home, login and legal pages render for anonymous visitors, and a support
// address printed in a footer is not a secret. Keep it to values like that.
// Anything per-user or per-org belongs behind verifyToken somewhere else.

const express = require("express");
const { supportEmail } = require("../lib/support");

module.exports = function createPublicConfigRouter() {
  const router = express.Router();

  router.get("/api/public-config", (req, res) => {
    // Changes only when the operator edits .env and restarts, so let
    // browsers hang on to it for a few minutes.
    res.set("Cache-Control", "public, max-age=300");
    res.json({ support_email: supportEmail() });
  });

  return router;
};
