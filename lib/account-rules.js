// What a username, password, email and a free-text name have to look like.
//
// Signup, register-org, the password change and reset (routes/auth.js) and
// a junior taking over their profile at 13 (routes/juniors.js) all set
// one of these, and they have to agree. These lived inside routes/auth.js
// until the junior handover needed the same rules.

// Loose on purpose, something@something.tld: the verification link is what
// actually proves the address. Register, register-org and the email change
// all check against this.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Username cap mirrors users.username = varchar(50) in init.sql. The
// charset is narrow on purpose: usernames turn up in audit logs, exports
// and push notifications, and a free string could carry CR/LF or HTML
// into those.
const USERNAME_RE = /^[a-zA-Z0-9._-]{2,50}$/;

// Centralised password policy, applied to every set-password path
// (register, register-org, password change, password reset, junior
// handover). Returns null on success, or a user-facing error string.
//
// Policy:
//   * minimum 12 characters (NIST SP 800-63B's lower bound for
//     memorised secrets without complexity rules; the longer
//     floor more than compensates for not requiring symbols).
//   * must contain at least one letter AND one digit, to block
//     the most trivially weak choices (all-digits PINs, single
//     dictionary words).
//
// Deliberately NOT enforced here: symbol classes, max length,
// breached-password lookups. Those are the next two upgrades
// (zxcvbn or HIBP k-anonymity) and can layer on top without
// changing this signature.
function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 12) {
    return "Password must be at least 12 characters";
  }
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    return "Password must contain at least one letter and one digit";
  }
  return null;
}

// Strip control chars + cap length on free-text user input (names, club
// names), so nobody can smuggle CR/LF (header or email-body injection) or
// a multi-megabyte payload through a form. Zero-width and BOM characters
// go too. Returns null when nothing's left.
function safeText(input, maxLen = 100) {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[\x00-\x1f\x7f​-‏﻿]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

module.exports = { EMAIL_RE, USERNAME_RE, validatePassword, safeText };
