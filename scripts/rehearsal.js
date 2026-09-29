#!/usr/bin/env node
//
// Production rehearsal kit. Seeds a throwaway country with one club, one
// meet and one event straight into the database, so the owner can run a
// real meet on the live site with real phones as judges, and then takes
// every trace of it out again.
//
//   node scripts/rehearsal.js seed    [--country ESH] [--email you@example.com] [--start 2026-10-04T10:00]
//   node scripts/rehearsal.js status  [--country ESH]
//   node scripts/rehearsal.js cleanup [--country ESH] [--dry-run]
//
//   --json on any of them prints one JSON object instead of the report.
//
// docs/rehearsal.md is the checklist that goes around it (who signs in on
// which phone, what to watch, when to clean up).
//
// WHY IT'S A SCRIPT AND NOT AN API
// --------------------------------
// Whoever runs the rehearsal runs this on the box itself, so nobody has
// to sign up or click through the live site to set it up. It talks to
// Postgres with plain SQL through pg, using the app's own .env (same as
// scripts/migrate.js), and never makes an HTTP call.
//
// WHAT COUNTS AS THE REHEARSAL
// ----------------------------
// An organisation with slug 'rehearsal-<country>' and claim_state
// 'unclaimed', plus the users in it whose username starts 'rehearsal-'.
// Nothing else is ever touched. The country defaults to Western Sahara
// (ESH): lib/countries.json leaves the uninhabited territories out
// (Antarctica, Bouvet, Heard Island), ESH is in the catalogue, has no
// World Aquatics federation, and no test in test/ uses the code. It has to
// be a catalogue code, otherwise the sysadmin's "needs a country" list
// would start nagging about the rehearsal org.
//
// The org is unclaimed on purpose: that's the club-first shape, where a
// club admin runs their own club's meets and nobody holds org_admin. The
// org has no continent, so a rehearsal dive can never land in (and knock
// someone out of) a real continental record book.
//
// SEED REFUSES RATHER THAN RE-SEEDS
// ---------------------------------
// A second seed while a rehearsal exists anywhere is refused, run cleanup
// first. The shared password is printed once and never stored, so an
// idempotent re-seed would either have to reset every password (logging
// out the phones mid rehearsal) or couldn't tell you what the password
// is. Usernames are global too, so two rehearsals in two countries would
// collide anyway.
//
// It also refuses when the country already has any other organisation, a
// real one, a pending federation, anything. Real users live there.
//
// CLEANUP
// -------
// One transaction, idempotent, prints what it removed. It refuses when the
// org holds a user that isn't 'rehearsal-' (a stranger who signed up into
// the country while it was open, say) or when any payment touches the
// rehearsal, since a payments row is somebody's money and the FKs are
// RESTRICT on purpose. It also takes out what the rehearsal left in
// tables without a foreign key back to it: audit rows, notifications that
// point at the event, record history, idempotency keys.
//
// The event is NOT flagged is_rehearsal. That flag (migration 048) skips
// the live and results emails and record setting, which are exactly the
// things this rehearsal wants to see working.

const crypto = require("node:crypto");
const { countryByCode, countryFromStored } = require("../lib/countries");

const DEFAULT_COUNTRY = "ESH";
const USER_PREFIX = "rehearsal-";
const SLUG_PREFIX = "rehearsal-";
const ORG_NAME = "DivingHQ Rehearsal";
const CLUB_NAME = "DivingHQ Rehearsal Club";
const CLUB_CODE = "RHSL";
const MEET_NAME = "DivingHQ Rehearsal Meet";
const EVENT_NAME = "Rehearsal Mixed 3m Springboard";
const BCRYPT_COST = 12; // same as the signup paths in routes/auth.js
const LOCK_KEY = "divinghq:rehearsal";

// Who gets made. The two women share their round 1 dive and so do the two
// men, which is how the record chip gets tested: the chip only shows for a
// mark that beats a standing record, and in a brand new club the first
// dive of anything is a first mark, not a beaten one. Score whoever goes
// second higher and the club book shows a proper "RHSL record".
//
// Names cover the PDF fonts: Latin with accents, Chinese (fonts-noto-cjk),
// Cyrillic (fonts-noto-core) and an apostrophe for the escaping. Everyone
// is an adult so no guardian flow gets in the way.
const JUDGES = [1, 2, 3, 4, 5].map((n) => ({
  key: `judge${n}`, username: `${USER_PREFIX}judge${n}`, full_name: `Rehearsal Judge ${n}`,
  role: "judge", judge_number: n,
}));
const DIVERS = [
  { key: "diver1", username: `${USER_PREFIX}diver1`, full_name: "Zoë Ångström", gender: "female",
    date_of_birth: "2001-03-14", dives: ["105B", "205C", "5132D"] },
  { key: "diver2", username: `${USER_PREFIX}diver2`, full_name: "陈美玲", gender: "female",
    date_of_birth: "2003-07-02", dives: ["105B", "303C", "403C"] },
  { key: "diver3", username: `${USER_PREFIX}diver3`, full_name: "Иван Петров", gender: "male",
    date_of_birth: "1999-11-23", dives: ["107C", "305C", "5235D"] },
  { key: "diver4", username: `${USER_PREFIX}diver4`, full_name: "Liam O'Connor", gender: "male",
    date_of_birth: "2002-05-30", dives: ["107C", "205B", "405C"] },
].map((d) => ({ ...d, role: "diver" }));
const ADMIN = { key: "admin", username: `${USER_PREFIX}admin`, full_name: "Rehearsal Club Admin", role: "club_admin" };
const REFEREE = { key: "referee", username: `${USER_PREFIX}referee`, full_name: "Rehearsal Referee", role: "referee" };
const ACCOUNTS = [ADMIN, ...JUDGES, REFEREE, ...DIVERS];

const EVENT = {
  name: EVENT_NAME, gender: "Mixed", height: "3m", board_height_m: 3.0,
  number_of_judges: JUDGES.length, total_rounds: 3,
};

class UsageError extends Error {}
class RefusedError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ------------------------------------------------------------------
// Pure helpers (test/rehearsal.test.js covers these without a database)
// ------------------------------------------------------------------

function parseArgs(argv) {
  const out = { command: null, country: null, email: null, start: null, dryRun: false, json: false, help: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    const value = () => {
      if (!args.length || args[0].startsWith("--")) throw new UsageError(`${a} needs a value`);
      return args.shift();
    };
    if (a === "--help" || a === "-h" || a === "help") out.help = true;
    else if (a === "--country") out.country = value();
    else if (a === "--email") out.email = value();
    else if (a === "--start") out.start = value();
    else if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) throw new UsageError(`Unknown option ${a}`);
    else if (!out.command) out.command = a;
    else throw new UsageError(`Unexpected argument ${a}`);
  }
  if (out.help) return out;
  if (!["seed", "status", "cleanup"].includes(out.command)) {
    throw new UsageError(out.command ? `Unknown command ${out.command}` : "Pick a command: seed, status or cleanup");
  }
  if (out.command !== "seed" && (out.email || out.start)) {
    throw new UsageError("--email and --start only go with seed");
  }
  if (out.command !== "cleanup" && out.dryRun) throw new UsageError("--dry-run only goes with cleanup");
  if (out.country != null) out.country = resolveCountry(out.country).a3;
  if (out.email != null) out.email = checkEmail(out.email);
  return out;
}

// Catalogue codes only, alpha-3, same as signup (lib/countries.js).
function resolveCountry(code) {
  const c = countryByCode(String(code || "").trim());
  if (!c) {
    throw new UsageError(`${code} isn't an alpha-3 code in lib/countries.json (the rehearsal needs a country signup knows about)`);
  }
  return c;
}

function checkEmail(raw) {
  const email = String(raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    throw new UsageError(`${raw} doesn't look like an email address`);
  }
  return email;
}

// you@example.com -> you+rehearsal-judge1@example.com. An address that
// already has a +tag gets the new one tacked on with a dash, which still
// lands in the same inbox at every provider that does plus addressing.
function plusAddress(email, tag) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return local.includes("+") ? `${local}-${tag}@${domain}` : `${local}+${tag}@${domain}`;
}

function accountEmail(account, ownerEmail) {
  return ownerEmail ? plusAddress(ownerEmail, account.username) : `${account.username}@example.invalid`;
}

function orgSlug(a3) {
  return `${SLUG_PREFIX}${String(a3).trim().toLowerCase()}`;
}

function isRehearsalOrg(org) {
  return !!org && org.claim_state === "unclaimed"
    && org.slug === orgSlug(String(org.country_code || "").trim());
}

// Something a judge can type on a phone without squinting: three groups of
// four from lowercase letters and digits, no 0/o/1/l/i. About 59 bits, and
// it always has a letter and a digit, so it'd pass validatePassword too.
const PW_LETTERS = "abcdefghjkmnpqrstuvwxyz";
const PW_DIGITS = "23456789";
function generatePassword(randomInt = crypto.randomInt) {
  const alphabet = PW_LETTERS + PW_DIGITS;
  for (;;) {
    const groups = [];
    for (let g = 0; g < 3; g++) {
      let s = "";
      for (let i = 0; i < 4; i++) s += alphabet[randomInt(alphabet.length)];
      groups.push(s);
    }
    const pw = groups.join("-");
    if (/[a-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

// Next quarter hour at least 30 minutes out. It's only what the schedule
// shows, nothing waits on it.
function defaultStart(now = new Date()) {
  const quarter = 15 * 60 * 1000;
  return new Date(Math.ceil((now.getTime() + 30 * 60 * 1000) / quarter) * quarter);
}

function parseStart(raw) {
  if (raw == null) return defaultStart();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new UsageError(`--start ${raw} isn't a date and time (try 2026-10-04T10:00)`);
  return d;
}

// The meet's date as the box sees it, not UTC.
function localDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function splitDive(code) {
  const m = /^(\d{3,4})([A-D])$/.exec(code);
  if (!m) throw new Error(`bad dive code ${code}`);
  return { dive_code: m[1], position: m[2] };
}

function baseUrl(env = process.env) {
  return String(env.APP_BASE_URL || "https://divinghq.app").replace(/\/+$/, "");
}

function urlsFor({ eventId, meetId }, env = process.env) {
  const b = baseUrl(env);
  return {
    login: `${b}/login`,
    control_room: `${b}/control?event=${eventId}`,
    judge: `${b}/judge`,
    sign_off_codes: `${b}/sign-off-codes`,
    scoreboard: `${b}/scoreboard/${eventId}`,
    broadcast: `${b}/scoreboard/${eventId}/broadcast`,
    meet: `${b}/meet/${meetId}`,
    diver_meet_day: `${b}/me/meet/${eventId}`,
    results_pdf: `${b}/api/events/${eventId}/results.pdf`,
    records: `${b}/records`,
  };
}

// Which database we're about to write to, for the report. No password.
function describeTarget(env = process.env) {
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      return `${decodeURIComponent(u.pathname.replace(/^\//, ""))} on ${u.hostname || "localhost"}`;
    } catch {
      return "(DATABASE_URL)";
    }
  }
  return `${env.DB_DATABASE || env.PGDATABASE || "(default)"} on ${env.DB_HOST || env.PGHOST || "localhost"}`;
}

// ------------------------------------------------------------------
// Database side
// ------------------------------------------------------------------

async function begin(client) {
  await client.query("BEGIN");
  // Don't sit behind a live meet's locks forever on the real box.
  await client.query("SET LOCAL lock_timeout = '15s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  // One seed or cleanup at a time.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
}

async function rehearsalOrgs(db, a3 = null) {
  const r = await db.query(
    `SELECT id, name, slug, trim(country_code) AS country_code, claim_state, status, created_at
       FROM organisations
      WHERE left(slug, ${SLUG_PREFIX.length}) = $1 AND claim_state = 'unclaimed'
      ORDER BY created_at`,
    [SLUG_PREFIX],
  );
  return r.rows.filter(isRehearsalOrg).filter((o) => !a3 || o.country_code === a3);
}

// Every org that says it's in this country, rehearsal or not. char(3)
// pads the alpha-2 form, and a row migration 093 hasn't reached can still
// hold it, so both are checked, same as resolveCountryOrg.
async function countryOrgs(db, country) {
  const r = await db.query(
    `SELECT o.id, o.name, o.slug, trim(o.country_code) AS country_code, o.claim_state, o.status,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id) AS user_count
       FROM organisations o
      WHERE o.country_code IN ($1, $2)
      ORDER BY o.created_at`,
    [country.a3, country.a2],
  );
  return r.rows;
}

// Any sysadmin who can still sign in, oldest first. The referee grant is
// made in their name: in a country nobody has claimed, referee is the one
// role only DivingHQ hands out (lib/role-requests.js), and lib/claims.js
// keeps a sysadmin's grant when a claim is revoked.
async function findSysadmin(db) {
  const r = await db.query(
    `SELECT id, username FROM users
      WHERE is_system_admin AND deleted_at IS NULL AND suspended_at IS NULL
      ORDER BY created_at, id LIMIT 1`,
  );
  return r.rows[0] || null;
}

async function resolveDives(db) {
  const wanted = [...new Set(DIVERS.flatMap((d) => d.dives))];
  const r = await db.query(
    `SELECT id, dive_code || position::text AS code
       FROM dive_directory
      WHERE NOT is_custom AND height = $1::numeric AND dive_code || position::text = ANY($2::text[])`,
    [EVENT.board_height_m, wanted],
  );
  const byCode = new Map();
  for (const row of r.rows) {
    if (byCode.has(row.code)) {
      throw new RefusedError("dive_ambiguous", `The core dive directory has ${row.code} at ${EVENT.height} more than once`);
    }
    byCode.set(row.code, row.id);
  }
  const missing = wanted.filter((c) => !byCode.has(c));
  if (missing.length) {
    throw new RefusedError("dive_missing", `The core dive directory has no ${missing.join(", ")} at ${EVENT.height}`);
  }
  return byCode;
}

async function seed(client, { country, email, start, bcrypt, password }) {
  await begin(client);
  try {
    const existing = await rehearsalOrgs(client);
    if (existing.length) {
      const where = existing.map((o) => o.country_code).join(", ");
      throw new RefusedError("already_seeded",
        `A rehearsal is already seeded (${where}). Run cleanup${existing.length === 1 ? ` --country ${existing[0].country_code}` : ""} first, seed won't do it twice.`,
        { orgs: existing });
    }
    const taken = await countryOrgs(client, country);
    if (taken.length) {
      throw new RefusedError("country_taken",
        `${country.name} (${country.a3}) already has an organisation on this database, so real people may be there. Pick another --country.`,
        { country: country.a3, orgs: taken.map((o) => ({
          id: o.id, name: o.name, country_code: o.country_code, status: o.status,
          claim_state: o.claim_state, users: o.user_count,
        })) });
    }
    const clash = await client.query(
      "SELECT username FROM users WHERE username = ANY($1::text[]) ORDER BY username",
      [ACCOUNTS.map((a) => a.username)],
    );
    if (clash.rows.length) {
      throw new RefusedError("username_taken",
        `These usernames already belong to someone: ${clash.rows.map((r) => r.username).join(", ")}`);
    }
    const sysadmin = await findSysadmin(client);
    if (!sysadmin) {
      throw new RefusedError("no_sysadmin", "No active system admin to grant the referee role in the name of");
    }
    const diveIds = await resolveDives(client);

    const hash = await bcrypt.hash(password, BCRYPT_COST);
    const one = async (sql, params) => (await client.query(sql, params)).rows[0];

    const org = await one(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state, continent)
       VALUES ($1, $2, $3, 'active', 'unclaimed', NULL)
       RETURNING id, name, slug, trim(country_code) AS country_code, created_at`,
      [ORG_NAME, country.a3, orgSlug(country.a3)],
    );
    const club = await one(
      `INSERT INTO clubs (org_id, name, short_code, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [org.id, CLUB_NAME, CLUB_CODE],
    );

    const ids = {};
    const accounts = [];
    for (const a of ACCOUNTS) {
      const row = await one(
        `INSERT INTO users (username, password, full_name, email, org_id, club_id,
                            email_verified_at, gender, date_of_birth)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8) RETURNING id`,
        [a.username, hash, a.full_name, accountEmail(a, email), org.id, club.id,
         a.gender || null, a.date_of_birth || null],
      );
      ids[a.key] = row.id;
      accounts.push({
        username: a.username, role: a.role, full_name: a.full_name, email: accountEmail(a, email),
        ...(a.judge_number ? { judge_number: a.judge_number } : {}),
        ...(a.gender ? { gender: a.gender, date_of_birth: a.date_of_birth } : {}),
        id: row.id,
      });
    }
    await client.query("UPDATE clubs SET created_by = $1 WHERE id = $2", [ids.admin, club.id]);
    // The club-first founder: an admin row, and only spectator as a role.
    await client.query(
      "INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)",
      [club.id, ids.admin, org.id],
    );

    // Everyone starts as a spectator, like a signup. Judges and divers are
    // the club's to grant, the referee is the sysadmin's. The audit rows
    // match what PUT /api/users/:id/roles writes, so the grants read the
    // same in the role history as ones made by hand.
    const grant = async (userId, role, by) => {
      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1, $2, $3, $4)",
        [userId, org.id, role, by],
      );
      if (role !== "spectator") {
        await client.query(
          `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note)
           VALUES ($1, $2, $3, 'granted', $4, 'scripts/rehearsal.js seed')`,
          [userId, org.id, role, by],
        );
      }
    };
    for (const a of ACCOUNTS) await grant(ids[a.key], "spectator", null);
    for (const j of JUDGES) await grant(ids[j.key], "judge", ids.admin);
    for (const d of DIVERS) await grant(ids[d.key], "diver", ids.admin);
    await grant(ids.referee, "referee", sysadmin.id);

    const meetDate = localDate(start);
    const meet = await one(
      `INSERT INTO meets (org_id, name, venue, start_date, end_date, description, host_club_id, represent_as)
       VALUES ($1, $2, $3, $4, $4, $5, $6, 'club') RETURNING id`,
      [org.id, MEET_NAME, "Rehearsal pool", meetDate,
       "A throwaway meet for rehearsing on the live site. It is deleted afterwards by scripts/rehearsal.js cleanup.",
       club.id],
    );
    // enforce_referee_signoff so the plain "manager says the referee
    // agreed" button is off and the referee has to actually sign off, from
    // their phone or on the laptop.
    const event = await one(
      `INSERT INTO events (org_id, meet_id, name, gender, age_group, height, number_of_judges,
                           total_rounds, event_type, event_format, scheduled_at,
                           enforce_referee_signoff, is_rehearsal)
       VALUES ($1, $2, $3, $4, 'Open', $5, $6, $7, 'individual', 'final', $8, TRUE, FALSE)
       RETURNING *`,
      [org.id, meet.id, EVENT.name, EVENT.gender, EVENT.height, EVENT.number_of_judges,
       EVENT.total_rounds, start.toISOString()],
    );
    // The creator of an event becomes its first manager (POST /api/events).
    await client.query(
      "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1, $2, $2)",
      [event.id, ids.admin],
    );
    for (const j of JUDGES) {
      await client.query(
        "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)",
        [event.id, ids[j.key], j.judge_number],
      );
    }

    // The lists go through the same validation and upsert the diver portal
    // uses, so a list that seeds is a list the app would have taken.
    const submitDiveList = require("../lib/dive-list-submit");
    for (const d of DIVERS) {
      await submitDiveList({
        client,
        event,
        actor: { id: ids.admin, org_id: org.id, is_system_admin: false, full_name: ADMIN.full_name },
        competitorId: ids[d.key],
        competitorOrgId: org.id,
        partnerId: null,
        dives: d.dives.map((code, i) => ({ round_number: i + 1, dive_id: diveIds.get(code) })),
        push: null,
      });
    }

    await client.query("COMMIT");
    return {
      country: { a3: country.a3, name: country.name },
      org_id: org.id, club_id: club.id, meet_id: meet.id, event_id: event.id,
      meet_date: meetDate, scheduled_at: start.toISOString(),
      sysadmin_for_referee: sysadmin.username,
      password,
      accounts,
      dive_lists: DIVERS.map((d) => ({ username: d.username, full_name: d.full_name, dives: d.dives })),
      urls: urlsFor({ eventId: event.id, meetId: meet.id }),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

// The ids that make up one rehearsal org, and anything in it that isn't
// ours. Reads only.
async function collect(db, org) {
  const col = async (sql, params) => (await db.query(sql, params)).rows.map((r) => r.id);
  const users = await col(
    `SELECT id FROM users WHERE org_id = $1 AND left(username, ${USER_PREFIX.length}) = $2`,
    [org.id, USER_PREFIX],
  );
  const clubs = await col("SELECT id FROM clubs WHERE org_id = $1", [org.id]);
  const regions = await col("SELECT id FROM regions WHERE org_id = $1", [org.id]);
  const meets = await col("SELECT id FROM meets WHERE org_id = $1", [org.id]);
  const events = await col(
    "SELECT id FROM events WHERE org_id = $1 OR meet_id = ANY($2::uuid[])",
    [org.id, meets],
  );
  // A user in the org without the prefix, or one from elsewhere sitting in
  // our club. Soft-deleted accounts count: their row is still somebody's.
  const foreign = (await db.query(
    `SELECT id, username, full_name, org_id, deleted_at, created_at
       FROM users
      WHERE (org_id = $1 AND left(username, ${USER_PREFIX.length}) <> $2)
         OR (club_id = ANY($3::uuid[]) AND org_id <> $1)
      ORDER BY created_at`,
    [org.id, USER_PREFIX, clubs],
  )).rows;
  const payments = (await db.query(
    `SELECT id, status, subject_type, amount_cents, currency FROM payments
      WHERE org_id = $1 OR club_id = ANY($2::uuid[]) OR payer_club_id = ANY($2::uuid[])
         OR payer_user_id = ANY($3::uuid[]) OR subject_user_id = ANY($3::uuid[])
         OR liable_user_id = ANY($3::uuid[]) OR event_id = ANY($4::uuid[]) OR meet_id = ANY($5::uuid[])
     UNION ALL
     SELECT id, status, 'payout', amount_cents, currency FROM payouts
      WHERE org_id = $1 OR club_id = ANY($2::uuid[])`,
    [org.id, clubs, users, events, meets],
  )).rows;
  const stripe = (await db.query(
    `SELECT 'organisation' AS kind, stripe_account_id FROM organisations WHERE id = $1 AND stripe_account_id IS NOT NULL
     UNION ALL
     SELECT 'club', stripe_account_id FROM clubs WHERE id = ANY($2::uuid[]) AND stripe_account_id IS NOT NULL`,
    [org.id, clubs],
  )).rows;
  return { org, users, clubs, regions, meets, events, foreign, payments, stripe };
}

// The id sets the cleanup statements pick from. They say @users,
// @events and so on, and bind() turns those into $n for just the ones a
// statement uses: Postgres won't take a parameter the text never mentions
// ("could not determine data type of parameter"). @all is every id at
// all, for the columns with no foreign key (audit_log.entity_id,
// claims.target_id); @urls matches an action_url that names the event.
const ID_TYPES = {
  org: "uuid", users: "uuid[]", clubs: "uuid[]", regions: "uuid[]",
  meets: "uuid[]", events: "uuid[]", all: "uuid[]", urls: "text[]",
};

function idSets(set) {
  return {
    org: set.org.id, users: set.users, clubs: set.clubs, regions: set.regions,
    meets: set.meets, events: set.events,
    all: [set.org.id, ...set.users, ...set.clubs, ...set.regions, ...set.meets, ...set.events],
    urls: [...set.events, ...set.meets].map((id) => `%${id}%`),
  };
}

function bind(sql, ids) {
  const order = [];
  const text = sql.replace(/@([a-z]+)/g, (whole, name) => {
    if (!(name in ID_TYPES)) throw new Error(`unknown placeholder ${whole}`);
    if (!order.includes(name)) order.push(name);
    return `$${order.indexOf(name) + 1}::${ID_TYPES[name]}`;
  });
  return [text, order.map((name) => ids[name])];
}

// Rows the rehearsal made or caused, table by table. Order matters for
// the counts only: the org delete at the end would cascade most of this
// anyway, but then nobody could see what went.
const CLEANUP_STEPS = [
  ["scores", `DELETE FROM scores WHERE event_id = ANY(@events)
     OR competitor_id = ANY(@users) OR judge_id = ANY(@users)`],
  ["score_audit_log", `DELETE FROM score_audit_log WHERE event_id = ANY(@events)
     OR competitor_id = ANY(@users) OR judge_id = ANY(@users) OR actor_user_id = ANY(@users)`],
  ["tiebreak_dive_offs", "DELETE FROM tiebreak_dive_offs WHERE event_id = ANY(@events)"],
  ["referee_signoff_requests", `DELETE FROM referee_signoff_requests WHERE event_id = ANY(@events)
     OR requested_by = ANY(@users) OR target_referee_id = ANY(@users)`],
  ["event_attendance", "DELETE FROM event_attendance WHERE event_id = ANY(@events) OR competitor_id = ANY(@users)"],
  ["event_live_state", "DELETE FROM event_live_state WHERE event_id = ANY(@events)"],
  // Record books. The history tables have no foreign keys at all, so
  // nothing would ever cascade them.
  ["records_personal", "DELETE FROM records_personal WHERE user_id = ANY(@users) OR event_id = ANY(@events)"],
  ["records_personal_history", "DELETE FROM records_personal_history WHERE user_id = ANY(@users) OR event_id = ANY(@events)"],
  ["records_club", `DELETE FROM records_club WHERE club_id = ANY(@clubs)
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_club_history", `DELETE FROM records_club_history WHERE club_id = ANY(@clubs)
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_region", `DELETE FROM records_region WHERE region_id = ANY(@regions)
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_region_history", `DELETE FROM records_region_history WHERE region_id = ANY(@regions)
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_federation", `DELETE FROM records_federation WHERE org_id = @org
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_federation_history", `DELETE FROM records_federation_history WHERE org_id = @org
     OR holder_id = ANY(@users) OR event_id = ANY(@events)`],
  ["records_continental", "DELETE FROM records_continental WHERE holder_id = ANY(@users) OR event_id = ANY(@events)"],
  ["records_continental_history", "DELETE FROM records_continental_history WHERE holder_id = ANY(@users) OR event_id = ANY(@events)"],
  // Notifications about the event land on people outside the rehearsal
  // too (the sysadmin, a real referee asked to sign off), and they only
  // point at it through data / action_url.
  ["notifications", `DELETE FROM notifications WHERE user_id = ANY(@users)
     OR data->>'event_id' = ANY(@events::text[]) OR data->>'meet_id' = ANY(@meets::text[])
     OR action_url LIKE ANY(@urls)`],
  ["push_subscriptions", "DELETE FROM push_subscriptions WHERE user_id = ANY(@users)"],
  ["idempotency_keys", "DELETE FROM idempotency_keys WHERE user_id = ANY(@users)"],
  ["audit_log", `DELETE FROM audit_log WHERE org_id = @org OR actor_id = ANY(@users)
     OR entity_id = ANY(@all)`],
  ["role_audit_log", `DELETE FROM role_audit_log WHERE org_id = @org
     OR user_id = ANY(@users) OR actor_id = ANY(@users)`],
  ["claim_votes", "DELETE FROM claim_votes WHERE user_id = ANY(@users) OR voter_id = ANY(@clubs) OR voter_id = ANY(@regions)"],
  ["claim_voters", "DELETE FROM claim_voters WHERE voter_id = ANY(@clubs) OR voter_id = ANY(@regions)"],
  ["claims", `DELETE FROM claims WHERE org_id = @org OR claimant_id = ANY(@users)
     OR target_id = ANY(@all)`],
  ["competitor_dive_lists", `DELETE FROM competitor_dive_lists WHERE event_id = ANY(@events)
     OR competitor_id = ANY(@users) OR partner_id = ANY(@users)`],
  ["event_judges", "DELETE FROM event_judges WHERE event_id = ANY(@events) OR judge_id = ANY(@users)"],
  ["event_managers", "DELETE FROM event_managers WHERE event_id = ANY(@events) OR user_id = ANY(@users)"],
  ["events", "DELETE FROM events WHERE id = ANY(@events)"],
  ["meets", "DELETE FROM meets WHERE id = ANY(@meets)"],
  ["club_admins", "DELETE FROM club_admins WHERE org_id = @org OR user_id = ANY(@users)"],
  ["user_org_roles", "DELETE FROM user_org_roles WHERE org_id = @org OR user_id = ANY(@users)"],
  // users.org_id is ON DELETE RESTRICT, so the users go before the org,
  // and only ours: collect() refused if anyone else was in there.
  ["users", "DELETE FROM users WHERE id = ANY(@users)"],
  ["clubs", "DELETE FROM clubs WHERE id = ANY(@clubs)"],
  ["regions", "DELETE FROM regions WHERE id = ANY(@regions)"],
  // Whatever's left hangs off the org by ON DELETE CASCADE (boards,
  // templates, role requests, fee definitions...).
  ["organisations", "DELETE FROM organisations WHERE id = @org"],
];

// Record rows sitting in a book that isn't the rehearsal's but were set by
// a rehearsal diver or dive. Can't happen with the org as seeded (no
// continent, every dive entered from the rehearsal club), but if it did,
// deleting them leaves that book without its previous holder until the
// books are replayed.
async function foreignRecordRows(db, ids) {
  const r = await db.query(...bind(
    `SELECT (SELECT count(*) FROM records_club WHERE NOT club_id = ANY(@clubs)
               AND (holder_id = ANY(@users) OR event_id = ANY(@events)))
          + (SELECT count(*) FROM records_region WHERE NOT region_id = ANY(@regions)
               AND (holder_id = ANY(@users) OR event_id = ANY(@events)))
          + (SELECT count(*) FROM records_federation WHERE org_id <> @org
               AND (holder_id = ANY(@users) OR event_id = ANY(@events)))
          + (SELECT count(*) FROM records_continental
               WHERE holder_id = ANY(@users) OR event_id = ANY(@events)) AS n`,
    ids,
  ));
  return Number(r.rows[0].n);
}

async function cleanupOrg(client, org) {
  const set = await collect(client, org);
  if (set.foreign.length) {
    throw new RefusedError("foreign_users",
      `${org.country_code}'s rehearsal org has ${set.foreign.length} account(s) that aren't rehearsal ones. ` +
      "Someone may have signed up into it. Nothing was deleted; sort those accounts out by hand first.",
      { org_id: org.id, users: set.foreign.map((u) => ({
        id: u.id, username: u.username, full_name: u.full_name,
        deleted: !!u.deleted_at, created_at: u.created_at,
      })) });
  }
  if (set.payments.length) {
    throw new RefusedError("payments_exist",
      `There are ${set.payments.length} payment or payout row(s) on the rehearsal. That's money, so nothing was deleted: ` +
      "refund or reconcile them in Stripe and remove them by hand, then run cleanup again.",
      { org_id: org.id, payments: set.payments });
  }
  const ids = idSets(set);
  const warnings = [];
  const foreignRecords = await foreignRecordRows(client, ids);
  if (foreignRecords) {
    warnings.push(`${foreignRecords} record(s) outside the rehearsal's own books were held by rehearsal dives. ` +
      "Run node scripts/rebuild-records.js (then again with --apply) to put the previous holders back.");
  }
  for (const s of set.stripe) {
    warnings.push(`The rehearsal ${s.kind} had Stripe account ${s.stripe_account_id}. Close it in the Stripe dashboard.`);
  }
  const deleted = {};
  for (const [table, sql] of CLEANUP_STEPS) {
    deleted[table] = (await client.query(...bind(sql, ids))).rowCount;
  }
  return { org_id: org.id, country: org.country_code, deleted, warnings };
}

async function cleanup(client, { country = null, dryRun = false } = {}) {
  await begin(client);
  try {
    const orgs = await rehearsalOrgs(client, country);
    const results = [];
    for (const org of orgs) results.push(await cleanupOrg(client, org));
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return { dry_run: dryRun, country, cleaned: results };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

async function count(db, sql, ids) {
  return Number((await db.query(...bind(sql, ids))).rows[0].n);
}

async function status(db, { country = null } = {}) {
  const orgs = await rehearsalOrgs(db, country);
  const rehearsals = [];
  for (const org of orgs) {
    const set = await collect(db, org);
    const ids = idSets(set);
    const users = (await db.query(
      `SELECT u.username, u.full_name, u.email,
              COALESCE(array_agg(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
              EXISTS (SELECT 1 FROM club_admins ca WHERE ca.user_id = u.id) AS club_admin
         FROM users u LEFT JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
        WHERE u.id = ANY($1::uuid[])
        GROUP BY u.id ORDER BY u.username`,
      [set.users],
    )).rows;
    const events = (await db.query(
      `SELECT e.id, e.name, e.status::text AS status, e.meet_id, e.scheduled_at,
              (SELECT count(*)::int FROM competitor_dive_lists c WHERE c.event_id = e.id) AS dive_list_rows,
              (SELECT count(*)::int FROM event_judges j WHERE j.event_id = e.id) AS judges,
              (SELECT count(*)::int FROM scores s WHERE s.event_id = e.id) AS scores
         FROM events e WHERE e.id = ANY($1::uuid[]) ORDER BY e.created_at`,
      [set.events],
    )).rows;
    const counts = {
      records: await count(db,
        `SELECT (SELECT count(*) FROM records_personal WHERE user_id = ANY(@users))
              + (SELECT count(*) FROM records_club WHERE club_id = ANY(@clubs) OR holder_id = ANY(@users))
              + (SELECT count(*) FROM records_federation WHERE org_id = @org OR holder_id = ANY(@users))
              + (SELECT count(*) FROM records_region WHERE region_id = ANY(@regions) OR holder_id = ANY(@users))
              + (SELECT count(*) FROM records_continental WHERE holder_id = ANY(@users)) AS n`, ids),
      notifications: await count(db,
        `SELECT count(*) AS n FROM notifications WHERE user_id = ANY(@users)
            OR data->>'event_id' = ANY(@events::text[])`, ids),
      audit_log: await count(db,
        "SELECT count(*) AS n FROM audit_log WHERE org_id = @org OR actor_id = ANY(@users)", ids),
      push_subscriptions: await count(db,
        "SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ANY(@users) AND revoked_at IS NULL", ids),
    };
    rehearsals.push({
      org_id: org.id, name: org.name, country: org.country_code,
      country_name: countryFromStored(org.country_code)?.name || org.country_code,
      created_at: org.created_at,
      clubs: set.clubs.length, meets: set.meets,
      users, events, counts,
      urls: events[0] ? urlsFor({ eventId: events[0].id, meetId: events[0].meet_id || set.meets[0] }) : null,
      cleanup_blockers: {
        foreign_users: set.foreign.map((u) => ({ username: u.username, full_name: u.full_name, deleted: !!u.deleted_at })),
        payments: set.payments.length,
      },
    });
  }
  // Would a seed go through for this country right now?
  const target = countryByCode(country || DEFAULT_COUNTRY);
  const others = (await countryOrgs(db, target)).filter((o) => !isRehearsalOrg(o));
  return {
    rehearsals,
    seed_check: {
      country: target.a3,
      free: others.length === 0 && (await rehearsalOrgs(db)).length === 0,
      other_orgs: others.map((o) => ({ name: o.name, status: o.status, claim_state: o.claim_state, users: o.user_count })),
    },
  };
}

// ------------------------------------------------------------------
// Reports
// ------------------------------------------------------------------

const ROLE_LABEL = { club_admin: "club admin", judge: "judge", referee: "referee", diver: "diver" };

// Chinese names take two terminal columns a character, which knocks the
// columns out of line if you pad by length.
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x20000;
    w += wide ? 2 : 1;
  }
  return w;
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => displayWidth(r[i]))));
  const pad = (c, w) => String(c) + " ".repeat(Math.max(0, w - displayWidth(c)));
  return rows.map((r) => "  " + r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()).join("\n");
}

function seedReport(res, target) {
  const u = res.urls;
  const rows = [["Username", "Role", "Name", "Email"]];
  for (const a of res.accounts) {
    const role = a.role === "judge" ? `judge J${a.judge_number}`
      : a.role === "diver" ? `diver (${a.gender === "female" ? "F" : "M"})` : ROLE_LABEL[a.role];
    rows.push([a.username, role, a.full_name, a.email]);
  }
  const lists = res.dive_lists.map((d) => `  ${d.username.padEnd(18)} ${d.dives.join("  ")}`).join("\n");
  return `Rehearsal seeded in ${res.country.name} (${res.country.a3}) on ${target}.

Password for every account below. It is shown once and stored nowhere:

    ${res.password}

${table(rows)}

Dive lists (3m, rounds 1 to 3):
${lists}

Next steps (docs/rehearsal.md has the full checklist):
  1. Laptop: sign in as ${ADMIN.username} at ${u.login}, then open the Control Room:
       ${u.control_room}
  2. Five phones: sign in as ${JUDGES[0].username} to ${JUDGES[JUDGES.length - 1].username}, then open ${u.judge}
     (judge1 sits as J1 and so on).
  3. Referee phone: sign in as ${REFEREE.username}. The dive order sign-off has to come from them:
     send the request from the Control Room, or they type the handoff code at ${u.sign_off_codes}
  4. A spectator phone, signed out: ${u.scoreboard}
     Meet page: ${u.meet}
     Broadcast view (TV or second laptop): ${u.broadcast}
  5. Divers are optional: ${DIVERS[0].username} to ${DIVERS[DIVERS.length - 1].username} see their day at ${u.diver_meet_day}
  6. Record chip: both women dive 105B in round 1, and both men 107C. Score whoever goes second higher.
  7. After Completed: ${u.results_pdf}
  8. When you're done: node scripts/rehearsal.js cleanup${res.country.a3 === DEFAULT_COUNTRY ? "" : ` --country ${res.country.a3}`}

The event goes on the public live list while it's Live. The referee role was granted in ${res.sysadmin_for_referee}'s name.`;
}

function statusReport(res, target) {
  const lines = [`Database: ${target}`];
  if (!res.rehearsals.length) lines.push("No rehearsal is seeded.");
  for (const r of res.rehearsals) {
    lines.push("", `Rehearsal in ${r.country_name} (${r.country}), org ${r.org_id}, seeded ${new Date(r.created_at).toISOString()}`);
    const rows = [["Username", "Name", "Roles"]];
    for (const u of r.users) {
      rows.push([u.username, u.full_name, [...(u.club_admin ? ["club admin"] : []), ...u.roles].join(", ")]);
    }
    if (r.users.length) lines.push(table(rows));
    for (const e of r.events) {
      lines.push(`  Event: ${e.name} [${e.status}], ${e.judges} judges, ${e.dive_list_rows} dive list rows, ${e.scores} scores`);
    }
    lines.push(`  Records ${r.counts.records}, notifications ${r.counts.notifications}, audit rows ${r.counts.audit_log}, push subscriptions ${r.counts.push_subscriptions}`);
    if (r.urls) lines.push(`  Control Room: ${r.urls.control_room}`, `  Scoreboard:   ${r.urls.scoreboard}`);
    if (r.cleanup_blockers.foreign_users.length) {
      lines.push(`  Cleanup will refuse: accounts that aren't rehearsal ones: ${r.cleanup_blockers.foreign_users.map((u) => u.username).join(", ")}`);
    }
    if (r.cleanup_blockers.payments) lines.push(`  Cleanup will refuse: ${r.cleanup_blockers.payments} payment row(s)`);
  }
  const s = res.seed_check;
  lines.push("", s.free
    ? `Seed in ${s.country}: free to go.`
    : `Seed in ${s.country}: would refuse (${s.other_orgs.length ? `${s.other_orgs.length} other org(s) in that country` : "a rehearsal already exists"}).`);
  return lines.join("\n");
}

function cleanupReport(res, target) {
  if (!res.cleaned.length) {
    return `Database: ${target}\nNothing to clean up${res.country ? ` in ${res.country}` : ""}, no rehearsal is seeded.`;
  }
  const lines = [`Database: ${target}`];
  for (const c of res.cleaned) {
    lines.push("", `${res.dry_run ? "Would remove" : "Removed"} the ${c.country} rehearsal (org ${c.org_id}):`);
    const rows = Object.entries(c.deleted).filter(([, n]) => n > 0).map(([t, n]) => [t, n]);
    lines.push(rows.length ? table(rows) : "  (nothing)");
    for (const w of c.warnings) lines.push(`  Warning: ${w}`);
  }
  if (res.dry_run) lines.push("", "Dry run: rolled back, nothing was deleted.");
  return lines.join("\n");
}

const USAGE = `Usage:
  node scripts/rehearsal.js seed    [--country ESH] [--email you@example.com] [--start 2026-10-04T10:00]
  node scripts/rehearsal.js status  [--country ESH]
  node scripts/rehearsal.js cleanup [--country ESH] [--dry-run]

  --country  alpha-3 code from lib/countries.json (default ${DEFAULT_COUNTRY}, Western Sahara)
  --email    your address; every account gets a plus-addressed copy of it
             (you+rehearsal-judge1@...) so the live and results emails reach you.
             Without it they get @example.invalid addresses.
  --start    when the event is scheduled (default: the next quarter hour, 30+ minutes out)
  --dry-run  cleanup reports what it would delete and rolls back
  --json     one JSON object on stdout instead of the report

See docs/rehearsal.md.`;

function connect(env = process.env) {
  const { Client } = require("pg");
  if (env.DATABASE_URL) return new Client({ connectionString: env.DATABASE_URL, application_name: "rehearsal" });
  return new Client({
    user: env.DB_USER || env.PGUSER,
    host: env.DB_HOST || env.PGHOST,
    database: env.DB_DATABASE || env.PGDATABASE,
    password: env.DB_PASSWORD || env.PGPASSWORD,
    port: env.DB_PORT || env.PGPORT,
    application_name: "rehearsal",
  });
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  require("dotenv").config({ quiet: true });
  const target = describeTarget();
  const emit = (obj, text) => console.log(opts.json ? JSON.stringify(obj, null, 2) : text);

  let start;
  try {
    start = opts.command === "seed" ? parseStart(opts.start) : null;
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const client = connect();
  try {
    await client.connect();
    if (opts.command === "seed") {
      const country = resolveCountry(opts.country || DEFAULT_COUNTRY);
      const res = await seed(client, {
        country, email: opts.email, start, bcrypt: require("bcrypt"), password: generatePassword(),
      });
      emit({ ok: true, database: target, ...res }, seedReport(res, target));
    } else if (opts.command === "status") {
      const res = await status(client, { country: opts.country });
      emit({ ok: true, database: target, ...res }, statusReport(res, target));
    } else {
      const res = await cleanup(client, { country: opts.country, dryRun: opts.dryRun });
      emit({ ok: true, database: target, ...res }, cleanupReport(res, target));
    }
    return 0;
  } catch (err) {
    if (err instanceof RefusedError) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, code: err.code, error: err.message, details: err.details }, null, 2));
      } else {
        console.error(`Refused: ${err.message}`);
        const users = err.details?.users || [];
        for (const u of users) console.error(`  ${u.username}  ${u.full_name}${u.deleted ? "  (deleted account)" : ""}`);
        // A busy country can have hundreds of orgs; the first few make the point.
        const orgs = err.details?.orgs || [];
        for (const o of orgs.slice(0, 10)) {
          const users = o.users == null ? "" : `, ${o.users} user(s)`;
          console.error(`  ${o.name} (${o.country_code || err.details.country || "?"}) [${o.status}, ${o.claim_state}${users}]`);
        }
        if (orgs.length > 10) console.error(`  ...and ${orgs.length - 10} more`);
      }
      return 1;
    }
    console.error(`rehearsal ${opts.command} failed on ${target}: ${err.message}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  DEFAULT_COUNTRY, USER_PREFIX, ACCOUNTS, JUDGES, DIVERS, ADMIN, REFEREE, EVENT, CLUB_CODE,
  UsageError, RefusedError,
  parseArgs, resolveCountry, plusAddress, accountEmail, orgSlug, isRehearsalOrg,
  generatePassword, defaultStart, parseStart, localDate, splitDive, urlsFor, describeTarget,
  bind, seed, cleanup, status,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
