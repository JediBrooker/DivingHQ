// What a username, password, email, free-text name, date of birth and
// gender have to look like.
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

// A date of birth off the wire: YYYY-MM-DD, a day that exists (the shape
// alone let 2020-02-30 through to Postgres, which refused it and the
// route answered 500), from 1900, and not past tomorrow (a day of slack
// for timezones). Signup, the Competition details editor and the User
// Manager drawer all run this. Returns null when it's fine, or the
// user-facing error. An empty value is the caller's call: pass
// { required: true } to refuse it.
function dateOfBirthError(dob, { required = false } = {}) {
  if (dob == null || dob === "") {
    return required ? "Date of birth is required" : null;
  }
  const bad = "Date of birth must be a real date, YYYY-MM-DD";
  if (typeof dob !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return bad;
  const parsed = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dob) return bad;
  const latest = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (dob < "1900-01-01" || dob > latest) return bad;
  return null;
}

// What the gender pickers offer (lib/entry-eligibility.js reads the
// stored value back; "other" and "prefer_not_to_say" can't enter a
// men's or women's event). Same rule for an empty value as above.
function genderError(gender, { required = false } = {}) {
  const { PROFILE_GENDERS } = require("./entry-eligibility");
  if (gender == null || gender === "") {
    return required ? "Gender is required" : null;
  }
  if (typeof gender !== "string" || !PROFILE_GENDERS.includes(gender.trim().toLowerCase())) {
    return `Gender must be one of: ${PROFILE_GENDERS.join(", ")}`;
  }
  return null;
}

module.exports = { EMAIL_RE, USERNAME_RE, validatePassword, safeText, dateOfBirthError, genderError };
