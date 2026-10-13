// Junior profiles (migration 107) against a real database: who can add an
// under-13 diver and how they get confirmed, the parent and coach links
// that come with that, results-only visibility, the parent getting the
// child's notifications, and the handover at 13.
//
// Mounts routes/juniors.js with users.js (the guardian review route) and
// the profile / search routers, the signed-in user swapped per request the
// way guardians.integration.test.js does it. The *.integration name keeps
// it out of test:safe. Skips when Postgres isn't reachable or 107 isn't
// applied.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config({ quiet: true });

const createJuniorsRouter = require("../routes/juniors");
const createUsersRouter = require("../routes/users");
const createDiverProfileRouter = require("../routes/diver-profile");
const createDiverSearchRouter = require("../routes/diver-search");
const createPublicProfileRouter = require("../routes/public-profile");

const sfx = crypto.randomBytes(4).toString("hex");
let pool;
let ready = false;
let server;
let base;
let push;
let acting = null;
const mails = [];
const handoverMails = [];
const ids = {};

function dobYearsAgo(years, days = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const as = (user) => { acting = user; };
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function makeUser(name, orgId, { roles = [], clubId = null, dob = null } = {}) {
  const u = await one(
    `INSERT INTO users (username, full_name, email, org_id, club_id, date_of_birth, password, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'x', now()) RETURNING id`,
    [`${name}-${sfx}`, `${name} ${sfx}`, `${name}-${sfx}@example.invalid`, orgId, clubId, dob],
  );
  for (const role of roles) {
    await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)", [u.id, orgId, role]);
  }
  return { id: u.id, username: `${name}-${sfx}`, full_name: `${name} ${sfx}`, org_id: orgId, org_roles: roles, is_system_admin: false };
}

const addJunior = (body) => api("POST", "/api/juniors", {
  gender: "female", consent: true, date_of_birth: dobYearsAgo(9), ...body,
});

before(async () => {
  require("./support/test-db").assertTestDatabase();
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     Number(process.env.DB_PORT || process.env.PGPORT || 5432),
      });
  try {
    const r = await pool.query("SELECT to_regclass('public.junior_profiles') AS t");
    if (!r.rows[0].t) { console.warn("[skip] junior_profiles missing, apply migration 107"); return; }
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // A country the clubs run (no federation), and one with a federation.
  ids.free = (await one(
    `INSERT INTO organisations (name, slug, status, claim_state, country_code)
     VALUES ($1, $1, 'active', 'unclaimed', 'TST') RETURNING id`, [`jr-free-${sfx}`])).id;
  ids.fed = (await one(
    `INSERT INTO organisations (name, slug, status, claim_state, country_code)
     VALUES ($1, $1, 'active', 'claimed', 'TST') RETURNING id`, [`jr-fed-${sfx}`])).id;
  ids.club = (await one("INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [ids.free, `Free Club ${sfx}`])).id;
  ids.otherClub = (await one("INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [ids.free, `Other Club ${sfx}`])).id;
  ids.fedClub = (await one("INSERT INTO clubs (org_id, name) VALUES ($1, $2) RETURNING id", [ids.fed, `Fed Club ${sfx}`])).id;

  ids.clubAdmin = await makeUser("cadmin", ids.free, { clubId: ids.club });
  ids.otherAdmin = await makeUser("oadmin", ids.free, { clubId: ids.otherClub });
  ids.parent = await makeUser("parent", ids.free, { roles: ["spectator"] });
  ids.parent2 = await makeUser("parent2", ids.free, { roles: ["spectator"] });
  ids.coach = await makeUser("coach", ids.free, { roles: ["coach"], clubId: ids.club });
  ids.stranger = await makeUser("stranger", ids.free, { roles: ["spectator"] });
  ids.fedAdmin = await makeUser("fadmin", ids.fed, { roles: ["org_admin"] });
  ids.fedClubAdmin = await makeUser("fcadmin", ids.fed, { clubId: ids.fedClub });
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [ids.club, ids.clubAdmin.id, ids.free]);
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [ids.otherClub, ids.otherAdmin.id, ids.free]);
  await pool.query("INSERT INTO club_admins (club_id, user_id, org_id) VALUES ($1, $2, $3)", [ids.fedClub, ids.fedClubAdmin.id, ids.fed]);
  ids.event = (await one(
    "INSERT INTO events (org_id, name, gender, number_of_judges) VALUES ($1, $2, 'Female', 5) RETURNING id",
    [ids.free, `Junior event ${sfx}`])).id;

  push = require("../lib/push")({ pool, io: null });
  const setUser = (req, _res, next) => { if (acting) req.user = { ...acting }; next(); };
  const verifyToken = (req, res, next) => (acting ? setUser(req, res, next) : res.status(401).json({ error: "no" }));
  const app = express();
  app.use(express.json());
  app.use(createJuniorsRouter({
    pool, verifyToken, push,
    sendNoticeEmail: async (userIds, mail) => { mails.push({ userIds, ...mail }); },
    sendJuniorHandoverEmail: async (m) => { handoverMails.push(m); return { sent: true }; },
  }));
  app.use(createUsersRouter({
    pool, verifyToken, requireOrgAdmin: verifyToken, requireMeetEditor: verifyToken,
    bumpTokenVersion: () => {}, sendRoleDecisionEmail: () => {}, push,
  }));
  app.use(createDiverProfileRouter({
    pool, verifyToken, optionalAuth: setUser, parseDateRange: () => ({ from: null, to: null }),
  }));
  app.use(createDiverSearchRouter({ pool, verifyToken }));
  app.use(createPublicProfileRouter({ pool }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (!pool) return;
  if (ready) {
    const orgs = [ids.free, ids.fed];
    await pool.query("DELETE FROM competitor_dive_lists WHERE event_id = $1", [ids.event]);
    await pool.query("DELETE FROM events WHERE id = $1", [ids.event]);
    await pool.query("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))", [orgs]);
    await pool.query("DELETE FROM audit_log WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM role_audit_log WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM coach_diver_links WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM guardians WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM club_admins WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM user_org_roles WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM users WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM clubs WHERE org_id = ANY($1)", [orgs]);
    await pool.query("DELETE FROM organisations WHERE id = ANY($1)", [orgs]);
  }
  await pool.end();
});

const diverRole = async (id) => (await pool.query(
  "SELECT 1 FROM user_org_roles WHERE user_id = $1 AND role = 'diver'", [id])).rowCount === 1;
const profileRow = (id) => one("SELECT * FROM junior_profiles WHERE user_id = $1", [id]);

test("a parent adds their child: it waits for the club, nobody can sign in to it", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.parent);
  const r = await addJunior({ full_name: `Amy Junior ${sfx}`, club_id: ids.club, as: "parent" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, "pending");
  assert.equal(r.json.reviewed_by, "club");
  ids.amy = r.json.id;

  const u = await one("SELECT password, email, username FROM users WHERE id = $1", [ids.amy]);
  assert.equal(u.password, null);
  assert.equal(u.email, null);
  assert.match(u.username, /^junior-[0-9a-f]{12}$/);
  assert.equal(await diverRole(ids.amy), false, "not enterable until it's confirmed");
  const jp = await profileRow(ids.amy);
  assert.equal(jp.created_as, "parent");
  assert.equal(jp.consent_by, ids.parent.id);
  const g = await one("SELECT status FROM guardians WHERE dependent_user_id = $1 AND guardian_user_id = $2", [ids.amy, ids.parent.id]);
  assert.equal(g.status, "pending");

  const asked = await pool.query(
    "SELECT user_id FROM notifications WHERE category = 'junior_request' AND data->>'junior_user_id' = $1", [ids.amy]);
  assert.deepEqual(asked.rows.map((x) => x.user_id), [ids.clubAdmin.id]);
  assert.ok(mails.some((m) => m.userIds.includes(ids.clubAdmin.id) && /Junior diver to confirm/.test(m.subject)));

  // The parent sees it on their page, waiting.
  const mine = await api("GET", "/api/juniors");
  const amy = mine.json.find((j) => j.id === ids.amy);
  assert.equal(amy.status, "pending");
  assert.equal(amy.you.guardian, "pending");
  assert.equal(amy.can.manage, false);
  assert.equal(amy.can.remove, true, "whoever added it can withdraw it");
});

test("the parent can't confirm their own child, the club admin can, and the queues agree", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.parent);
  assert.equal((await api("POST", `/api/juniors/${ids.amy}/review`, { decision: "approved" })).status, 403);

  as(ids.otherAdmin);
  const other = await api("GET", "/api/juniors/pending");
  assert.ok(!other.json.juniors.some((j) => j.id === ids.amy), "another club's admin doesn't see it");
  assert.equal((await api("POST", `/api/juniors/${ids.amy}/review`, { decision: "approved" })).status, 404);

  as(ids.clubAdmin);
  const q = await api("GET", "/api/juniors/pending");
  const row = q.json.juniors.find((j) => j.id === ids.amy);
  assert.ok(row);
  assert.equal(row.age, 9);
  assert.equal(row.added_by.username, ids.parent.username);
  assert.ok(!q.json.parent_links.some((l) => l.junior_id === ids.amy), "the adder's own link rides with the junior");

  const ok = await api("POST", `/api/juniors/${ids.amy}/review`, { decision: "approved" });
  assert.equal(ok.status, 200);
  assert.equal((await profileRow(ids.amy)).status, "active");
  assert.equal(await diverRole(ids.amy), true);
  const g = await one("SELECT status FROM guardians WHERE dependent_user_id = $1 AND guardian_user_id = $2", [ids.amy, ids.parent.id]);
  assert.equal(g.status, "approved");
  const told = await one(
    "SELECT title FROM notifications WHERE user_id = $1 AND category = 'junior_decision' ORDER BY created_at DESC LIMIT 1",
    [ids.parent.id]);
  assert.match(told.title, /is confirmed/);
  assert.equal((await api("POST", `/api/juniors/${ids.amy}/review`, { decision: "approved" })).status, 409);
});

test("a club admin where there's no federation adds one and it's confirmed at once", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.clubAdmin);
  const r = await addJunior({ full_name: `Ben Junior ${sfx}`, club_id: ids.club, as: "club", gender: "male" });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "active");
  ids.ben = r.json.id;
  assert.equal(await diverRole(ids.ben), true);
});

test("under a federation a club admin's junior waits for the federation's admins", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.fedClubAdmin);
  const r = await addJunior({ full_name: `Cal Junior ${sfx}`, club_id: ids.fedClub, as: "club", gender: "male" });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "pending");
  assert.equal(r.json.reviewed_by, "org");
  ids.cal = r.json.id;
  // Runs the club, doesn't confirm divers: the federation does.
  assert.equal((await api("POST", `/api/juniors/${ids.cal}/review`, { decision: "approved" })).status, 403);
  const mine = (await api("GET", "/api/juniors")).json.find((j) => j.id === ids.cal);
  assert.equal(mine.can.manage, true);

  as(ids.fedAdmin);
  assert.ok((await api("GET", "/api/juniors/pending")).json.juniors.some((j) => j.id === ids.cal));
  assert.equal((await api("POST", `/api/juniors/${ids.cal}/review`, { decision: "approved" })).status, 200);
  assert.equal(await diverRole(ids.cal), true);
});

test("a coach's junior is confirmed by the club and comes with a coach link", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.coach);
  const r = await addJunior({ full_name: `Dee Junior ${sfx}`, club_id: ids.club, as: "coach" });
  assert.equal(r.json.status, "pending");
  ids.dee = r.json.id;
  as(ids.clubAdmin);
  assert.equal((await api("POST", `/api/juniors/${ids.dee}/review`, { decision: "approved" })).status, 200);
  assert.equal((await pool.query(
    "SELECT 1 FROM coach_diver_links WHERE coach_id = $1 AND diver_id = $2", [ids.coach.id, ids.dee])).rowCount, 1);
  as(ids.coach);
  const seen = (await api("GET", "/api/juniors")).json.find((j) => j.id === ids.dee);
  assert.equal(seen.you.coach, true);
  assert.equal(seen.can.manage, false, "a coach enters them in meets but doesn't edit them");
});

test("the rules: under 13 only, a parent's agreement, the right relation, no duplicates", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.parent2);
  const old = await addJunior({ full_name: `Too Old ${sfx}`, club_id: ids.club, as: "parent", date_of_birth: dobYearsAgo(13) });
  assert.equal(old.status, 400);
  assert.equal(old.json.code, "not_junior");
  const noConsent = await addJunior({ full_name: `No Consent ${sfx}`, club_id: ids.club, as: "parent", consent: false });
  assert.equal(noConsent.json.code, "consent_required");
  const notAdmin = await addJunior({ full_name: `Not Admin ${sfx}`, club_id: ids.club, as: "club" });
  assert.equal(notAdmin.status, 403);
  const notCoach = await addJunior({ full_name: `Not Coach ${sfx}`, club_id: ids.club, as: "coach" });
  assert.equal(notCoach.status, 403);
  const future = await addJunior({ full_name: `Future ${sfx}`, club_id: ids.club, as: "parent", date_of_birth: "2999-01-01" });
  assert.equal(future.status, 400);
  // Already here: as a club admin that's a plain no, as a parent it's a
  // request to be linked to the one that exists.
  as(ids.clubAdmin);
  const dupClub = await addJunior({ full_name: `ben junior ${sfx}`, club_id: ids.club, as: "club", gender: "male" });
  assert.equal(dupClub.status, 409);
  assert.equal(dupClub.json.code, "junior_exists");
  as(ids.otherAdmin);
  const dup = await addJunior({ full_name: ` Ben Junior ${sfx} `, club_id: ids.club, as: "parent", gender: "male" });
  assert.equal(dup.status, 202, JSON.stringify(dup.json));
  assert.equal(dup.json.status, "link_requested");
  assert.equal((await pool.query(
    "SELECT 1 FROM users WHERE lower(full_name) = lower($1)", [`Ben Junior ${sfx}`])).rowCount, 1, "no second profile");
  assert.equal((await addJunior({ full_name: `Ben Junior ${sfx}`, club_id: ids.club, as: "parent", gender: "male" })).status, 409,
    "asking twice is refused");
  as(ids.clubAdmin);
  const queued = (await api("GET", "/api/juniors/pending")).json.parent_links.find((l) => l.junior_id === ids.ben);
  assert.equal(queued.parent.username, ids.otherAdmin.username);
  const asked = await one(
    "SELECT title FROM notifications WHERE user_id = $1 AND title LIKE '%asked to be linked to Ben Junior%'",
    [ids.clubAdmin.id]);
  assert.ok(asked, "the club hears about it");
  as(ids.parent2);
  // Another federation's club isn't somewhere a parent from here can add one.
  const elsewhere = await addJunior({ full_name: `Elsewhere ${sfx}`, club_id: ids.fedClub, as: "parent" });
  assert.equal(elsewhere.status, 403);
});

test("turning one down removes it", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.parent2);
  const r = await addJunior({ full_name: `Eve Junior ${sfx}`, club_id: ids.club, as: "parent" });
  as(ids.clubAdmin);
  assert.equal((await api("POST", `/api/juniors/${r.json.id}/review`, { decision: "rejected" })).status, 200);
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [r.json.id])).rowCount, 0);
  const told = await one(
    "SELECT title FROM notifications WHERE user_id = $1 AND category = 'junior_decision' ORDER BY created_at DESC LIMIT 1",
    [ids.parent2.id]);
  assert.match(told.title, /wasn't confirmed/);
});

test("under 13 is results only: profile pages and search are for the diver's own people", async (t) => {
  if (!ready) return t.skip("no database");
  as(null);
  const anon = await api("GET", `/api/divers/${ids.amy}/profile`);
  assert.equal(anon.status, 404);
  assert.equal(anon.json.code, "junior_private");
  assert.equal((await api("GET", `/api/divers/${ids.amy}/analytics`)).status, 404);
  as(ids.stranger);
  assert.equal((await api("GET", `/api/divers/${ids.amy}/profile`)).status, 404);
  const search = await api("GET", `/api/divers/search?q=${encodeURIComponent(`Amy Junior ${sfx}`)}`);
  assert.deepEqual(search.json, []);
  for (const who of [ids.parent, ids.clubAdmin]) {
    as(who);
    assert.equal((await api("GET", `/api/divers/${ids.amy}/profile`)).status, 200);
  }
  as(ids.coach);
  assert.equal((await api("GET", `/api/divers/${ids.dee}/profile`)).status, 200);
  const slug = (await one("SELECT public_slug FROM users WHERE id = $1", [ids.amy])).public_slug;
  as(null);
  assert.equal((await api("GET", `/api/public/divers/${slug}`)).status, 404);
});

test("a junior's notifications go to their parents, with the child's name on", async (t) => {
  if (!ready) return t.skip("no database");
  await push.sendNotification([ids.amy, ids.stranger.id], {
    category: "event_live", title: "Your event is live", action_url: "/competitor",
  });
  const toAmy = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1", [ids.amy]);
  assert.equal(toAmy.rowCount, 0, "nobody reads a junior's inbox");
  const toParent = await one(
    "SELECT title, action_url, data FROM notifications WHERE user_id = $1 AND category = 'event_live'", [ids.parent.id]);
  assert.equal(toParent.title, `Amy Junior ${sfx}: Your event is live`);
  assert.equal(toParent.action_url, "/juniors", "Dive Sheets would bounce a parent");
  assert.equal(toParent.data.for_junior.id, ids.amy);
  const toStranger = await pool.query("SELECT title FROM notifications WHERE user_id = $1 AND category = 'event_live'", [ids.stranger.id]);
  assert.equal(toStranger.rows[0].title, "Your event is live");

  await push.sendNotification([ids.amy], {
    category: "event_live", title: "Results", action_url: `/scoreboard/${ids.event}`,
  });
  const sb = await one(
    "SELECT action_url FROM notifications WHERE user_id = $1 AND title LIKE '%: Results'", [ids.parent.id]);
  assert.equal(sb.action_url, `/scoreboard/${ids.event}`);
});

test("the meet-live and results emails go to a junior's parents, naming the child", async (t) => {
  if (!ready) return t.skip("no database");
  await pool.query(
    "INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number) VALUES ($1, $2, 1)",
    [ids.event, ids.amy]);
  // lib/email builds its mailer from the env when it's created, and sends
  // through Cloudflare's API with fetch. Point both at a recorder.
  const saved = { a: process.env.CF_ACCOUNT_ID, t: process.env.CF_EMAIL_TOKEN, fetch: globalThis.fetch };
  const sent = [];
  process.env.CF_ACCOUNT_ID = "acct";
  process.env.CF_EMAIL_TOKEN = "tok";
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.cloudflare.com")) {
      sent.push(JSON.parse(opts.body));
      return new Response("{}", { status: 200 });
    }
    return saved.fetch(url, opts);
  };
  try {
    const email = require("../lib/email")({ pool });
    await email.sendEventStartedEmails({ id: ids.event, name: `Junior event ${sfx}` });
    await email.sendEventResultsEmails({ id: ids.event, name: `Junior event ${sfx}` });
  } finally {
    process.env.CF_ACCOUNT_ID = saved.a ?? "";
    process.env.CF_EMAIL_TOKEN = saved.t ?? "";
    if (saved.a === undefined) delete process.env.CF_ACCOUNT_ID;
    if (saved.t === undefined) delete process.env.CF_EMAIL_TOKEN;
    globalThis.fetch = saved.fetch;
    await pool.query("DELETE FROM competitor_dive_lists WHERE competitor_id = $1", [ids.amy]);
  }
  const toParent = sent.filter((m) => m.to === `parent-${sfx}@example.invalid`);
  assert.equal(toParent.length, 2, JSON.stringify(sent.map((m) => m.to)));
  assert.match(toParent[0].text, new RegExp(`which Amy Junior ${sfx} is diving in`));
  assert.match(toParent[1].subject, new RegExp(`\\(Amy Junior ${sfx}\\)$`));
  assert.ok(!sent.some((m) => m.to === `parent2-${sfx}@example.invalid`), "a parent of someone else hears nothing");
});

test("parents added by username: at once by the club, through the queue from another parent", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.clubAdmin);
  const byClub = await api("POST", `/api/juniors/${ids.ben}/parents`, { username: `@${ids.parent2.username}` });
  assert.equal(byClub.status, 201, JSON.stringify(byClub.json));
  assert.equal(byClub.json.status, "approved");
  assert.equal((await api("POST", `/api/juniors/${ids.ben}/parents`, { username: ids.parent2.username })).status, 409);
  assert.equal((await api("POST", `/api/juniors/${ids.ben}/parents`, { username: "nobody-here" })).status, 404);
  assert.equal((await api("POST", `/api/juniors/${ids.ben}/parents`, { username: ids.fedAdmin.username })).status, 404,
    "another country's account can't be linked");

  as(ids.parent);
  const byParent = await api("POST", `/api/juniors/${ids.amy}/parents`, { username: ids.stranger.username });
  assert.equal(byParent.json.status, "pending");
  as(ids.clubAdmin);
  const q = await api("GET", "/api/juniors/pending");
  const link = q.json.parent_links.find((l) => l.junior_id === ids.amy);
  assert.ok(link);
  assert.equal(link.parent.username, ids.stranger.username);
  const ok = await api("POST", `/api/guardian-requests/${link.id}/review`, { decision: "approved" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const told = await one(
    "SELECT body, action_url FROM notifications WHERE user_id = $1 AND category = 'guardian_decision' ORDER BY created_at DESC LIMIT 1",
    [ids.stranger.id]);
  assert.equal(told.action_url, "/juniors");
  assert.match(told.body, /meet notifications/);
  // Payments-era queue leaves junior links to the juniors queue.
  const legacy = await api("GET", "/api/guardian-requests");
  assert.ok(!legacy.json.some((r) => r.dependent_id === ids.amy));

  as(ids.stranger);
  const amy = (await api("GET", "/api/juniors")).json.find((j) => j.id === ids.amy);
  const own = amy.parents.find((p) => p.user_id === ids.stranger.id);
  assert.equal((await api("DELETE", `/api/juniors/${ids.amy}/parents/${own.link_id}`)).status, 200, "a parent can take themselves off");
});

test("editing: the diver's people only, and moving club takes someone who runs both", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.coach);
  assert.equal((await api("PUT", `/api/juniors/${ids.dee}`, { full_name: "Nope" })).status, 403);
  as(ids.parent);
  assert.equal((await api("PUT", `/api/juniors/${ids.amy}`, { gender: "other" })).status, 200);
  assert.equal((await api("PUT", `/api/juniors/${ids.amy}`, { club_id: ids.otherClub })).status, 403);
  as(ids.stranger);
  assert.equal((await api("PUT", `/api/juniors/${ids.amy}`, { gender: "female" })).status, 404);
});

test("handover at 13: a link by email, then it's the diver's own account", async (t) => {
  if (!ready) return t.skip("no database");
  as(ids.clubAdmin);
  const tooYoung = await api("POST", `/api/juniors/${ids.ben}/handover`, { email: "ben@example.invalid" });
  assert.equal(tooYoung.status, 400);
  assert.equal(tooYoung.json.code, "too_young");

  await pool.query("UPDATE users SET date_of_birth = $2 WHERE id = $1", [ids.ben, dobYearsAgo(13, 1)]);
  const sent = await api("POST", `/api/juniors/${ids.ben}/handover`, { email: "ben@example.invalid" });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const mail = handoverMails.at(-1);
  assert.equal(mail.to, "ben@example.invalid");
  assert.equal(mail.juniorName, `Ben Junior ${sfx}`);
  const stored = await profileRow(ids.ben);
  assert.notEqual(stored.handover_token_hash, mail.token, "only the hash is stored");

  as(null);
  const peek = await api("GET", `/api/junior-handover/${mail.token}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.json.full_name, `Ben Junior ${sfx}`);
  assert.equal((await api("GET", "/api/junior-handover/not-a-real-token-at-all-xx")).status, 404);

  const noAge = await api("POST", "/api/junior-handover", { token: mail.token, username: `ben-${sfx}`, password: "a-good-pass-123" });
  assert.equal(noAge.status, 400);
  const weak = await api("POST", "/api/junior-handover", {
    token: mail.token, username: `ben-${sfx}`, password: "short", age_13_or_older: true });
  assert.equal(weak.status, 400);
  const taken = await api("POST", "/api/junior-handover", {
    token: mail.token, username: ids.parent.username, password: "a-good-pass-123", age_13_or_older: true });
  assert.equal(taken.status, 409);
  const done = await api("POST", "/api/junior-handover", {
    token: mail.token, username: `ben-${sfx}`, password: "a-good-pass-123", age_13_or_older: true });
  assert.equal(done.status, 200, JSON.stringify(done.json));

  const u = await one("SELECT username, email, email_verified_at, password FROM users WHERE id = $1", [ids.ben]);
  assert.equal(u.username, `ben-${sfx}`);
  assert.equal(u.email, "ben@example.invalid");
  assert.ok(u.email_verified_at, "the link proved the address");
  assert.ok(u.password && u.password.startsWith("$2"));
  assert.equal((await profileRow(ids.ben)).status, "handed_over");
  assert.equal((await api("POST", "/api/junior-handover", {
    token: mail.token, username: `ben2-${sfx}`, password: "a-good-pass-123", age_13_or_older: true })).status, 404,
  "the link works once");
  const told = await one(
    "SELECT title FROM notifications WHERE user_id = $1 AND title LIKE '%own DivingHQ account%'", [ids.parent2.id]);
  assert.ok(told, "the linked parent hears about it");

  // Their own account now, so their notifications are theirs again.
  await push.sendNotification([ids.ben], { category: "event_live", title: "Ben's own" });
  assert.equal((await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title = 'Ben''s own'", [ids.ben])).rowCount, 1);
});

test("removing a junior: gone if they never dived, name kept on results if they did", async (t) => {
  if (!ready) return t.skip("no database");
  await pool.query(
    "INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number) VALUES ($1, $2, 1)",
    [ids.event, ids.dee]);
  as(ids.clubAdmin);
  assert.equal((await api("DELETE", `/api/juniors/${ids.dee}`)).status, 200);
  const dee = await one("SELECT full_name, deleted_at, date_of_birth FROM users WHERE id = $1", [ids.dee]);
  assert.equal(dee.full_name, `Dee Junior ${sfx}`);
  assert.ok(dee.deleted_at);
  assert.equal(dee.date_of_birth, null);
  assert.equal(await profileRow(ids.dee), undefined);

  as(ids.parent2);
  const r = await addJunior({ full_name: `Fay Junior ${sfx}`, club_id: ids.club, as: "parent" });
  assert.equal((await api("DELETE", `/api/juniors/${r.json.id}`)).status, 200, "whoever added a pending one can withdraw it");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [r.json.id])).rowCount, 0);
});
