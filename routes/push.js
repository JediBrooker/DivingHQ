// HTTP surface for the Web Push backend. Wraps lib/push.js with
// the auth, rate-limiting, and payload validation an external
// client (the SPA's service worker subscribe flow, the inbox
// poller) needs.
//
//   GET    /api/push/vapid-public-key       PUBLIC: SPA needs this
//                                            before it can subscribe
//   POST   /api/push/subscribe              AUTH:   register a sub
//   DELETE /api/push/subscribe              AUTH:   revoke a sub
//   GET    /api/notifications/me            AUTH:   inbox feed
//   POST   /api/notifications/:id/acknowledge AUTH: mark seen
//
// Mounted via:
//   app.use(require('./routes/push')({ verifyToken, push }))

const express = require("express");

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
  // GET /api/notifications/me?limit=20&since_id=<uuid>
  // SPA inbox: recent notifications for the signed-in user,
  // newest first. Excludes expired rows server-side. FYI, since_id
  // is optional, it's the pagination cursor for "load more".
  // -------------------------------------------------------------
  router.get("/api/notifications/me", verifyToken, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const sinceId = req.query.since_id || null;
    try {
      const rows = await push.listForUser(req.user.id, { limit, sinceId });
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
