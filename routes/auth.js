// Auth routes — extracted from the single-file server.js as the
// first slice of an incremental modularisation. This module
// exports a factory that takes the wiring it needs (pool,
// mailer-backed email helpers, jwt config, middleware) and
// returns an Express router.
//
// Mounted at the app root in server.js as:
//     app.use(require('./routes/auth')({ ... }))
//
// Every route here was moved verbatim — no behaviour changes.

const express = require("express");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const crypto  = require("node:crypto");
const totp    = require("../lib/totp");
const { SESSION_COOKIE, cookieOptions } = require("../lib/session-cookie");

// Plant the JWT in the httpOnly session cookie. This is the SPA's
// session of record — browser JS can neither read nor exfiltrate it.
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

// Decide whether to include the bearer token in a JSON auth response.
// The SPA authenticates via the httpOnly session cookie and ignores any
// body token, so we omit it from BROWSER requests — that way XSS active
// during login / token refresh can't read the token from the response
// body and replay it off-origin (defeating one goal of the cookie
// migration). Non-browser API clients (the e2e harness, integration
// tests, programmatic Bearer clients) don't send Fetch-Metadata
// headers, so they still receive the token. Browsers always attach
// Sec-Fetch-* to fetch/XHR and JS cannot forge or strip it (it's a
// forbidden header), so its presence is a reliable "this is a browser"
// signal; absence safely falls back to the legacy token-in-body shape.
function includeBodyToken(req) {
  return !req.get("sec-fetch-site");
}

// Pre-computed dummy bcrypt hash used by the login flow to keep
// the timing constant when the username doesn't exist. Without
// this, an attacker can enumerate usernames by measuring the
// response delay (no-user ≈ 5ms, bad-password ≈ 150ms). Computed
// once at module load — same cost factor (12) bcrypt.hash() uses
// for real passwords.
//
// The plaintext "*" is never a valid password; bcrypt.compare
// against this hash always returns false. We just want the
// CPU-time profile of a real comparison.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  // Long unguessable nonsense so that even if an attacker tried
  // this exact string they couldn't authenticate.
  Math.random().toString(36) + Date.now() + Math.random().toString(36),
  12,
);

// Centralised password policy — applied to every set-password
// path (register, register-org, password change, password reset).
// Returns null on success, or a user-facing error string.
//
// Policy:
//   * minimum 12 characters (NIST SP 800-63B's lower bound for
//     memorised secrets without complexity rules; the longer
//     floor more than compensates for not requiring symbols).
//   * must contain at least one letter AND one digit, to block
//     the most trivially weak choices (all-digits PINs, single
//     dictionary words).
//
// Deliberately NOT enforced here: symbol classes, max length,
// breached-password lookups. Those are the next two upgrades —
// zxcvbn or HIBP k-anonymity — and can layer on top without
// changing this signature.
function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 12) {
    return "Password must be at least 12 characters";
  }
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Password must contain at least one letter and one digit";
  }
  return null;
}

module.exports = function createAuthRouter({
  pool,
  io,
  authLimiter,
  verifyToken,
  optionalAuth,
  buildTokenPayload,
  hashFingerprint,
  sendWelcomeEmail,
  sendVerifyEmailEmail,
  sendNewRoleRequestEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendEmailChangeVerify,
  sendEmailChangedNotice,
  bumpTokenVersion,
  JWT_SECRET,
  JWT_EXPIRY,
}) {
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/auth/me — rehydrate the signed-in identity from the
  // httpOnly session cookie. The SPA calls this on boot because the
  // JWT now lives in a cookie its JS can't read/decode. Returns the
  // same user payload shape the login response carries. 401 when
  // anonymous (no / expired / revoked cookie) — a normal first-visit
  // state, not an error.
  // -------------------------------------------------------------
  router.get("/api/auth/me", optionalAuth, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    try {
      // Rebuild from the DB so a role/locale change since the cookie
      // was minted is reflected without forcing a re-login.
      const payload = await buildTokenPayload(req.user.id);
      res.json({ user: payload });
    } catch (err) {
      console.error("[Auth Me Error]", err.message);
      res.status(500).json({ error: "Failed to load session" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/auth/logout — clear the session cookie. JS can't delete
  // an httpOnly cookie, so sign-out has to round-trip the server. We
  // deliberately don't bump token_version (that would sign the user
  // out on every device); clearing the cookie + the JWT's own exp
  // bound this session. No auth gate — clearing a cookie is harmless.
  // -------------------------------------------------------------
  router.post("/api/auth/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.json({ ok: true });
  });

  router.post("/api/auth/login", authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // Reject malformed bodies up front so bcrypt.compare never sees
    // a non-string and throws — that was leaking 500 vs 401, which
    // a probing attacker could use to distinguish "user exists".
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    try {
      // Pull only the columns we need. Defence in depth: a future
      // change that responds with the row directly can't leak the
      // password hash if it was never selected.
      const result = await pool.query(
        "SELECT id, password, email_verified_at, totp_enabled_at, deleted_at, suspended_at FROM users WHERE username = $1",
        [username],
      );
      const user = result.rows[0];
      // Always run bcrypt.compare — against the user's hash if we
      // found them, against a dummy hash otherwise — so the
      // response time is the same in both branches. Stops timing-
      // based username enumeration.
      //
      // Migration 053: a deleted user has password = NULL; the
      // dummy-hash fallback fires and the compare returns false,
      // so the deleted account collapses into the same generic
      // "Invalid username or password" response as wrong-password
      // and missing-user. We never reveal "account was deleted".
      const hashToCheck = (user && !user.deleted_at) ? user.password : DUMMY_BCRYPT_HASH;
      const passwordOk = await bcrypt.compare(password, hashToCheck || DUMMY_BCRYPT_HASH);
      if (!user || user.deleted_at != null || !passwordOk)
        return res.status(401).json({ error: "Invalid username or password" });

      // Migration 058: an org admin can suspend an account. With a
      // correct password but a suspended flag, return a clear,
      // distinct message (the legitimate owner knows the password,
      // so this leaks nothing useful to an attacker).
      if (user.suspended_at != null) {
        return res.status(403).json({
          error: "Your account has been suspended. Contact your federation administrator.",
          code: "account_suspended",
        });
      }

      // Migration 021: registrations must verify their email
      // before they can sign in. Existing users were grandfathered
      // (backfilled to created_at) so this only blocks accounts
      // created after the deploy that haven't clicked the link.
      if (user.email_verified_at == null) {
        return res.status(403).json({
          error: "Please verify your email — check your inbox for the link we sent at sign-up.",
          code: "email_not_verified",
        });
      }

      // Migration 022: if 2FA is enabled, the password check is
      // only the first factor. Mint a short-lived "step-up" token
      // scoped to the second-factor exchange and hand it back —
      // the client posts it with a TOTP / recovery code to
      // /api/auth/login/totp to get a real session JWT.
      if (user.totp_enabled_at != null) {
        const totp_token = jwt.sign(
          { sub: user.id, type: "totp_pending" },
          JWT_SECRET,
          { expiresIn: "5m" },
        );
        return res.json({ needs_totp: true, totp_token });
      }

      const payload = await buildTokenPayload(user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      setSessionCookie(res, token);
      const resBody = { user: payload, ...payload };
      if (includeBodyToken(req)) resBody.token = token;
      res.json(resBody);
    } catch (err) {
      console.error("[Login Error]", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/auth/login/totp — second-factor exchange.
  //
  // Body: { totp_token, code }
  //   totp_token: the 5-min JWT minted by /api/auth/login above.
  //   code:       6-digit TOTP from the authenticator app, OR a
  //               10-char recovery code (with or without dash).
  //
  // Returns the same shape as /api/auth/login on success: { token,
  // ...payload }. Recovery codes are one-time — on success the
  // matched hash is removed from the user's stored array.
  // -------------------------------------------------------------
  router.post("/api/auth/login/totp", authLimiter, async (req, res) => {
    const { totp_token, code } = req.body || {};
    if (!totp_token || !code) {
      return res.status(400).json({ error: "totp_token and code are required" });
    }
    let decoded;
    try {
      decoded = jwt.verify(totp_token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ error: "TOTP step-up token is invalid or expired" });
    }
    if (decoded.type !== "totp_pending" || !decoded.sub) {
      return res.status(401).json({ error: "TOTP step-up token is invalid" });
    }
    try {
      const u = await pool.query(
        `SELECT id, totp_secret, totp_enabled_at, totp_recovery_codes
         FROM users WHERE id = $1`,
        [decoded.sub],
      );
      const user = u.rows[0];
      if (!user || user.totp_enabled_at == null) {
        return res.status(401).json({ error: "TOTP not enabled for this user" });
      }

      // Try TOTP first (six digits). Fall back to recovery code
      // matching only when the input doesn't look like a code.
      const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
      let accepted = false;
      let consumedRecovery = false;
      if (looksLikeTotp) {
        // Replay guard (migration 063): the ±1-step verify window
        // keeps a code valid for ~90s, so a just-consumed code
        // could otherwise mint a second session. verifyTokenDelta
        // returns the absolute time-step the code matched; the
        // conditional UPDATE below persists it and only succeeds
        // when it's strictly newer than the stored last-used step
        // — a replay (or a concurrent presentation of the same
        // code) loses the race and is rejected like any bad code.
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
      if (!accepted) {
        const { matched, remainingHashes } = await totp.consumeRecoveryCode(
          user.totp_recovery_codes || [],
          code,
        );
        if (matched) {
          accepted = true;
          consumedRecovery = true;
          await pool.query(
            "UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2",
            [JSON.stringify(remainingHashes), user.id],
          );
        }
      }
      if (!accepted) {
        return res.status(401).json({ error: "Invalid TOTP / recovery code" });
      }

      const payload = await buildTokenPayload(user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      setSessionCookie(res, token);
      const resBody = {
        user: payload,
        ...payload,
        ...(consumedRecovery
          ? { warning: "Recovery code consumed. Re-generate your recovery codes when convenient." }
          : {}),
      };
      if (includeBodyToken(req)) resBody.token = token;
      res.json(resBody);
    } catch (err) {
      console.error("[Login TOTP Error]", err.message);
      res.status(500).json({ error: "TOTP login failed" });
    }
  });

  // -------------------------------------------------------------
  // 2FA enable / disable / regenerate-recovery flow
  //
  // Three endpoints, all behind verifyToken:
  //
  //   POST /api/auth/2fa/setup   — mints a fresh secret, returns
  //                                 the QR + base32 + provisional
  //                                 recovery codes. Saves the secret
  //                                 to users.totp_secret but DOES
  //                                 NOT enable 2FA yet (totp_enabled_at
  //                                 stays NULL). User must verify a
  //                                 code via /confirm before login is
  //                                 gated.
  //
  //   POST /api/auth/2fa/confirm — { code }. Verifies a TOTP code
  //                                 against the pending secret and
  //                                 stamps totp_enabled_at + saves
  //                                 the recovery code hashes from
  //                                 the setup response. Bumps
  //                                 token_version to invalidate
  //                                 every existing session for this
  //                                 user (Migration 021 plumbing).
  //
  //   POST /api/auth/2fa/disable — { password, code? }. Requires
  //                                 the password (proof of access)
  //                                 + a current TOTP / recovery code.
  //                                 Clears every totp_* column.
  //
  //   GET  /api/auth/2fa/status  — { enabled: bool, recovery_codes_remaining: int|null }.
  //                                 Lets the SPA's Profile page show
  //                                 the right Enable/Disable affordance
  //                                 without trying setup first.
  // -------------------------------------------------------------
  router.get("/api/auth/2fa/status", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT totp_enabled_at,
                jsonb_array_length(COALESCE(totp_recovery_codes, '[]'::jsonb)) AS rc
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const row = r.rows[0] || {};
      res.json({
        enabled: !!row.totp_enabled_at,
        recovery_codes_remaining: row.totp_enabled_at ? Number(row.rc) || 0 : null,
      });
    } catch (err) {
      console.error("[2FA Status Error]", err.message);
      res.status(500).json({ error: "Couldn't load 2FA status" });
    }
  });

  router.post("/api/auth/2fa/setup", verifyToken, async (req, res) => {
    try {
      const u = await pool.query(
        "SELECT username, totp_enabled_at FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.totp_enabled_at != null) {
        return res.status(409).json({
          error: "2FA is already enabled. Disable it first if you want to re-set it up.",
        });
      }
      const { base32, otpauth_url, qr_data_url } = await totp.generateSecret(user.username);
      // generateRecoveryCodes is async (10 bcrypt hashes ≈ 1s of
      // CPU — hashing off the event loop keeps concurrent
      // requests, including live scoring, unaffected).
      const { plain, hashes } = await totp.generateRecoveryCodes(10);
      // Save the secret + provisional recovery hashes. We DON'T
      // set totp_enabled_at — until the user verifies a code via
      // /confirm, login still bypasses 2FA. This means a half-
      // finished setup (browser tab closed at the QR screen)
      // doesn't lock the user out. totp_last_used_step resets
      // with the secret — the replay guard's bookkeeping belongs
      // to the old secret (migration 063).
      await pool.query(
        `UPDATE users
         SET totp_secret = $1,
             totp_recovery_codes = $2::jsonb,
             totp_enabled_at = NULL,
             totp_last_used_step = NULL
         WHERE id = $3`,
        [base32, JSON.stringify(hashes), req.user.id],
      );
      res.json({
        base32,
        otpauth_url,
        qr_data_url,
        recovery_codes: plain,    // shown ONCE; re-generated via /confirm if lost
      });
    } catch (err) {
      console.error("[2FA Setup Error]", err.message);
      res.status(500).json({ error: "Couldn't start 2FA setup" });
    }
  });

  router.post("/api/auth/2fa/confirm", authLimiter, verifyToken, async (req, res) => {
    const { code } = req.body || {};
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "code must be the 6-digit TOTP from your authenticator" });
    }
    try {
      const u = await pool.query(
        "SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user || !user.totp_secret) {
        return res.status(400).json({ error: "Run /api/auth/2fa/setup first" });
      }
      if (user.totp_enabled_at != null) {
        return res.status(409).json({ error: "2FA already enabled" });
      }
      const matchedStep = totp.verifyTokenDelta(user.totp_secret, code);
      if (matchedStep == null) {
        return res.status(401).json({ error: "Code didn't verify against the new secret. Check your authenticator clock and try again." });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Record the consumed step alongside the enable stamp so
        // the very first login can't replay the confirm code
        // within its ~90s verify window (migration 063). GREATEST
        // guards the (unlikely) case of an older value surviving
        // — the step only ever moves forward.
        await client.query(
          `UPDATE users
           SET totp_enabled_at = now(),
               totp_last_used_step = GREATEST(COALESCE(totp_last_used_step, 0), $2)
           WHERE id = $1`,
          [req.user.id, matchedStep],
        );
        // Bump token_version so every device this user is signed
        // in on is forced through the new 2FA flow on next request.
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client, req.user.id);
        }
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      res.json({ ok: true, message: "2FA enabled. You'll be asked for a code on your next login." });
    } catch (err) {
      console.error("[2FA Confirm Error]", err.message);
      res.status(500).json({ error: "Couldn't confirm 2FA" });
    }
  });

  router.post("/api/auth/2fa/disable", authLimiter, verifyToken, async (req, res) => {
    const { password, code } = req.body || {};
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password is required to disable 2FA" });
    }
    try {
      const u = await pool.query(
        `SELECT password, totp_secret, totp_enabled_at, totp_recovery_codes
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.totp_enabled_at == null) {
        return res.status(409).json({ error: "2FA isn't enabled" });
      }
      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        return res.status(401).json({ error: "Password is incorrect" });
      }
      // Require a TOTP or recovery code as proof of authenticator
      // access. Without this, anyone with a hijacked session +
      // password could disable the second factor.
      const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
      let codeOk = false;
      if (looksLikeTotp) {
        // Same single-use guard as the login exchange (migration
        // 063): a code that already minted a session can't be
        // replayed to tear the second factor down.
        const matchedStep = totp.verifyTokenDelta(user.totp_secret, code);
        if (matchedStep != null) {
          const consumed = await pool.query(
            `UPDATE users
             SET totp_last_used_step = $1
             WHERE id = $2
               AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)
             RETURNING id`,
            [matchedStep, req.user.id],
          );
          codeOk = consumed.rowCount > 0;
        }
      } else {
        const { matched } = await totp.consumeRecoveryCode(
          user.totp_recovery_codes || [],
          code || "",
        );
        codeOk = matched;
      }
      if (!codeOk) {
        return res.status(401).json({
          error: "Provide a current 6-digit TOTP or a recovery code to disable 2FA",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE users
           SET totp_secret = NULL,
               totp_enabled_at = NULL,
               totp_recovery_codes = NULL,
               totp_last_used_step = NULL
           WHERE id = $1`,
          [req.user.id],
        );
        // Bump token_version: a session with the disabled 2FA flag
        // baked in is no different from one without, but bumping
        // is the consistent posture after every privilege change.
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client, req.user.id);
        }
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      res.json({ ok: true, message: "2FA disabled. Re-enable from your account settings any time." });
    } catch (err) {
      console.error("[2FA Disable Error]", err.message);
      res.status(500).json({ error: "Couldn't disable 2FA" });
    }
  });

  // Strip control chars + cap length on free-text user input. Used
  // on full_name + new_club_name during registration so a malicious
  // user can't smuggle CR/LF (header/email-body injection) or
  // multi-megabyte payloads through the form.
  function safeText(input, maxLen = 100) {
    if (typeof input !== "string") return null;
    // Strip all control chars (incl. CR, LF, tab, BOM) and trim.
    const cleaned = input.replace(/[\x00-\x1f\x7f​-‏﻿]/g, "").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, maxLen);
  }

  // Self-register as a user within an existing org. Email
  // verification (Migration 021) is now mandatory: the user is
  // created with email_verified_at = NULL and login is blocked
  // until they click the link in the verification email.
  // Public account creation (self-register + found-an-org) is OFF by default
  // so the live site is "coming soon" until we're ready to open it; set
  // SIGNUPS_ENABLED=true to turn it on (the test env does). Login and every
  // existing-account flow (password reset, email change, 2FA) are NEVER gated
  // — the super admin must always be able to sign in.
  router.get("/api/auth/signups-status", (req, res) => {
    res.json({ enabled: process.env.SIGNUPS_ENABLED === "true" });
  });

  router.post("/api/auth/register", authLimiter, async (req, res) => {
    if (process.env.SIGNUPS_ENABLED !== "true") {
      return res.status(403).json({ error: "Account creation is coming soon.", code: "signups_disabled" });
    }
    const {
      username, password, email, org_id, requested_role, note,
      club_id, new_club_name, new_club_short_code,
    } = req.body || {};

    const fullName = safeText(req.body?.full_name, 100);
    const cleanClubName = safeText(new_club_name, 80);
    // Username cap mirrors users.username = varchar(50) in init.sql.
    // Charset is intentionally narrow — username surfaces in audit
    // logs, exports, and push notifications, and an unconstrained
    // string would let a registrant smuggle CR/LF or HTML through
    // those secondary channels.
    const cleanUsername = safeText(username, 50);
    if (!cleanUsername) {
      return res.status(400).json({ error: "Username is required" });
    }
    if (!/^[a-zA-Z0-9._-]{2,50}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Username must be 2–50 characters of letters, digits, dot, underscore, or hyphen",
      });
    }
    if (!fullName) {
      return res.status(400).json({ error: "Full name is required" });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required for verification" });
    }

    const client = await pool.connect();
    let newUserId = null;
    let requestedRoleSaved = null;
    try {
      await client.query("BEGIN");

      const org = await client.query(
        "SELECT id FROM organisations WHERE id = $1 AND status = 'active'",
        [org_id],
      );
      if (!org.rows.length) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Organisation not found or not yet active" });
      }

      let resolvedClubId = null;
      if (club_id) {
        const club = await client.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2",
          [club_id, org_id],
        );
        if (!club.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Selected club doesn't belong to that organisation" });
        }
        resolvedClubId = club_id;
      } else if (cleanClubName) {
        const cnew = await client.query(
          `INSERT INTO clubs (org_id, name, short_code)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [org_id, cleanClubName, safeText(new_club_short_code, 8) || null],
        );
        resolvedClubId = cnew.rows[0].id;
      }

      const hash = await bcrypt.hash(password, 12);
      // email_verified_at left NULL on purpose: gates login until
      // the user clicks the verification link.
      const uRes = await client.query(
        "INSERT INTO users (username, password, full_name, email, org_id, club_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [cleanUsername, hash, fullName, email, org_id, resolvedClubId],
      );
      newUserId = uRes.rows[0].id;

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
        [newUserId, org_id],
      );

      const validRoles = ["meet_manager", "referee", "judge", "diver"];
      if (requested_role && validRoles.includes(requested_role)) {
        await client.query(
          "INSERT INTO role_requests (user_id, org_id, requested_role, note) VALUES ($1,$2,$3,$4)",
          [newUserId, org_id, requested_role, safeText(note, 500)],
        );
        requestedRoleSaved = requested_role;
        // Real-time push for the dashboard pulse strip — let any
        // connected org admin's dashboard tab refetch its pending
        // count immediately. Best-effort.
        if (io && typeof io.emit === "function") {
          try {
            io.emit("role_request_created", {
              org_id,
              requested_role,
            });
          } catch (_e) { /* ignore */ }
        }
      }

      await client.query("COMMIT");

      // Email verification is the gate; welcome message goes out
      // alongside it. Both are best-effort.
      //
      // 24h TTL (was 7d): defensive — limits the blast radius of
      // a leaked verification link via email archives / Sentry
      // breadcrumbs / mail forwards. A genuine user who misses
      // the window can request a fresh link via re-registration
      // or password reset; the cost of a slightly tighter expiry
      // is far smaller than the cost of a week-long replay
      // window for a leaked URL.
      const verifyToken = jwt.sign(
        { sub: newUserId, type: "email_verify" },
        JWT_SECRET,
        { expiresIn: "24h" },
      );
      if (typeof sendVerifyEmailEmail === "function") {
        // Pass `req` so the verify-email subject/body are rendered
        // in the locale the registrant was using when they submitted
        // the form (Accept-Language at register-time, since the user
        // row doesn't have a locale yet).
        sendVerifyEmailEmail(newUserId, verifyToken, { req }).catch(() => {});
      }
      sendWelcomeEmail(newUserId).catch(() => {});
      if (requestedRoleSaved) {
        sendNewRoleRequestEmail(newUserId, org_id, requestedRoleSaved,
                                 safeText(note, 500)).catch(() => {});
      }

      res.status(201).json({
        message:
          "Registration successful. Check your email for a verification link before signing in.",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Register Error]", err.message);
      res.status(500).json({ error: err.detail || "Registration failed" });
    } finally {
      client.release();
    }
  });

  // Verify email — clicked from the link sent at registration.
  // Single-use via the email_verified_at column: once stamped,
  // re-presenting the same token has no effect.
  router.post("/api/auth/verify-email", authLimiter, async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Verification token required" });
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
      return res.status(400).json({ error: "Verification link is invalid or has expired" });
    }
    if (decoded.type !== "email_verify" || !decoded.sub) {
      return res.status(400).json({ error: "Verification link is invalid" });
    }
    try {
      const r = await pool.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
         WHERE id = $1 RETURNING email_verified_at`,
        [decoded.sub],
      );
      if (!r.rows.length) {
        return res.status(400).json({ error: "Verification link is invalid" });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Verify Email Error]", err.message);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // Register a new organisation + its founding org_admin
  router.post("/api/auth/register-org", authLimiter, async (req, res) => {
    if (process.env.SIGNUPS_ENABLED !== "true") {
      return res.status(403).json({ error: "Account creation is coming soon.", code: "signups_disabled" });
    }
    const { org_name, country_code, slug, username, password, full_name, email } =
      req.body || {};

    // Apply the same input validation we run on /api/auth/register.
    // Without these checks the org-founding flow accepted blank
    // passwords, missing emails, and CR/LF-laced names — every
    // pending org seeded a row that a sysadmin clicking Approve
    // turned into a 0-character-password active account.
    const cleanOrgName  = safeText(org_name, 100);
    const cleanFullName = safeText(full_name, 100);
    const cleanSlug     = safeText(slug, 60);
    const cleanUsername = safeText(username, 50);
    if (!cleanOrgName)  return res.status(400).json({ error: "Organisation name is required" });
    if (!cleanFullName) return res.status(400).json({ error: "Full name is required" });
    if (!cleanSlug)     return res.status(400).json({ error: "Slug is required" });
    // Slug shows up in public URLs (organisations.slug). Require
    // a URL-safe shape so `/`, `..`, percent-bytes, and HTML-ish
    // payloads can't smuggle through the SPA's escaping in some
    // future deep-link.
    if (!/^[a-z0-9-]{2,60}$/.test(cleanSlug)) {
      return res.status(400).json({
        error: "slug must be 2-60 chars of lowercase letters, digits, or hyphens",
      });
    }
    if (!cleanUsername) return res.status(400).json({ error: "Username is required" });
    if (!/^[a-zA-Z0-9._-]{2,50}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Username must be 2-50 characters of letters, digits, dot, underscore, or hyphen",
      });
    }
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    // Email max-length: users.email is varchar(254) in init.sql;
    // exceeding that produces a noisy 500. Cap here so the 400
    // is returned with a clear error instead.
    if (typeof email !== "string"
        || email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (country_code != null && !/^[A-Z]{2,3}$/.test(country_code)) {
      return res.status(400).json({ error: "country_code must be a 2-3 letter ISO code" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const orgRes = await client.query(
        "INSERT INTO organisations (name, country_code, slug, status) VALUES ($1,$2,$3,'pending') RETURNING id",
        [cleanOrgName, country_code || null, cleanSlug],
      );
      const orgId = orgRes.rows[0].id;

      const hash = await bcrypt.hash(password, 12);
      const uRes = await client.query(
        "INSERT INTO users (username, password, full_name, email, org_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [cleanUsername, hash, cleanFullName, email, orgId],
      );
      const userId = uRes.rows[0].id;

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'org_admin')",
        [userId, orgId],
      );

      await client.query("COMMIT");

      // Mint + send the email-verification token, same flow as
      // /api/auth/register. The previous register-org omitted
      // this step, which left the founding org_admin permanently
      // unable to log in (the login gate at line 82-87 refuses
      // bcrypt-correct credentials when email_verified_at IS
      // NULL). The operational workaround was for a sysadmin to
      // UPDATE-stamp email_verified_at directly — bypassing
      // proof-of-inbox-control on the highest-privilege account
      // in a fresh tenant.
      // 24h TTL (was 7d): see /api/auth/register for the
      // rationale — leaked verification links shouldn't be
      // replayable for a week.
      const verifyToken = jwt.sign(
        { sub: userId, type: "email_verify" },
        JWT_SECRET,
        { expiresIn: "24h" },
      );
      if (typeof sendVerifyEmailEmail === "function") {
        sendVerifyEmailEmail(userId, verifyToken, { req }).catch(() => {});
      }

      res
        .status(201)
        .json({
          message: "Organisation registered. Check your email for a verification link before signing in.",
          org_id: orgId,
        });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Register Org Error]", err.message);
      if (err.constraint === "organisations_slug_key")
        return res
          .status(400)
          .json({ error: "That organisation slug is already taken" });
      res
        .status(500)
        .json({ error: err.detail || "Organisation registration failed" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // SELF-SERVICE PASSWORD CHANGE
  // Logged-in user changes their own password. Requires the
  // current password as a defence against a hijacked session
  // silently rotating the credential.
  // -------------------------------------------------------------
  router.put("/api/users/me/password", verifyToken, async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query(
        "SELECT id, password, full_name, email FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "User not found" });
      }
      const ok = await bcrypt.compare(current_password, user.password);
      if (!ok) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      const hash = await bcrypt.hash(new_password, 12);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
      // Migration 021: invalidate every other session this user
      // has open on other devices. Then issue a replacement JWT
      // carrying the new token_version so this request doesn't
      // strand its own tab on a stale token.
      if (typeof bumpTokenVersion === "function") {
        await bumpTokenVersion(client, user.id);
      }
      await client.query("COMMIT");
      sendPasswordChangedEmail(user.id).catch(() => {});
      const payload = await buildTokenPayload(user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      setSessionCookie(res, token);
      const resBody = { ok: true, user: payload, ...payload };
      if (includeBodyToken(req)) resBody.token = token;
      res.json(resBody);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Change Password Error]", err.message);
      res.status(500).json({ error: "Password change failed" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/users/me/locale (Migration 052)
  //
  // Lets a signed-in user persist their preferred UI locale to
  // their user row so it follows them across devices. The SPA
  // also mirrors the value into localStorage, but that's only
  // device-local; this endpoint is the cross-device source of
  // truth.
  //
  // Body: { locale: "en" }     (one of the SUPPORTED codes)
  //
  // Re-issues a JWT carrying the new locale so the in-tab token
  // matches the DB row immediately (otherwise the user's PDF
  // exports would still resolve via Accept-Language until the
  // next login).
  // -------------------------------------------------------------
  router.post("/api/users/me/locale", verifyToken, async (req, res) => {
    const { SUPPORTED } = require("../lib/server-i18n");
    const raw = req.body?.locale;
    // Accept null/empty as "clear preference, fall back to
    // Accept-Language" — symmetric with the column being NULLable.
    const cleared = raw === null || raw === "";
    if (!cleared && (typeof raw !== "string" || !SUPPORTED.includes(raw))) {
      return res.status(400).json({
        error: req.t
          ? req.t("errors.validation_failed")
          : "locale must be one of the supported codes or null",
        supported: SUPPORTED,
      });
    }
    try {
      await pool.query(
        "UPDATE users SET locale = $1 WHERE id = $2",
        [cleared ? null : raw, req.user.id],
      );
      // Reissue the token so the next request resolves this
      // user's locale from req.user.locale (cheap path) rather
      // than falling through to Accept-Language.
      const payload = await buildTokenPayload(req.user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      setSessionCookie(res, token);
      const resBody = { ok: true, locale: cleared ? null : raw, user: payload, ...payload };
      if (includeBodyToken(req)) resBody.token = token;
      res.json(resBody);
    } catch (err) {
      console.error("[Set Locale Error]", err.message);
      res.status(500).json({
        error: req.t ? req.t("errors.server_error") : "Failed to set locale",
      });
    }
  });

  // -------------------------------------------------------------
  // SELF-SERVICE EMAIL CHANGE (Migration 044)
  //
  // Two-step flow:
  //   1. POST /api/users/me/email/change-request
  //        Body: { new_email, current_password }
  //        Auth: verifyToken (signed-in user only)
  //        Effect: parks new_email + sha256(token) + 30-min expiry
  //                on the user row, emails the plaintext link to
  //                the NEW address.
  //
  //   2. POST /api/auth/confirm-email-change
  //        Body: { token }
  //        Auth: none — the token IS the credential
  //        Effect: swaps users.email = pending_email, clears the
  //                pending_* columns, bumps token_version (forces
  //                re-login on every other session), sends a
  //                hygiene notice to the OLD address.
  //
  // Why DB-backed token (and not the JWT-fingerprint pattern
  // /forgot-password uses): we need to carry the new address
  // between request and confirm without baking it into a JWT
  // payload that would land in mailer transcripts. The DB
  // overwrite also gives us "re-issuing supersedes" for free —
  // the new row write invalidates any earlier in-flight token
  // without a separate revocation column.
  //
  // Tokens are random 32-byte hex (256 bits of entropy). Only
  // sha256(token) is persisted, so a DB dump doesn't hand an
  // attacker every pending link.
  // -------------------------------------------------------------
  router.post("/api/users/me/email/change-request", authLimiter, verifyToken, async (req, res) => {
    const { new_email, current_password } = req.body || {};
    // Format checks mirror /api/auth/register so a payload that
    // passes here is the same shape registrations enforce.
    if (typeof new_email !== "string"
        || new_email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email)) {
      return res.status(400).json({ error: "A valid new email address is required" });
    }
    if (typeof current_password !== "string" || !current_password) {
      return res.status(400).json({ error: "Current password is required" });
    }
    const normalisedNew = new_email.trim().toLowerCase();
    try {
      const u = await pool.query(
        "SELECT id, password, email FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });

      const passwordOk = await bcrypt.compare(current_password, user.password);
      if (!passwordOk) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      // Reject no-op changes early so we don't email the user a
      // link to confirm an address they already use.
      if (user.email && user.email.trim().toLowerCase() === normalisedNew) {
        return res.status(400).json({ error: "That's already your current email address" });
      }

      // Uniqueness check — soft, racy by design. The DB constraint
      // (if any) would catch a true race at confirm time, but a
      // pre-check here gives a clean 409 instead of a 500. Compare
      // case-insensitively because email addresses are case-folded
      // in practice and we don't want two accounts to differ only
      // by capitalisation.
      const dup = await pool.query(
        "SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2",
        [normalisedNew, req.user.id],
      );
      if (dup.rows.length) {
        return res.status(409).json({ error: "That email address is already in use" });
      }

      // 32 bytes = 256 bits of entropy, hex-encoded into 64 chars
      // for the link. The DB only ever sees sha256(token).
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      await pool.query(
        `UPDATE users
         SET pending_email = $1,
             pending_email_token_hash = $2,
             pending_email_expires_at = now() + interval '30 minutes'
         WHERE id = $3`,
        [normalisedNew, tokenHash, req.user.id],
      );

      // Fire-and-forget the send so a stuck SMTP host can't hold
      // the request open. The user sees an immediate "check your
      // inbox" response either way.
      if (typeof sendEmailChangeVerify === "function") {
        // Capture req at schedule time — setImmediate runs after
        // the request lifecycle but our translator only reads
        // req.user.locale + headers['accept-language'], both of
        // which are plain strings, so it's safe to hold a reference.
        setImmediate(() => {
          sendEmailChangeVerify(req.user.id, normalisedNew, token, { req }).catch(() => {});
        });
      }

      res.json({
        ok: true,
        message: "Check your new email inbox for a confirmation link. It expires in 30 minutes.",
      });
    } catch (err) {
      console.error("[Email Change Request Error]", err.message);
      res.status(500).json({ error: "Email change request failed" });
    }
  });

  router.post("/api/auth/confirm-email-change", authLimiter, async (req, res) => {
    const { token } = req.body || {};
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)) {
      return res.status(400).json({ error: "Confirmation token is invalid" });
    }
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the row so a racing second confirm can't claim the
      // same token. The partial index on pending_email_token_hash
      // (Migration 044) makes this lookup O(log n) over the small
      // set of users with an in-flight change.
      const u = await client.query(
        `SELECT id, email, pending_email, pending_email_expires_at
         FROM users
         WHERE pending_email_token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );
      const user = u.rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Confirmation link is invalid or has already been used" });
      }
      if (!user.pending_email
          || !user.pending_email_expires_at
          || new Date(user.pending_email_expires_at) < new Date()) {
        // Clear the stale row so further confirms hit the "invalid"
        // branch above instead of slipping past the expiry check.
        await client.query(
          `UPDATE users
           SET pending_email = NULL,
               pending_email_token_hash = NULL,
               pending_email_expires_at = NULL
           WHERE id = $1`,
          [user.id],
        );
        await client.query("COMMIT");
        return res.status(400).json({ error: "Confirmation link has expired. Request a new one." });
      }

      // Final-mile uniqueness check inside the transaction. Catches
      // the rare race where someone else's confirm landed on the
      // same address between our request-time check and now.
      const dup = await client.query(
        "SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2",
        [user.pending_email, user.id],
      );
      if (dup.rows.length) {
        await client.query(
          `UPDATE users
           SET pending_email = NULL,
               pending_email_token_hash = NULL,
               pending_email_expires_at = NULL
           WHERE id = $1`,
          [user.id],
        );
        await client.query("COMMIT");
        return res.status(409).json({ error: "That email address was just claimed by another account. Request a different one." });
      }

      const oldEmail = user.email;
      const newEmail = user.pending_email;

      await client.query(
        `UPDATE users
         SET email = $1,
             email_verified_at = COALESCE(email_verified_at, now()),
             pending_email = NULL,
             pending_email_token_hash = NULL,
             pending_email_expires_at = NULL
         WHERE id = $2`,
        [newEmail, user.id],
      );
      // Force re-login on every device. Same posture as password
      // change / 2FA toggle — a session that's been resting on the
      // old email shouldn't keep going on the new one without an
      // explicit sign-in.
      if (typeof bumpTokenVersion === "function") {
        await bumpTokenVersion(client, user.id);
      }
      await client.query("COMMIT");

      // Hygiene notice goes to the OLD address — if someone hijacked
      // the session and rotated the email, this is the original
      // owner's signal to lock down their account.
      if (typeof sendEmailChangedNotice === "function" && oldEmail) {
        sendEmailChangedNotice(user.id, oldEmail, newEmail).catch(() => {});
      }

      res.json({ ok: true, message: "Email address updated. Please sign in again." });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Confirm Email Change Error]", err.message);
      res.status(500).json({ error: "Email change confirmation failed" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // FORGOT / RESET PASSWORD
  //
  // Two-step flow over email. /forgot-password takes an email
  // address, mints a short-lived JWT with type=password_reset
  // scoped to that user, and emails a link. /reset-password
  // accepts the token + a new password.
  //
  // Tokens are stateless JWTs rather than DB-backed nonces:
  // simpler, and the 30-min expiry plus single-use enforcement
  // (we read the user's current password hash into the JWT
  // payload and reject if it has changed) gives us "single use"
  // without an extra table.
  // -------------------------------------------------------------
  router.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
    const { email } = req.body || {};
    // Always respond 200 + ok:true so callers can't enumerate which
    // emails are registered. To avoid timing-based enumeration we
    // also do equal work in both branches and dispatch SMTP fully
    // out-of-band (setImmediate) so the email-send latency doesn't
    // leak through the response time either.
    try {
      let user = null;
      if (typeof email === "string" && email.length <= 320) {
        // Migration 053: deleted users have email = NULL, so they
        // won't match here anyway — but we add an explicit
        // deleted_at filter so the constant-time response shape
        // doesn't depend on whether a tombstoned row exists.
        const u = await pool.query(
          "SELECT id, password, full_name, email FROM users WHERE email = $1 AND deleted_at IS NULL",
          [email],
        );
        user = u.rows[0] || null;
      }
      if (user && user.email) {
        const fingerprint = jwt.sign(
          { sub: user.id, type: "password_reset", fp: hashFingerprint(user.password) },
          JWT_SECRET,
          { expiresIn: "30m" },
        );
        // Defer the SMTP round-trip so the response time doesn't
        // depend on whether we found a user. The catch is swallowed
        // intentionally — we never tell the caller about delivery.
        // Pass `req` so the email lands in the locale the user's
        // current browser is configured for (forgot-password is
        // unauthenticated so we can't use req.user.locale here —
        // Accept-Language is the only signal we have until the
        // user signs back in and POST /api/users/me/locale runs).
        setImmediate(() => {
          sendPasswordResetEmail(user, fingerprint, { req }).catch(() => {});
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Forgot Password Error]", err.message);
      res.json({ ok: true });
    }
  });

  router.post("/api/auth/reset-password", authLimiter, async (req, res) => {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    try {
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch {
        return res.status(400).json({ error: "Reset link is invalid or has expired" });
      }
      if (decoded.type !== "password_reset" || !decoded.sub) {
        return res.status(400).json({ error: "Reset link is invalid" });
      }
      const u = await pool.query(
        "SELECT id, password, deleted_at FROM users WHERE id = $1",
        [decoded.sub],
      );
      const user = u.rows[0];
      // Migration 053: refuse reset links pointing at a deleted
      // account. The user has to go through registration (and
      // optionally claim past results) instead.
      if (!user || user.deleted_at != null) {
        return res.status(400).json({ error: "Reset link is invalid" });
      }
      if (decoded.fp !== hashFingerprint(user.password)) {
        return res.status(400).json({ error: "Reset link has already been used" });
      }
      const hash = await bcrypt.hash(new_password, 12);
      // Bump token_version atomically with the password write so a
      // racing reset can't end with the password rotated but stale
      // JWTs still valid.
      const client2 = await pool.connect();
      try {
        await client2.query("BEGIN");
        await client2.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client2, user.id);
        }
        await client2.query("COMMIT");
      } catch (txErr) {
        await client2.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client2.release();
      }
      sendPasswordChangedEmail(user.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      console.error("[Reset Password Error]", err.message);
      res.status(500).json({ error: "Password reset failed" });
    }
  });

  return router;
};

// Exposed for unit testing the response-token content-negotiation
// (same pattern as lib/idempotency.js's helper export).
module.exports.includeBodyToken = includeBodyToken;
