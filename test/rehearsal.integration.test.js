// scripts/rehearsal.js against a real database, run the way the owner
// runs it: as a child process, reading the same env. Covers
//
//   * seed builds the whole rehearsal (org, club, accounts, roles, meet,
//     event, panel, dive lists) and refuses a second time
//   * the accounts actually sign in with the printed password, and the
//     Control Room roster, the scoreboard and the judge's event list all
//     show the seeded meet (server.js booted in process, like
//     integration.test.js does)
//   * a rehearsal's worth of side effects (status flips, scores, records,
//     notifications, audit rows, idempotency keys, push subscriptions)
//     all go on cleanup, including the rows with no FK back to it
//   * cleanup refuses while a stranger is in the org (even one called
//     rehearsal-something) or a seeded account sits on a real event's
//     panel, is idempotent, and --dry-run rolls back
//   * seed refuses a country that already has real users
//   * --judges 3 (one person rehearsing) and 7 seed, report and clean up
//     that panel, and a stranger who signs up as a judge name the panel
//     didn't use is still a stranger to cleanup
//
// Skips when Postgres isn't reachable. The in-process server part also
// needs JWT_SECRET, same as integration.test.js. The *.integration name
// keeps it out of test:safe, which deploy.sh runs on the production box:
// this file seeds and deletes, it must never go near the live database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");

const SCRIPT = path.join(__dirname, "..", "scripts", "rehearsal.js");
const { DEFAULT_COUNTRY, DIVERS, JUDGES, ADMIN, REFEREE } = require("../scripts/rehearsal");
// A catalogue country no other test touches, for the "real users live
// here" refusal. The seed itself uses the default, which test/rehearsal.test.js
// pins as unused elsewhere.
const TAKEN_COUNTRY = "URY";

let pool;
// Starts false and only goes true once the test-DB guard and SELECT 1 have
// both passed. node:test still runs after() when before() throws, and
// after() runs cleanup: with this defaulting to true, the guard refusing
// the box's .env (node --test on this file directly skips run-tests.js)
// would have been followed by a cleanup against the live database anyway.
let dbReachable = false;
let httpServer;
let baseUrl = null;

before(async () => {
  require("./support/test-db").assertTestDatabase();
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     process.env.DB_PORT     || process.env.PGPORT,
      });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }
  dbReachable = true;
  // A run that died half way leaves its rehearsal behind. Clear it so the
  // seed below starts from nothing (cleanup is idempotent).
  const pre = cli(["cleanup"]);
  assert.equal(pre.status, 0, pre.stderr);

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_this_secret_in_production") {
    console.warn("[skip] JWT_SECRET not set, the sign-in and endpoint checks won't run");
    return;
  }
  process.env.RATE_LIMIT_DISABLED = "true";
  const mod = require("../server.js");
  httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  await mod.features.load();
});

after(async () => {
  if (dbReachable) cli(["cleanup"]);
  // Only when before() booted it: require()ing server.js here otherwise
  // boots the whole app against whatever database the guard just refused.
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    const { io } = require("../server.js");
    if (io && typeof io.close === "function") io.close();
  }
  if (pool) await pool.end();
});

// The script as a child process with this process's env, so it resolves
// the same database. --json on everything for a stable shape.
function cli(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args, "--json"], {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 120_000,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* usage errors print text */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function fetchJson(method, urlPath, { body, token, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(
      { method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password) {
  const r = await fetchJson("POST", "/api/auth/login", { body: { username, password } });
  assert.equal(r.status, 200, `${username} sign in: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const n = async (sql, params) => Number((await one(sql, params)).n);

test("seed, sign in, rehearse, status, clean up, clean up again", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");

  // ---- seed -------------------------------------------------------
  const seeded = cli(["seed", "--email", "owner@example.test"]);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const s = seeded.json;
  assert.equal(s.ok, true);
  assert.equal(s.country.a3, DEFAULT_COUNTRY);
  assert.match(s.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const byName = Object.fromEntries(s.accounts.map((a) => [a.username, a]));
  const userIds = s.accounts.map((a) => a.id);
  assert.equal(userIds.length, 11);

  const org = await one("SELECT * FROM organisations WHERE id = $1", [s.org_id]);
  assert.equal(org.claim_state, "unclaimed");
  assert.equal(org.status, "active");
  assert.equal(org.country_code.trim(), DEFAULT_COUNTRY);
  assert.equal(org.continent, null, "no continent, so no continental books");

  const users = (await pool.query(
    `SELECT id, username, email, email_verified_at, org_id, club_id, gender, date_of_birth
       FROM users WHERE id = ANY($1::uuid[])`, [userIds])).rows;
  assert.equal(users.length, 11);
  for (const u of users) {
    assert.ok(u.username.startsWith("rehearsal-"), u.username);
    assert.ok(u.email_verified_at, `${u.username} verified`);
    assert.equal(u.email, `owner+${u.username}@example.test`);
    assert.equal(u.org_id, s.org_id);
    assert.equal(u.club_id, s.club_id);
  }
  for (const d of DIVERS) {
    const u = users.find((x) => x.username === d.username);
    assert.equal(u.gender, d.gender);
    assert.ok(u.date_of_birth, `${d.username} has a date of birth`);
  }

  const roles = async (username) => (await pool.query(
    `SELECT r.role::text AS role, g.is_system_admin AS by_sysadmin, g.username AS granted_by
       FROM user_org_roles r JOIN users u ON u.id = r.user_id LEFT JOIN users g ON g.id = r.granted_by
      WHERE u.username = $1 AND r.org_id = $2 ORDER BY r.role`, [username, s.org_id])).rows;
  const referee = (await roles(REFEREE.username)).find((r) => r.role === "referee");
  assert.equal(referee.by_sysadmin, true, "referee granted in a sysadmin's name");
  for (const j of JUDGES) {
    assert.deepEqual((await roles(j.username)).map((r) => r.role), ["judge", "spectator"]);
  }
  assert.deepEqual((await roles(ADMIN.username)).map((r) => r.role), ["spectator"]);
  assert.equal(await n("SELECT count(*) AS n FROM club_admins WHERE club_id = $1 AND user_id = $2",
    [s.club_id, byName[ADMIN.username].id]), 1);
  const club = await one("SELECT * FROM clubs WHERE id = $1", [s.club_id]);
  assert.equal(club.status, "active");
  assert.equal(club.short_code, "RHSL");

  const meet = await one("SELECT * FROM meets WHERE id = $1", [s.meet_id]);
  assert.equal(meet.represent_as, "club");
  assert.equal(meet.host_club_id, s.club_id);
  const event = await one("SELECT * FROM events WHERE id = $1", [s.event_id]);
  assert.equal(event.meet_id, s.meet_id);
  assert.equal(event.number_of_judges, 5);
  assert.equal(event.total_rounds, 3);
  assert.equal(event.event_type, "individual");
  assert.ok(["1m", "3m"].includes(event.height));
  assert.equal(event.status, "Upcoming");
  assert.equal(event.is_rehearsal, false, "emails and records have to fire");

  const panel = (await pool.query(
    `SELECT u.username, ej.judge_number FROM event_judges ej JOIN users u ON u.id = ej.judge_id
      WHERE ej.event_id = $1 ORDER BY ej.judge_number`, [s.event_id])).rows;
  assert.deepEqual(panel, JUDGES.map((j) => ({ username: j.username, judge_number: j.judge_number })));

  const lists = (await pool.query(
    `SELECT u.username, c.round_number, d.dive_code || d.position::text AS code, d.is_custom,
            d.height, c.confirmed_at, c.rep_club_id
       FROM competitor_dive_lists c
       JOIN users u ON u.id = c.competitor_id
       JOIN dive_directory d ON d.id = c.dive_id
      WHERE c.event_id = $1 ORDER BY u.username, c.round_number`, [s.event_id])).rows;
  assert.equal(lists.length, 12);
  for (const row of lists) {
    assert.equal(row.is_custom, false, "core directory only");
    assert.equal(Number(row.height), parseFloat(event.height));
    assert.ok(row.confirmed_at);
    assert.equal(row.rep_club_id, s.club_id, "entered from the rehearsal club");
  }
  for (const d of DIVERS) {
    assert.deepEqual(lists.filter((l) => l.username === d.username).map((l) => l.code), d.dives);
  }

  // ---- a second seed refuses --------------------------------------
  const again = cli(["seed"]);
  assert.equal(again.status, 1);
  assert.equal(again.json.code, "already_seeded");
  assert.equal(await n("SELECT count(*) AS n FROM organisations WHERE left(slug, 10) = 'rehearsal-'"), 1);

  // ---- status -----------------------------------------------------
  const st = cli(["status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(st.json.rehearsals.length, 1);
  assert.equal(st.json.rehearsals[0].country, DEFAULT_COUNTRY);
  assert.equal(st.json.rehearsals[0].users.length, 11);
  assert.equal(st.json.rehearsals[0].events[0].dive_list_rows, 12);
  assert.equal(st.json.rehearsals[0].events[0].judges, 5);
  assert.equal(st.json.seed_check.free, false);

  // ---- the app sees it -------------------------------------------
  // Endpoints through the real server. Then the rehearsal itself: the
  // status flips go through the API (audit rows, notifications, an
  // idempotency key), the scores and records through SQL and the records
  // module, since judging over the socket isn't what's under test here.
  const sysadmin = await one(
    "SELECT id FROM users WHERE is_system_admin AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
  const eventNotes = [];
  if (baseUrl) {
    const adminToken = await login(ADMIN.username, s.password);
    const roster = await fetchJson("GET", `/api/events/${s.event_id}/roster`, { token: adminToken });
    assert.equal(roster.status, 200, JSON.stringify(roster.body));
    const rows = roster.body;
    assert.equal(rows.length, 12);
    assert.deepEqual([...new Set(rows.map((r) => r.full_name))].sort(), DIVERS.map((d) => d.full_name).sort());
    assert.ok(rows.every((r) => r.country_code === "RHSL"), "represent_as club prints the club code");

    const board = await fetchJson("GET", `/api/scoreboard/${s.event_id}?cache=skip`, { token: adminToken });
    assert.equal(board.status, 200);
    assert.equal(board.body.upcoming.length, 12);
    assert.deepEqual([...new Set(board.body.upcoming.map((r) => r.full_name))].sort(),
      DIVERS.map((d) => d.full_name).sort());
    assert.equal(board.body.panel.length, 5);

    const judgeToken = await login(JUDGES[0].username, s.password);
    const mine = await fetchJson("GET", "/api/judge/my-events", { token: judgeToken });
    assert.equal(mine.status, 200);
    assert.ok(mine.body.some((e) => e.id === s.event_id));
    const refToken = await login(REFEREE.username, s.password);
    assert.ok(refToken);

    const live = await fetchJson("PUT", `/api/events/${s.event_id}/status`, {
      token: adminToken, body: { status: "Live" }, headers: { "X-Idempotency-Key": crypto.randomUUID() },
    });
    assert.equal(live.status, 200, JSON.stringify(live.body));
  } else {
    await pool.query("UPDATE events SET status = 'Live' WHERE id = $1", [s.event_id]);
  }

  // Round 1 scored by all five. The second woman and the second man beat
  // the first on the shared dive, which is what puts the record chip up.
  const scoreFor = { diver1: 6.0, diver2: 7.0, diver3: 6.0, diver4: 7.5 };
  const createRecords = require("../lib/records");
  const records = createRecords({ pool });
  for (const d of DIVERS) {
    const diverId = byName[d.username].id;
    const cdl = await one(
      "SELECT dive_id FROM competitor_dive_lists WHERE event_id = $1 AND competitor_id = $2 AND round_number = 1",
      [s.event_id, diverId]);
    for (const j of JUDGES) {
      const sc = await one(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`,
        [s.event_id, diverId, byName[j.username].id, cdl.dive_id, scoreFor[d.key]]);
      await pool.query(
        `INSERT INTO score_audit_log (score_id, event_id, competitor_id, judge_id, round_number, action, new_score, actor_user_id)
         VALUES ($1, $2, $3, $4, 1, 'insert', $5, $4)`,
        [sc.id, s.event_id, diverId, byName[j.username].id, scoreFor[d.key]]);
    }
    await records.checkAndApplyRecords({ eventId: s.event_id, competitorId: diverId, roundNumber: 1 });
  }
  const { eventRecordMarks } = require("../lib/records");
  const marks = await eventRecordMarks(pool, s.event_id);
  const clubMarks = marks.filter((m) => m.scope === "club");
  assert.deepEqual(clubMarks.map((m) => m.competitor_id).sort(),
    [byName["rehearsal-diver2"].id, byName["rehearsal-diver4"].id].sort(),
    "the second diver on each shared dive holds a beaten club record");
  assert.ok(await n("SELECT count(*) AS n FROM records_club_history WHERE club_id = $1", [s.club_id]) >= 2);

  // Things a rehearsal leaves around that don't hang off the org by FK:
  // a notification to someone outside it (the sysadmin, asked to sign
  // off), a phone's push subscription, check-in, a sign-off request.
  const note = await one(
    `INSERT INTO notifications (user_id, category, title, data, action_url)
     VALUES ($1, 'referee_signoff', 'Rehearsal sign-off', $2::jsonb, $3) RETURNING id`,
    [sysadmin.id, JSON.stringify({ event_id: s.event_id }), `/control?event=${s.event_id}`]);
  eventNotes.push(note.id);
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
     VALUES ($1, $2, 'k', 'a')`, [byName["rehearsal-judge1"].id, `https://push.example.test/${crypto.randomUUID()}`]);
  await pool.query(
    `INSERT INTO event_attendance (event_id, competitor_id, status, set_by)
     VALUES ($1, $2, 'present', $3)`, [s.event_id, byName["rehearsal-diver1"].id, byName[ADMIN.username].id]);
  await pool.query(
    `INSERT INTO referee_signoff_requests (event_id, requested_by, target_referee_id, status)
     VALUES ($1, $2, $3, 'approved')`, [s.event_id, byName[ADMIN.username].id, byName[REFEREE.username].id]);

  if (baseUrl) {
    const adminToken = await login(ADMIN.username, s.password);
    const done = await fetchJson("PUT", `/api/events/${s.event_id}/status`, {
      token: adminToken, body: { status: "Completed" },
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(await n("SELECT count(*) AS n FROM audit_log WHERE entity_id = $1", [s.event_id]) >= 2);
    assert.ok(await n("SELECT count(*) AS n FROM notifications WHERE data->>'event_id' = $1", [s.event_id]) > 1,
      "going live notified the panel and the divers");
    assert.ok(await n("SELECT count(*) AS n FROM idempotency_keys WHERE user_id = $1", [byName[ADMIN.username].id]) >= 1);
  }

  // ---- cleanup --dry-run rolls back ------------------------------
  const dry = cli(["cleanup", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.json.dry_run, true);
  assert.equal(dry.json.cleaned[0].deleted.scores, 20);
  assert.equal(dry.json.cleaned[0].deleted.users, 11);
  assert.deepEqual(dry.json.cleaned[0].warnings, []);
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[])", [userIds]), 11);

  // ---- cleanup refuses while a stranger is in the org -------------
  // Named like one of ours on purpose: anyone can sign up as rehearsal-x,
  // so only the usernames seed made count as the rehearsal's.
  const stranger = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Somebody Real', $2, now()) RETURNING id`,
    [`rehearsal-intruder-${crypto.randomBytes(4).toString("hex")}`, s.org_id]);
  const refused = cli(["cleanup"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.code, "foreign_users");
  assert.equal(refused.json.details.users.length, 1);
  assert.equal(refused.json.details.users[0].id, stranger.id);
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[])", [userIds]), 11);
  await pool.query("DELETE FROM users WHERE id = $1", [stranger.id]);

  // ---- and while a seeded account sits on a real event's panel ----
  // Deleting the judge would cascade that event's panel seat (and any
  // scores) away, so cleanup has to stop and say so.
  const sfx = crypto.randomBytes(4).toString("hex");
  const realOrg = await one(
    `INSERT INTO organisations (name, country_code, slug, status, claim_state)
     VALUES ('Real Host', 'TST', $1, 'active', 'claimed') RETURNING id`, [`real-host-${sfx}`]);
  try {
    const realEvent = await one(
      `INSERT INTO events (org_id, name, gender, number_of_judges)
       VALUES ($1, 'Real Event', 'Mixed', 5) RETURNING id`, [realOrg.id]);
    await pool.query(
      "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, 1)",
      [realEvent.id, byName[JUDGES[0].username].id]);
    const lent = cli(["cleanup"]);
    assert.equal(lent.status, 1, lent.stdout);
    assert.equal(lent.json.code, "used_elsewhere");
    assert.deepEqual(lent.json.details.elsewhere, [{ what: "seats on another event's panel", n: 1 }]);
    const blocked = cli(["status"]);
    assert.deepEqual(blocked.json.rehearsals[0].cleanup_blockers.elsewhere, lent.json.details.elsewhere);
    assert.equal(await n("SELECT count(*) AS n FROM event_judges WHERE event_id = $1", [realEvent.id]), 1,
      "the real event's panel is untouched");
    assert.equal(await n("SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[])", [userIds]), 11);
  } finally {
    await pool.query("DELETE FROM organisations WHERE id = $1", [realOrg.id]);
  }

  // ---- cleanup for real -------------------------------------------
  const clean = cli(["cleanup", "--country", DEFAULT_COUNTRY]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.json.cleaned.length, 1);
  assert.equal(clean.json.cleaned[0].deleted.organisations, 1);

  const ids = [s.org_id, s.club_id, s.meet_id, s.event_id, ...userIds];
  assert.equal(await n("SELECT count(*) AS n FROM organisations WHERE id = $1 OR slug = $2",
    [s.org_id, `rehearsal-${DEFAULT_COUNTRY.toLowerCase()}`]), 0);
  const leftovers = {
    users: ["SELECT count(*) AS n FROM users WHERE id = ANY($1::uuid[]) OR username LIKE 'rehearsal-%'", [userIds]],
    clubs: ["SELECT count(*) AS n FROM clubs WHERE id = $1", [s.club_id]],
    meets: ["SELECT count(*) AS n FROM meets WHERE id = $1", [s.meet_id]],
    events: ["SELECT count(*) AS n FROM events WHERE id = $1", [s.event_id]],
    competitor_dive_lists: ["SELECT count(*) AS n FROM competitor_dive_lists WHERE event_id = $1", [s.event_id]],
    scores: ["SELECT count(*) AS n FROM scores WHERE event_id = $1", [s.event_id]],
    score_audit_log: ["SELECT count(*) AS n FROM score_audit_log WHERE event_id = $1 OR judge_id = ANY($2::uuid[])", [s.event_id, userIds]],
    audit_log: ["SELECT count(*) AS n FROM audit_log WHERE org_id = $1 OR entity_id = ANY($2::uuid[]) OR actor_id = ANY($3::uuid[])", [s.org_id, ids, userIds]],
    role_audit_log: ["SELECT count(*) AS n FROM role_audit_log WHERE org_id = $1 OR user_id = ANY($2::uuid[])", [s.org_id, userIds]],
    notifications: ["SELECT count(*) AS n FROM notifications WHERE user_id = ANY($1::uuid[]) OR data->>'event_id' = $2 OR id = ANY($3::uuid[])", [userIds, s.event_id, eventNotes]],
    push_subscriptions: ["SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ANY($1::uuid[])", [userIds]],
    idempotency_keys: ["SELECT count(*) AS n FROM idempotency_keys WHERE user_id = ANY($1::uuid[])", [userIds]],
    event_attendance: ["SELECT count(*) AS n FROM event_attendance WHERE event_id = $1", [s.event_id]],
    referee_signoff_requests: ["SELECT count(*) AS n FROM referee_signoff_requests WHERE event_id = $1", [s.event_id]],
    user_org_roles: ["SELECT count(*) AS n FROM user_org_roles WHERE org_id = $1 OR user_id = ANY($2::uuid[])", [s.org_id, userIds]],
  };
  for (const t of ["personal", "club", "region", "federation", "continental"]) {
    for (const suffix of ["", "_history"]) {
      const holder = t === "personal" ? "user_id" : "holder_id";
      leftovers[`records_${t}${suffix}`] = [
        `SELECT count(*) AS n FROM records_${t}${suffix} WHERE ${holder} = ANY($1::uuid[]) OR event_id = $2`,
        [userIds, s.event_id],
      ];
    }
  }
  leftovers.records_club_by_club = ["SELECT count(*) AS n FROM records_club_history WHERE club_id = $1", [s.club_id]];
  leftovers.records_federation_by_org = ["SELECT count(*) AS n FROM records_federation_history WHERE org_id = $1", [s.org_id]];
  for (const [label, [sql, params]] of Object.entries(leftovers)) {
    assert.equal(await n(sql, params), 0, `${label} left behind`);
  }
  // The sysadmin whose notification went is still there, of course.
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE id = $1", [sysadmin.id]), 1);

  // ---- and again: nothing to do, still exit 0 ----------------------
  const twice = cli(["cleanup"]);
  assert.equal(twice.status, 0, twice.stderr);
  assert.deepEqual(twice.json.cleaned, []);
  const empty = cli(["status"]);
  assert.equal(empty.status, 0);
  assert.deepEqual(empty.json.rehearsals, []);
  assert.equal(empty.json.seed_check.free, true);
});

// A rehearsal for one person: three judges, so a phone and two browsers
// can be the panel (docs/rehearsal.md, "Rehearsing alone").
test("--judges 3: a three-judge panel, and cleanup takes only what seed made", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  const seeded = cli(["seed", "--judges", "3"]);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const s = seeded.json;
  assert.equal(s.judges, 3);
  const judges = s.accounts.filter((a) => a.role === "judge");
  assert.deepEqual(judges.map((a) => [a.username, a.judge_number]),
    [["rehearsal-judge1", 1], ["rehearsal-judge2", 2], ["rehearsal-judge3", 3]]);
  assert.equal(s.accounts.length, 9);
  const event = await one("SELECT number_of_judges FROM events WHERE id = $1", [s.event_id]);
  assert.equal(event.number_of_judges, 3);
  const panel = (await pool.query(
    `SELECT u.username, ej.judge_number FROM event_judges ej JOIN users u ON u.id = ej.judge_id
      WHERE ej.event_id = $1 ORDER BY ej.judge_number`, [s.event_id])).rows;
  assert.deepEqual(panel.map((p) => p.username), judges.map((a) => a.username));
  for (const j of judges) {
    const roles = (await pool.query(
      `SELECT r.role::text AS role FROM user_org_roles r JOIN users u ON u.id = r.user_id
        WHERE u.username = $1 ORDER BY r.role`, [j.username])).rows.map((r) => r.role);
    assert.deepEqual(roles, ["judge", "spectator"]);
  }
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE username IN ('rehearsal-judge4', 'rehearsal-judge5')"), 0);

  const st = cli(["status"]);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(st.json.rehearsals[0].users.length, 9);
  assert.equal(st.json.rehearsals[0].events[0].judges, 3);
  const text = spawnSync(process.execPath, [SCRIPT, "status"], { env: { ...process.env }, encoding: "utf8" });
  assert.match(text.stdout, /3 judges/);

  // rehearsal-judge4 is one of the names seed can make, but this seed
  // didn't, so it was free to sign up with. Somebody who did is still
  // somebody, and cleanup stops for them.
  const stranger = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ('rehearsal-judge4', 'x', 'Somebody Real', $1, now()) RETURNING id`, [s.org_id]);
  try {
    const refused = cli(["cleanup"]);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(refused.json.code, "foreign_users");
    assert.deepEqual(refused.json.details.users.map((u) => u.username), ["rehearsal-judge4"]);
    assert.equal(await n("SELECT count(*) AS n FROM users WHERE org_id = $1", [s.org_id]), 10);
  } finally {
    await pool.query("DELETE FROM users WHERE id = $1", [stranger.id]);
  }

  const clean = cli(["cleanup"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.json.cleaned[0].deleted.users, 9);
  assert.equal(clean.json.cleaned[0].deleted.event_judges, 3);
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE username LIKE 'rehearsal-%'"), 0);
});

// Bigger than the default too: the judges past five are the rehearsal's
// as much as the first five, so cleanup takes them without a fuss.
test("--judges 7: the extra judges are seeded and cleaned up with the rest", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  const seeded = cli(["seed", "--judges", "7"]);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  assert.equal(seeded.json.judges, 7);
  assert.equal(seeded.json.accounts.length, 13);
  assert.equal(await n("SELECT count(*) AS n FROM event_judges WHERE event_id = $1", [seeded.json.event_id]), 7);
  const clean = cli(["cleanup"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.json.cleaned[0].deleted.users, 13);
  assert.equal(await n("SELECT count(*) AS n FROM users WHERE username LIKE 'rehearsal-%'"), 0);
});

test("seed refuses a country where real users already are", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  const sfx = crypto.randomBytes(4).toString("hex");
  const org = await one(
    `INSERT INTO organisations (name, country_code, slug, status, claim_state)
     VALUES ('Real Federation', $1, $2, 'active', 'claimed') RETURNING id`,
    [TAKEN_COUNTRY, `rehearsal-refusal-${sfx}`]);
  const user = await one(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, 'x', 'Real Person', $2, now()) RETURNING id`, [`real-person-${sfx}`, org.id]);
  try {
    const res = cli(["seed", "--country", TAKEN_COUNTRY]);
    assert.equal(res.status, 1, res.stdout);
    assert.equal(res.json.code, "country_taken");
    assert.equal(res.json.details.orgs[0].users, 1);
    assert.equal(await n(
      "SELECT count(*) AS n FROM organisations WHERE slug = $1", [`rehearsal-${TAKEN_COUNTRY.toLowerCase()}`]), 0);
    assert.equal(await n("SELECT count(*) AS n FROM users WHERE username LIKE 'rehearsal-%'"), 0,
      "a refused seed writes nothing");

    // Cleanup and status leave a real org alone even when asked about its
    // country: the slug above looks a bit like ours but it isn't unclaimed.
    const clean = cli(["cleanup", "--country", TAKEN_COUNTRY]);
    assert.equal(clean.status, 0);
    assert.deepEqual(clean.json.cleaned, []);
    assert.equal(await n("SELECT count(*) AS n FROM users WHERE id = $1", [user.id]), 1);
    const st = cli(["status", "--country", TAKEN_COUNTRY]);
    assert.equal(st.json.seed_check.free, false);
    assert.equal(st.json.seed_check.other_orgs.length, 1);
  } finally {
    await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    await pool.query("DELETE FROM organisations WHERE id = $1", [org.id]);
  }
});

test("a country outside the catalogue is a usage error", async (t) => {
  if (!dbReachable) return t.skip("Postgres not reachable");
  const res = spawnSync(process.execPath, [SCRIPT, "seed", "--country", "ATA"], { env: { ...process.env }, encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /lib\/countries\.json/);
});
