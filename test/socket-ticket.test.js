// Native socket credentials have a narrower purpose and lifetime than the
// HTTP session that issues them. Exercise the real JWT and HTTP perimeter so
// a ticket can never accidentally become a general-purpose bearer token.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const createMiddleware = require("../lib/middleware");
const { mintSocketTicket, verifySocketTicket, nativeSocketLifetimeMs } = require("../lib/socket-ticket");
const attachSocket = require("../routes/socket");
const { includeBodyToken } = require("../routes/auth");

const SECRET = "socket-ticket-tests-only-secret-01234567890123456789";
const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const now = () => Math.floor(Date.now() / 1000);

test("long native sessions cannot overflow Node's timer into an immediate disconnect", () => {
  const start = 1800000000000;
  const eightHours = 8 * 60 * 60 * 1000;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  assert.equal(nativeSocketLifetimeMs((start + eightHours) / 1000, start), eightHours);
  assert.equal(nativeSocketLifetimeMs((start + thirtyDays) / 1000, start), 2 ** 31 - 1);
  assert.equal(nativeSocketLifetimeMs((start - 1000) / 1000, start), 0);
});

function session(at = now()) {
  return {
    id: USER, org_id: ORG, org_roles: ["judge"], is_system_admin: false,
    tv: 7, iat: at - 10, exp: at + 3600,
  };
}

test("socket ticket carries only socket identity and a 30-second admission window", () => {
  const at = now();
  const original = { ...session(at), full_name: "Private name", token: "never-copy-me", extra: true };
  const before = structuredClone(original);
  const raw = mintSocketTicket(original, SECRET, { now: at });
  const ticket = verifySocketTicket(raw, SECRET);
  assert.deepEqual(ticket, {
    id: USER, org_id: ORG, org_roles: ["judge"], is_system_admin: false, tv: 7,
    type: "socket_ticket", aud: "dhq-native-socket", iat: at, exp: at + 30,
    session_exp: original.exp,
  });
  assert.deepEqual(original, before, "issuing a ticket must not mutate the session");
});

test("socket ticket never extends its issuing session's expiry", () => {
  const at = now();
  const raw = mintSocketTicket({ ...session(at), exp: at + 5 }, SECRET, { now: at });
  const ticket = verifySocketTicket(raw, SECRET);
  assert.equal(ticket.exp, at + 5);
  assert.equal(ticket.session_exp, at + 5);
  assert.throws(() => jwt.verify(raw, SECRET, { algorithms: ["HS256"], clockTimestamp: at + 5 }), /expired/);
});

test("socket ticket mint refuses expired, unversioned and non-session claims", () => {
  const at = now();
  const cases = [
    null, {}, { ...session(at), id: "not-a-uuid" },
    { ...session(at), exp: at }, { ...session(at), exp: at - 1 },
    { ...session(at), exp: undefined }, { ...session(at), exp: "9999999999" },
    { ...session(at), tv: undefined }, { ...session(at), tv: "7" },
    { ...session(at), type: "password_reset" },
    { ...session(at), type: "totp_step" },
    { ...session(at), type: "socket_ticket" },
  ];
  for (const claims of cases) {
    assert.throws(() => mintSocketTicket(claims, SECRET, { now: at }), `refuse ${JSON.stringify(claims)}`);
  }
});

test("socket verifier rejects ordinary sessions and tokens for another purpose", () => {
  const at = now();
  const base = jwt.decode(mintSocketTicket(session(at), SECRET, { now: at }));
  for (const claims of [
    session(at),
    { ...base, type: "password_reset" },
    { ...base, type: "totp_step" },
    { ...base, type: undefined },
    { ...base, aud: "another-service" },
    { ...base, aud: undefined },
    { ...base, id: "not-a-uuid" },
  ]) {
    assert.throws(() => verifySocketTicket(jwt.sign(claims, SECRET), SECRET));
  }
});

test("socket verifier rejects expired tickets, altered signatures and other algorithms", () => {
  const at = now();
  const raw = mintSocketTicket(session(at), SECRET, { now: at });
  const claims = jwt.decode(raw);
  assert.throws(() => verifySocketTicket(jwt.sign({ ...claims, exp: at - 1 }, SECRET), SECRET), /expired/);
  assert.throws(() => verifySocketTicket(raw, SECRET + "wrong"));
  assert.throws(() => verifySocketTicket(jwt.sign(claims, SECRET, { algorithm: "HS384" }), SECRET));
  assert.throws(() => verifySocketTicket(jwt.sign(claims, null, { algorithm: "none" }), SECRET));
  for (const malformed of [null, "", "not-a-jwt", {}, []]) {
    assert.throws(() => verifySocketTicket(malformed, SECRET));
  }
});

test("socket verifier rejects signed tickets with unbounded or unversioned claims", () => {
  const at = now();
  const claims = jwt.decode(mintSocketTicket(session(at), SECRET, { now: at }));
  for (const invalid of [
    { ...claims, exp: at + 31 },
    { ...claims, session_exp: at + 1 },
    { ...claims, exp: undefined },
    { ...claims, iat: undefined },
    { ...claims, session_exp: undefined },
    { ...claims, tv: undefined },
    { ...claims, tv: "7" },
  ]) {
    // noTimestamp prevents jsonwebtoken from filling a deliberately absent iat.
    const options = invalid.iat === undefined ? { noTimestamp: true } : {};
    assert.throws(() => verifySocketTicket(jwt.sign(invalid, SECRET, options), SECRET));
  }
});

async function handshake(auth, check = async () => true) {
  let gate;
  attachSocket({
    io: { use(fn) { gate = fn; }, on() {} },
    pool: { async query() { return { rows: [] }; } },
    JWT_SECRET: SECRET,
    isTokenVersionCurrent: check,
  });
  const socket = { handshake: { auth, headers: {} } };
  const error = await new Promise((resolve, reject) => {
    Promise.resolve(gate(socket, resolve)).catch(reject);
  });
  return { socket, error };
}

test("native handshake carries identity through the existing token-version check", async () => {
  const checked = [];
  const ticket = mintSocketTicket(session(), SECRET);
  const { socket, error } = await handshake({ ticket }, async (...args) => {
    checked.push(args);
    return true;
  });
  assert.equal(error, undefined);
  assert.deepEqual(checked, [[USER, 7]]);
  assert.equal(socket.userId, USER);
  assert.equal(socket.userOrgId, ORG);
  assert.deepEqual(socket.userOrgRoles, ["judge"]);
  assert.equal(socket.userIsSystemAdmin, false);
  assert.equal(socket.userTokenVersion, 7);
  assert.equal(socket.nativeSessionExpires, jwt.decode(ticket).session_exp);
});

test("invalid, revoked and unavailable native sessions fail the handshake closed", async () => {
  const ticket = mintSocketTicket(session(), SECRET);
  for (const [auth, check] of [
    [{ ticket: "bad-ticket" }, async () => true],
    [{ ticket }, async () => false],
    [{ ticket }, async () => { throw new Error("database unavailable"); }],
  ]) {
    const { socket, error } = await handshake(auth, check);
    assert.ok(error instanceof Error);
    assert.equal(socket.userId, undefined);
  }
});

test("explicit spectator sockets remain anonymous even if a ticket is supplied", async () => {
  let checked = false;
  const { socket, error } = await handshake({ token: "spectator", ticket: "ignored" }, async () => {
    checked = true;
    return true;
  });
  assert.equal(error, undefined);
  assert.equal(checked, false);
  assert.equal(socket.userId, undefined);
});

test("native auth responses suppress the reusable bearer just like browser responses", () => {
  const req = { get(name) { return name.toLowerCase() === "x-divinghq-native" ? "1" : undefined; } };
  assert.equal(includeBodyToken(req), false);
});

test("HTTP verifyToken rejects a valid socket ticket before accessing user state", async () => {
  let queries = 0;
  const { verifyToken } = createMiddleware({
    pool: { async query() { queries += 1; return { rows: [] }; } },
    JWT_SECRET: SECRET,
  });
  const token = mintSocketTicket(session(), SECRET);
  const result = await new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    verifyToken(req, res, () => resolve({ status: 200 }));
  });
  assert.equal(result.status, 401);
  assert.equal(queries, 0);
});
