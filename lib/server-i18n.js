// Lightweight server-side i18n. Loads per-locale JSON dictionaries
// from src/locales/server-{xx}.json (smaller than the SPA dict;
// covers only error messages + email templates + PDF column
// headers). Resolution order on each request:
//   1. req.user.locale  (when authenticated + users.locale set)
//   2. Accept-Language header (best 2-letter prefix match)
//   3. 'en' fallback
//
// Usage:
//   const t = serverT(req);   // bound translator for the request
//   t('errors.unauthorized');
//   t('emails.password_reset.subject', { app_name: 'DivingHQ' });
//
// Pulling in i18next + i18next-http-middleware would have been a
// 6-figure-byte dependency for ~30 strings; this in-house helper
// is ~80 lines and zero deps. The trade-off is: no plurals, no
// gender, no ICU. If a future string ever needs those, replace
// this module — the call-site shape `t(req, key, params)` lines
// up with i18next's `req.t(key, params)` so the migration is local.

const fs = require("node:fs");
const path = require("node:path");

// The list of locales the SPA supports today. Server-locale JSON
// files are expected to exist for each of these in
// src/locales/server-{code}.json. Order doesn't matter for
// resolution — Set membership is what gets checked.
const SUPPORTED = Object.freeze([
  "ar", "cs", "da", "de", "el", "en", "es", "fi", "fr", "hr",
  "hu", "id", "it", "ja", "ko", "ms", "no", "pl", "pt", "ru",
  "sr", "sv", "tl", "tr", "uk", "zh",
]);
const SUPPORTED_SET = new Set(SUPPORTED);
const DEFAULT_LOCALE = "en";

// Eager-load every locale file at require-time. 25 files × ~2KB
// is well under the cost of a single DB query, and avoids any
// async resolution at request time. If a file is missing or
// malformed we log + skip — the lookup falls back to English.
const DICTS = (() => {
  const out = Object.create(null);
  const dir = path.resolve(__dirname, "..", "src", "locales");
  for (const code of SUPPORTED) {
    const file = path.join(dir, `server-${code}.json`);
    try {
      out[code] = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      // Don't throw: a missing/broken locale must not stop the
      // server booting. The translator falls back to English.
      console.error(`[server-i18n] failed to load ${file}: ${err.message}`);
      out[code] = null;
    }
  }
  // The English dict is the source of truth for fallback. Refuse
  // to start if it can't be loaded — every other locale falls
  // back to it, so without en the helper is non-functional.
  if (!out[DEFAULT_LOCALE]) {
    throw new Error(
      `[server-i18n] cannot load server-${DEFAULT_LOCALE}.json — refusing to start`,
    );
  }
  return out;
})();

// Parse an Accept-Language header into an ordered list of
// (lang, q) pairs, highest q first. We only care about the
// primary subtag (the bit before the dash) since our locale
// codes are all 2-letter. q defaults to 1.0 per RFC 9110.
function parseAcceptLanguage(header) {
  if (!header || typeof header !== "string") return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";").map((s) => s.trim());
      let q = 1.0;
      for (const p of params) {
        if (p.startsWith("q=")) {
          const n = Number(p.slice(2));
          if (Number.isFinite(n)) q = n;
        }
      }
      const primary = (tag.split("-")[0] || "").toLowerCase();
      return { lang: primary, q };
    })
    .filter((x) => x.lang)
    .sort((a, b) => b.q - a.q);
}

// Decide which dictionary to use for this request.
//
// 1. If the authed user has a stored preference (users.locale),
//    honour it — that's the cross-device persistence story the
//    migration is here to enable.
// 2. Otherwise walk Accept-Language in q order and take the
//    first 2-letter primary subtag we recognise.
// 3. Else 'en'.
function resolveLocale(req) {
  const fromUser = req?.user?.locale;
  if (typeof fromUser === "string" && SUPPORTED_SET.has(fromUser)) {
    return fromUser;
  }
  const header = req?.headers?.["accept-language"];
  const parsed = parseAcceptLanguage(header);
  for (const { lang } of parsed) {
    if (SUPPORTED_SET.has(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}

// Walk a flat dot-path (`'emails.password_reset.subject'`)
// through a dictionary object. Returns undefined when any
// segment is missing — the caller handles fallback.
function lookup(dict, key) {
  if (!dict || typeof key !== "string") return undefined;
  let node = dict;
  for (const seg of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[seg];
  }
  return typeof node === "string" ? node : undefined;
}

// Simple `{name}` substitution. Anything missing from `params`
// is left in place — handy for debugging missed wiring (you'll
// see the literal `{app_name}` in a rendered template).
function substitute(str, params) {
  if (!params || typeof str !== "string") return str;
  let out = str;
  for (const [k, v] of Object.entries(params)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

// Look up `key` in the resolved locale, fall back to English,
// then fall back to the literal key. Then run `{param}` subs.
function t(req, key, params) {
  const locale = resolveLocale(req);
  let str = lookup(DICTS[locale], key);
  if (str === undefined && locale !== DEFAULT_LOCALE) {
    str = lookup(DICTS[DEFAULT_LOCALE], key);
  }
  if (str === undefined) str = key;
  return substitute(str, params);
}

// Bound translator for ergonomic use. Caller does:
//   const t = serverT(req);
//   t('errors.unauthorized');
// Stash the resolved locale on req for downstream code (e.g. so
// a route handler can include it in a response without re-running
// resolution).
function serverT(req) {
  if (req && !req._locale) req._locale = resolveLocale(req);
  return (key, params) => t(req, key, params);
}

// Express middleware: attaches `req.t` + `req.locale` so any
// downstream route handler can call `req.t('errors.not_found')`
// without importing this module. The verbatim `t(req, key)` form
// stays available for code that doesn't have access to a bound
// helper (e.g. error handlers built before the middleware ran).
function middleware() {
  return (req, _res, next) => {
    req.locale = resolveLocale(req);
    req.t = (key, params) => t(req, key, params);
    next();
  };
}

// Test/inspection helpers.
serverT.list = () => SUPPORTED.slice();
serverT.default = DEFAULT_LOCALE;
serverT.middleware = middleware;

module.exports = {
  serverT,
  resolveLocale,
  t,
  middleware,
  SUPPORTED,
  DEFAULT_LOCALE,
};
