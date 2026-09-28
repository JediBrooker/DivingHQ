// Referee sign-off of the dive order, the attributed ways (the plain
// manager-attests POST /dive-order/sign-off stays in control-room.js):
//
//   GET  /api/events/:id/referees                        picker source
//   POST /api/events/:id/dive-order/sign-off/request     push to a referee
//   POST /api/events/:id/dive-order/sign-off/respond     referee's answer
//   POST /api/events/:id/dive-order/sign-off/credential  referee signs in
//                                                         on the manager's laptop
//   POST /api/events/:id/dive-order/sign-off/code        6-digit handoff code
//   POST /api/sign-off/code/verify                       referee types it in
//
// Mounted from routes/control-room.js, where these routes used to sit,
// with the operator gate and pre-meet check that file already builds:
//   router.use(require('./control-room-signoff')({ pool, push, bcrypt,
//     totp, requireOrgRole, ensureEventOrgGate, requireMeetController,
//     loadUpcomingEvent }))
//
// Moved out as is. The credential path is a password check, so its rate
// limiters and the push / bcrypt / totp 503 guards came across
// unchanged.

const express = require("express");
const rateLimit = require("express-rate-limit");
const QRCode  = require("qrcode");

// The referee a sign-off request or handoff code is aimed at has to
// exist, be in the event's org and actually hold the referee role, a
// meet manager shouldn't be able to "ask the diver" to sign off. Sends
// the 400 itself on a miss.
async function requireReferee(pool, res, refereeId, orgId) {
  const r = await pool.query(
    `SELECT u.id, u.full_name
       FROM users u
       JOIN user_org_roles r ON r.user_id = u.id
      WHERE u.id = $1 AND u.org_id = $2 AND r.role = 'referee'
      LIMIT 1`,
    [refereeId, orgId],
  );
  if (!r.rows.length) {
    res.status(400).json({ error: "Selected user is not a referee in this org" });
    return null;
  }
  return r.rows[0];
}

// A new request or code supersedes whatever was still pending for the
// event, so the manager's modal only ever tracks the latest one.
function expirePendingSignoffs(pool, eventId) {
  return pool.query(
    `UPDATE referee_signoff_requests
     SET status = 'expired', responded_at = now()
     WHERE event_id = $1 AND status = 'pending'`,
    [eventId],
  );
}

module.exports = function createSignoffRoutes({
  pool,
  // push, bcrypt and totp are optional: the endpoints that need them
  // answer 503 without them, same as before the move.
  push,
  bcrypt,
  totp,
  requireOrgRole,
  ensureEventOrgGate,
  // Built once in control-room.js and handed over, so these routes gate
  // exactly like the rest of the Control Room.
  requireMeetController,
  loadUpcomingEvent,
}) {
  if (!pool || !requireOrgRole || !ensureEventOrgGate || !requireMeetController || !loadUpcomingEvent) {
    throw new Error("createSignoffRoutes requires { pool, requireOrgRole, ensureEventOrgGate, requireMeetController, loadUpcomingEvent }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // CUT 2: REFEREE SIGN-OFF VIA PUSH + CREDENTIAL FALLBACK
  //
  // Three endpoints replace the simple POST /dive-order/sign-off:
  //
  //   GET  /events/:id/referees        : picker dropdown source
  //   POST /events/:id/sign-off/request    : manager picks ref;
  //          creates a request row + fires the push notification
  //   POST /events/:id/sign-off/respond    : referee taps Approve/Deny
  //          via the in-app banner; closes the loop
  //   POST /events/:id/sign-off/credential : fallback for when the
  //          referee can't get the push (no device registered,
  //          permissions denied). Referee enters their username +
  //          password (+ TOTP if enabled) on the manager's laptop;
  //          server verifies and stamps signed_off_by = referee.id
  //
  // The simple POST /dive-order/sign-off (manager pre-confirms
  // verbally, no attribution) stays in place as the lightest-
  // touch option. The new endpoints add proper attribution when
  // the meet calls for it.
  // -------------------------------------------------------------

  // GET /api/events/:id/referees: list referees in the event's
  // org so the manager modal has something to populate. Names +
  // ids only, no contact info, no role tuples.
  router.get("/api/events/:id/referees", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id
         WHERE u.org_id = (SELECT org_id FROM events WHERE id = $1)
           AND r.role = 'referee'
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Referees List Error]", err.message);
      res.status(500).json([]);
    }
  });

  // POST /api/events/:id/dive-order/sign-off/request
  //   Body: { referee_id }
  // Creates a referee_signoff_requests row + fires a notification
  // through the reusable push engine. Returns the request id so
  // the manager's modal can subscribe to its outcome.
  router.post("/api/events/:id/dive-order/sign-off/request",
              requireMeetController, async (req, res) => {
    if (!push) {
      return res.status(503).json({ error: "Push backend not configured" });
    }
    const eventId = req.params.id;
    const { referee_id } = req.body || {};
    if (!referee_id) return res.status(400).json({ error: "referee_id required" });
    try {
      const ev = await loadUpcomingEvent(pool, req, res, { verb: "request sign-off" });
      if (!ev) return;
      if (!(await requireReferee(pool, res, referee_id, ev.org_id))) return;
      await expirePendingSignoffs(pool, eventId);

      // Fetch the managers name now so we can put it in the
      // notification body without another join later.
      const managerQ = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [req.user.id],
      );
      const managerName = managerQ.rows[0]?.full_name || "A meet manager";

      // Insert request first (without notification_id) so we
      // have an id to include in the push payload. Notification
      // gets linked back via UPDATE below.
      const reqIns = await pool.query(
        `INSERT INTO referee_signoff_requests
           (event_id, requested_by, target_referee_id)
         VALUES ($1, $2, $3)
         RETURNING id, expires_at`,
        [eventId, req.user.id, referee_id],
      );
      const requestId = reqIns.rows[0].id;

      // Fire the notification: push (where subscribed) plus
      // socket emit (always). 5-min TTL matches the request row's
      // expires_at default.
      const result = await push.sendNotification([referee_id], {
        category: "referee_signoff",
        title: "Referee sign-off requested",
        body: `${managerName} asked you to approve the dive order for ${ev.name}.`,
        data: {
          event_id: eventId,
          event_name: ev.name,
          request_id: requestId,
          requested_by_name: managerName,
        },
        action_url: `/control?signoff_request=${requestId}`,
        actions: [
          { action: "approve", title: "Approve" },
          { action: "deny",    title: "Deny"    },
        ],
        ttl_seconds: 300,
      });

      const notificationId = result.notification_ids[0] || null;
      if (notificationId) {
        await pool.query(
          `UPDATE referee_signoff_requests
           SET notification_id = $1
           WHERE id = $2`,
          [notificationId, requestId],
        );
      }

      res.status(201).json({
        ok: true,
        request_id: requestId,
        expires_at: reqIns.rows[0].expires_at,
        dispatched: result.dispatched,
      });
    } catch (err) {
      console.error("[Sign-Off Request Error]", err.message);
      res.status(500).json({ error: "Failed to request sign-off" });
    }
  });

  // POST /api/events/:id/dive-order/sign-off/respond
  //   Body: { request_id, decision: 'approve' | 'deny' }
  // Referee's SPA hits this from the in-app banner Approve/Deny
  // buttons (or from a deep-linked /control?signoff_request=...).
  // Auth attributes the action to whoever's signed in, must
  // match referee_signoff_requests.target_referee_id.
  router.post("/api/events/:id/dive-order/sign-off/respond",
              requireMeetController, async (req, res) => {
    const { request_id, decision } = req.body || {};
    if (!request_id || !["approve", "deny"].includes(decision)) {
      return res.status(400).json({ error: "request_id + decision (approve|deny) required" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqQ = await client.query(
        `SELECT id, event_id, target_referee_id, status, expires_at
         FROM referee_signoff_requests
         WHERE id = $1 AND event_id = $2
         FOR UPDATE`,
        [request_id, req.params.id],
      );
      if (!reqQ.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }
      const reqRow = reqQ.rows[0];
      if (reqRow.target_referee_id !== req.user.id && !req.user.is_system_admin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Not the targeted referee for this request" });
      }
      if (reqRow.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: `Request already ${reqRow.status}`,
          status: reqRow.status,
        });
      }
      if (new Date(reqRow.expires_at) < new Date()) {
        await client.query(
          `UPDATE referee_signoff_requests
           SET status = 'expired', responded_at = now()
           WHERE id = $1`,
          [request_id],
        );
        await client.query("COMMIT");
        return res.status(409).json({ error: "Request expired" });
      }

      const newStatus = decision === "approve" ? "approved" : "declined";
      await client.query(
        `UPDATE referee_signoff_requests
         SET status = $1, decision_method = 'push', responded_at = now()
         WHERE id = $2`,
        [newStatus, request_id],
      );

      if (decision === "approve") {
        await client.query(
          `UPDATE events
           SET dive_order_signed_off_at = now(),
               dive_order_signed_off_by = $1
           WHERE id = $2`,
          [req.user.id, req.params.id],
        );
      }
      await client.query("COMMIT");

      // Notify the manager + anyone else watching the event so
      // their modal flips out of "waiting for referee" state.
      // Doesn't go through the push engine, no need to OS-notify
      // the manager since they're staring at the screen.
      if (push) {
        // Best-effort emit. We don't have a direct handle to the
        // manager's user_id here, but the SPA listens for any
        // referee_signoff_response on its event room.
        try {
          // event_id room is already joined by the Control Room
          // (existing subscribe_event call), so that's where we
          // emit.
          push.emitEvent?.(reqRow.event_id, "referee_signoff_response", {
            request_id, decision: newStatus, by_user_id: req.user.id,
          });
        } catch { /* silent */ }
      }
      res.json({ ok: true, status: newStatus });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Sign-Off Respond Error]", err.message);
      res.status(500).json({ error: "Failed to record response" });
    } finally {
      client.release();
    }
  });

  // POST /api/events/:id/dive-order/sign-off/credential
  //   Body: { username, password, code? }
  // Fallback path: meet manager hands the laptop to the referee.
  // Referee enters their own credentials (+ TOTP code if 2FA is
  // on). Server verifies, ensures they hold the referee role for
  // this event's org, and stamps signed_off_by = their user id.
  // The manager's session is untouched, no JWT swap.
  //
  // This is a password check reachable by anyone who runs an event,
  // and in a country with no federation that's anyone who founds a
  // club. So it's treated like a login form: throttled per IP and per
  // target username, and the account has to be a live, verified
  // referee in this event's org BEFORE bcrypt runs. Every way of
  // failing, wrong password or wrong person, gets the same 401, and
  // bcrypt runs exactly once either way so the timing doesn't split
  // them either. Only a real referee's correct password gets further
  // (to the TOTP prompt or the sign-off).
  const CREDENTIAL_FAIL = "Invalid referee username or password";
  const credentialLimitSkip = () => process.env.RATE_LIMIT_DISABLED === "true";
  // What counts as a miss. The "now your 2FA code" reply is a 401 too,
  // but it only comes back after the right password for a real referee,
  // so it isn't a guess. Counting it meant a referee with 2FA signing off
  // a morning's events on the manager's laptop locked themselves out by
  // the fifth.
  const credentialAttemptOk = (_req, res) => res.statusCode < 400 || res.locals.signoffNeedsTotp === true;
  const credentialIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    // Only failures count, so a venue signing off a dozen events from
    // one laptop never trips it.
    skipSuccessfulRequests: true,
    requestWasSuccessful: credentialAttemptOk,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many sign-off attempts, please try again in 15 minutes." },
    // Read per request, not at construction, so a test can switch it
    // back on for itself without restarting the server.
    skip: credentialLimitSkip,
  });
  // Keyed on the caller's org as well as the username. The lookup below
  // only ever matches a referee in the event's org, and outside the
  // sysadmin that's the caller's own org, so guesses from anywhere else
  // can't be right. Keyed on the username alone, a club founder on the
  // other side of the world could burn a federation referee's five tries
  // with junk against their own event and lock them out mid-meet.
  const credentialTargetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    requestWasSuccessful: credentialAttemptOk,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) =>
      `signoff-target:${req.user?.org_id || ""}:${String(req.body?.username || "").trim().toLowerCase()}`,
    message: { error: "Too many sign-off attempts for that referee, please try again in 15 minutes." },
    skip: credentialLimitSkip,
  });
  // Same cost factor as real hashes, so a miss takes as long as a hit.
  const FAKE_BCRYPT_HASH = "$2b$12$00000000000000000000000000000000000000000000000000000";

  router.post("/api/events/:id/dive-order/sign-off/credential",
              requireMeetController, credentialIpLimiter, credentialTargetLimiter,
              async (req, res) => {
    if (!bcrypt) {
      return res.status(503).json({ error: "Credential verifier not wired" });
    }
    const { username, password, code } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password
        || username.length > 100 || password.length > 1024) {
      return res.status(400).json({ error: "username + password required" });
    }
    try {
      const ev = await loadUpcomingEvent(pool, req, res);
      if (!ev) return;

      // Only a live, verified referee of this event's org can be the
      // answer. Anything else (no such user, another org, not a
      // referee, unverified, deleted, suspended) is decided here and
      // compared against the dummy hash instead of their real one.
      const u = await pool.query(
        `SELECT u.id, u.password, u.totp_enabled_at, u.totp_secret, u.totp_recovery_codes
           FROM users u
          WHERE u.username = $1 AND u.org_id = $2
            AND u.deleted_at IS NULL AND u.suspended_at IS NULL
            AND u.email_verified_at IS NOT NULL AND u.password IS NOT NULL
            AND EXISTS (SELECT 1 FROM user_org_roles r
                         WHERE r.user_id = u.id AND r.org_id = $2 AND r.role = 'referee')`,
        [username, ev.org_id],
      );
      const user = u.rows[0] || null;
      const passwordOk = await bcrypt.compare(password, user ? user.password : FAKE_BCRYPT_HASH);
      if (!user || !passwordOk) {
        return res.status(401).json({ error: CREDENTIAL_FAIL });
      }
      // TOTP if enabled.
      if (user.totp_enabled_at) {
        if (!totp) return res.status(503).json({ error: "TOTP verifier not wired" });
        if (!code) {
          res.locals.signoffNeedsTotp = true;
          return res.status(401).json({ error: "TOTP code required", needs_totp: true });
        }
        const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
        // Replay guard (migration 063), same shape as the main
        // login flow: consume the matched time-step via a
        // conditional UPDATE so a code observed during this
        // sign-off can't mint a second use within the ~90s
        // verify window.
        let accepted = false;
        if (looksLikeTotp) {
          const matchedStep = totp.verifyTokenDelta(user.totp_secret, code);
          if (matchedStep != null) {
            const consumed = await pool.query(
              `UPDATE users
               SET totp_last_used_step = $1
               WHERE id = $2
                 AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)
               RETURNING id`,
              [matchedStep, user.id],
            );
            accepted = consumed.rowCount > 0;
          }
        }
        // Single use even under a race, see spendRecoveryCode.
        if (!accepted) {
          accepted = await totp.spendRecoveryCode(pool, user.id, user.totp_recovery_codes, code);
        }
        if (!accepted) return res.status(401).json({ error: "Invalid TOTP code" });
      }

      // Stamp the sign-off in the event row + close any pending
      // push request for the same event (the referee just signed
      // in person, the push is moot).
      //
      // IMPORTANT: BEGIN/COMMIT must run on the same pooled
      // connection. Using `pool.query` here checks out a fresh
      // connection per call, so the BEGIN ran on a connection
      // that was returned to the pool before the UPDATEs ran on
      // (potentially different) ones, i.e. no transaction at
      // all. A failure between the two UPDATEs would leave the
      // event signed off but the referee_signoff_requests row
      // stuck "pending" forever.
      const txClient = await pool.connect();
      try {
        await txClient.query("BEGIN");
        await txClient.query(
          `UPDATE events
           SET dive_order_signed_off_at = now(),
               dive_order_signed_off_by = $1
           WHERE id = $2`,
          [user.id, req.params.id],
        );
        await txClient.query(
          `UPDATE referee_signoff_requests
           SET status = 'approved', decision_method = 'credential',
               responded_at = now()
           WHERE event_id = $1 AND status = 'pending'
             AND target_referee_id = $2`,
          [req.params.id, user.id],
        );
        await txClient.query("COMMIT");
      } catch (err) {
        await txClient.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        txClient.release();
      }

      res.json({
        ok: true,
        signed_off_by: { id: user.id, full_name: undefined /* not fetched */ },
      });
    } catch (err) {
      console.error("[Sign-Off Credential Error]", err.message);
      res.status(500).json({ error: "Sign-off failed" });
    }
  });

  // -------------------------------------------------------------
  // CUT 3: CODE HANDOFF
  //
  // The push and credential paths cover most setups, but they
  // both require something: push permission OR the referee
  // physically at the manager's laptop. Cut 3 plugs the gap: the
  // manager generates a 6-digit code on their screen; the
  // referee opens DivingHQ on their own already-signed-in
  // device, navigates to /sign-off-codes, types the code in.
  // Server matches code → pending request → stamps signed_off_by
  // = the referee whose session typed it.
  //
  //   POST /api/events/:id/dive-order/sign-off/code
  //     Body: { referee_id }
  //     Returns: { request_id, code, expires_at }
  //
  //   POST /api/sign-off/code/verify
  //     Body: { code }
  //     Auth: must be a referee. Looks up the pending request
  //     keyed on (target_referee_id = req.user.id, code), stamps
  //     the event's sign-off in the same txn.
  // -------------------------------------------------------------

  // 1-in-1,000,000 collision per code per referee, well below
  // any practical run rate. Cryptographically random rather than
  // Math.random so the codes aren't predictable from the prior
  // batch.
  function generateHandoffCode() {
    const buf = require("crypto").randomBytes(4);
    const n = buf.readUInt32BE(0) % 1_000_000;
    return n.toString().padStart(6, "0");
  }

  router.post("/api/events/:id/dive-order/sign-off/code",
              requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    const { referee_id } = req.body || {};
    if (!referee_id) return res.status(400).json({ error: "referee_id required" });
    try {
      const ev = await loadUpcomingEvent(pool, req, res, { verb: "generate code" });
      if (!ev) return;
      if (!(await requireReferee(pool, res, referee_id, ev.org_id))) return;
      await expirePendingSignoffs(pool, eventId);

      // Retry on the unique-pending-code-per-referee index race.
      // Three tries is plenty, the cardinality is 1e6 and the
      // partial index narrows to <1 active code per referee on
      // average.
      let attempts = 0;
      let inserted;
      while (attempts++ < 3 && !inserted) {
        const code = generateHandoffCode();
        try {
          inserted = await pool.query(
            `INSERT INTO referee_signoff_requests
               (event_id, requested_by, target_referee_id, handoff_code)
             VALUES ($1, $2, $3, $4)
             RETURNING id, expires_at, handoff_code`,
            [eventId, req.user.id, referee_id, code],
          );
        } catch (err) {
          if (err.code !== "23505") throw err;
          // Collision on (target_referee_id, handoff_code) WHERE
          // pending, just try again with a fresh code. Won't happen
          // in practice but the retry guards against the rare
          // case where two managers are both generating codes
          // for the same referee at the exact same instant.
        }
      }
      if (!inserted) {
        return res.status(503).json({ error: "Could not allocate a handoff code; try again" });
      }

      // QR encodes a deep link back into the SPA's referee-side
      // sign-off page with the code pre-filled. Server-side render
      // (qrcode → PNG data URL) keeps the SPA free of an extra
      // client lib and means the manager's tab doesn't need to do
      // canvas work mid-meet. Same auth path on the receiving end:
      // the referee scans, lands on /sign-off-codes?code=…, the
      // SPA auto-submits if they're already signed in OR bounces
      // through /login?next=… and back. The QR carries no secret
      // beyond what the typeable code already has, the verifier
      // still requires the referee's own JWT (target_referee_id =
      // req.user.id) so a leaked QR is useless to anyone but the
      // specific referee the manager picked.
      // APP_BASE_URL must be configured. Without it the previous
      // fallback used `req.get('host')`, a client-supplied header
      // that an attacker can spoof to point the QR at their own
      // domain (the referee would then type the code into the
      // attacker's site, which replays it to the real server).
      // Refusing to issue a code when the env is missing surfaces
      // the misconfiguration loudly instead of silently exposing
      // the open-redirect.
      const baseUrl = process.env.APP_BASE_URL;
      if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
        return res.status(503).json({
          error: "Sign-off codes are not available — APP_BASE_URL is not configured",
        });
      }
      const deepLink = `${baseUrl}/sign-off-codes?code=${encodeURIComponent(inserted.rows[0].handoff_code)}`;
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(deepLink, {
          // Slightly larger + higher error-correction than default
          // so a phone camera in a dim pool deck still resolves it.
          // 256×256 is plenty at the modal's render size; "M" is
          // 15% redundancy which tolerates a thumb-print on the
          // manager's screen.
          width: 256,
          margin: 1,
          errorCorrectionLevel: "M",
        });
      } catch (err) {
        // FYI, QR is just a UX nicety, falling back to the
        // typeable code alone keeps the modal functional if the
        // generator hits an edge case.
        console.error("[Sign-Off QR Generate Error]", err.message);
      }

      res.status(201).json({
        ok: true,
        request_id:   inserted.rows[0].id,
        code:         inserted.rows[0].handoff_code,
        expires_at:   inserted.rows[0].expires_at,
        qr_data_url:  qrDataUrl,
        deep_link:    deepLink,
      });
    } catch (err) {
      console.error("[Sign-Off Code Generate Error]", err.message);
      res.status(500).json({ error: "Failed to generate code" });
    }
  });

  // POST /api/sign-off/code/verify
  //   Body: { code }
  // Used by the referee on their own device (SignOffCodeView).
  // Looks up the pending request keyed on the caller's user_id,
  // stamps the event sign-off, fires the same socket broadcast
  // the push respond endpoint does so the manager modal flips.
  router.post("/api/sign-off/code/verify",
              requireOrgRole(["referee", "org_admin"]), async (req, res) => {
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Code must be 6 digits" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reqQ = await client.query(
        `SELECT id, event_id, expires_at, status
         FROM referee_signoff_requests
         WHERE target_referee_id = $1 AND handoff_code = $2
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [req.user.id, code],
      );
      if (!reqQ.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Code not recognised" });
      }
      const reqRow = reqQ.rows[0];
      if (reqRow.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `Code already ${reqRow.status}` });
      }
      if (new Date(reqRow.expires_at) < new Date()) {
        await client.query(
          `UPDATE referee_signoff_requests SET status='expired', responded_at=now() WHERE id=$1`,
          [reqRow.id],
        );
        await client.query("COMMIT");
        return res.status(409).json({ error: "Code expired" });
      }
      await client.query(
        `UPDATE referee_signoff_requests
         SET status='approved', decision_method='code', responded_at=now()
         WHERE id=$1`,
        [reqRow.id],
      );
      await client.query(
        `UPDATE events
         SET dive_order_signed_off_at = now(),
             dive_order_signed_off_by = $1
         WHERE id = $2`,
        [req.user.id, reqRow.event_id],
      );
      await client.query("COMMIT");

      // Broadcast so the manager's open Control Room flips out
      // of "waiting" state, same channel the push respond path
      // uses.
      try {
        push?.emitEvent?.(reqRow.event_id, "referee_signoff_response", {
          request_id: reqRow.id, decision: "approved", by_user_id: req.user.id,
        });
      } catch { /* silent */ }

      res.json({ ok: true, event_id: reqRow.event_id });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Sign-Off Code Verify Error]", err.message);
      res.status(500).json({ error: "Verification failed" });
    } finally {
      client.release();
    }
  });

  return router;
};
