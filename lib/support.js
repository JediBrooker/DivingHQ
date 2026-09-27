// Where people reach a person at DivingHQ.
//
// One address for the whole deployment, set with SUPPORT_EMAIL. It's used as
// the Reply-To on everything lib/email.js sends (EMAIL_FROM is usually a
// no-reply sender, so "reply to this email" went nowhere before), in the
// "contact support" lines of error messages and claim notices, and by the SPA
// footers via GET /api/public-config.
//
// Read on every call rather than once at require time, like fromAddress() in
// lib/email.js, so a test or a hot env reload sees the current value. A value
// that isn't shaped like an address falls back to the default instead of
// being printed into an error message or a mail header.

const DEFAULT_SUPPORT_EMAIL = "support@divinghq.app";

// Deliberately loose: one @, a dot in the domain, nothing that could break
// out of a header or a mailto: link (spaces, angle brackets, quotes, CR/LF).
const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

function supportEmail() {
  const raw = typeof process.env.SUPPORT_EMAIL === "string" ? process.env.SUPPORT_EMAIL.trim() : "";
  if (raw && raw.length <= 254 && ADDRESS.test(raw)) return raw;
  return DEFAULT_SUPPORT_EMAIL;
}

// The phrase the English server messages share, so they all say it the same
// way: "DivingHQ support at support@divinghq.app".
function supportContact() {
  return `DivingHQ support at ${supportEmail()}`;
}

module.exports = { DEFAULT_SUPPORT_EMAIL, supportEmail, supportContact };
