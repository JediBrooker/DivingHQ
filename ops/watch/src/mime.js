// A hand-rolled RFC 5322 / MIME builder for one plain-text email.
//
// Why not mimetext: the Worker has no npm dependencies on purpose (nothing
// to install, audit or bump on a box nobody watches), and a single
// text/plain part is small enough to get right by hand. What "right" means
// here, and what test/watch-evaluate.test.js pins:
//   * CRLF line endings everywhere, never a bare LF or CR
//   * header lines under 78 characters, folded where needed
//   * non-ASCII in the subject or display name as RFC 2047 encoded-words
//   * CR / LF in any header value stripped, so an alert can't inject a Bcc
//   * the body as 7bit when it's plain ASCII with sane line lengths,
//     base64 otherwise
//
// Cloudflare's send_email binding takes the finished string as the third
// argument to new EmailMessage(from, to, raw).

const CRLF = "\r\n";
const ADDRESS = /^[^\s<>@",;:\\()[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// 39 bytes of UTF-8 is 52 base64 characters, so "Subject: =?UTF-8?B?...?="
// comes to 73 and a folded continuation line to 65. Both under 76, the
// RFC 2047 ceiling for a line carrying encoded-words.
const WORD_BYTES = 39;
const utf8 = new TextEncoder();

function assertAddress(addr, label) {
  if (typeof addr !== "string" || !ADDRESS.test(addr)) {
    throw new TypeError(`buildMime: ${label} isn't a plain email address`);
  }
}

// Header values are single-line by definition. Anything that could end a
// header early (CR, LF, other control characters) becomes a space.
function oneLine(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function isPlainAscii(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Split on code points, never inside a UTF-8 sequence, each chunk at most
// WORD_BYTES long.
function encodedWords(s) {
  const words = [];
  let chunk = [];
  let size = 0;
  for (const ch of s) {
    const b = utf8.encode(ch);
    if (size + b.length > WORD_BYTES && chunk.length) {
      words.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(...b);
    size += b.length;
  }
  if (chunk.length) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(Uint8Array.from(w))}?=`);
}

// Fold plain ASCII text at spaces so no line passes 78 characters.
function foldAscii(name, value) {
  const lines = [];
  let line = `${name}:`;
  for (const word of value.split(" ")) {
    if (line.length + 1 + word.length > 78 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

// "Name: value" for an unstructured header (Subject), encoded if it needs
// to be and folded either way.
export function encodeHeader(name, value) {
  const v = oneLine(value);
  if (isPlainAscii(v)) return foldAscii(name, v);
  return `${name}: ${encodedWords(v).join(CRLF + " ")}`;
}

// "DivingHQ watch" <alerts@divinghq.app>, with the display name quoted, or
// encoded when it isn't ASCII.
export function formatMailbox(address, displayName) {
  const name = oneLine(displayName);
  if (!name) return address;
  if (isPlainAscii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${encodedWords(name).join(" ")} <${address}>`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// RFC 5322 date-time, always in UTC with a numeric zone:
// "Tue, 29 Sep 2026 10:00:00 +0000". Date#toUTCString says "GMT", which is
// only the obsolete form.
export function formatRfc5322Date(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) throw new TypeError("buildMime: bad date");
  return (
    `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

function randomId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function encodeBody(text) {
  const normal = String(text ?? "").replace(/\r\n|\r|\n/g, CRLF);
  const withEnd = normal.endsWith(CRLF) ? normal : normal + CRLF;
  const ascii = /^[\x00-\x7f]*$/.test(withEnd);
  const longest = Math.max(...withEnd.split(CRLF).map((l) => l.length));
  if (ascii && longest <= 998 && !/[\x00\x7f]/.test(withEnd)) {
    return { encoding: "7bit", body: withEnd };
  }
  const b64 = bytesToBase64(utf8.encode(withEnd));
  const lines = b64.match(/.{1,76}/g) || [""];
  return { encoding: "base64", body: lines.join(CRLF) + CRLF };
}

/**
 * Build the raw message.
 * @param {{from: string, fromName?: string, to: string, subject: string, text: string,
 *   date?: Date|number, messageId?: string}} m
 * @returns {string}
 */
export function buildMime(m) {
  assertAddress(m.from, "from");
  assertAddress(m.to, "to");
  const domain = m.from.split("@")[1];
  const idLocal = oneLine(m.messageId || randomId()).replace(/[^A-Za-z0-9._-]/g, "");
  const { encoding, body } = encodeBody(m.text);
  const headers = [
    `From: ${formatMailbox(m.from, m.fromName)}`,
    `To: ${m.to}`,
    encodeHeader("Subject", m.subject),
    `Date: ${formatRfc5322Date(m.date ?? new Date())}`,
    `Message-ID: <${idLocal || randomId()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    // RFC 3834: tells vacation responders not to answer a robot.
    "Auto-Submitted: auto-generated",
  ];
  return headers.join(CRLF) + CRLF + CRLF + body;
}
