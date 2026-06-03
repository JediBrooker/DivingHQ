// =============================================================
// DIVING APP — SERVER v2
// Express + Socket.IO + PostgreSQL
// Multi-tenant RBAC with org-scoped roles
//
// AGENT NAVIGATION
// ----------------
// Each section is tagged with [SECTION: NAME] so an agent can jump
// to it via Cmd-F / grep. Order below mirrors the file's reading
// flow top-to-bottom. Read AGENTS.md alongside this file for the
// invariants (JWT shape, sysadmin bypass, org-resource cross-checks).
//
//   [SECTION: BOOTSTRAP]              app + io setup, helmet, limiters
//   [SECTION: EMAIL]                  nodemailer + send-* helpers
//   [SECTION: DB POOL & JWT_SECRET]   pool config, fail-closed secret
//   [SECTION: MIDDLEWARE]             verifyToken, requireOrgRole,
//                                     requireEventManager, requireSystemAdmin,
//                                     ensureEventOrgGate, isInSameOrg,
//                                     parseDateRange, isValidScore
//   [SECTION: TOKEN PAYLOAD]          buildTokenPayload (JWT shape)
//   [SECTION: ROUTES — ORGANISATIONS] /api/orgs/*, /api/clubs/*
//   [SECTION: ROUTES — TEAMS]         /api/teams/*, /api/events/:id/teams
//   [SECTION: ROUTES — COACH]         /api/coach/*
//   [SECTION: ROUTES — USERS]         /api/users/*, /api/role-requests/*
//   [SECTION: ROUTES — MEETS]         /api/meets/*
//   [SECTION: ROUTES — SESSIONS]      /api/meets/:id/sessions, schedule.ics
//   [SECTION: ROUTES — EVENTS]        /api/events (CRUD + status)
//   [SECTION: ROUTES — STAGE ADVANCE] /api/events/:id/advance (top-N)
//   [SECTION: ROUTES — TEMPLATES]     /api/orgs/:id/event-templates
//   [SECTION: ROUTES — JUDGES]        /api/events/:id/judges
//   [SECTION: ROUTES — CONTROL ROOM]  /api/events/:id/roster + reorder + DNS
//   [SECTION: ROUTES — SCOREBOARD]    public scoreboard, score corrections
//   [SECTION: MEET HOLD STATE]        in-memory hold map
//   [SECTION: ROUTES — DIVE TEMPLATES] /api/dive-list-templates/*
//   [SECTION: ROUTES — COMPETITOR]    /api/competitor/submit-list
//   [SECTION: ROUTES — DIVE DIRECTORY] /api/dive-directory
//   [SECTION: ROUTES — DIVER PROFILE] /api/divers/:id/profile, /analytics
//   [SECTION: ROUTES — AUDIT LOG]     /api/events/:id/score-audit
//   [SECTION: SOCKET ENGINE]          io.use, submit_score, referee_*,
//                                     meet_hold/resume, set_active_diver
//   [SECTION: ROUTES — ARCHIVE]       /api/archive
//   [SECTION: ROUTES — PDF EXPORT]    /api/events/:id/results.pdf, /program.pdf
//   [SECTION: SPA FALLBACK]           static + history-API rewrite
//   [SECTION: START]                  server.listen (skipped under require())
// =============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const logger = require("./lib/logger");
const metrics = require("./lib/metrics");

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// [SECTION: BOOTSTRAP]
const app = express();

// Time every request and emit a Prometheus histogram + counter.
// Mounted FIRST so it captures even helmet/cors short-circuits.
app.use(metrics.httpMetricsMiddleware);

// Trust the immediate reverse proxy (Cloudflare / Nginx / etc).
// Without this:
//   * express-rate-limit warns "X-Forwarded-For is set but trust
//     proxy is false" on every request and rate-limits all users
//     by the proxy IP (= one shared bucket).
//   * req.ip is the proxy address, not the real client.
// `1` trusts ONE hop — exactly what's wanted behind a single
// edge proxy. Override via TRUST_PROXY env if you need more
// hops (or set to 'false' for a no-proxy setup).
const TRUST_PROXY = process.env.TRUST_PROXY ?? "1";
app.set("trust proxy", TRUST_PROXY === "false" ? false
  : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY)
  : TRUST_PROXY);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

// Standard HTTP-security headers. The SPA is served via the same
// origin as the API, so one CSP covers both.
//
// We start from helmet's default CSP (default-src 'self', object-src
// 'none', script-src 'self', style-src 'self' https: 'unsafe-inline',
// frame-ancestors 'self', etc.) and override the few directives the
// app actually needs:
//
//   * connect-src — adds ws:/wss: so Socket.IO upgrades aren't
//     blocked (helmet's default-src 'self' only covers HTTP fetches).
//   * img-src     — adds blob: alongside data: + 'self' for the
//     sharp-rendered OG cards and QR data URIs.
//
// The Vite build emits no inline <script> tags — the only inline
// element in dist/index.html is a <link rel="stylesheet"> — so
// strict script-src 'self' works without a nonce or hash list.
// In test mode (RATE_LIMIT_DISABLED=true), drop the
// upgrade-insecure-requests CSP directive. Production unaffected.
//
// Why: the local Playwright webServer only listens on HTTP, but
// WebKit obeys upgrade-insecure-requests by silently rewriting
// every asset URL from http://127.0.0.1:3097 to https://...
// which then fails with a TLS error and the SPA never mounts.
// Chromium has a localhost exemption so the existing chromium
// tests aren't affected; WebKit doesn't. Keeping the directive
// disabled in production-style runs (where HTTPS is real and
// the upgrade is a no-op) avoids the routing complexity that
// would otherwise be needed in test/e2e/mobile-safari.spec.js.
const cspDirectives = {
  "connect-src": ["'self'", "ws:", "wss:"],
  "img-src": ["'self'", "data:", "blob:"],
};
if (process.env.RATE_LIMIT_DISABLED === "true") {
  cspDirectives["upgrade-insecure-requests"] = null;
}
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: cspDirectives,
  },
  // Skip HSTS in test mode for the same reason — HSTS would
  // make WebKit upgrade on subsequent visits even with CSP
  // disabled.
  strictTransportSecurity: process.env.RATE_LIMIT_DISABLED !== "true",
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: CORS_ORIGIN }));
// Bound the JSON body size — the largest legitimate payload is the
// CSV roster import, which never approaches 256kb. Anything bigger
// is either a bug or an abuse attempt.
app.use(express.json({ limit: "256kb" }));

// Migration 052: server-side i18n. Attaches req.t + req.locale so
// any downstream handler can produce localized error messages,
// email subjects, and PDF column headers. Resolution order:
//   1. req.user.locale  (decoded by verifyToken further down the chain)
//   2. Accept-Language header
//   3. 'en' fallback
// Mounted before the routers so every handler sees req.t.
app.use(require("./lib/server-i18n").middleware());

// Rate-limit bypass for the e2e + integration suites. Both run
// every request from 127.0.0.1, which under the production
// settings (20 auth requests / 15 min / IP) trips the limiter
// after a handful of register/login calls and leaves the rest of
// the suite seeing 429s. Setting RATE_LIMIT_DISABLED=true in the
// test webServer env disables the limiters at module load — no
// effect on the deployed app where the env var is unset.
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === "true";
const skipWhenDisabled = () => RATE_LIMIT_DISABLED;

// 20 requests / 15 min / IP for auth + password flows. Tight enough
// to slow brute-force, loose enough that a real user fat-fingering
// their password a couple of times isn't locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: "Too many attempts, please try again in 15 minutes." },
  skip: skipWhenDisabled,
});

// Heavier limiter for the bulk-write endpoints (CSV roster import,
// dive-list submission). Mostly to prevent a logged-in but malicious
// user from looping these to lock tables.
const bulkWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many bulk-write attempts, please slow down." },
  skip: skipWhenDisabled,
});

// Export-class endpoints (PDF program / results, results.csv,
// archive listing, OG-card render). These are anonymous-readable
// and individually expensive (PDFKit, sharp, multi-CTE aggregates),
// so without a limiter a single anonymous client can saturate the
// event loop with a few dozen RPS. Per-IP cap is intentionally
// generous so a federation kiosk legitimately downloading every
// program in the lobby still works.
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many export requests, please try again shortly." },
  skip: skipWhenDisabled,
});

// Search-class read endpoints (diver search, paginated diver
// browse). Authenticated but every signed-in user can call them,
// which means a freshly-registered spectator can enumerate the
// federation roster at full speed without this. 60/min/IP is
// well clear of legitimate typeahead use (debounced at ~180ms
// per the SPA = ~5 RPS at most).
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many search requests, please slow down." },
  skip: skipWhenDisabled,
});

// =============================================================
// EMAIL
// [SECTION: EMAIL]
// =============================================================
// Every send-* helper lives in lib/email.js. Built lazily after
// the pool is ready (see below) so the factory has its dependency.

// Serve the built Vue app (run `npm run build` before starting the server)
app.use(express.static(path.join(__dirname, 'dist')))

// [SECTION: DB POOL & JWT_SECRET]
//
// Connection precedence:
//   1. DATABASE_URL  (preferred for hosted Postgres / single-string envs)
//   2. DB_*          (the app's documented vars in .env.example)
//   3. PG*           (libpq standard, used by CI's Postgres service)
//
// node-postgres falls back to libpq env vars when a config field is
// undefined, so the explicit DB_*-then-PG* coalesce below is mostly
// belt-and-braces — but it makes the precedence visible to anyone
// debugging a connection error.
// `application_name` is propagated to pg_stat_activity. Setting
// distinct values on the writer + reader pools lets an operator
// tell from a `SELECT application_name FROM pg_stat_activity`
// query which side of the wiring served any given connection —
// invaluable when verifying read-replica routing.
const POOL_APP_NAME_WRITER = "dive-recorder-writer";
const POOL_APP_NAME_READER = "dive-recorder-reader";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: POOL_APP_NAME_WRITER,
    })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
      application_name: POOL_APP_NAME_WRITER,
    });

// -------------------------------------------------------------
// Optional read replica
// -------------------------------------------------------------
// When DATABASE_READ_URL is set, heavy read paths (analytics,
// archive listing, per-event recap) route to a Postgres streaming
// replica so they don't contend with live writes on the primary.
// Live-scoring reads (scoreboard, attendance, queue) intentionally
// stay on the primary — replication lag (typically <1s but
// variable) is acceptable for "what was the diver's PB last year"
// but not for "did my score just land?"
//
// Falls back to the primary when DATABASE_READ_URL isn't set, so
// single-node deployments keep working with no config change. The
// factory pattern means a route's code is identical regardless of
// whether the dep is the writer or a replica.
const readPool = process.env.DATABASE_READ_URL
  ? new Pool({
      connectionString: process.env.DATABASE_READ_URL,
      application_name: POOL_APP_NAME_READER,
    })
  : pool;
if (readPool !== pool) {
  logger.info({ host: new URL(process.env.DATABASE_READ_URL).host },
    "read replica configured");
}

// Refuse to boot with no JWT secret or the well-known placeholder —
// either case means tokens are trivially forgeable. We DON'T fail on
// short-but-unique secrets: existing deployments may have a working
// 12-20 char string set, and crashing those on upgrade is worse than
// nudging them to rotate. We do print a loud warning so it shows up
// in PM2 logs and the operator can fix it on their next pass.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === "change_this_secret_in_production") {
  console.error(
    "FATAL: JWT_SECRET must be set in the environment to a strong random value. Refusing to start.",
  );
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.warn(
    `[security] JWT_SECRET is only ${JWT_SECRET.length} chars. Rotate to ≥32 random chars when convenient — short secrets are easier to brute force.`,
  );
}
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

// =============================================================
// MIDDLEWARE
// [SECTION: MIDDLEWARE]
//
// All middleware + security helpers live in lib/middleware.js so
// the auth/RBAC perimeter can be reviewed as a single unit. See
// AGENTS.md for the invariants. Don't add new gates inline here —
// add them to lib/middleware.js and re-export.
// =============================================================
const {
  verifyToken,
  optionalAuth,
  requireOrgRole,
  requireSystemAdmin,
  requireEventManager,
  ensureEventOrgGate,
  ensureEventPreMeet,
  isInSameOrg,
  socketRequireRole,
  socketCanManageEvent,
  isValidScore,
  parseDateRange,
  bumpTokenVersion,
  invalidateTokenVersion,
  isTokenVersionCurrent,
  loadEventForEntries,
  requireTotpForPrivilegedRoles,
} = require("./lib/middleware")({ pool, JWT_SECRET });

// Convenience aliases — defined once so a typo can't drift the
// role tuple across 20+ route mountings. Used throughout.
//
// Each is an array of middleware (Express accepts arrays anywhere
// a single function is accepted, so the call sites that take
// these as factory deps don't need to know). The TOTP gate is
// pre-wired but no-ops unless TOTP_REQUIRED_FOR_ADMINS=true is
// set in the env — see lib/middleware.js for the rollout
// rationale.
const requireMeetEditor = [
  requireOrgRole(["org_admin", "meet_manager"]),
  requireTotpForPrivilegedRoles,
];
const requireOrgAdmin = [
  requireOrgRole(["org_admin"]),
  requireTotpForPrivilegedRoles,
];

// Email helpers — moved into lib/email.js. Factory takes the pool
// so the test runner can swap it. Every helper is best-effort and
// silently no-ops when SMTP_HOST isn't set (dev-mode default).
const {
  hashFingerprint,
  sendRoleDecisionEmail,
  sendPasswordResetEmail,
  sendVerifyEmailEmail,
  sendPasswordChangedEmail,
  sendEmailChangeVerify,
  sendEmailChangedNotice,
  sendWelcomeEmail,
  sendNewRoleRequestEmail,
  sendEventStartedEmails,
  sendEventResultsEmails,
} = require("./lib/email")({ pool });

// Scoreboard cache — short-TTL bucket per eventId. The HTTP
// scoreboard route reads/writes via .get/.set; the socket
// submit_score handler and the HTTP score-correction handler
// both invalidate the bucket on commit so the next reader
// rebuilds. Without this, every connected scoreboard re-runs
// the same 7-table standings query after every score event.
// Defined here (before any route mount) so both consumers can
// take it via dependency injection.
const scoreboardCache = require("./lib/scoreboard-cache")();

// Live state — activeDivers (current performer per event) +
// meetHolds (per-event hold reason). Shared by
// routes/events.js (PUT /:id/status clears them on Completed),
// routes/socket.js (set/get from set_active_diver, meet_hold),
// and any future handler that needs to read live state.
//
// Backed by the `event_live_state` table (migration 034) — the
// in-memory maps are a write-through cache rebuilt from the
// DB on boot via init(pool), so a server restart mid-meet
// doesn't wipe the live state.
const liveState = require("./lib/live-state");
const {
  activeDivers,
  meetHolds,
  persistActiveDiver,
  persistMeetHold,
  persistClearMeetHold,
  persistClearAll,
} = liveState;

// Reusable push engine — wires Web Push (when VAPID is set) plus
// in-app socket banners. Created here so route modules mounted
// further down can inject it as a dependency. The socket attach
// further down picks up the same instance to handle per-user
// rooms + notification:ack.
const push = require("./lib/push")({ pool, io });

// =============================================================
// HELPER — Build JWT payload
// [SECTION: TOKEN PAYLOAD]
// =============================================================
async function buildTokenPayload(userId) {
  const u = await pool.query(
    "SELECT id, username, full_name, org_id, is_system_admin, token_version, locale FROM users WHERE id = $1",
    [userId],
  );
  if (!u.rows.length) throw new Error("User not found");
  const user = u.rows[0];

  const r = await pool.query(
    "SELECT role FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
    [user.id, user.org_id],
  );
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    org_id: user.org_id,
    org_roles: r.rows.map((x) => x.role),
    is_system_admin: user.is_system_admin,
    // Stamped on every issued JWT. verifyToken (lib/middleware.js)
    // rejects any token whose `tv` is older than the current row.
    // Bumping users.token_version invalidates every outstanding
    // session for that user — used by role grant/revoke and the
    // password change flow (Migration 021).
    tv: user.token_version,
    // Migration 052: per-user locale. Null when the user has never
    // set one — the server falls back to Accept-Language; the SPA
    // falls back to whatever localStorage has remembered. Stamped
    // on the JWT (not just the response body) so resolveLocale in
    // lib/server-i18n.js can find it on every subsequent authed
    // request without a DB round-trip.
    locale: user.locale || null,
  };
}

// =============================================================
// =============================================================
// HEALTH CHECK
// [SECTION: ROUTES — HEALTH]
// =============================================================
// Cheap public-readable health probe used by deploy.sh and any
// external uptime monitor. Confirms two things:
//   * the process is up and serving HTTP
//   * the DB pool can issue a trivial query (catches the case
//     where the process bound a port but Postgres is wedged or
//     unreachable, which a port-only liveness check would miss).
//
// 200 + { ok: true, schema_version } when both pass. 503 + { ok:
// false } if the DB query throws — the deploy script can refuse
// to advance past restart on that signal. No auth: monitors and
// load balancers shouldn't need a credential.
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query(
      "SELECT version FROM public.schema_meta WHERE id = 1",
    );
    res.json({
      ok: true,
      schema_version: r.rows[0]?.version ?? null,
    });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// =============================================================
// METRICS — Prometheus scrape target
// =============================================================
// `text/plain; version=0.0.4` (the prom-client default) is the
// content-type Prometheus expects. The payload contains operational
// counters only (no PII), but route names and request volume are
// still operational intel worth not handing out anonymously.
//
// Auth model — opt-in, back-compat:
//   * METRICS_TOKEN unset (default): no auth gate. Same behaviour
//     as before; relies on firewall / reverse-proxy ACL to keep
//     /metrics off the public internet. Suitable for single-node
//     deployments where Prometheus runs on localhost.
//   * METRICS_TOKEN set: requires `Authorization: Bearer <token>`.
//     Comparison is constant-time via crypto.timingSafeEqual so
//     a probing client can't binary-search the token.
//
// lib/metrics.js documents the cardinality discipline each metric
// follows.
const METRICS_TOKEN = process.env.METRICS_TOKEN || null;
function metricsAuthOk(req) {
  if (!METRICS_TOKEN) return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice(7);
  const a = Buffer.from(presented);
  const b = Buffer.from(METRICS_TOKEN);
  // timingSafeEqual requires equal-length buffers; the length
  // check itself is fine to leak (it's the expected token's length
  // and an attacker who controls METRICS_TOKEN already knows it).
  if (a.length !== b.length) return false;
  return require("node:crypto").timingSafeEqual(a, b);
}
app.get("/metrics", async (req, res) => {
  if (!metricsAuthOk(req)) {
    res.set("WWW-Authenticate", 'Bearer realm="metrics"');
    return res.status(401).end();
  }
  try {
    metrics.collectPoolStats(pool);
    res.set("Content-Type", metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  } catch (err) {
    logger.error({ err }, "metrics scrape failed");
    res.status(500).end();
  }
});

// =============================================================
// AUTH ROUTES
// Moved into routes/auth.js. The factory pattern lets this slice
// live in its own file without forcing every other slice (events,
// users, scoreboard, archive…) to be extracted at the same time.
// Subsequent batches can follow the same shape.
// =============================================================

app.use(
  require("./routes/auth")({
    pool,
    io,
    authLimiter,
    verifyToken,
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
  }),
);

// =============================================================
// ORGANISATION + CLUBS ROUTES
// [SECTION: ROUTES — ORGANISATIONS]
// /api/orgs/* and /api/clubs/* extracted into routes/orgs.js.
// /api/orgs/:id/divers (used by the synchro-partner picker)
// also lives there since it's a per-org listing.
// =============================================================
app.use(require("./routes/orgs")({
  pool,
  verifyToken,
  requireSystemAdmin,
  requireMeetEditor,
}));

// =============================================================
// TEAM ROUTES
// [SECTION: ROUTES — TEAMS]
// /api/orgs/:id/teams, /api/teams/*, team_members,
// /api/teams/:id/dive-lists, and the event_teams routes
// (/api/events/:id/teams[/...]) extracted into routes/teams.js.
// =============================================================
app.use(require("./routes/teams")({
  pool,
  requireMeetEditor,
  requireEventManager,
  bulkWriteLimiter,
  ensureEventOrgGate,
  isInSameOrg,
  loadEventForEntries,
}));

// =============================================================
// COACH ROUTES
// [SECTION: ROUTES — COACH]
// /api/coach/dashboard, /api/coach/divers, /api/orgs/:id/coach-links,
// /api/coach-links/:id extracted into routes/coach.js.
// =============================================================
app.use(require("./routes/coach")({
  pool,
  verifyToken,
  requireOrgAdmin,
  bulkWriteLimiter,
  loadEventForEntries,
}));

// =============================================================
// VENUE INTEGRATION ROUTES
// [SECTION: ROUTES — VENUE]
// /api/venue/scoreboard-state/:event_id — one-shot snapshot
// for hardware bridges (Daktronics, Colorado Time Systems, etc).
// Companion to the `venue.scoreboard_state` socket event
// emitted from routes/socket.js. See lib/venue-state.js for
// the canonical payload spec.
//
// Wrapped in searchLimiter (60/min/IP): the endpoint is anonymous
// and each call runs buildScoreboardState's aggregate CTEs over the
// event's scores, so without a cap a single client could saturate
// the read pool. 60/min is comfortably above a bridge's legitimate
// poll cadence (the socket subscribe_venue is the real-time path).
// =============================================================
app.use(searchLimiter, require("./routes/venue")({ pool }));

// Cross-org diver search + browse + orgs/all live in routes/
// diver-search.js — extracted to keep server.js manageable. See
// AGENTS.md for the modularisation plan.
app.use(searchLimiter, require("./routes/diver-search")({ pool, verifyToken }));

// =============================================================
// USER & ROLE MANAGEMENT ROUTES
// [SECTION: ROUTES — USERS]
// All seven endpoints + the role-mutation/token-bump plumbing
// extracted into routes/users.js.
// =============================================================
app.use(require("./routes/users")({
  pool,
  verifyToken,
  requireOrgAdmin,
  requireMeetEditor,
  bumpTokenVersion,
  sendRoleDecisionEmail,
  // Self-delete + claim endpoints (Migration 053) — rate-limited
  // so a hijacked session can't brute-force the password gate.
  bulkWriteLimiter,
  // Org-admin profile edit + account lifecycle (Migration 058).
  sendVerifyEmailEmail,
  sendPasswordResetEmail,
  hashFingerprint,
  JWT_SECRET,
}));

// Club-change requests + cross-org transfers (Migration 057).
app.use(require("./routes/club-changes")({ pool, verifyToken }));

// =============================================================
// MEET ROUTES
// [SECTION: ROUTES — MEETS]
// /api/orgs/:id/meets, /api/meets/*, /api/events/:id/meet
// extracted into routes/meets.js.
// =============================================================
app.use(require("./routes/meets")({
  pool,
  optionalAuth,
  requireMeetEditor,
  requireEventManager,
}));

// =============================================================
// SESSION SCHEDULER ROUTES
// [SECTION: ROUTES — SESSIONS]
// /api/meets/:meetId/sessions       — sessions + inlined blocks
// /api/meets/:meetId/schedule.ics   — public iCal feed
// Phase 1 is read-only; phase 2-4 (conflicts, manual edit, live
// re-flow) extend this same file. See docs/session-scheduler.md.
// =============================================================
app.use(require("./routes/sessions")({
  pool,
  optionalAuth,
  // Phase 2 wires the dismissal endpoints and the
  // schedule:conflict_dismissed socket emit; Phase 1 callers
  // only used { pool, optionalAuth } so passing these is
  // additive.
  requireMeetEditor,
  io,
}));

// =============================================================
// EVENT ROUTES
// [SECTION: ROUTES — EVENTS]
// CRUD + status transitions extracted into routes/events.js.
// loadEventForEntries (used here AND by the team dive-list +
// diver-portal submit handlers) lives in lib/middleware.js so a
// single helper is shared by all three callers.
// =============================================================
app.use(require("./routes/events")({
  pool,
  JWT_SECRET,
  io,
  verifyToken,
  requireOrgAdmin,
  requireOrgRole,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
  persistClearAll,
  // Push helper used by the international-invite flow to notify
  // an invited federation's admins. Optional — if push isn't
  // wired the events router falls back to a silent insert.
  push,
}));

// =============================================================
// EVENT STAFF — managers + judges + per-judge views
// [SECTION: ROUTES — EVENT STAFF]
// /api/events/:id/managers (CRUD), /api/events/:id/judges (panel
// CRUD), /api/events/:eventId/my-judge-number, /api/judge/my-events
// extracted into routes/event-staff.js.
// =============================================================
app.use(require("./routes/event-staff")({
  pool,
  requireOrgRole,
  requireMeetEditor,
  requireEventManager,
  ensureEventOrgGate,
  isInSameOrg,
}));

// =============================================================
// CONTROL ROOM ROUTES
// [SECTION: ROUTES — CONTROL ROOM]
// 10 endpoints — roster + reorder + randomise + check-in +
// late-entry + CSV import + public history — extracted into
// routes/control-room.js along with the local parseCsv helper.
// =============================================================
app.use(require("./routes/control-room")({
  pool,
  requireOrgRole,
  requireMeetEditor,
  bulkWriteLimiter,
  ensureEventOrgGate,
  // Cut 2 referee sign-off needs the push engine for the request
  // path + bcrypt/totp for the credential-fallback verification
  // path.
  push,
  bcrypt,
  totp: require("./lib/totp"),
}));

// =============================================================
// SCOREBOARD — public
// [SECTION: ROUTES — SCOREBOARD]
// Endpoints (/api/scoreboard/:eventId and /leaderboard) moved
// to routes/scoreboard.js. The dive-list-templates section
// below sits between the two original mounts and is kept here
// since it's per-diver state, not scoreboard-related.
// =============================================================

app.use(require("./routes/scoreboard")({
  pool,
  scoreboardCache,
  metrics,
  optionalAuth,
}));

// =============================================================
// SCORE CORRECTION + AUDIT LOG
// [SECTION: ROUTES — SCORE CORRECTION]
// PUT /api/scores/:id (manager / referee amends a score) and
// GET /api/events/:id/score-audit (audit trail) extracted into
// routes/score-correction.js. The HTTP correction handler also
// invalidates scoreboardCache and broadcasts a `score_corrected`
// socket event to the event's room — needs both io and the
// cache as factory deps.
// =============================================================
app.use(require("./routes/score-correction")({
  pool,
  io,
  scoreboardCache,
  requireOrgRole,
  requireEventManager,
}));

// =============================================================
// DASHBOARD BUNDLE
// [SECTION: ROUTES — DASHBOARD]
// /api/dashboard returns every role-scoped slice the dashboard
// view needs in one round trip — events, role requests,
// pending orgs, recent activity, judge events, coach divers.
// Replaces the previous fan-out of 5–6 separate API calls on
// dashboard mount.
// =============================================================
app.use(require("./routes/dashboard")({
  pool,
  verifyToken,
}));

// =============================================================
// FEDERATION-WIDE AUDIT
// [SECTION: ROUTES — AUDIT]
// /api/audit/scores + /api/audit/roles + /api/audit/recent —
// cross-event / cross-user audit views for org admins doing
// dispute investigations and compliance review. The per-event
// /api/events/:id/score-audit (inside score-correction.js) and
// per-user /api/users/:id/role-audit (inside users.js) remain
// for drill-down navigation.
// =============================================================
app.use(require("./routes/audit")({
  pool,
  requireOrgAdmin,
}));

// =============================================================
// LIVE STATE — activeDivers + meetHolds
// [SECTION: LIVE STATE]
// activeDivers + meetHolds are imported earlier in the file (just
// after the email helpers) because the events router mounts before
// this point and needs the references at module-load time. Re-exposed
// in this section header for grep-ability.
// =============================================================


// =============================================================
// DIVE LIST TEMPLATES
// [SECTION: ROUTES — DIVE TEMPLATES]
// Per-diver saved combinations (CompetitorView load/save)
// extracted into routes/templates.js.
// =============================================================
app.use(require("./routes/templates")({ pool, verifyToken }));

// =============================================================
// CONFLICT RESOLUTION (P1 stub)
// =============================================================
// Companion endpoint to the conflict_pending socket event
// (routes/socket.js submit_score). P1 stub returns 501; P4
// wires the actual write + audit-log path. See
// docs/offline-p1-design.md §4.
// =============================================================
app.use(require("./routes/conflicts")({
  pool, io, scoreboardCache, requireOrgRole,
}));

// =============================================================
// LATE-ARRIVAL REVIEW (P4)
// =============================================================
// Operator's tray for rows the deadline-with-review gate flagged
// (see lib/deadline-gate.js + DEC-04 in offline-inventory.md).
// Lists pending late-arrival rows + accepts approve/deny.
// =============================================================
app.use(require("./routes/late-arrivals")({ pool, requireOrgRole }));

// =============================================================
// MANUAL SCORE ENTRY (P5)
// =============================================================
// POST /api/scores/manual-entry — operator types each judge's
// score during a fallback episode (extended outage; judges
// showing values on phone screens). See docs/offline-p1-design.md
// §Phase 5.
// =============================================================
app.use(require("./routes/manual-scores")({
  pool, io, scoreboardCache, requireOrgRole,
}));

// =============================================================
// COMPETITOR ROUTES
// [SECTION: ROUTES — COMPETITOR]
// /api/competitor/submit-list extracted into routes/competitor.js.
// =============================================================
app.use(require("./routes/competitor")({
  pool,
  verifyToken,
  requireOrgRole,
  bulkWriteLimiter,
  loadEventForEntries,
  push,
}));

// =============================================================
// DIVE DIRECTORY
// [SECTION: ROUTES — DIVE DIRECTORY]
// /api/dive-directory extracted into routes/dive-directory.js.
// =============================================================
app.use(require("./routes/dive-directory")({ pool, verifyToken, requireOrgRole }));

// =============================================================
// DIVER PROFILE & HISTORY
// [SECTION: ROUTES — DIVER PROFILE]
// /api/divers/:id/profile, /analytics, and /api/users/me/dashboard
// extracted into routes/diver-profile.js along with the local
// canViewDiverProfile / canViewDiverPrivate helpers and the
// KNOWN_WIDGETS whitelist.
//
// Wrapped in searchLimiter (60/min/IP) to match its sibling
// judge-analytics: the /analytics endpoint is anonymous-readable
// and fans out ~12 multi-join aggregate CTEs per request, so an
// unauth client could otherwise saturate the read pool.
// =============================================================
app.use(searchLimiter, require("./routes/diver-profile")({
  pool,
  readPool,
  verifyToken,
  optionalAuth,
  parseDateRange,
}));

// =============================================================
// JUDGE ANALYSIS
// [SECTION: ROUTES — JUDGE ANALYTICS]
// /api/judges/:id/profile, /api/judges/:id/analytics, and
// /api/users/me/judge-dashboard. The analytics endpoint computes
// per-judge metrics referenced against the World Aquatics-trim
// kept mean for each dive (PART FOUR Article 13 trim rules) — the
// same "kept set" the dive-points formula uses, so a judge's
// deviation from it is the same signal an WA judges' assessor
// would compute by hand. See routes/judge-analytics.js for the
// permission model (judge sees own; org admins / managers /
// referees see same-org judges; sysadmin sees all).
// =============================================================
// AUDIT FIX (Medium-2): wrap the public judge-analytics router in
// searchLimiter. The /api/judges/:id/analytics endpoint fires 14
// SQL queries per request (each invokes the JUDGE_PER_DIVE CTE
// that scans scores ⨝ events ⨝ event_judges ⨝ competitor_dive_lists
// ⨝ dive_directory). The directory endpoint runs ILIKE + a LATERAL
// COUNT(*) over all scores. Both are public; without a limiter an
// unauth client can saturate the read pool. searchLimiter (60/min/
// IP) is well above any legitimate typeahead use of the directory.
app.use(searchLimiter, require("./routes/judge-analytics")({
  pool,
  readPool,
  verifyToken,
  optionalAuth,
  parseDateRange,
}));

// =============================================================
// RECORDS
// [SECTION: RECORDS]
// Moved into lib/records.js (Phase 2 of the server.js split).
// The factory exposes both checkAndApplyRecords (called from the
// socket submit_score handler when a dive completes) and a tiny
// Express router with the public GET /api/records endpoint. We
// destructure both here and mount the router immediately.
// =============================================================
const { checkAndApplyRecords, router: recordsRouter } =
  require("./lib/records")({ pool, verifyToken });
app.use(recordsRouter);

// =============================================================
// SOCKET ENGINE
// [SECTION: SOCKET ENGINE]
// Every io.use / socket.on handler lives in routes/socket.js.
// We hand it the dependencies it needs — pool, JWT_SECRET, the
// auth helpers, isValidScore, the records helper, the shared
// activeDivers / meetHolds maps from lib/live-state, and the push
// engine (the connection handler joins per-user rooms + accepts
// notification:ack messages).
// =============================================================
require("./routes/socket")({
  io,
  pool,
  JWT_SECRET,
  socketRequireRole,
  socketCanManageEvent,
  isValidScore,
  isTokenVersionCurrent,
  checkAndApplyRecords,
  activeDivers,
  meetHolds,
  persistActiveDiver,
  persistMeetHold,
  persistClearMeetHold,
  scoreboardCache,
  metrics,
  push,
});

// =============================================================
// WEB PUSH ROUTES
// [SECTION: ROUTES — WEB PUSH]
// /api/push/* + /api/notifications/* live in routes/push.js. The
// engine itself (lib/push.js) is shared with the socket layer +
// any feature that wants to fire a notification (referee sign-off,
// judge calls, "you're up next", ...).
// =============================================================
app.use(require("./routes/push")({ verifyToken, push }));

// Periodic expirer — cheap thanks to the partial index on
// (status, expires_at). Five-minute cadence is plenty: a
// stale-by-30-seconds row in the inbox isn't worth a tighter
// loop, and the engine refuses to re-dispatch expired rows
// regardless of when this fires.
setInterval(() => {
  push.expireOld().catch((err) =>
    console.error("[push expire]", err.message),
  );
}, 5 * 60 * 1000).unref();

// =============================================================
// RESULTS ARCHIVE
// [SECTION: ROUTES — ARCHIVE]
// /api/archive, /api/archive/clubs, /api/archive/:eventId/results
// extracted into routes/archive.js.
// =============================================================
app.use(exportLimiter, require("./routes/archive")({ pool, readPool }));

// =============================================================
// PDF + CSV EXPORT
// [SECTION: ROUTES — PDF EXPORT]
// 4 PDFs (program, start-list, score-sheet, results) + 1 CSV
// (per-dive results) extracted into routes/pdf.js along with
// the local csvCell / csvRow helpers and the World Aquatics trim
// annotation used by the score sheet.
// =============================================================
app.use(exportLimiter, require("./routes/pdf")({ pool }));

// =============================================================
// JUDGE RANKING ANALYSIS
// [SECTION: ROUTES — JUDGE RANKING]
// "What would the standings have been if every judge had scored
// unanimously like one specific judge?" Powers the in-page table
// + score-chip tooltip enhancement on Completed events, plus CSV
// + PDF exports for federation reporting. See routes/judge-
// ranking.js for the rationale (public read; v1 individual only).
// =============================================================
app.use(exportLimiter, require("./routes/judge-ranking")({ pool }));

// =============================================================
// PUBLIC DIVER PROFILE
// [SECTION: ROUTES — PUBLIC PROFILE]
// /api/public/divers/:public_slug (JSON) and /diver/:public_slug
// (server-rendered OG-tagged HTML for social-network crawlers,
// SPA fall-through for browsers). Mounted BEFORE the SPA static
// fallback so the crawler path can next() into it.
// =============================================================
app.use(exportLimiter, require("./routes/public-profile")({ pool, readPool }));

// =============================================================
// SPA FALLBACK — must come after all API routes
// [SECTION: SPA FALLBACK]
//
// Hard-refreshing /dashboard (or any client-side route) hits
// Express, not the Vue router. We send index.html so the SPA
// can boot and take over the route client-side. /api and
// /socket.io paths fall through so unknown API requests get a
// proper 404 below instead of an HTML page.
//
// (Express 5 dropped support for `app.get('*', ...)` in
// path-to-regexp v8, so we use middleware here.)
// =============================================================

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'), (err) => {
    if (err) next(err);
  });
});

// Final 404 for unmatched /api/* and non-GET requests, so they
// don't quietly succeed with HTML or a Vite dev page.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Not found');
});

// =============================================================
// START
// =============================================================

// Log schema version + run audit-log retention sweep at boot.
// Both queries are best-effort: a failure (e.g. running against
// an old DB that pre-dates migration 008) just logs a warning.
async function bootChecks() {
  // Rehydrate live-state cache from event_live_state. Best-
  // effort — if the table doesn't exist yet (DB pre-dates
  // migration 034) the helper logs and returns. After
  // rehydrate the in-memory maps reflect any meet that was
  // running when the previous server instance shut down.
  try {
    await liveState.init(pool);
  } catch (err) {
    logger.warn({ err: err.message }, "live-state rehydrate failed");
  }

  // Start the idempotency-keys TTL sweeper (migration 054).
  // Background interval inside this Node process; deletes rows
  // older than 72 hours every hour. Safe to call before any
  // route uses idempotency — if the table doesn't exist yet
  // the first sweep logs an error and the next deploy applies
  // the migration. See docs/offline-p1-design.md §2 for the
  // retention rationale.
  try {
    require("./lib/idempotency-sweeper").start({ pool });
  } catch (err) {
    logger.warn({ err: err.message }, "idempotency-sweeper start failed");
  }
  try {
    const v = await pool.query("SELECT version, applied_at FROM schema_meta WHERE id = 1");
    if (v.rows[0]) {
      logger.info(
        { schema_version: v.rows[0].version, applied_at: v.rows[0].applied_at },
        "schema_meta loaded",
      );
    } else {
      logger.warn("schema_meta has no rows — run migration 008");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "couldn't read schema_meta");
  }
  // Snapshot the past 24 h of audit rows to AUDIT_SNAPSHOT_DIR
  // BEFORE the purge runs, so legal-retention archives outlive
  // the 30-day DB window. No-op when AUDIT_SNAPSHOT_DIR isn't
  // set (dev / single-node deployments don't need it).
  if (process.env.AUDIT_SNAPSHOT_DIR) {
    try {
      await snapshotAuditTables();
    } catch (err) {
      logger.warn(
        { err: err.message },
        "audit snapshot failed; purge will continue",
      );
    }
  }
  try {
    const purge = await pool.query("SELECT * FROM purge_audit_logs(30)");
    const total = purge.rows.reduce((sum, r) => sum + Number(r.deleted_rows), 0);
    if (total > 0) logger.info({ deleted_rows: total }, "purged audit log");
  } catch (err) {
    logger.warn({ err: err.message }, "purge_audit_logs failed (run migration 008?)");
  }
}

// Daily snapshot — writes the past 24 h of audit rows to JSONL
// files in AUDIT_SNAPSHOT_DIR (one file per table per day).
// Called from bootChecks before the purge so the rows about to
// roll off the 30-day window survive externally. The operator
// is expected to push the dir to S3 / off-site backup via a
// separate cron / systemd job.
async function snapshotAuditTables() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = process.env.AUDIT_SNAPSHOT_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  for (const [table, file] of [
    ["score_audit_log", `score_audit_${stamp}.jsonl`],
    ["role_audit_log",  `role_audit_${stamp}.jsonl`],
    ["audit_log",       `audit_${stamp}.jsonl`],
  ]) {
    try {
      const r = await pool.query(
        `SELECT * FROM ${table} WHERE created_at >= $1 ORDER BY created_at`,
        [since],
      );
      const out = path.join(dir, file);
      // Append mode so multiple snapshots in the same day
      // accumulate rather than overwrite — dedupe is the
      // operator's problem if they run this manually.
      const stream = fs.createWriteStream(out, { flags: "a" });
      for (const row of r.rows) {
        stream.write(JSON.stringify(row) + "\n");
      }
      stream.end();
      if (r.rows.length) {
        logger.info(
          { table, file, rows: r.rows.length },
          "audit snapshot written",
        );
      }
    } catch (err) {
      logger.warn(
        { table, err: err.message },
        "audit snapshot failed for one table; continuing",
      );
    }
  }
}

// [SECTION: START]
const PORT = process.env.PORT || 3000;

// Only bind the port when this file is the entry point (i.e. node
// server.js or pm2 start server.js). When server.js is required by
// the integration test runner we skip listen() and instead export
// the app + server so the test can drive it without a side-effect
// listener that the process never closes.
if (require.main === module) {
  server.listen(PORT, () => {
    logger.info({ port: PORT }, "diving app started");
    bootChecks();
  });

  // -------- Graceful shutdown --------
  // SIGTERM (deploy script / Docker / pm2 reload) and SIGINT
  // (Ctrl-C in dev) drop us here. Without trapping these, Node
  // exits the process while in-flight HTTP requests are still
  // running, sockets get yanked without a `disconnect` event,
  // and the pg pool's open connections become Postgres zombies
  // for a few seconds. With this handler:
  //
  //   1. Stop accepting new connections (server.close stops
  //      .listen but lets active requests finish).
  //   2. Close all socket.io connections (io.close drains).
  //   3. Drain the pg pool (pool.end waits for queries in
  //      flight).
  //   4. Exit 0.
  //
  // 25-second deadline forces an exit if any of the above
  // hangs — better to bounce loudly than to leave a half-dead
  // process holding a port. The deploy environment's grace
  // period (pm2 default 30s, Kubernetes default 30s) matches.
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "graceful shutdown beginning");

    const deadline = setTimeout(() => {
      logger.error("graceful shutdown deadline hit — forcing exit");
      process.exit(1);
    }, 25_000);
    deadline.unref();

    try {
      // Stop accepting new HTTP — promisified so we await the close.
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      logger.info("http server closed");
      // Detach all socket clients.
      try {
        io.close();
        logger.info("socket.io server closed");
      } catch (err) {
        logger.warn({ err: err.message }, "io.close threw; continuing");
      }
      // Drain the pg pool. New queries on this pool will reject
      // immediately after end() is called.
      try {
        await pool.end();
        logger.info("pg pool drained");
      } catch (err) {
        logger.warn({ err: err.message }, "pool.end threw; continuing");
      }
      logger.info("graceful shutdown complete");
      clearTimeout(deadline);
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, "graceful shutdown failed");
      clearTimeout(deadline);
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
}

module.exports = { app, server, pool, io };
