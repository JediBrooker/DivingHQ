// Auth routes, pulled out of the single-file server.js as the
// first slice of an incremental modularisation. This module
// exports a factory that takes the wiring it needs (pool,
// mailer-backed email helpers, jwt config, middleware) and
// returns an Express router.
//
// Mounted at the app root in server.js as:
//     app.use(require('./routes/auth')({ ... }))
//
// It started as a straight move out of server.js and has grown a lot
// since (club-first signup, claims, 2FA).

const express = require("express");
const bcrypt  = require("bcrypt");
const jwt     = require("jsonwebtoken");
const crypto  = require("node:crypto");
const totp    = require("../lib/totp");
const { SESSION_COOKIE, cookieOptions } = require("../lib/session-cookie");
const { ADMIN_ORG_ID } = require("../lib/admin-org");
const { countryByCode } = require("../lib/countries");
const { materializeRegions } = require("../lib/regions");
const claims = require("../lib/claims");
const { supportContact, suspendedAccountMessage } = require("../lib/support");
const { liveAdminCount, sysadminIds } = require("../lib/admin-rows");
const roleRequests = require("../lib/role-requests");
const clubApprovals = require("../lib/club-approvals");
const { withTx } = clubApprovals;
const notices = require("../lib/notices");
const { recordAudit } = require("../lib/audit");
const createAuthLinks = require("../lib/auth-links");

// Loose on purpose, something@something.tld: the verification link is what
// actually proves the address. Register, register-org and the email change
// all check against this.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Plant the JWT in the httpOnly session cookie. This is the SPA's
// session of record, browser JS can neither read nor exfiltrate it.
function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

// Decide whether to include the bearer token in a JSON auth response.
// The SPA authenticates via the httpOnly session cookie and ignores any
// body token, so we omit it from BROWSER requests: that way XSS active
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

// Who a forgot-password request for this address should reach. Register
// keeps the email as typed while the email change lower-cases it, so an
// exact match missed "John.Smith@Example.com" asked for as
// "john.smith@example.com", and the person got ok:true and no mail.
// users.email isn't unique either (a parent's address on two children's
// accounts is normal here), and rows[0] used to pick one of them at
// random. Every live account on it gets its own link now, greeted by its
// own name. Capped, so one address can't fan out without limit.
const RESET_ACCOUNTS_MAX = 5;
async function resetAccountsFor(db, email) {
  if (typeof email !== "string") return [];
  const addr = email.trim();
  if (!addr || addr.length > 320) return [];
  const r = await db.query(
    `SELECT id, password, full_name, email FROM users
      WHERE lower(email) = lower($1) AND deleted_at IS NULL
      ORDER BY (email_verified_at IS NOT NULL) DESC, created_at DESC
      LIMIT ${RESET_ACCOUNTS_MAX}`,
    [addr],
  );
  return r.rows;
}

// Pre-computed dummy bcrypt hash used by the login flow to keep
// the timing constant when the username doesn't exist. Without
// this, an attacker can enumerate usernames by measuring the
// response delay (no-user ≈ 5ms, bad-password ≈ 150ms). Computed
// once at module load, same cost factor (12) bcrypt.hash() uses
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

// Centralised password policy, applied to every set-password
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
// breached-password lookups. Those are the next two upgrades
// (zxcvbn or HIBP k-anonymity) and can layer on top without
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

// Clubs this user admins, [{ id, name, region_id, org_claim_state }]. Same reasoning as
// has_dependents below: a club admin grant lands whenever the federation
// (or signup) makes it, so it rides on the response body, never the JWT.
// The SPA uses it to show the meet screens and pick a host club, and
// org_claim_state tells My club whether a federation appoints the club's
// admins. The server never trusts any of it, every club-scoped route
// re-reads club_admins.
async function loadClubAdminOf(pool, userId) {
  const r = await pool.query(
    `SELECT c.id, c.name, c.region_id, o.claim_state AS org_claim_state
       FROM club_admins ca
       JOIN clubs c ON c.id = ca.club_id
       JOIN organisations o ON o.id = c.org_id
      WHERE ca.user_id = $1
      ORDER BY lower(c.name)`,
    [userId],
  );
  return r.rows;
}

// Regions this user admins, [{ id, name, short_code, org_claim_state }].
// Body-only like club_admin_of, for the SPA's meet screens and region page.
// org_claim_state tells My region whether role requests come to it (only
// where there's no federation, lib/role-requests.js).
async function loadRegionAdminOf(pool, userId) {
  const r = await pool.query(
    `SELECT rg.id, rg.name, rg.short_code, o.claim_state AS org_claim_state
       FROM region_admins ra JOIN regions rg ON rg.id = ra.region_id
       JOIN organisations o ON o.id = rg.org_id
      WHERE ra.user_id = $1
      ORDER BY rg.name`,
    [userId],
  );
  return r.rows;
}

// Does this user look after anybody? A guardian with an approved
// dependent gets to reach the payment surfaces even when they hold no
// role beyond 'spectator', which is what registration hands out. See
// the router's allowGuardian meta.
//
// Deliberately NOT folded into buildTokenPayload: that shape gets
// signed into the JWT, and an approval that lands after the cookie was
// minted would sit stale until the next sign-in. This rides on the
// response body instead, so /api/auth/me refreshes it on every boot.
async function loadHasDependents(pool, userId) {
  const r = await pool.query(
    `SELECT 1 FROM guardians
      WHERE guardian_user_id = $1 AND status = 'approved' LIMIT 1`,
    [userId],
  );
  return r.rows.length > 0;
}

// Orgs in this country with the given status, skipping the sysadmin's
// Administration org. Matches the alpha-2 code as well as the alpha-3:
// register-org used to take either, and until migration 093 has run on a
// box a federation stored as 'WS' would otherwise be invisible here and
// its clubs would start a second Samoa next to it.
async function countryOrgs(client, country, status) {
  const r = await client.query(
    `SELECT id, name, claim_state FROM organisations
      WHERE country_code IN ($1, $2) AND status = $3 AND id <> $4
      ORDER BY created_at`,
    [country.a3, country.a2, status, ADMIN_ORG_ID],
  );
  return r.rows;
}

// Everything the SPA gets alongside the token payload on sign-in and on
// /api/auth/me, none of it signed into the JWT (see above for why). One
// helper so the three places that build a session body can't drift:
// has_claim was about to be the fourth copy-pasted line in each.
async function addSessionExtras(pool, payload, userId) {
  payload.has_dependents = await loadHasDependents(pool, userId);
  payload.club_admin_of = await loadClubAdminOf(pool, userId);
  payload.region_admin_of = await loadRegionAdminOf(pool, userId);
  // A claimant signs in as a plain spectator; this is what puts Claims
  // in their nav so they can follow their claim.
  payload.has_claim = await claims.hasOwnClaim(pool, userId);
  // A founder whose club is waiting on the federation (migration 096).
  payload.pending_club = await clubApprovals.pendingClubFor(pool, userId);
  return payload;
}

// Club-first signup (migration 087): find the org a registrant from this
// country joins, starting an unclaimed country account if there's none.
//
// Returns { id, claim_state, created }, or { choose: true } when several
// active orgs share the country and the registrant has to pick one, or
// { pending: true } when the country's federation registered the old way
// and is still waiting on the sysadmin (callers turn that into a 409).
// Runs inside the caller's transaction. The partial unique index on
// (country_code) WHERE unclaimed is what stops two first-signups racing
// into two accounts: the loser's insert DOs NOTHING and it reads back the
// winner's row.
async function resolveCountryOrg(client, country) {
  const existing = await countryOrgs(client, country, "active");
  if (existing.length > 1) return { choose: true };
  if (existing.length === 1) {
    return { id: existing[0].id, claim_state: existing[0].claim_state, created: false };
  }

  // A pending federation is the country's org being set up. Starting an
  // unclaimed account beside it is how a country ended up with two once
  // the sysadmin approved the federation. Nobody can join the pending one
  // either (its members can't sign in yet), so the signup waits.
  const pending = await countryOrgs(client, country, "pending");
  if (pending.length) return { pending: true };

  // Bare ON CONFLICT DO NOTHING on purpose. Two racing signups collide
  // on the slug as readily as on the one-per-country index, and naming
  // just the index let the slug clash through as a 500.
  const tryInsert = (slug) => client.query(
    `INSERT INTO organisations (name, country_code, slug, status, claim_state)
     VALUES ($1, $2, $3, 'active', 'unclaimed')
     ON CONFLICT DO NOTHING
     RETURNING id, claim_state`,
    [country.name, country.a3, slug],
  );
  const base = `country-${country.a3.toLowerCase()}`;
  let ins = await tryInsert(base);
  if (ins.rows.length) return { ...ins.rows[0], created: true };

  // Nothing inserted: either someone else just started this country
  // (read their row back), or 'country-xyz' was already some other
  // org's slug (try once more with a suffix).
  const findUnclaimed = () => client.query(
    `SELECT id, claim_state, status FROM organisations
      WHERE country_code = $1 AND claim_state = 'unclaimed'`,
    [country.a3],
  );
  let row = (await findUnclaimed()).rows[0];
  if (!row) {
    ins = await tryInsert(`${base}-${crypto.randomBytes(2).toString("hex")}`);
    if (ins.rows.length) return { ...ins.rows[0], created: true };
    row = (await findUnclaimed()).rows[0];
  }
  // Still nothing, or a sysadmin suspended this country's account.
  // Joining a suspended one would just lock them out.
  if (!row || row.status !== "active") return { closed: true };
  return { id: row.id, claim_state: row.claim_state, created: false };
}

// The 409 body for a signup that hits a pending federation.
function federationPendingBody(country) {
  return {
    error: `${country.name}'s federation has registered on DivingHQ and is waiting for approval. `
      + `Try again once it's approved, or contact ${supportContact()}.`,
    code: "federation_pending",
  };
}

// URL-safe slug from an organisation's name: "Fédération Française de
// Natation" becomes "federation-francaise-de-natation". A name that
// doesn't survive the trip (Cyrillic, Arabic, CJK...) gets the caller's
// fallback. Capped at 50 so a clash suffix still fits inside the 60-char
// shape register-org has always required of a slug.
function slugFromName(name, fallback) {
  const s = String(name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return s.length >= 2 ? s : fallback;
}

module.exports = function createAuthRouter({
  pool,
  io,
  push,
  features,
  authLimiter,
  verifyToken,
  optionalAuth,
  buildTokenPayload,
  hashFingerprint,
  sendWelcomeEmail,
  sendVerifyEmailEmail,
  sendNewRoleRequestEmail,
  sendNewOrgRequestEmail,
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendEmailChangeVerify,
  sendEmailChangedNotice,
  bumpTokenVersion,
  JWT_SECRET,
  JWT_EXPIRY,
  sendClaimEmail,      // optional, claim notices by email (lib/claims.js)
  sendNoticeEmail,     // optional, club approval notices by email (lib/club-approvals.js)
}) {
  const router = express.Router();
  const { mintVerifyToken, mintResetToken } = createAuthLinks(JWT_SECRET);

  // Sign a fresh session for userId, set the cookie and answer with
  // { ...before, user, ...payload, ...after }, plus the token for clients
  // that want it in the body. Login and login/totp pass withExtras so the
  // SPA gets the nav flags too; those go on after signing so they never
  // end up inside the JWT. Change-password and the locale switch never
  // sent them, and still don't.
  async function sendSession(req, res, userId, { before = {}, after = {}, withExtras = false } = {}) {
    const payload = await buildTokenPayload(userId);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    setSessionCookie(res, token);
    if (withExtras) await addSessionExtras(pool, payload, userId);
    const resBody = { ...before, user: payload, ...payload, ...after };
    if (includeBodyToken(req)) resBody.token = token;
    res.json(resBody);
  }

  // -------------------------------------------------------------
  // GET /api/auth/me: rehydrate the signed-in identity from the
  // httpOnly session cookie. The SPA calls this on boot because the
  // JWT now lives in a cookie its JS can't read/decode. Returns the
  // same user payload shape the login response carries. 401 when
  // anonymous (no / expired / revoked cookie), a normal first-visit
  // state, not an error.
  // -------------------------------------------------------------
  router.get("/api/auth/me", optionalAuth, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    try {
      // Rebuild from the DB so a role/locale change since the cookie
      // was minted is reflected without forcing a re-login. Same goes
      // for a guardian link an admin approved five minutes ago.
      const payload = await buildTokenPayload(req.user.id);
      await addSessionExtras(pool, payload, req.user.id);
      res.json({ user: payload });
    } catch (err) {
      console.error("[Auth Me Error]", err.message);
      res.status(500).json({ error: "Failed to load session" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/auth/logout: clear the session cookie. JS can't delete
  // an httpOnly cookie, so sign-out has to round-trip the server. We
  // deliberately don't bump token_version (that would sign the user
  // out on every device); clearing the cookie + the JWT's own exp
  // bound this session. No auth gate, clearing a cookie is harmless.
  // -------------------------------------------------------------
  router.post("/api/auth/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.json({ ok: true });
  });

  router.post("/api/auth/login", authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // Reject malformed bodies up front so bcrypt.compare never sees
    // a non-string and throws. That was leaking 500 vs 401, which
    // a probing attacker could use to distinguish "user exists".
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    try {
      // Pull only the columns we need. Defence in depth: a future
      // change that responds with the row directly can't leak the
      // password hash if it was never selected.
      const result = await pool.query(
        `SELECT u.id, u.password, u.email_verified_at, u.totp_enabled_at,
                u.deleted_at, u.suspended_at, u.is_system_admin,
                o.status AS org_status, o.claim_state AS org_claim_state
           FROM users u
           LEFT JOIN organisations o ON o.id = u.org_id
          WHERE u.username = $1`,
        [username],
      );
      const user = result.rows[0];
      // Always run bcrypt.compare, against the user's hash if we
      // found them, against a dummy hash otherwise, so the
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
      //
      // In a club-first country there's no federation to ask (nobody
      // there holds org_admin), so point them at their club and at us.
      if (user.suspended_at != null) {
        return res.status(403).json({
          error: suspendedAccountMessage(user.org_claim_state),
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

      // A federation stays 'pending' until a sysadmin approves it and
      // goes 'suspended' when it's denied or pulled. Nobody in it signs
      // in meanwhile, the register-org page already promises as much.
      // Checked after the password so it can't be used to probe which
      // usernames belong to a pending org.
      if (!user.is_system_admin && user.org_status !== "active") {
        const pending = user.org_status === "pending";
        return res.status(403).json({
          error: pending
            ? "Your organisation is still waiting for approval. We'll email you as soon as it's reviewed."
            : `Your organisation's access to DivingHQ has been suspended. If you think this is a mistake, contact ${supportContact()}.`,
          code: pending ? "org_pending" : "org_suspended",
        });
      }

      // Migration 022: if 2FA is enabled, the password check is
      // only the first factor. Mint a short-lived "step-up" token
      // scoped to the second-factor exchange and hand it back;
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

      await sendSession(req, res, user.id, { withExtras: true });
    } catch (err) {
      console.error("[Login Error]", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Replay guard (migration 063): the ±1-step verify window keeps a
  // code valid for ~90s, so a just-consumed code could otherwise mint a
  // second session, or be replayed to tear the second factor down.
  // verifyTokenDelta returns the absolute time-step the code matched; the
  // conditional UPDATE persists it and only succeeds when it's strictly
  // newer than the stored last-used step, so a replay (or a concurrent
  // presentation of the same code) loses the race and is rejected like
  // any bad code. Login and 2FA disable both spend codes through this.
  async function consumeTotpStep(userId, secret, code) {
    const matchedStep = totp.verifyTokenDelta(secret, code);
    if (matchedStep == null) return false;
    const consumed = await pool.query(
      `UPDATE users
       SET totp_last_used_step = $1
       WHERE id = $2
         AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)
       RETURNING id`,
      [matchedStep, userId],
    );
    return consumed.rowCount > 0;
  }

  // -------------------------------------------------------------
  // POST /api/auth/login/totp: second-factor exchange.
  //
  // Body: { totp_token, code }
  //   totp_token: the 5-min JWT minted by /api/auth/login above.
  //   code:       6-digit TOTP from the authenticator app, OR a
  //               10-char recovery code (with or without dash).
  //
  // Returns the same shape as /api/auth/login on success: { token,
  // ...payload }. Recovery codes are one-time, on success the
  // matched hash is removed from the user's stored array.
  // -------------------------------------------------------------
  // Spend one recovery code. The bcrypt compares take a while, and the
  // write used to be a plain overwrite of the whole list, so two logins
  // racing with the same code both matched it and both got a session
  // (and two different codes at once wrote one of them back, unused).
  // The write is a compare-and-set against the list we matched in: if it
  // changed underneath us, re-read and match again. A code the other
  // request already spent isn't there the second time, so it fails.
  async function consumeRecoveryAtomically(userId, hashes, code) {
    let current = hashes || [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const { matched, remainingHashes } = await totp.consumeRecoveryCode(current, code);
      if (!matched) return false;
      const done = await pool.query(
        `UPDATE users SET totp_recovery_codes = $1::jsonb
          WHERE id = $2 AND totp_recovery_codes = $3::jsonb`,
        [JSON.stringify(remainingHashes), userId, JSON.stringify(current)],
      );
      if (done.rowCount) return true;
      const fresh = await pool.query("SELECT totp_recovery_codes FROM users WHERE id = $1", [userId]);
      current = fresh.rows[0]?.totp_recovery_codes || [];
    }
    return false;
  }

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
      if (looksLikeTotp) accepted = await consumeTotpStep(user.id, user.totp_secret, code);
      if (!accepted) {
        consumedRecovery = await consumeRecoveryAtomically(user.id, user.totp_recovery_codes, code);
        accepted = consumedRecovery;
      }
      if (!accepted) {
        return res.status(401).json({ error: "Invalid TOTP / recovery code" });
      }

      await sendSession(req, res, user.id, {
        withExtras: true,
        after: consumedRecovery
          ? { warning: "Recovery code consumed. Re-generate your recovery codes when convenient." }
          : {},
      });
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
  //   POST /api/auth/2fa/setup   : mints a fresh secret, returns
  //                                 the QR + base32 + provisional
  //                                 recovery codes. Saves the secret
  //                                 to users.totp_secret but DOES
  //                                 NOT enable 2FA yet (totp_enabled_at
  //                                 stays NULL). User must verify a
  //                                 code via /confirm before login is
  //                                 gated.
  //
  //   POST /api/auth/2fa/confirm : { code }. Verifies a TOTP code
  //                                 against the pending secret and
  //                                 stamps totp_enabled_at + saves
  //                                 the recovery code hashes from
  //                                 the setup response. Bumps
  //                                 token_version to invalidate
  //                                 every existing session for this
  //                                 user (Migration 021 plumbing).
  //
  //   POST /api/auth/2fa/disable : { password, code? }. Requires
  //                                 the password (proof of access)
  //                                 + a current TOTP / recovery code.
  //                                 Clears every totp_* column.
  //
  //   GET  /api/auth/2fa/status  : { enabled: bool, recovery_codes_remaining: int|null }.
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
      // CPU), hashing off the event loop keeps concurrent
      // requests, including live scoring, unaffected.
      const { plain, hashes } = await totp.generateRecoveryCodes(10);
      // Save the secret + provisional recovery hashes. We DON'T
      // set totp_enabled_at: until the user verifies a code via
      // /confirm, login still bypasses 2FA. This means a half-
      // finished setup (browser tab closed at the QR screen)
      // doesn't lock the user out. totp_last_used_step resets
      // with the secret, since the replay guard's bookkeeping belongs
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
      await withTx(pool, async (client) => {
        // Record the consumed step alongside the enable stamp so
        // the very first login can't replay the confirm code
        // within its ~90s verify window (migration 063). GREATEST
        // guards the (unlikely) case of an older value surviving;
        // the step only ever moves forward.
        await client.query(
          `UPDATE users
           SET totp_enabled_at = now(),
               totp_last_used_step = GREATEST(COALESCE(totp_last_used_step, 0), $2)
           WHERE id = $1`,
          [req.user.id, matchedStep],
        );
        // Bump token_version so every device this user is signed
        // in on is forced through the new 2FA flow on next request.
        await bumpTokenVersion(client, req.user.id);
      });
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
        // Single-use, same as the login exchange: a code that already
        // minted a session can't be replayed to tear 2FA down.
        codeOk = await consumeTotpStep(req.user.id, user.totp_secret, code);
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
      await withTx(pool, async (client) => {
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
        await bumpTokenVersion(client, req.user.id);
      });
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
  // Public account creation (self-register + found-an-org) is gated by the
  // 'signups' feature flag (migration 086), toggled at /admin/features. Login
  // and every existing-account flow (password reset, email change, 2FA) are
  // NEVER gated, since the super admin must always be able to sign in.
  function signupsOpen() {
    return features.enabled("signups");
  }

  router.get("/api/auth/signups-status", (req, res) => {
    res.json({ enabled: signupsOpen() });
  });

  // Best-effort in-app heads-up to every sysadmin. Fire and forget: the
  // lookup runs here, and lib/notices does the push without throwing.
  function notifySysadminsOfClub({ clubName, orgId, countryName, startedCountry }) {
    const where = countryName || "an unclaimed country";
    const tag = "Club Created Notification Skipped";
    sysadminIds(pool)
      .then((userIds) => notices.deliver({ push }, [{
        userIds,
        category:   "club_created",
        title:      `New club: ${clubName}`,
        body:       startedCountry
          ? `First club on DivingHQ from ${where}. The country account was created unclaimed.`
          : `A new club joined ${where}, which has no federation on DivingHQ yet.`,
        data:       { org_id: orgId, club_name: clubName },
        action_url: "/clubs",
        email:      false,
      }], { tag }))
      .catch((err) => console.error(`[${tag}]`, err.message));
  }

  router.post("/api/auth/register", authLimiter, async (req, res) => {
    if (!signupsOpen()) {
      return res.status(403).json({ error: "Account creation is coming soon.", code: "signups_disabled" });
    }
    const {
      username, password, email, org_id, country_code, requested_role, note,
      club_id, new_club_name, new_club_short_code, region_code,
    } = req.body || {};
    // Club-first signup (migration 087) sends a country instead of an org.
    // org_id still wins when both are present: that's the form telling us
    // which of several federations in one country the registrant picked.
    const country = org_id ? null : countryByCode(country_code);
    if (!org_id && !country) {
      return res.status(400).json({ error: "Pick your country" });
    }

    const fullName = safeText(req.body?.full_name, 100);
    const cleanClubName = safeText(new_club_name, 80);
    // Username cap mirrors users.username = varchar(50) in init.sql.
    // Charset is intentionally narrow: username surfaces in audit
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
    // users.email is varchar(255); a longer one failed the INSERT and came
    // back a 500. Same cap as register-org and the email change.
    if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required for verification" });
    }

    const client = await pool.connect();
    let newUserId = null;
    let requestedRoleSaved = null;
    try {
      await client.query("BEGIN");

      let orgId;
      let orgClaimState;
      let orgName = country ? country.name : null;
      let orgCountry = country ? country.a3 : null;
      let startedCountry = false;
      let orgAutoApprove = false;
      if (country) {
        const found = await resolveCountryOrg(client, country);
        if (found.pending) {
          await client.query("ROLLBACK");
          return res.status(409).json(federationPendingBody(country));
        }
        if (found.closed) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Signups from ${country.name} are paused. Contact ${supportContact()}.` });
        }
        if (found.choose) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "More than one organisation runs diving in that country, pick yours",
            code: "org_choice_required",
          });
        }
        ({ id: orgId, claim_state: orgClaimState, created: startedCountry } = found);
        // The federation's own name (not the country's) and whether it
        // lets new clubs straight in. resolveCountryOrg doesn't carry either.
        const o = (await client.query(
          "SELECT name, auto_approve_clubs FROM organisations WHERE id = $1", [orgId],
        )).rows[0];
        if (o) {
          orgName = o.name;
          orgAutoApprove = o.auto_approve_clubs;
        }
      } else {
        // The Administration org is active but never open to the public,
        // same filter as /api/orgs/active so a hand-crafted POST can't
        // get round the missing dropdown entry.
        const org = await client.query(
          "SELECT id, name, claim_state, country_code, auto_approve_clubs FROM organisations WHERE id = $1 AND status = 'active' AND id <> $2",
          [org_id, ADMIN_ORG_ID],
        );
        if (!org.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Organisation not found or not yet active" });
        }
        orgId = org.rows[0].id;
        orgClaimState = org.rows[0].claim_state;
        orgName = org.rows[0].name;
        orgCountry = org.rows[0].country_code;
        orgAutoApprove = org.rows[0].auto_approve_clubs;
      }
      const unclaimed = orgClaimState === "unclaimed";

      // Nobody holds org_admin in an unclaimed country, and an org-wide
      // meet_manager there could run every club's meets. Clubs appoint
      // per-meet managers instead, so the request isn't on offer.
      if (unclaimed && requested_role === "meet_manager") {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Meet managers are appointed by club admins in countries without a federation on DivingHQ yet",
        });
      }

      let resolvedClubId = null;
      let createdClubId = null;
      let clubStatus = null;
      if (club_id) {
        // Active clubs only. A pending one isn't in the picker, and a
        // hand-made POST mustn't be a way to join it before it's approved.
        const club = await client.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2 AND status = 'active'",
          [club_id, orgId],
        );
        if (!club.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Selected club doesn't belong to that organisation" });
        }
        resolvedClubId = club_id;
        clubStatus = "active";
      } else if (cleanClubName) {
        // Regions (migration 088). A country the clubs started gets its
        // built-in list the first time anyone founds a club there, which
        // also catches accounts started before regions existed. Where the
        // org has regions, a new club has to say which one it's in.
        if (unclaimed) await materializeRegions(client, orgId, orgCountry);
        let regionId = null;
        let askRegionId = null;
        const regions = await client.query(
          `SELECT rg.id, rg.short_code, rg.claim_state,
                  EXISTS (SELECT 1 FROM region_admins ra JOIN users u ON u.id = ra.user_id
                           WHERE ra.region_id = rg.id
                             AND u.deleted_at IS NULL AND u.suspended_at IS NULL) AS has_live_admin
             FROM regions rg WHERE rg.org_id = $1`,
          [orgId],
        );
        if (regions.rows.length) {
          const code = typeof region_code === "string" ? region_code.toUpperCase() : "";
          const pick = regions.rows.find((r) => r.short_code === code) || null;
          regionId = pick?.id || null;
          if (!regionId) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Pick which state or region your club is in", code: "region_required" });
          }
          // Where there's no federation, a region its state body has
          // claimed decides which clubs it takes (PUT /api/clubs/:id/region
          // answers 202 and waits for the region). Signup is no back door:
          // the club asks, and sits outside the region until it's accepted.
          // Under a federation where to put a club is the federation's
          // call, same as that route.
          if (unclaimed && pick.claim_state === "claimed" && pick.has_live_admin) {
            askRegionId = regionId;
            regionId = null;
          }
        }
        // Under a federation a new club waits for its org admin, unless
        // it lets clubs join automatically (lib/club-approvals.js).
        clubStatus = clubApprovals.needsApproval({ claim_state: orgClaimState, auto_approve_clubs: orgAutoApprove })
          ? "pending" : "active";
        // Same code rule as club setup and the approve dialog. A club that
        // goes live straight away (no federation, or one that lets clubs
        // straight in) has nobody checking its code later, so the clash
        // check happens now. A waiting one gets checked when it's approved.
        let newClubCode;
        try {
          newClubCode = clubApprovals.normaliseClubCode(new_club_short_code);
          if (clubStatus === "active") await clubApprovals.assertCodeFree(client, orgId, newClubCode);
        } catch (err) {
          if (!(err instanceof clubApprovals.ClubApprovalError)) throw err;
          await client.query("ROLLBACK");
          return res.status(err.status).json({ error: err.message, code: err.code });
        }
        const cnew = await client.query(
          `INSERT INTO clubs (org_id, name, short_code, region_id, status, requested_region_id, region_requested_at)
           VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END)
           RETURNING id`,
          [orgId, cleanClubName, newClubCode, regionId, clubStatus, askRegionId],
        );
        resolvedClubId = cnew.rows[0].id;
        createdClubId = resolvedClubId;
      }

      const hash = await bcrypt.hash(password, 12);
      // email_verified_at left NULL on purpose: gates login until
      // the user clicks the verification link.
      const uRes = await client.query(
        "INSERT INTO users (username, password, full_name, email, org_id, club_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [cleanUsername, hash, fullName, email, orgId, resolvedClubId],
      );
      newUserId = uRes.rows[0].id;

      if (createdClubId) {
        await client.query("UPDATE clubs SET created_by = $1 WHERE id = $2", [newUserId, createdClubId]);
        const ask = (await client.query(
          "SELECT name, requested_region_id FROM clubs WHERE id = $1 AND requested_region_id IS NOT NULL", [createdClubId],
        )).rows[0];
        if (ask) {
          // Same audit row as asking from My club. The region hears about
          // it once the founder has verified their email (askRegions), so
          // a signup nobody finishes doesn't ping its admins.
          await recordAudit(client, {
            org_id: orgId, actor_id: newUserId, entity_type: "club", entity_id: createdClubId,
            entity_name: ask.name, action: "club.region_requested",
            metadata: { from: null, to: ask.requested_region_id, at_signup: true },
          });
        }
        // In an unclaimed country the founder runs their club, there's
        // nobody above them to appoint anyone. Under a real federation
        // it stays the federation's call: approving the club can make
        // the founder its admin, and an auto-joined club gets its admins
        // from Clubs -> Admins, same as before club-first signup existed.
        if (unclaimed) {
          await client.query(
            "INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)",
            [createdClubId, newUserId, orgId],
          );
        }
      }

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
        [newUserId, orgId],
      );

      // Same list the signed-in request path uses (lib/role-requests.js).
      if (requested_role && roleRequests.REQUESTABLE_ROLES.includes(requested_role)) {
        await client.query(
          "INSERT INTO role_requests (user_id, org_id, requested_role, note) VALUES ($1,$2,$3,$4)",
          [newUserId, orgId, requested_role, safeText(note, 500)],
        );
        requestedRoleSaved = requested_role;
        // Real-time push for the dashboard pulse strip, lets any
        // connected org admin's dashboard tab refetch its pending
        // count immediately. Best-effort.
        if (io && typeof io.emit === "function") {
          try {
            io.emit("role_request_created", {
              org_id: orgId,
              requested_role,
            });
          } catch (_e) { /* ignore */ }
        }
      }

      await client.query("COMMIT");

      // Email verification is the gate, best effort like every mail here
      // (lib/auth-links.js has why the link only lasts a day). Pass `req`
      // so the verify-email subject/body are rendered in the locale the
      // registrant was using when they submitted the form
      // (Accept-Language at register-time, since the user row doesn't
      // have a locale yet).
      sendVerifyEmailEmail(newUserId, mintVerifyToken(newUserId), { req }).catch(() => {});
      // The welcome mail waits for the verify click (see verify-email),
      // it says "you can sign in now" and that isn't true yet.
      if (requestedRoleSaved) {
        sendNewRoleRequestEmail(newUserId, orgId, requestedRoleSaved,
                                 safeText(note, 500)).catch(() => {});
      }
      // Nobody approves a club in an unclaimed country, so the sysadmin
      // at least hears about it and can suspend a junk one after the fact.
      if (createdClubId && unclaimed) {
        notifySysadminsOfClub({
          clubName:  cleanClubName,
          orgId,
          countryName: orgName,
          startedCountry,
        });
      }
      // A federation that lets clubs join automatically still likes to
      // know. One that approves them hears once the founder has verified
      // their email (verify-email below), not now.
      if (createdClubId && !unclaimed && clubStatus === "active") {
        clubApprovals.announceAutoJoin(pool, { clubId: createdClubId }, { push })
          .catch((err) => console.error("[Club Joined Notification Skipped]", err.message));
      }

      res.status(201).json({
        message:
          "Registration successful. Check your email for a verification link before signing in.",
        // Lets the page say "your club is waiting for {org}" straight away.
        club_status: clubStatus,
        org_name: orgName,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Register Error]", err.message);
      res.status(500).json({ error: err.detail || "Registration failed" });
    } finally {
      client.release();
    }
  });

  // Following a verify link, or a reset link, proves the inbox, and a few
  // things wait on exactly that: a federation or state body's claim goes
  // live (lib/claims.js), a club waiting on its federation gets put in
  // front of it, and a new club that picked a claimed region asks to join.
  // Both routes run this one list so a new step can't land in only one.
  // Best effort: a hiccup mustn't fail the verification or the reset, and
  // the next click (or support) can redo it. Returns how many claims went
  // live, which verify-email uses to pick what to say next.
  async function afterInboxProven(userId) {
    const opened = await claims.activateForUser(pool, userId, { push, email: { sendClaimEmail } })
      .catch((err) => { console.error("[Claim Activate Error]", err.message); return 0; });
    await clubApprovals.submitForUser(pool, userId, { push, email: { sendNoticeEmail } })
      .catch((err) => console.error("[Club Submit Error]", err.message));
    await clubApprovals.askRegionsForUser(pool, userId)
      .catch((err) => console.error("[Club Region Ask Error]", err.message));
    return opened;
  }

  // Verify email: clicked from the link sent at registration.
  // Single-use via the email_verified_at column, once stamped,
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
        `UPDATE users u SET email_verified_at = COALESCE(u.email_verified_at, now())
           FROM users prev
          WHERE u.id = $1 AND prev.id = u.id AND u.deleted_at IS NULL
          RETURNING prev.email_verified_at IS NULL AS fresh,
                    (SELECT o.status FROM organisations o WHERE o.id = u.org_id) AS org_status`,
        [decoded.sub],
      );
      if (!r.rows.length) {
        return res.status(400).json({ error: "Verification link is invalid" });
      }
      const { fresh, org_status: orgStatus } = r.rows[0];
      const opened = await afterInboxProven(decoded.sub);
      // Welcome mail only once, and only when they can actually sign in.
      // A pending federation hears from us when it's approved instead.
      if (fresh && orgStatus === "active") sendWelcomeEmail(decoded.sub).catch(() => {});
      // Tells the page what to say next. A claimant can sign in straight
      // away (as a spectator) while their claim runs. A denied federation
      // (or one pulled later) is 'suspended', and nobody's going to email
      // that one about a review, so it gets its own answer.
      const next = orgStatus === "pending" ? "org_pending"
        : orgStatus !== "active" ? "org_suspended"
          : opened ? "claim_open" : "sign_in";
      res.json({ ok: true, next });
    } catch (err) {
      console.error("[Verify Email Error]", err.message);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // Send a fresh verification link. The one from sign-up lasts 24 hours
  // and mail gets lost, and before this the only way back in was to
  // register again (which the unique username/email then refused).
  //
  // Takes a username or an email, answers ok either way so it can't be
  // used to find out who's registered, and only ever mails the address
  // already on the account. The per-account cooldown stops someone
  // using it to flood an inbox from lots of IPs.
  const resendCooldown = new Map();
  const RESEND_COOLDOWN_MS = 60 * 1000;
  router.post("/api/auth/resend-verification", authLimiter, async (req, res) => {
    const { username, email } = req.body || {};
    try {
      const who = typeof username === "string" && username.trim() ? username.trim()
        : typeof email === "string" && email.trim() ? email.trim() : "";
      if (!who || who.length > 320) return res.json({ ok: true });
      const u = await pool.query(
        `SELECT id FROM users
          WHERE (username = $1 OR lower(email) = lower($1))
            AND email_verified_at IS NULL AND deleted_at IS NULL AND email IS NOT NULL
          LIMIT 1`,
        [who],
      );
      const id = u.rows[0]?.id;
      const last = id && resendCooldown.get(id);
      if (id && !(last && Date.now() - last < RESEND_COOLDOWN_MS)) {
        resendCooldown.set(id, Date.now());
        if (resendCooldown.size > 5000) resendCooldown.clear();
        const link = mintVerifyToken(id);
        setImmediate(() => {
          sendVerifyEmailEmail(id, link, { req }).catch(() => {});
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Resend Verification Error]", err.message);
      res.json({ ok: true });
    }
  });

  // Register a new organisation + its founding org_admin
  router.post("/api/auth/register-org", authLimiter, async (req, res) => {
    if (!signupsOpen()) {
      return res.status(403).json({ error: "Account creation is coming soon.", code: "signups_disabled" });
    }
    const { org_name, country_code, slug, username, password, full_name, email, region_code, website } =
      req.body || {};

    // Apply the same input validation we run on /api/auth/register.
    // Without these checks the org-founding flow accepted blank
    // passwords, missing emails, and CR/LF-laced names, and every
    // pending org seeded a row that a sysadmin clicking Approve
    // turned into a 0-character-password active account.
    const cleanOrgName  = safeText(org_name, 100);
    const cleanFullName = safeText(full_name, 100);
    const cleanSlug     = safeText(slug, 60);
    const cleanUsername = safeText(username, 50);
    if (!cleanOrgName)  return res.status(400).json({ error: "Organisation name is required" });
    if (!cleanFullName) return res.status(400).json({ error: "Full name is required" });
    // The slug is made from the name further down, the form stopped
    // asking for it. Older clients (and the test fixtures) still send one,
    // and that's fine as long as it's URL-safe: slugs end up in public
    // URLs, so no `/`, `..`, percent-bytes or HTML-ish payloads that some
    // future deep-link might not escape.
    if (cleanSlug && !/^[a-z0-9-]{2,60}$/.test(cleanSlug)) {
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
        || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    // Country is required, alpha-3 only. Signups find their federation by
    // country (/api/orgs/by-country), so an org registered without one, or
    // with a 2-letter code, was an org nobody could ever join.
    if (typeof country_code !== "string" || !/^[A-Z]{3}$/.test(country_code)) {
      return res.status(400).json({
        error: "Pick your organisation's country (a 3-letter ISO code such as AUS)",
        code: "country_required",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Phase 3 (migration 089): a federation or state body from a real
      // country always claims what's there rather than starting a second,
      // parallel org (there's no merge). That's the country account clubs
      // started, a region of it, or, when nobody from the country is on
      // DivingHQ yet, a country account started right here for them to
      // claim (DivingHQ reviews that one, there's nobody else to vote). The
      // claimant gets an ordinary account in that org and takes over only
      // once the claim passes. lib/claims.js has the rules.
      //
      // Only a code that isn't in the catalogue still gets the old pending
      // org below. Signups can't reach it by country, so it can't split one.
      const country = countryByCode(country_code);
      const regionCode = typeof region_code === "string" ? region_code.trim().toUpperCase() : "";
      if (country) {
        const orgs = await countryOrgs(client, country, "active");
        const unclaimedOrg = orgs.find((o) => o.claim_state === "unclaimed");
        const claimedOrgs = orgs.filter((o) => o.claim_state === "claimed");
        // Callers `return await` this. Without the await, the finally below
        // hands the client back to the pool while the ROLLBACK is still
        // running, and a ROLLBACK that fails never reaches the catch.
        const refuse = async (status, body) => {
          await client.query("ROLLBACK");
          return res.status(status).json(body);
        };
        let target;
        if (regionCode) {
          let orgRow = unclaimedOrg || (claimedOrgs.length === 1 ? claimedOrgs[0] : null);
          if (!orgRow) {
            if (claimedOrgs.length > 1) {
              return await refuse(409, { error: `Several federations share this country on DivingHQ. Contact ${supportContact()} to claim your region.`, code: "claim_needs_support" });
            }
            // Nobody from this country is here yet. Start its account so
            // the state body has something to claim a region of.
            const found = await resolveCountryOrg(client, country);
            if (found.pending) return await refuse(409, federationPendingBody(country));
            if (found.closed || found.choose) {
              return await refuse(409, { error: `Contact ${supportContact()} to claim your region.`, code: "claim_needs_support" });
            }
            orgRow = { id: found.id, claim_state: found.claim_state };
          }
          if (orgRow.claim_state === "unclaimed") await materializeRegions(client, orgRow.id, country.a3);
          const rg = (await client.query(
            "SELECT id, claim_state FROM regions WHERE org_id = $1 AND short_code = $2",
            [orgRow.id, regionCode],
          )).rows[0];
          if (!rg) {
            return await refuse(400, { error: "That region isn't set up on DivingHQ for this country", code: "region_unknown" });
          }
          // A claimed region whose admins have all gone (removed by the
          // sysadmin, or every one of them deleted their account) has
          // nobody who can run it or add anyone, so it's open to a fresh
          // claim rather than stuck until support steps in. Approval
          // just stamps claimed_name again and adds the new admin.
          if (rg.claim_state === "claimed" && (await liveAdminCount(client, "region", rg.id)) > 0) {
            return await refuse(409, { error: `That region already has its body on DivingHQ. If that's wrong, contact ${supportContact()}.`, code: "already_claimed" });
          }
          target = { kind: "region", id: rg.id, orgId: orgRow.id };
        } else {
          let orgId = unclaimedOrg?.id;
          if (!orgId && claimedOrgs.length) {
            return await refuse(409, {
              error: `${claimedOrgs[0].name} already runs ${country.name} on DivingHQ. `
                + `A state or regional body can claim its region instead. Otherwise, contact ${supportContact()}.`,
              code: "already_claimed",
            });
          }
          if (!orgId) {
            const found = await resolveCountryOrg(client, country);
            if (found.pending) return await refuse(409, federationPendingBody(country));
            if (found.closed || found.choose || found.claim_state !== "unclaimed") {
              return await refuse(409, { error: `Contact ${supportContact()} to register for ${country.name}.`, code: "claim_needs_support" });
            }
            orgId = found.id;
          }
          target = { kind: "org", id: orgId, orgId };
        }

        const hash = await bcrypt.hash(password, 12);
        const claimant = (await client.query(
          "INSERT INTO users (username, password, full_name, email, org_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
          [cleanUsername, hash, cleanFullName, email, target.orgId],
        )).rows[0].id;
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
          [claimant, target.orgId],
        );
        const claim = await claims.openClaim(client, {
          targetKind: target.kind, targetId: target.id, orgId: target.orgId,
          claimantId: claimant, claimantEmail: email, bodyName: cleanOrgName,
          website: safeText(website, 255),
        });
        await client.query("COMMIT");
        // Whoever held an unverified claim on the same target hears it
        // was replaced. Awaited like verify-email's notices, but a failed
        // send doesn't undo a claim that's already committed.
        await claims.deliver({ push, email: { sendClaimEmail } }, claim.notices)
          .catch((err) => console.error("[Claim Notice Error]", err.message));

        // The claim goes live (and voters hear about it) when this link
        // is clicked, see the verify-email handler.
        sendVerifyEmailEmail(claimant, mintVerifyToken(claimant), { req }).catch(() => {});
        const who = {
          clubs:    "the clubs already on DivingHQ there vote on it",
          regions:  "the states and provinces already on DivingHQ vote on it",
          parent:   "your federation decides",
          sysadmin: "DivingHQ reviews it",
        }[claim.approver];
        return res.status(201).json({
          message: `Verify your email to open your claim. Then ${who}.`,
          claim_id: claim.id,
          approver: claim.approver,
          target_kind: target.kind,
        });
      }

      // A slug the client sent is theirs to keep, so a clash is their 400.
      // One we made up just gets a short suffix until it's free.
      const baseSlug = cleanSlug || slugFromName(cleanOrgName, `org-${country_code.toLowerCase()}`);
      let orgId = null;
      for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
        const candidate = attempt === 0 ? baseSlug : `${baseSlug}-${crypto.randomBytes(2).toString("hex")}`;
        const ins = await client.query(
          `INSERT INTO organisations (name, country_code, slug, status) VALUES ($1,$2,$3,'pending')
           ON CONFLICT (slug) DO NOTHING RETURNING id`,
          [cleanOrgName, country_code, candidate],
        );
        orgId = ins.rows[0]?.id || null;
        if (cleanSlug) break;
      }
      if (!orgId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "That organisation slug is already taken" });
      }

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
      // unable to log in (the login gate in /api/auth/login refuses
      // bcrypt-correct credentials when email_verified_at IS
      // NULL). The operational workaround was for a sysadmin to
      // UPDATE-stamp email_verified_at directly, bypassing
      // proof-of-inbox-control on the highest-privilege account
      // in a fresh tenant.
      sendVerifyEmailEmail(userId, mintVerifyToken(userId), { req }).catch(() => {});
      // Sysadmins otherwise have no signal that a new org is
      // sitting in the pending queue other than polling the
      // dashboard. Without this, an org can sit unapproved
      // indefinitely with nobody aware it's waiting.
      sendNewOrgRequestEmail(cleanOrgName).catch(() => {});
      // And the same heads-up in-app, fire and forget.
      sysadminIds(pool)
        .then((userIds) => notices.deliver({ push }, [{
          userIds,
          category:   "org_pending",
          title:      `${cleanOrgName} is awaiting approval`,
          body:       "A new federation registered and needs a system admin to review it.",
          data:       { org_id: orgId, org_name: cleanOrgName },
          action_url: "/users",
          email:      false,
        }], { tag: "Org Pending Notification Skipped" }))
        .catch((err) => console.error("[Org Pending Notification Skipped]", err.message));

      res
        .status(201)
        .json({
          message: "Organisation registered. Check your email for a verification link before signing in.",
          org_id: orgId,
        });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof claims.ClaimError) {
        return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      }
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
      await bumpTokenVersion(client, user.id);
      await client.query("COMMIT");
      sendPasswordChangedEmail(user.id).catch(() => {});
      await sendSession(req, res, user.id, { before: { ok: true } });
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
    // Accept-Language", symmetric with the column being NULLable.
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
      await sendSession(req, res, req.user.id, {
        before: { ok: true, locale: cleared ? null : raw },
      });
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
  //        Auth: none, the token IS the credential
  //        Effect: swaps users.email = pending_email, clears the
  //                pending_* columns, bumps token_version (forces
  //                re-login on every other session), sends a
  //                hygiene notice to the OLD address.
  //
  // Why DB-backed token (and not the JWT-fingerprint pattern
  // /forgot-password uses): we need to carry the new address
  // between request and confirm without baking it into a JWT
  // payload that would land in mailer transcripts. The DB
  // overwrite also gives us "re-issuing supersedes" for free,
  // since the new row write invalidates any earlier in-flight token
  // without a seperate revocation column.
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
        || !EMAIL_RE.test(new_email)) {
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

      // Uniqueness check: soft, racy by design. The DB constraint
      // (if any) would catch a true race at confirm time, but a
      // pre-check here gives a clean 409 instead of a 500. Compare
      // case-insensitively because email addresses are case-folded
      // in practice, and we don't want two accounts to differ only
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

      // Fire-and-forget the send so a stuck mail API can't hold
      // the request open. The user sees an immediate "check your
      // inbox" response either way.
      //
      // Capture req at schedule time: setImmediate runs after the
      // request lifecycle but our translator only reads
      // req.user.locale + headers['accept-language'], both of which
      // are plain strings, so it's safe to hold a reference.
      setImmediate(() => {
        sendEmailChangeVerify(req.user.id, normalisedNew, token, { req }).catch(() => {});
      });

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
      // change / 2FA toggle: a session that's been resting on the
      // old email shouldn't keep going on the new one without an
      // explicit sign-in.
      await bumpTokenVersion(client, user.id);
      await client.query("COMMIT");

      // Hygiene notice goes to the OLD address; if someone hijacked
      // the session and rotated the email, this is the original
      // owner's signal to lock down their account.
      if (oldEmail) {
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
    // also do equal work in both branches and dispatch the email fully
    // out-of-band (setImmediate) so the email-send latency doesn't
    // leak through the response time either.
    try {
      // Migration 053: deleted users have email = NULL, so they won't
      // match anyway, but resetAccountsFor filters deleted_at too so the
      // constant-time response shape doesn't depend on whether a
      // tombstoned row exists.
      const users = await resetAccountsFor(pool, email);
      for (const user of users) {
        if (!user.email) continue;
        const fingerprint = mintResetToken(user.id, hashFingerprint(user.password));
        // Defer the mail API round-trip so the response time doesn't
        // depend on whether we found a user. The catch is swallowed
        // intentionally, we never tell the caller about delivery.
        // Pass `req` so the email lands in the locale the user's
        // current browser is configured for (forgot-password is
        // unauthenticated so we can't use req.user.locale here;
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
      await withTx(pool, async (client) => {
        // Following a reset link proves the inbox as well as a verify
        // link does, so someone who lost the sign-up mail isn't stuck.
        await client.query(
          "UPDATE users SET password = $1, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2",
          [hash, user.id],
        );
        await bumpTokenVersion(client, user.id);
      });
      sendPasswordChangedEmail(user.id).catch(() => {});
      await afterInboxProven(user.id);
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
module.exports.resetAccountsFor = resetAccountsFor;
module.exports.slugFromName = slugFromName;
