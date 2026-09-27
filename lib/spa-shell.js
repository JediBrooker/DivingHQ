// The SPA shell, dist/index.html, goes out for every deep link the Vue
// router owns (/guide/faq, /meet/<id>, /privacy, ...). It carries one
// canonical link and one og:url, both written for the home page. Served
// unchanged, every page would tell search engines "I'm a copy of /" and get
// folded into the home page, and every shared link would claim to be the
// home page too.
//
// renderShell() points both at the path actually requested, and swaps the
// hosted origin for APP_BASE_URL so a self-hosted copy doesn't send its
// canonical URLs and share images to divinghq.app. server.js calls it from
// the SPA fallback, and renderCrawlerFile() for robots.txt and sitemap.xml.
// Pure string work, so it's unit tested against the real files in
// test/spa-shell.test.js.

const HOSTED_ORIGIN = "https://divinghq.app";

// The path lands inside a quoted attribute, and req.path is whatever the
// client sent, so escape it. A raw quote in a request line would otherwise
// be a reflected-HTML hole on every page.
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// APP_BASE_URL is already required in production (reset links, sign-off QR
// codes). Only its origin matters here; anything unparseable falls back to
// the hosted site rather than printing junk into the page.
function publicOrigin(env = process.env) {
  const raw = typeof env.APP_BASE_URL === "string" ? env.APP_BASE_URL.trim() : "";
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      // fall through
    }
  }
  return HOSTED_ORIGIN;
}

function renderShell(html, { origin = HOSTED_ORIGIN, path = "/" } = {}) {
  let out = origin === HOSTED_ORIGIN ? html : html.split(HOSTED_ORIGIN).join(origin);
  const here = escapeAttr(origin + (typeof path === "string" && path.startsWith("/") ? path : "/"));
  // Function replacers, not "$1...": a "$&" in a path must stay literal.
  out = out
    .replace(/(<link rel="canonical" href=")[^"]*(")/, (_, a, b) => a + here + b)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, (_, a, b) => a + here + b);
  return out;
}

// robots.txt and sitemap.xml stay plain files in public/ with the hosted
// origin written in, and get the same swap on the way out, or a self-hosted
// copy would point crawlers at divinghq.app's sitemap and pages. new URL()
// lets "&" and '"' through in a hostname, so the XML gets them escaped.
function renderCrawlerFile(text, { origin = HOSTED_ORIGIN, xml = false } = {}) {
  if (origin === HOSTED_ORIGIN) return text;
  return text.split(HOSTED_ORIGIN).join(xml ? escapeAttr(origin) : origin);
}

// Guide topics that only exist while a feature flag is on. src/guide/topics.js
// marks them with `feature: '<flag>'` (it's an ESM file full of Vite ?raw
// imports, so the server reads it as text rather than loading it). The
// same parse test/spa-shell.test.js uses on it.
function gatedGuideTopics(topicsSrc) {
  return [...String(topicsSrc).matchAll(/\{\s*slug:\s*'([^']+)'[^}\n]*?\bfeature:\s*'([^']+)'/g)]
    .map((m) => ({ slug: m[1], feature: m[2] }));
}

// While payments or classes are off, /guide/payments and /guide/classes
// render "Topic not found" (with a 200, it's the SPA), so the sitemap
// shouldn't send crawlers there. public/sitemap.xml keeps every topic; this
// drops the gated ones whose flag is off, so a flip at /admin/features is
// all it takes to list them.
function dropGatedGuidePages(xml, gated, isOn) {
  let out = String(xml);
  for (const { slug, feature } of gated) {
    if (isOn(feature)) continue;
    out = out.replace(new RegExp(`[ \\t]*<url><loc>[^<]*/guide/${slug}</loc></url>\\r?\\n?`, "g"), "");
  }
  return out;
}

module.exports = {
  HOSTED_ORIGIN, publicOrigin, renderShell, renderCrawlerFile, escapeAttr,
  gatedGuideTopics, dropGatedGuidePages,
};
