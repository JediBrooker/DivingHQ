// The verify and reset emails an org admin sends from User Manager go
// out in the member's own language (users.locale), not the admin's. The
// routes used to pass the admin's request along, so a French-speaking
// admin resending a link to a Japanese member sent it in French.
//
// Mounts routes/users with spies for the two mailers. Self-skips when
// Postgres isn't reachable.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");

require("dotenv").config();

const createUsersRouter = require("../routes/users");

const suffix = crypto.randomUUID().slice(0, 8);
let pool;
let ready = false;
let server;
let base;
let orgId;
let memberId;
const sent = [];

before(async () => {
  pool = new Pool({
    user: process.env.DB_USER || process.env.PGUSER,
    host: process.env.DB_HOST || process.env.PGHOST,
    database: process.env.DB_DATABASE || process.env.PGDATABASE,
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
    port: Number(process.env.DB_PORT || process.env.PGPORT || 5432),
  });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }
  orgId = (await pool.query(
    "INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id",
    [`Mail Locale Fed ${suffix}`, `mail-locale-${suffix}`],
  )).rows[0].id;
  memberId = (await pool.query(
    `INSERT INTO users (username, password, full_name, email, org_id, locale)
     VALUES ($1, 'x', 'Aiko Member', $2, $3, 'ja') RETURNING id`,
    [`aiko-${suffix}`, `aiko-${suffix}@example.test`, orgId],
  )).rows[0].id;

  const admin = { id: crypto.randomUUID(), org_id: orgId, org_roles: ["org_admin"], is_system_admin: false, locale: "fr" };
  const setUser = (req, _res, next) => { req.user = { ...admin }; next(); };
  const app = express();
  app.use(express.json());
  app.use(createUsersRouter({
    pool,
    verifyToken: setUser,
    requireOrgAdmin: setUser,
    requireMeetEditor: setUser,
    bumpTokenVersion: () => {},
    sendRoleDecisionEmail: () => {},
    sendVerifyEmailEmail: async (id, token, opts) => { sent.push({ kind: "verify", id, opts }); },
    sendPasswordResetEmail: async (user, token, opts) => { sent.push({ kind: "reset", id: user.id, opts }); },
    hashFingerprint: (fp) => String(fp),
    JWT_SECRET: "test-secret-that-is-long-enough-for-this",
  }));
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
  ready = true;
});

after(async () => {
  if (server) await new Promise((res) => server.close(res));
  if (orgId) {
    await pool.query("DELETE FROM audit_log WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]).catch(() => {});
    await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]).catch(() => {});
  }
  if (pool) await pool.end();
});

test("an admin's resend-verification leaves the language to the member's account", async (t) => {
  if (!ready) return t.skip();
  const r = await fetch(`${base}/api/users/${memberId}/resend-verification`, { method: "POST" });
  assert.equal(r.status, 200, await r.text());
  const mail = sent.find((m) => m.kind === "verify" && m.id === memberId);
  assert.ok(mail, "a verify mail went out");
  // sendVerifyEmailEmail reads users.locale itself when it gets no req.
  assert.equal(mail.opts?.req, undefined, "not the admin's request");
});

test("an admin's password reset goes out in the member's saved locale", async (t) => {
  if (!ready) return t.skip();
  await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [memberId]);
  const r = await fetch(`${base}/api/users/${memberId}/reset-password`, { method: "POST" });
  assert.equal(r.status, 200, await r.text());
  const mail = sent.find((m) => m.kind === "reset" && m.id === memberId);
  assert.ok(mail, "a reset mail went out");
  assert.equal(mail.opts?.req, undefined, "not the admin's request");
  assert.equal(mail.opts?.locale, "ja");
});
