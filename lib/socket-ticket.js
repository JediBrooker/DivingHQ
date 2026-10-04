// Native WebViews cannot rely on cross-site websocket cookies. Exchange the
// verified HTTP session for a short admission ticket, never for another session.
const jwt = require("jsonwebtoken");
const { isSessionClaims } = require("./middleware");

const AUDIENCE = "dhq-native-socket";

// Node turns delays above its signed 32-bit limit into a 1ms timeout. A very
// long configured session must reconnect early, not loop on immediate expiry.
function nativeSocketLifetimeMs(expiresAt, now = Date.now()) {
  return Math.min(2 ** 31 - 1, Math.max(0, expiresAt * 1000 - now));
}

function mintSocketTicket(session, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!isSessionClaims(session) || !Number.isFinite(session.exp) || session.exp <= now
      || !Number.isInteger(session.tv)) throw new Error("A current versioned session is required");
  return jwt.sign({
    id: session.id,
    org_id: session.org_id,
    org_roles: session.org_roles || [],
    is_system_admin: !!session.is_system_admin,
    tv: session.tv,
    type: "socket_ticket",
    aud: AUDIENCE,
    iat: now,
    exp: Math.min(now + 30, session.exp),
    session_exp: session.exp,
  }, secret, { algorithm: "HS256" });
}

function verifySocketTicket(ticket, secret) {
  const claims = jwt.verify(ticket, secret, { algorithms: ["HS256"], audience: AUDIENCE });
  if (claims.type !== "socket_ticket" || !isSessionClaims({ ...claims, type: undefined })
      || !Number.isInteger(claims.tv) || !Number.isFinite(claims.session_exp)
      || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)
      || claims.exp > claims.iat + 30 || claims.exp > claims.session_exp) {
    throw new Error("Invalid socket ticket");
  }
  return claims;
}

module.exports = { mintSocketTicket, verifySocketTicket, nativeSocketLifetimeMs };
