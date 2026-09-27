// The two emailed links that carry a JWT: "verify your email" and "reset
// your password". The signed-in flows in routes/auth.js mint them, and so
// do the org admin's resend buttons in routes/users.js. They used to be
// five and two hand-written jwt.sign calls, so the type strings and the
// lifetimes live here now and the admin path can't drift from the rest.
//
//   const { mintVerifyToken, mintResetToken } = require("./lib/auth-links")(JWT_SECRET);

const jwt = require("jsonwebtoken");

// 24 hours (it used to be 7 days). A verify link that leaks through a
// mail archive, a forward or an error tracker's breadcrumbs shouldn't be
// replayable for a week, and someone who misses the window can ask for a
// fresh one (resend-verification) or reset their password instead.
const VERIFY_TTL = "24h";

// A reset link is only good for half an hour, and only once: fp is a
// fingerprint of the password hash when it was minted (lib/email.js
// hashFingerprint), so the moment the password changes the link is dead.
const RESET_TTL = "30m";

module.exports = function createAuthLinks(secret) {
  return {
    mintVerifyToken(userId) {
      return jwt.sign({ sub: userId, type: "email_verify" }, secret, { expiresIn: VERIFY_TTL });
    },
    mintResetToken(userId, fingerprint) {
      return jwt.sign({ sub: userId, type: "password_reset", fp: fingerprint }, secret, { expiresIn: RESET_TTL });
    },
  };
};
