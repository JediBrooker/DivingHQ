// TOTP 2FA helpers, wraps speakeasy + qrcode behind a small surface
// so the auth router doesn't have to know either API.
//
// Surface:
//   * generateSecret(label)           → { base32, otpauth_url, qr_data_url }
//   * verifyToken(secret, token)      → bool (with ±1 step window)
//   * verifyTokenDelta(secret, token) → matched absolute time-step
//                                       (Number) or null, feeds the
//                                       replay guard (migration 063)
//   * generateRecoveryCodes(n=10)     → Promise<{ plain, hashes }>
//   * consumeRecoveryCode(hashes, code) → { matched, remainingHashes }
//   * spendRecoveryCode(db, userId, hashes, code) → true when this call
//     matched the code and burnt it (conditional write, race-safe)
//
// Secret length: 20 bytes (160 bits) base32-encoded, which is what
// RFC 6238 §5.1 recommends for SHA-1-based TOTP.
//
// Step tolerance: ±1 (one 30s window before/after current). Catches
// drifted phone clocks without widening the auth window past the
// OWASP guideline (~1 minute total, give or take).
//
// Recovery codes: 10 codes, each 10 hex chars [0-9a-f], so about 40
// bits each. Stored as bcrypt hashes (cost 10, no need for the 12 we
// use on passwords: a successful brute-force still needs both the
// password and the code itself).

const speakeasy = require("speakeasy");
const QRCode    = require("qrcode");
const bcrypt    = require("bcrypt");
const crypto    = require("node:crypto");

// Generate a fresh secret plus an otpauth:// URI plus a base64 PNG QR.
// The QR encodes the URI; the user scans it with their authenticator
// app. We return all three so the frontend can pick whatever
// presentation fits: QR for mobile camera scan, otpauth URL for
// click-to-add desktop apps, base32 for manual keypad entry.
async function generateSecret(label) {
  const secret = speakeasy.generateSecret({
    name:   `DivingHQ (${label})`,
    issuer: "DivingHQ",
    length: 20,
  });
  const qr_data_url = await QRCode.toDataURL(secret.otpauth_url);
  return {
    base32:       secret.base32,
    otpauth_url:  secret.otpauth_url,
    qr_data_url,
  };
}

// Verify a 6-digit token against the user's stored base32 secret.
// `token` is a string of digits, we don't trim/pad since the
// authenticator-app side always emits exactly 6 chars.
function verifyToken(base32Secret, token) {
  if (typeof token !== "string" || !/^\d{6}$/.test(token)) return false;
  return speakeasy.totp.verify({
    secret:   base32Secret,
    encoding: "base32",
    token,
    window:   1,    // ±1 step (±30s)
  });
}

// Like verifyToken, but returns the ABSOLUTE 30s time-step the
// token matched (or null when it doesn't verify). The ±1 window
// means a code stays acceptable for ~90s, long enough for a
// shoulder-surfed or real-time-phished code to mint a second
// session. Callers persist the returned step (users.
// totp_last_used_step, migration 063) and reject any code whose
// step is <= the stored value, so each code is single-use per
// RFC 6238 §5.2.
//
// speakeasy.totp.verifyDelta returns { delta } relative to the
// current counter (-1 / 0 / +1 inside our window), so the
// absolute step works out to floor(now_seconds / 30) + delta.
function verifyTokenDelta(base32Secret, token) {
  if (typeof token !== "string" || !/^\d{6}$/.test(token)) return null;
  const result = speakeasy.totp.verifyDelta({
    secret:   base32Secret,
    encoding: "base32",
    token,
    window:   1,    // ±1 step (±30s), same window as verifyToken
  });
  if (!result) return null;
  return Math.floor(Date.now() / 1000 / 30) + result.delta;
}

// Mint N recovery codes. Returns plain strings for one-time display
// plus hashed equivalents for storage. Plain codes use a dash
// separator every 5 chars purely for readability, the dashes get
// stripped before hashing so a user typing them without dashes
// still works fine.
//
// Async on purpose: 10 bcrypt cost-10 hashes is about 1s of CPU,
// which hashSync would spend blocking the event loop (stalling
// every concurrent request, including live scoring). Doing the
// hashes async keeps them off the hot path, and Promise.all keeps
// total latency at roughly one hash instead of ten.
async function generateRecoveryCodes(n = 10) {
  const plain = [];
  const raws = [];
  for (let i = 0; i < n; i++) {
    // 10 random hex chars = 40 bits, so about 1 in 10^12 collision
    // risk for a 10-code set. Plenty for an out-of-band recovery flow.
    const raw = crypto.randomBytes(5).toString("hex");
    raws.push(raw);
    plain.push(raw.slice(0, 5) + "-" + raw.slice(5));
  }
  const hashes = await Promise.all(raws.map((raw) => bcrypt.hash(raw, 10)));
  return { plain, hashes };
}

// Try every stored hash against the user-provided code. Returns
// { matched: bool, remainingHashes: string[] } so the caller can
// persist the smaller array on a successful consume. Strips dashes
// and lowercases before checking, so the user can type either
// "abcde-12345" or "ABCDE12345".
async function consumeRecoveryCode(hashes, code) {
  if (!Array.isArray(hashes) || typeof code !== "string") {
    return { matched: false, remainingHashes: hashes };
  }
  const normalised = code.replace(/-/g, "").toLowerCase().trim();
  if (!/^[0-9a-f]{10}$/.test(normalised)) {
    return { matched: false, remainingHashes: hashes };
  }
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(normalised, hashes[i])) {
      const remainingHashes = hashes.slice(0, i).concat(hashes.slice(i + 1));
      return { matched: true, remainingHashes };
    }
  }
  return { matched: false, remainingHashes: hashes };
}

// Match a recovery code and burn it, atomically. The bcrypt compares take
// a while, and the write used to be a plain overwrite of the whole list,
// so two logins racing with the same code both matched it and both got in
// (and two different codes at once wrote one of them back, unused). The
// write is a compare-and-set against the list we matched in; if it changed
// underneath us, re-read and match again. A code the other request already
// spent isn't there the second time, so it fails, while a different code
// spent at the same moment doesn't cost this one its turn. Returns true
// when this call spent the code. `db` is the pool or a client.
async function spendRecoveryCode(db, userId, storedHashes, code) {
  let current = storedHashes || [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const { matched, remainingHashes } = await consumeRecoveryCode(current, code);
    if (!matched) return false;
    const done = await db.query(
      `UPDATE users SET totp_recovery_codes = $1::jsonb
        WHERE id = $2 AND totp_recovery_codes = $3::jsonb`,
      [JSON.stringify(remainingHashes), userId, JSON.stringify(current)],
    );
    if (done.rowCount) return true;
    const fresh = await db.query("SELECT totp_recovery_codes FROM users WHERE id = $1", [userId]);
    current = fresh.rows[0]?.totp_recovery_codes || [];
  }
  return false;
}

module.exports = {
  generateSecret,
  verifyToken,
  verifyTokenDelta,
  generateRecoveryCodes,
  consumeRecoveryCode,
  spendRecoveryCode,
};
