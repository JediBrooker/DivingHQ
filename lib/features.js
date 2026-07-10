// lib/features.js, runtime feature switches backed by the feature_flags
// table (migration 085).
//
// Factory pattern, same as lib/middleware / lib/email / lib/stripe, so
// tests can hand in a stub instead of standing up Postgres.
//
// Why a table and not an env var: SIGNUPS_ENABLED (routes/auth.js) proved
// that env-var gates mean "ssh to the box, edit .env, restart, hope you
// spelled it right". Payments and classes are whole product areas we want
// to switch on the day we decide to, from the admin UI, without a deploy
// window.
//
// The cache is a plain Map. That's safe precisely because the app runs a
// single PM2 fork (ecosystem.config.js spells out why clustering is off).
// If that ever changes this needs LISTEN/NOTIFY or a short TTL, otherwise
// one worker would keep serving a stale flag after another flipped it.
// Leaving a note rather than building for a clustering story we don't have.
//
// EVERYTHING DEFAULTS OFF. An unknown key, a missing row, a database we
// couldn't read at boot: all of it reads as disabled. A flag that fails
// open is a flag that takes money you didn't mean to take.

const { recordAudit } = require("./audit");

// The registry. Adding a key here and nowhere else gives you a flag that
// is off, gated, and visible in the admin UI. The label/description are
// what the sysadmin toggle screen renders, so write them for a human.
const REGISTRY = {
  payments: {
    label: "Payments",
    description:
      "Stripe checkout, fees, fines, donations, memberships, and club/federation payouts. " +
      "Turning this off hides every money screen and makes checkout routes return 503. " +
      "Payments already in flight still reconcile via the Stripe webhook.",
  },
  classes: {
    label: "Classes",
    description:
      "Club training classes: scheduling, rosters, enrolments, and the coach class view. " +
      "Club payouts are part of Payments, not this flag, but they're reached through the " +
      "Classes page so they follow it in the UI.",
  },
  signups: {
    label: "Registration",
    description:
      "Public account creation: self-register into an existing federation, and found-a-new-federation. " +
      "Off means the register pages show a coming-soon notice and the register endpoints 403. " +
      "Login and every existing-account flow (password reset, 2FA, email change) are never affected, " +
      "so the admin can always sign in.",
  },
  maintenance: {
    label: "Maintenance mode",
    description:
      "Read-only lockdown for deploys or database work. A banner appears for everyone and every write " +
      "(score submission, edits, new records) is refused for non-admins on both the HTTP and socket paths. " +
      "Reading, the scoreboard, and admin sign-in stay live. System admins can still make changes so they " +
      "can fix whatever they came in to fix.",
  },
};

// Break-glass override: FEATURE_FLAGS_ON=payments,classes forces those keys on
// no matter what the table says.
//
// It exists for the e2e suite, which boots one server against a freshly
// migrated database (every flag seeded off) and then wants to drive the
// payments and classes screens. Same shape as the SIGNUPS_ENABLED gate the
// auth routes already use.
//
// It can only force a flag ON, never off, and it's read once at construction.
// If you find yourself reaching for it in production, the admin screen at
// /admin/features is almost certainly what you actually wanted.
function forcedOn() {
  return new Set(
    String(process.env.FEATURE_FLAGS_ON || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function createFeatures({ pool, logger } = {}) {
  if (!pool) throw new Error("createFeatures requires { pool }");
  const log = logger || { warn: () => {}, error: () => {}, info: () => {} };

  const cache = new Map();
  const forced = forcedOn();
  let loaded = false;

  function assertKnown(key) {
    if (!Object.hasOwn(REGISTRY, key)) {
      throw new Error(`Unknown feature flag: ${key}`);
    }
  }

  // Read every flag into the cache. Call once at boot, before listen().
  // If it throws, the caller should let the process die rather than serve
  // traffic with a guessed flag state.
  async function load() {
    const { rows } = await pool.query("SELECT key, enabled FROM feature_flags");
    cache.clear();
    for (const row of rows) {
      // Ignore rows for keys we retired. They're harmless, and refusing to
      // boot over a leftover row would be a rotten way to find out.
      if (Object.hasOwn(REGISTRY, row.key)) cache.set(row.key, row.enabled === true);
    }
    loaded = true;
    if (forced.size) {
      log.warn({ forced: [...forced] }, "FEATURE_FLAGS_ON is overriding the feature_flags table");
    }
    log.info({ features: all() }, "feature flags loaded");
    return all();
  }

  // Synchronous, hot-path safe. Every gate in the app calls this.
  function enabled(key) {
    assertKnown(key);
    if (forced.has(key)) return true;
    return cache.has(key) ? cache.get(key) : false;
  }

  function all() {
    const out = {};
    for (const key of Object.keys(REGISTRY)) out[key] = enabled(key);
    return out;
  }

  // Richer shape for the admin screen: who last touched each flag and when.
  // Goes to the database rather than the cache because "updated 3 minutes
  // ago by Christian" is the whole point of the screen.
  async function list() {
    const { rows } = await pool.query(
      `SELECT f.key, f.enabled, f.updated_at, u.full_name AS updated_by_name
         FROM feature_flags f
         LEFT JOIN users u ON u.id = f.updated_by`,
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(REGISTRY).map(([key, meta]) => {
      const row = byKey.get(key);
      return {
        key,
        label: meta.label,
        description: meta.description,
        enabled: enabled(key),
        updated_at: row?.updated_at ?? null,
        updated_by_name: row?.updated_by_name ?? null,
      };
    });
  }

  // Flip a flag. Writes the row, updates the cache in the same tick so the
  // very next request sees the new value, then records the audit entry.
  // Audit is best-effort by design (lib/audit swallows), so it never rolls
  // back a toggle that actually happened.
  async function set(key, on, { actorId = null, ip = null, userAgent = null } = {}) {
    assertKnown(key);
    const value = on === true;
    await pool.query(
      `INSERT INTO feature_flags (key, enabled, updated_at, updated_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
      [key, value, actorId],
    );
    cache.set(key, value);
    await recordAudit(pool, {
      org_id: null,
      actor_id: actorId,
      entity_type: "feature_flag",
      entity_id: null,
      entity_name: key,
      action: value ? "feature_flag.enabled" : "feature_flag.disabled",
      metadata: { key, enabled: value },
      ip_address: ip,
      user_agent: userAgent,
    });
    log.info({ key, enabled: value, actor: actorId }, "feature flag toggled");
    return value;
  }

  // Express gate. Sits in front of a route the way requireOrgRole does.
  //
  // 503 rather than 404: the resource exists, this deployment just has it
  // switched off, and that's exactly what payments has always returned
  // (routes/payments.js ensurePayments). Keeping one status code for
  // "feature is dark" means clients only need one branch.
  function requireFeature(key) {
    assertKnown(key);
    return function featureGate(req, res, next) {
      if (enabled(key)) return next();
      return res.status(503).json({
        error: `${REGISTRY[key].label} are not available on this server yet.`,
        code: "feature_disabled",
        feature: key,
      });
    };
  }

  return {
    load,
    enabled,
    all,
    list,
    set,
    requireFeature,
    isLoaded: () => loaded,
    KEYS: Object.keys(REGISTRY),
  };
}

module.exports = createFeatures;
module.exports.REGISTRY = REGISTRY;
