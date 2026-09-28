// HTTP surface for the Web Push backend. Wraps lib/push.js with
// the auth, rate-limiting, and payload validation an external
// client (the SPA's service worker subscribe flow, the inbox
// poller) needs.
//
//   GET    /api/push/vapid-public-key       PUBLIC: SPA needs this
//                                            before it can subscribe
//   POST   /api/push/subscribe              AUTH:   register a sub
//   DELETE /api/push/subscribe              AUTH:   revoke a sub
//   GET    /api/notifications/me            AUTH:   inbox feed (?limit, ?before_id)
//   POST   /api/notifications/:id/acknowledge AUTH: mark seen
//
// Mounted via:
//   app.use(require('./routes/push')({ verifyToken, push }))

const express = require("express");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = function createPushRouter({ verifyToken, push }) {
  if (!verifyToken || !push) {
    throw new Error("createPushRouter requires { verifyToken, push }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/push/vapid-public-key
  // Public, the SPA service worker calls this before it can ask
  // PushManager.subscribe(). Returns an empty string if VAPID
  // isn't configured so the client can detect "push not
  // available" without a 500.
  // -------------------------------------------------------------
  router.get("/api/push/vapid-public-key", (req, res) => {
    res.json({ key: push.vapidPublicKey(), enabled: push.pushEnabled });
  });

  // -------------------------------------------------------------
  // POST /api/push/subscribe
  //   Body: PushSubscription.toJSON(), i.e. { endpoint, keys: { p256dh, auth } }
  // Idempotent on endpoint UNIQUE, calling twice from the same
  // browser just updates the existing row.
  // -------------------------------------------------------------
  router.post("/api/push/subscribe", verifyToken, async (req, res) => {
    try {
      const userAgent = req.headers["user-agent"] || null;
      const result = await push.addSubscription(req.user.id, req.body, userAgent);
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      const status = err.status || 500;
      console.error("[push subscribe]", err.message);
      res.status(status).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // DELETE /api/push/subscribe
  //   Body: { endpoint }
  // Soft-delete via revoked_at so the row sticks around and old
  // notification audit pointers don't dangle.
  // -------------------------------------------------------------
  router.delete("/api/push/subscribe", verifyToken, async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    try {
      await push.removeSubscription(req.user.id, endpoint);
      res.json({ ok: true });
    } catch (err) {
      console.error("[push unsubscribe]", err.message);
      res.status(500).json({ error: "Failed to unsubscribe" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/notifications/me?limit=20&before_id=<uuid>
  // SPA inbox: recent notifications for the signed-in user,
  // newest first. Excludes expired rows server-side. before_id is the
  // optional "load more" cursor: pass the last id of the page you have.
  // since_id is the old name for it and still works.
  //
  // limit is clamped to 1..100: a negative one used to reach LIMIT -1 and
  // 500. A cursor that isn't a uuid is a 400 rather than a Postgres cast
  // error.
  // -------------------------------------------------------------
  router.get("/api/notifications/me", verifyToken, async (req, res) => {
    const n = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 20;
    const beforeId = req.query.before_id || req.query.since_id || null;
    if (beforeId && (typeof beforeId !== "string" || !UUID_RE.test(beforeId))) {
      return res.status(400).json({ error: "before_id must be a notification id" });
    }
    try {
      const rows = await push.listForUser(req.user.id, { limit, beforeId });
      res.json(rows);
    } catch (err) {
      console.error("[notifications list]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // POST /api/notifications/:id/acknowledge
  // Marks the row 'acknowledged'. Idempotent. The service worker
  // also fires this from the notificationclick handler so tapping
  // a system notification clears it from the inbox.
  // -------------------------------------------------------------
  router.post("/api/notifications/:id/acknowledge", verifyToken, async (req, res) => {
    try {
      const ok = await push.acknowledgeNotification(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: "Notification not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[notifications ack]", err.message);
      res.status(500).json({ error: "Failed to acknowledge" });
    }
  });

  return router;
};
