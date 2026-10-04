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
// Browsers receive a session cookie, cleared when the browser closes. Native
// apps may keep it across process restarts, capped to the JWT's signed expiry;
// it remains in the platform cookie jar rather than JS-readable storage.
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

// Call only with the expiry of the session just minted by this server. A native
// marker changes cookie lifetime, never identity, roles or JWT expiry.
function nativeCookieOptions(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now) {
    throw new Error("A future session expiry is required");
  }
  return { ...cookieOptions(), maxAge: expiresAt * 1000 - now };
}

// Parse a raw `Cookie:` header value for the session cookie. Used by
// the socket handshake since it doesn't go through cookie-parser.
//
// The header is whatever the client chose to send, and a value that
// isn't valid percent-encoding (dhq_session=%E0%A4%A) makes
// decodeURIComponent throw. Inside the async handshake that became an
// unhandled rejection and took the whole process down for one anonymous
// connect. A cookie we can't decode is just no cookie, which is the call
// cookie-parser already makes on the HTTP side.
function readSessionCookie(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

module.exports = { SESSION_COOKIE, cookieOptions, nativeCookieOptions, readSessionCookie };
