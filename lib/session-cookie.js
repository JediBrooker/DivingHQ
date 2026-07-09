// Single source of truth for the session cookie: its name and its
// attributes, shared by the three places that touch it:
//   * routes/auth.js      issues + clears it (login / 2FA / password
//                         / locale refresh / logout)
//   * lib/middleware.js   reads it on every HTTP request (cookie first,
//                         then the Authorization header for API clients
//                         + the e2e harness)
//   * routes/socket.js    reads it off the WebSocket handshake headers
//
// The JWT lives in this httpOnly cookie so browser JS can't read it or
// exfiltrate it (the old sessionStorage token was readable by any XSS).
// It's NOT a maxAge cookie, it's a session cookie, cleared when the
// browser closes. That approximates the sessionStorage lifetime it
// replaced; the JWT's own `exp` still bounds it server-side.
//
// secure: only over HTTPS in production. Left off in dev/test so the
// cookie works over http://localhost and the Playwright http webServer.
//
// sameSite 'lax': sent on top-level navigations (so a logged-in user
// following a deep link to the app still arrives authenticated) but not
// on cross-site POST/PUT/DELETE, which blocks the standard CSRF vector
// for state-changing requests without needing a separate CSRF token.

const SESSION_COOKIE = "dhq_session";

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

// Parse a raw `Cookie:` header value for the session cookie. Used by
// the socket handshake since it doesn't go through cookie-parser.
function readSessionCookie(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

module.exports = { SESSION_COOKIE, cookieOptions, readSessionCookie };
