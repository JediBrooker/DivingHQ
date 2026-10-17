// Entry eligibility (lib/entry-eligibility.js) against a real database
// and the real server: signup asks for date of birth and gender and turns
// an under-13 away, a member sets theirs through PUT /api/users/me/details,
// and every entry path (Dive Sheets submit, the coach's submit, the
// Control Room late add, the CSV roster import) refuses a wrong-gender or
// out-of-age-group diver with the same 400 while a mixed Open event still
// takes anyone. The pickers (GET /api/events, GET /api/orgs/:id/divers,
// GET /api/coach/dive-lists/:id) carry the same verdict.
//
// Boots server.js the way integration.test.js does. The *.integration
// name keeps it out of test:safe; skips when Postgres isn't reachable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";
process.env.PDF_FONT_DIR = "none";

require("dotenv").config();
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

let pool;
let ready = false;
let httpServer;
let baseUrl;
const orgs = [];

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
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_this_secret_in_production") {
    console.warn("[skip] JWT_SECRET not set");
    return;
  }
  process.env.RATE_LIMIT_DISABLED = "true";
  const mod = require("../server.js");
  httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
  await mod.features.load();
  if (!mod.features.enabled("signups")) await mod.features.set("signups", true);
  ready = true;
});

after(async () => {
  for (const orgId of orgs) {
    try {
      await pool.query("DELETE FROM events WHERE org_id = $1", [orgId]);
      await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
      await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
    } catch (err) {
      console.warn(`[cleanup] org ${orgId}: ${err.message}`);
    }
  }
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  try {
    const { io } = require("../server.js");
    if (io && typeof io.close === "function") io.close();
  } catch { /* noop */ }
  if (pool) await pool.end();
});

function api(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request({ method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const rand = () => crypto.randomBytes(3).toString("hex");

const kit = {
  async org() {
    const slug = `elig-${rand()}`;
    const r = await pool.query(
      `INSERT INTO organisations (name, country_code, slug, status, claim_state)
       VALUES ($1, 'TST', $2, 'active', 'claimed') RETURNING id`,
      [`Eligibility ${slug}`, slug],
    );
    orgs.push(r.rows[0].id);
    return r.rows[0].id;
  },
  // gender / dob null means "never filled in", the state every account
  // made before signup asked for them is in.
  async user(orgId, name, roles, { gender = null, dob = null } = {}) {
    const username = `${name}-${rand()}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 50);
    const r = await pool.query(
      `INSERT INTO users (username, full_name, org_id, email_verified_at, gender, date_of_birth, password)
       VALUES ($1, $2, $3, now(), $4, $5, 'x') RETURNING id, token_version`,
      [username, name, orgId, gender, dob],
    );
    for (const role of roles) {
      await pool.query("INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)", [r.rows[0].id, orgId, role]);
    }
    const u = { id: r.rows[0].id, username, full_name: name, org_id: orgId, org_roles: roles, is_system_admin: false, tv: r.rows[0].token_version };
    u.token = jwt.sign(
      { id: u.id, username, full_name: name, org_id: orgId, org_roles: roles, is_system_admin: false, tv: u.tv },
      process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" },
    );
    return u;
  },
  async event(orgId, fields = {}) {
    const f = {
      name: "Eligibility event", gender: "Mixed", height: "3m", number_of_judges: 5, total_rounds: 1,
      event_type: "individual", event_format: "final", status: "Upcoming", ...fields,
    };
    const cols = Object.keys(f);
    const r = await pool.query(
      `INSERT INTO events (org_id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING id`,
      [orgId, ...cols.map((c) => f[c])],
    );
    return r.rows[0].id;
  },
  async dive() {
    const r = await pool.query(
      "SELECT id, dive_code, position FROM dive_directory WHERE height = 3 AND NOT is_custom ORDER BY dive_code, id LIMIT 1",
    );
    return r.rows[0];
  },
};

const skip = (t) => (!ready ? t.skip("DB not reachable or server didn't boot") : false);

// Age on 31 December of this year, as a birthday (Article 1.8).
function bornAged(age, year = new Date().getUTCFullYear()) {
  return `${year - age}-06-15`;
}

test("signup needs a date of birth and a gender, and turns an under-13 towards junior profiles", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const base = () => ({
    age_13_or_older: true, username: `elig-${rand()}`, full_name: "New Member", password: "integration-test-password-1234",
    email: `elig-${rand()}@example.test`, org_id: orgId,
  });

  let r = await api("POST", "/api/auth/register", { body: { ...base(), gender: "female" } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "date_of_birth_required");

  r = await api("POST", "/api/auth/register", { body: { ...base(), date_of_birth: "1990-06-15" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "gender_required");

  r = await api("POST", "/api/auth/register", { body: { ...base(), date_of_birth: "2020-02-30", gender: "female" } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /real date/);

  r = await api("POST", "/api/auth/register", { body: { ...base(), date_of_birth: bornAged(10), gender: "male" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "minimum_age");
  assert.equal(r.body.junior_profiles, "/guide/junior-divers");

  const ok = base();
  r = await api("POST", "/api/auth/register", { body: { ...ok, date_of_birth: "1990-06-15", gender: "Female" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = (await pool.query(
    "SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob, gender FROM users WHERE username = $1", [ok.username],
  )).rows[0];
  assert.deepEqual(row, { dob: "1990-06-15", gender: "female" });
});

test("a member sets their own competition details, audit-logged, and the session body carries them", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const me = await kit.user(orgId, "Self Service", ["diver"]);

  // /api/auth/me answers { user }, the body-only extras included.
  let r = await api("GET", "/api/auth/me", { token: me.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.date_of_birth, null);
  assert.equal(r.body.user.gender, null);

  r = await api("PUT", "/api/users/me/details", { token: me.token, body: {} });
  assert.equal(r.status, 400);
  r = await api("PUT", "/api/users/me/details", { token: me.token, body: { date_of_birth: "15/06/1990" } });
  assert.equal(r.status, 400);
  r = await api("PUT", "/api/users/me/details", { token: me.token, body: { gender: "yes" } });
  assert.equal(r.status, 400);
  r = await api("PUT", "/api/users/me/details", { token: me.token, body: { date_of_birth: bornAged(11) } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "minimum_age");

  r = await api("PUT", "/api/users/me/details", { token: me.token, body: { date_of_birth: "1990-06-15", gender: "Male" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, date_of_birth: "1990-06-15", gender: "male" });

  r = await api("GET", "/api/auth/me", { token: me.token });
  assert.equal(r.body.user.date_of_birth, "1990-06-15");
  assert.equal(r.body.user.gender, "male");

  // One field at a time leaves the other alone; an empty string clears.
  r = await api("PUT", "/api/users/me/details", { token: me.token, body: { gender: "" } });
  assert.deepEqual(r.body, { ok: true, date_of_birth: "1990-06-15", gender: null });

  const audit = await pool.query(
    "SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'user.details_updated' ORDER BY created_at",
    [me.id],
  );
  assert.equal(audit.rows.length, 2);
  assert.deepEqual(audit.rows[0].metadata.date_of_birth, { from: null, to: "1990-06-15" });
  assert.deepEqual(audit.rows[0].metadata.gender, { from: null, to: "male" });
  assert.deepEqual(audit.rows[1].metadata.gender, { from: "male", to: null });
});

test("Dive Sheets: a women's event refuses a man or a blank profile, an age group refuses the over-age, mixed Open takes anyone", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const dive = await kit.dive();
  const women = await kit.event(orgId, { name: "Women 3m", gender: "Female", age_group: "Open" });
  const groupB = await kit.event(orgId, { name: "Girls B 3m", gender: "Female", age_group: "Junior Group B", scheduled_at: `${new Date().getUTCFullYear()}-11-20T10:00:00Z` });
  const open = await kit.event(orgId, { name: "Open 3m", gender: "Mixed", age_group: "Open" });

  const man = await kit.user(orgId, "Marco", ["diver"], { gender: "male", dob: "1990-01-01" });
  const blank = await kit.user(orgId, "Blank", ["diver"]);
  const woman = await kit.user(orgId, "Wendy", ["diver"], { gender: "female", dob: bornAged(19) });
  const girl = await kit.user(orgId, "Gina", ["diver"], { gender: "female", dob: bornAged(15) });
  const noDob = await kit.user(orgId, "Nora", ["diver"], { gender: "female" });

  const submit = (u, event_id) => api("POST", "/api/competitor/submit-list", {
    token: u.token, body: { event_id, dives: [{ dive_id: dive.id, round_number: 1 }] },
  });

  let r = await submit(man, women);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "ineligible");
  assert.match(r.body.error, /women's event; your profile says male/);

  r = await submit(blank, women);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "ineligible");
  assert.match(r.body.error, /your profile has no gender.*Competition details on My Profile/);

  r = await submit(woman, women);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await submit(woman, groupB);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "ineligible");
  assert.match(r.body.error, /Age Group B \(14-15\); you are 19 on 31 December/);
  assert.match(r.body.error, /Article 13\.2\.1/);

  r = await submit(noDob, groupB);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no date of birth/);

  r = await submit(girl, groupB);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  for (const u of [man, blank, woman, girl, noDob]) {
    r = await submit(u, open);
    assert.equal(r.status, 200, `${u.full_name} on the open event: ${JSON.stringify(r.body)}`);
  }

  // The events list says the same thing to the diver, and nothing to an admin.
  const admin = await kit.user(orgId, "Admin", ["org_admin"]);
  const forMan = await api("GET", "/api/events", { token: man.token });
  const womenRow = forMan.body.find((e) => e.id === women);
  assert.equal(womenRow.entry_eligibility.allowed, false);
  assert.equal(womenRow.entry_eligibility.code, "gender");
  assert.equal(forMan.body.find((e) => e.id === open).entry_eligibility.allowed, true);
  const forAdmin = await api("GET", "/api/events", { token: admin.token });
  assert.equal(forAdmin.body.find((e) => e.id === women).entry_eligibility, undefined);
});

test("a synchro partner is checked too", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const dive = await kit.dive();
  const women = await kit.event(orgId, { name: "Women synchro", gender: "Female", event_type: "synchro_pair", number_of_judges: 9 });
  const a = await kit.user(orgId, "Pair A", ["diver"], { gender: "female", dob: "1999-01-01" });
  const b = await kit.user(orgId, "Pair B", ["diver"], { gender: "male", dob: "1999-01-01" });
  const r = await api("POST", "/api/competitor/submit-list", {
    token: a.token, body: { event_id: women, partner_id: b.id, dives: [{ dive_id: dive.id, round_number: 1 }] },
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "ineligible");
  assert.match(r.body.error, /Pair B's profile says male/);
});

test("the coach workbench refuses the same entries and shows the verdict per diver", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const dive = await kit.dive();
  const women = await kit.event(orgId, { name: "Women 3m", gender: "Female" });
  const coach = await kit.user(orgId, "Coach", ["coach"]);
  const man = await kit.user(orgId, "Linked Man", ["diver"], { gender: "male", dob: "1990-01-01" });
  const woman = await kit.user(orgId, "Linked Woman", ["diver"], { gender: "female", dob: "1990-01-01" });
  for (const d of [man, woman]) {
    await pool.query("INSERT INTO coach_diver_links (coach_id, diver_id, org_id) VALUES ($1, $2, $3)", [coach.id, d.id, orgId]);
  }
  const list = await api("GET", `/api/coach/dive-lists/${women}`, { token: coach.token });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const manRow = list.body.divers.find((d) => d.diver_id === man.id);
  const womanRow = list.body.divers.find((d) => d.diver_id === woman.id);
  assert.equal(manRow.entry_eligibility.allowed, false);
  assert.equal(manRow.coach_eligibility.can_submit, false);
  assert.equal(manRow.gender, undefined, "the diver's gender itself stays off the wire");
  assert.equal(manRow.date_of_birth, undefined);
  assert.equal(womanRow.entry_eligibility.allowed, true);
  assert.equal(womanRow.coach_eligibility.can_submit, true);

  const submit = (diverId) => api("POST", `/api/coach/dive-lists/${women}/${diverId}`, {
    token: coach.token, body: { dives: [{ dive_id: dive.id, round_number: 1 }] },
  });
  let r = await submit(man.id);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "ineligible");
  assert.match(r.body.error, /Linked Man's profile says male/);
  r = await submit(woman.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("Control Room late entry and the CSV import refuse ineligible divers, and the picker says who can", async (t) => {
  if (skip(t)) return;
  const orgId = await kit.org();
  const dive = await kit.dive();
  const year = new Date().getUTCFullYear();
  const boysC = await kit.event(orgId, { name: "Boys C 3m", gender: "Male", age_group: "Junior Group C", scheduled_at: `${year}-08-01T10:00:00Z` });
  const admin = await kit.user(orgId, "Roster Admin", ["org_admin"]);
  const boy = await kit.user(orgId, "Ben Boy", ["diver"], { gender: "male", dob: bornAged(13) });
  const teen = await kit.user(orgId, "Ted Teen", ["diver"], { gender: "male", dob: bornAged(16) });
  const girl = await kit.user(orgId, "Gail Girl", ["diver"], { gender: "female", dob: bornAged(12) });
  const blank = await kit.user(orgId, "Blank Slate", ["diver"]);

  const late = (competitor_id) => api("POST", `/api/events/${boysC}/roster`, {
    token: admin.token, body: { competitor_id, dive_id: dive.id, round_number: 1 },
  });
  let r = await late(girl.id);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, "ineligible");
  assert.equal(r.body.eligibility_code, "gender");
  r = await late(teen.id);
  assert.equal(r.status, 400);
  assert.equal(r.body.eligibility_code, "too_old");
  assert.match(r.body.error, /Ted Teen is 16 on 31 December/);
  r = await late(blank.id);
  assert.equal(r.status, 400);
  assert.equal(r.body.eligibility_code, "missing_gender");
  r = await late(boy.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));

  // CSV: the bad rows are reported, the good one lands, the file isn't rejected.
  const csv = [
    "username,round_1_code,round_1_pos",
    `${boy.username},${dive.dive_code},${dive.position}`,
    `${girl.username},${dive.dive_code},${dive.position}`,
    `${teen.username},${dive.dive_code},${dive.position}`,
  ].join("\n");
  r = await api("POST", `/api/events/${boysC}/roster/import`, { token: admin.token, body: { csv } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 1);
  assert.equal(r.body.errors.length, 2);
  assert.ok(r.body.errors.every((e) => e.code === "ineligible"), JSON.stringify(r.body.errors));
  assert.match(r.body.errors.find((e) => e.username === teen.username).error, /Age Group C/);
  const rows = await pool.query("SELECT competitor_id FROM competitor_dive_lists WHERE event_id = $1", [boysC]);
  assert.deepEqual(rows.rows.map((x) => x.competitor_id), [boy.id]);

  // The late-entry picker's source: a verdict per diver, no birthday on the wire.
  const picker = await api("GET", `/api/orgs/${orgId}/divers?event_id=${boysC}`, { token: admin.token });
  assert.equal(picker.status, 200);
  const byId = new Map(picker.body.map((d) => [d.id, d]));
  assert.equal(byId.get(boy.id).entry_eligibility.allowed, true);
  assert.equal(byId.get(girl.id).entry_eligibility.code, "gender");
  assert.equal(byId.get(teen.id).entry_eligibility.code, "too_old");
  assert.equal(byId.get(blank.id).entry_eligibility.code, "missing_gender");
  assert.equal(byId.get(boy.id).date_of_birth, undefined);
  assert.equal(byId.get(boy.id).gender, undefined);
  const plain = await api("GET", `/api/orgs/${orgId}/divers`, { token: admin.token });
  assert.equal(plain.body.find((d) => d.id === boy.id).entry_eligibility, undefined);
  const other = await api("GET", `/api/orgs/${orgId}/divers?event_id=${crypto.randomUUID()}`, { token: admin.token });
  assert.equal(other.status, 404);
});
