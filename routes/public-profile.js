// Public diver profile: share-friendly, read-only page.
//
//   GET /api/public/divers/:public_slug
//       JSON payload (the SPA route /diver/:slug consumes this)
//
//   GET /diver/:public_slug
//       Server-rendered HTML when a social-network crawler asks
//       (Twitterbot, FacebookExternalHit, LinkedInBot, etc) so
//       the unfurled link card looks right. Browsers fall through
//       to the SPA's index.html.
//
//   GET /api/public/divers/:public_slug/og-card.png
//       (left as a TODO, static fallback used for now)
//
// Permission model: completely public. The profile shows only
// data already visible on the live scoreboard / archive: name,
// org, country, club, headline meet stats, recent placings.
// Internal fields (email, dashboard_widgets, judge assignments)
// are never included.
//
// Mounted via:
//   app.use(require('./routes/public-profile')({ … }))

const express = require("express");
const sharp = require("sharp");
const { perDivePointsCte } = require("../lib/scoring-sql");

// In-memory cache of rendered OG cards. Each crawler hits the
// og:image once per share-to-cache (Twitter / FB / LinkedIn all
// behave this way), so a small LRU is plenty.
//
// Bounded two ways, since each PNG is ~100-300KB and an unbounded
// Map would pin real memory:
//   * a periodic sweep deletes expired entries (the read path
//     only BYPASSED them before, so a crawler sweep over many
//     profiles left every stale buffer resident forever);
//   * a hard entry cap with oldest-first eviction (Map iteration
//     order is insertion order) so even a burst of fresh slugs
//     inside one TTL window can't grow past ~60MB worst case.
const ogCardCache = new Map();   // public_slug → { png, expiresAt }
const OG_CARD_TTL_MS = 60 * 60 * 1000;
const OG_CARD_CACHE_MAX = 200;

// Sweep cadence mirrors lib/scoreboard-cache.js (a fraction of
// the TTL is plenty of resolution); unref()'d so the timer never
// holds the process open, same posture as the idempotency
// sweeper's interval.
setInterval(() => {
  const now = Date.now();
  for (const [slug, entry] of ogCardCache.entries()) {
    if (entry.expiresAt <= now) ogCardCache.delete(slug);
  }
}, 5 * 60 * 1000).unref?.();

// Crawler UA detection, matched anywhere in the User-Agent
// string. Conservative on purpose: we'd rather mis-serve OG-tagged
// HTML to a curl probe than fail to unfurl on a real Twitter card.
const CRAWLER_UA_RE = /(twitterbot|facebookexternalhit|linkedinbot|slackbot|discordbot|whatsapp|telegrambot|googlebot|bingbot|duckduckbot|pinterestbot|redditbot)/i;

// Strict hostname[:port] shape. Used as a fallback validator for
// the Host: header when APP_BASE_URL is unset. Without it,
// malicious crawler hit with a wild Host header could steer the
// meta-refresh redirect at an arbitrary host.
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?(?::\d{1,5})?$/i;

// HTML-escape a free-text field before splicing it into a meta
// tag. The values come from the DB (full_name, org_name, club
// name) which we sanitised on the way in (Migration 021), but
// this is defence in depth, just in case a missed code path lets
// a bad string land and pops a meta tag attribute.
function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = function createPublicProfileRouter({ pool, readPool }) {
  if (!pool) throw new Error("createPublicProfileRouter requires { pool, … }");
  const reads = readPool || pool;
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/public/divers/:public_slug: JSON payload.
  //
  // Returns:
  //   diver:           id (opaque slug, NOT user_id), full_name,
  //                    org name + country, club name + code
  //   stats:           total meets, total dives, best single
  //                    dive total, average DD attempted (all
  //                    over the diver's full history, so the
  //                    page has something to say even for a
  //                    diver who just wrapped one event)
  //   recent_meets:    last 5 events with placing + score
  //
  // No PII (no email, no internal id, no dashboard layout).
  // -------------------------------------------------------------
  router.get("/api/public/divers/:public_slug", async (req, res) => {
    try {
      const slug = req.params.public_slug;
      // Cheap shape check: public_slug is 32 hex chars (16 bytes
      // of randomness, base16-encoded). Just a sanity check, reject
      // anything else with a 404 so we're not filling the logs with
      // junk.
      if (!/^[0-9a-f]{32}$/i.test(slug)) {
        return res.status(404).json({ error: "Diver not found" });
      }
      const diverRes = await reads.query(
        `SELECT u.id, u.full_name,
                u.org_id, o.name AS org_name, o.country_code,
                u.club_id, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.public_slug = $1
           AND u.deleted_at IS NULL`,
        [slug],
      );
      if (!diverRes.rows.length) {
        return res.status(404).json({ error: "Diver not found" });
      }
      const diver = diverRes.rows[0];

      // Stats query, same shape as /api/divers/:id/profile but
      // without the date filter (public profile is "all time").
      const stats = await reads.query(
        `WITH ${perDivePointsCte({
           name:        "dive_totals",
           select:      ["s.event_id", "s.round_number"],
           pointsAlias: "dive_total",
           selectExtra: ["MAX(d.dd) AS dd"],
           where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
         })}
         SELECT
           COUNT(DISTINCT event_id)::int AS total_meets,
           COUNT(*)::int                 AS total_dives,
           AVG(dd)::numeric(4,2)         AS avg_dd,
           MAX(dive_total)::numeric(6,2) AS best_single_dive
         FROM dive_totals`,
        [diver.id],
      );

      // Last 5 meets ranked against the full field. Same FULL_FIELD
      // ranking shape as the analytics dashboard's recent_form,
      // simplified for public consumption.
      const recent = await reads.query(
        `WITH ${perDivePointsCte({
           select:      ["s.event_id", "s.competitor_id", "s.round_number"],
           pointsAlias: "pts",
           where: `s.event_id IN (
             SELECT DISTINCT s0.event_id
             FROM scores s0
             JOIN events e0 ON e0.id = s0.event_id
             WHERE s0.competitor_id = $1
               AND COALESCE(e0.is_rehearsal, FALSE) = FALSE
           )`,
         })},
         totals AS (
           SELECT event_id, competitor_id, SUM(pts) AS total
           FROM per_dive GROUP BY event_id, competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER (PARTITION BY event_id)::int AS field_size
           FROM totals
         )
         SELECT e.id AS event_id, e.name AS event_name, e.created_at,
                e.event_type::text AS event_type, e.height,
                ranked.total::numeric(8,2) AS total,
                ranked.rnk::int AS rank,
                ranked.field_size
         FROM ranked
         JOIN events e ON e.id = ranked.event_id
         WHERE ranked.competitor_id = $1
           AND COALESCE(e.is_rehearsal, FALSE) = FALSE
         ORDER BY e.created_at DESC
         LIMIT 5`,
        [diver.id],
      );

      res.json({
        diver: {
          public_slug: slug,
          full_name:   diver.full_name,
          org_name:    diver.org_name,
          country_code: diver.country_code,
          club_name:   diver.club_name,
          club_code:   diver.club_code,
        },
        stats: stats.rows[0] || {
          total_meets: 0, total_dives: 0,
          avg_dd: null, best_single_dive: null,
        },
        recent_meets: recent.rows,
      });
    } catch (err) {
      console.error("[Public Profile Error]", err.message);
      res.status(500).json({ error: "Couldn't load public profile" });
    }
  });

  // -------------------------------------------------------------
  // GET /api/public/divers/:public_slug/og-card.png
  //
  // Per-diver social-preview image for og:image. 1200×630 (the
  // FB / Twitter / LinkedIn sweet spot), branded gradient
  // background, name + org + best-PB headline. Generated on
  // demand via sharp's SVG-to-PNG renderer; results cached in
  // memory for an hour to keep the response fast on warm
  // crawlers.
  //
  // No PII here either, same data the public profile endpoint
  // already exposes, just rendered as pixels instead of JSON.
  // -------------------------------------------------------------
  router.get("/api/public/divers/:public_slug/og-card.png", async (req, res) => {
    const slug = req.params.public_slug;
    if (!/^[0-9a-f]{32}$/i.test(slug)) return res.status(404).end();

    // Cache hit: serve straight from memory. An expired entry gets
    // deleted on sight (not just bypassed) so the ~quarter-MB
    // buffer is reclaimable before the next sweep.
    const cached = ogCardCache.get(slug);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=3600");
        return res.end(cached.png);
      }
      ogCardCache.delete(slug);
    }

    try {
      // Diver row + their best single dive total. One round trip.
      // The best-dive scalar is fine to send to the replica since
      // the OG card is allowed to be a few seconds stale on
      // purpose (hit ratio matters more than freshness here).
      const r = await reads.query(
        `SELECT u.id, u.full_name, o.name AS org_name, o.country_code,
                cl.name AS club_name
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.public_slug = $1
           AND u.deleted_at IS NULL`,
        [slug],
      );
      if (!r.rows.length) return res.status(404).end();
      const d = r.rows[0];

      const stat = await reads.query(
        `WITH ${perDivePointsCte({
           select:      [],
           pointsAlias: "dive_total",
           where: `s.competitor_id = $1
             AND COALESCE(e.is_rehearsal, FALSE) = FALSE`,
           groupBy:     ["s.event_id", "s.round_number"],
         })}
         SELECT MAX(dive_total)::numeric(6,2) AS best
         FROM per_dive`,
        [d.id],
      );
      const best = stat.rows[0]?.best
        ? Number(stat.rows[0].best).toFixed(2)
        : "—";

      // Defence-in-depth HTML escape: the source rows come from
      // the DB (sanitised at registration) but a missed code
      // path that lets a bad string land would otherwise pop
      // an SVG attribute and either break the render or leak.
      const e = (s) => String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

      const subline = [d.org_name, d.country_code, d.club_name]
        .filter(Boolean)
        .map(e)
        .join("  ·  ");

      // 1200×630 SVG. Helvetica is the safest cross-distro choice
      // (FreeType resolves it via fontconfig on every Linux base
      // image we'd plausibly run on). Branded gradient, two
      // bands of typography, headline stat anchored bottom-left.
      const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#0e7490"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="80" y="120" font-family="Helvetica, Arial, sans-serif"
        font-size="28" fill="#67e8f9" letter-spacing="3">DIVINGHQ</text>
  <text x="80" y="280" font-family="Helvetica, Arial, sans-serif"
        font-size="84" font-weight="bold" fill="#ffffff">${e(d.full_name)}</text>
  <text x="80" y="340" font-family="Helvetica, Arial, sans-serif"
        font-size="32" fill="#94a3b8">${subline}</text>
  <text x="80" y="500" font-family="Helvetica, Arial, sans-serif"
        font-size="24" fill="#94a3b8" letter-spacing="2">BEST SINGLE DIVE</text>
  <text x="80" y="570" font-family="Helvetica, Arial, sans-serif"
        font-size="72" font-weight="bold" fill="#06b6d4">${e(best)}</text>
</svg>`;

      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      // Hard cap: evict oldest-first until there's room. A
      // crawler enumerating thousands of profiles in one sweep
      // now recycles the same 200 slots instead of growing the
      // Map without bound.
      while (ogCardCache.size >= OG_CARD_CACHE_MAX) {
        ogCardCache.delete(ogCardCache.keys().next().value);
      }
      ogCardCache.set(slug, { png, expiresAt: Date.now() + OG_CARD_TTL_MS });
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=3600");
      res.end(png);
    } catch (err) {
      console.error("[OG Card Error]", err.message);
      // Fall back to the static icon, never a broken og:image.
      res.redirect(302, "/icon-512.png");
    }
  });

  // -------------------------------------------------------------
  // GET /diver/:public_slug: server-rendered HTML for crawlers,
  // SPA fallthrough for browsers.
  //
  // Detection: User-Agent is checked against CRAWLER_UA_RE. If
  // it matches, we return a tiny HTML document with OG + Twitter
  // card meta tags so the unfurled link looks good. Browsers
  // (everything not matching) fall through (next()) to the
  // existing SPA history-API rewrite, which serves index.html
  // and the Vue router takes over.
  //
  // The route is mounted BEFORE the SPA fallback in server.js so
  // the next() above hits the SPA middleware naturally.
  // -------------------------------------------------------------
  router.get("/diver/:public_slug", async (req, res, next) => {
    const ua = req.headers["user-agent"] || "";
    if (!CRAWLER_UA_RE.test(ua)) return next();

    const slug = req.params.public_slug;
    if (!/^[0-9a-f]{32}$/i.test(slug)) return next();

    try {
      const r = await reads.query(
        `SELECT u.full_name, o.name AS org_name, o.country_code, cl.name AS club_name
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.public_slug = $1
           AND u.deleted_at IS NULL`,
        [slug],
      );
      if (!r.rows.length) return next();
      const d = r.rows[0];

      // APP_BASE_URL is preferred; when unset we fall back to the
      // request's protocol + Host header, but only if Host passes
      // a strict shape check. An attacker-supplied Host like
      // `evil.com" content="0;url=javascript:…` is HTML-escaped at
      // the splice site, but a bare attacker-controlled hostname
      // would still steer the meta-refresh redirect. If we can't
      // build a trustworthy canonical URL, fall through to the SPA.
      let base = process.env.APP_BASE_URL;
      if (!base) {
        const host = req.get("host") || "";
        if (!HOST_RE.test(host)) return next();
        base = `${req.protocol}://${host}`;
      }
      const url = `${base}/diver/${slug}`;
      const title = `${d.full_name} — DivingHQ`;
      const subline = [d.org_name, d.country_code, d.club_name]
        .filter(Boolean).join(" · ");
      const description = subline
        ? `${subline}. View competitive history, personal bests, and recent meet placings.`
        : "View competitive history, personal bests, and recent meet placings.";
      const ogImage = `${base}/api/public/divers/${slug}/og-card.png`;

      // Inline HTML, no template engine. Just Open Graph +
      // Twitter card meta. The body is intentionally near-empty:
      // crawlers only read the head, and a human who somehow
      // lands here without JS still gets a graceful redirect.
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .end(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${htmlEscape(title)}</title>
<meta name="description" content="${htmlEscape(description)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${htmlEscape(url)}">
<meta property="og:title" content="${htmlEscape(title)}">
<meta property="og:description" content="${htmlEscape(description)}">
<meta property="og:image" content="${htmlEscape(ogImage)}">
<meta property="og:site_name" content="DivingHQ">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${htmlEscape(title)}">
<meta name="twitter:description" content="${htmlEscape(description)}">
<meta name="twitter:image" content="${htmlEscape(ogImage)}">
<meta http-equiv="refresh" content="0; url=${htmlEscape(url)}">
</head><body>
<noscript><a href="${htmlEscape(url)}">${htmlEscape(title)}</a></noscript>
</body></html>`);
    } catch (err) {
      console.error("[Public Profile HTML Error]", err.message);
      next();   // fall through to SPA on DB error
    }
  });

  return router;
};
