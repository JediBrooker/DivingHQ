// Claims API (migration 089, lib/claims.js has the rules).
//
//   GET  /api/claims               claims this user can see: their own,
//                                  ones they vote on or decide, all for
//                                  the sysadmin
//   POST /api/claims/:id/vote      { vote: 'approve'|'object', reason?, voter_id? }
//   POST /api/claims/:id/decide    { decision: 'approve'|'reject', reason? }
//   POST /api/claims/:id/revoke    sysadmin, { reason? }
//
//   GET  /api/admin/settings       sysadmin, the claim-vote knobs
//   PUT  /api/admin/settings/:key  sysadmin, { value }
//
// Opening a claim happens in POST /api/auth/register-org, which is where
// a federation or state body arrives.

const express = require("express");
const claims = require("../lib/claims");
const settingsLib = require("../lib/platform-settings");
const { recordAudit, auditFromReq } = require("../lib/audit");

module.exports = function createClaimsRouter({ pool, push, email, verifyToken, requireSystemAdmin, bumpTokenVersion }) {
  if (!pool || !verifyToken) throw new Error("createClaimsRouter requires { pool, verifyToken }");
  const router = express.Router();
  // email: lib/email, for the claim notices (sendClaimEmail).
  const deps = { push, email, bumpTokenVersion };

  function fail(res, err, label) {
    if (err instanceof claims.ClaimError) {
      return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    console.error(`[${label}]`, err.message);
    return res.status(500).json({ error: "Internal server error" });
  }

  router.get("/api/claims", verifyToken, async (req, res) => {
    try {
      res.json(await claims.listForUser(pool, req.user));
    } catch (err) {
      fail(res, err, "Claims List Error");
    }
  });

  router.post("/api/claims/:id/vote", verifyToken, async (req, res) => {
    try {
      const status = await claims.castVote(pool, {
        claimId: req.params.id, user: req.user,
        vote: req.body?.vote, reason: req.body?.reason, voterId: req.body?.voter_id,
      }, deps);
      res.json({ ok: true, status });
    } catch (err) {
      fail(res, err, "Claim Vote Error");
    }
  });

  router.post("/api/claims/:id/decide", verifyToken, async (req, res) => {
    try {
      await claims.decide(pool, {
        claimId: req.params.id, user: req.user, decision: req.body?.decision, reason: req.body?.reason,
      }, deps);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Claim Decide Error");
    }
  });

  router.post("/api/claims/:id/revoke", verifyToken, async (req, res) => {
    try {
      await claims.revoke(pool, { claimId: req.params.id, user: req.user, reason: req.body?.reason }, deps);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Claim Revoke Error");
    }
  });

  router.get("/api/admin/settings", verifyToken, requireSystemAdmin, async (_req, res) => {
    try {
      res.json(await settingsLib.describeAll(pool));
    } catch (err) {
      fail(res, err, "Settings List Error");
    }
  });

  router.put("/api/admin/settings/:key", verifyToken, requireSystemAdmin, async (req, res) => {
    try {
      const value = await settingsLib.set(pool, req.params.key, req.body?.value, req.user.id);
      await recordAudit(pool, {
        ...auditFromReq(req),
        entity_type: "setting", entity_name: req.params.key,
        action: "setting.changed", metadata: { value },
      });
      res.json({ key: req.params.key, value });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      fail(res, err, "Settings Update Error");
    }
  });

  return router;
};
