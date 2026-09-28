// The DD range a custom dive has to stay inside.
//
// Custom dive-directory rows (is_custom, an org's own dives) used to take
// any DD from 0.1 to 9.9, and scoring multiplies every judge's award by
// it, so a "101B at 9.9" on a real dive list made a joke of the results.
// The product decision (A7-06) is that a custom row's DD has to fall
// inside the range the official World Aquatics dives at the same board
// height use: the lowest to the highest DD among the core rows at that
// height. It's read from the directory every time rather than written
// down here, so a refreshed catalogue moves the range with it.
//
// For context, WA Competition Regulations Part Four, Article 3: DD is set
// by the Technical Diving Committee (3.1), calculated by formula (3.2),
// and a dive that isn't in the tables but is used in a competition has to
// be given a DD worked out under Articles 2 and 3 (3.4). DivingHQ doesn't
// run that formula for custom rows, so it keeps them inside the span the
// tabled dives cover. The range check is ours, the Articles don't set one.
//
// There are no official dives at 0m, where the poolside drills live, so a
// height with none of its own falls back to the range across every
// official dive. A directory with no official rows at all has nothing to
// compare against, and then nothing passes (fail closed).
//
// Checked in two places: when a custom row is created or edited
// (routes/dive-directory.js) and whenever a dive list takes a dive
// (lib/dive-list-submit.js, the team bulk submit, the roster CSV import,
// the late-entry add and an event's prescribed round dives), which is
// what catches rows made before the rule existed.

const { isUuid } = require("./uuid");

// Heights come back from Postgres as numeric strings ("3.0", "7.5").
function heightLabel(h) {
  const n = Number(h);
  return Number.isFinite(n) ? `${n}m` : String(h);
}

function ddLabel(dd) {
  const n = Number(dd);
  return Number.isFinite(n) ? n.toFixed(1) : String(dd);
}

// { min, max, fromAllHeights } for one height (a number, metres), or null
// when the directory holds no official dives at all.
async function officialDdRange(db, height) {
  const r = await db.query(
    `SELECT MIN(dd) FILTER (WHERE height = $1) AS lo,
            MAX(dd) FILTER (WHERE height = $1) AS hi,
            MIN(dd) AS all_lo,
            MAX(dd) AS all_hi
       FROM dive_directory
      WHERE NOT is_custom`,
    [height],
  );
  const row = r.rows[0] || {};
  if (row.lo != null) return { min: Number(row.lo), max: Number(row.hi), fromAllHeights: false };
  if (row.all_lo != null) return { min: Number(row.all_lo), max: Number(row.all_hi), fromAllHeights: true };
  return null;
}

// The 400 message for a custom dive whose DD sits outside the range, or
// for one we can't check at all. `code` / `position` are optional (the
// create form's own fields).
function outOfRangeMessage({ height, dd, code = null, position = null, range }) {
  const what = code ? `custom dive ${code}${position || ""}` : "a custom dive";
  if (!range) {
    return `DD ${ddLabel(dd)} for ${what} can't be checked: the dive directory has no official dives to compare it with`;
  }
  const h = heightLabel(height);
  const span = `${ddLabel(range.min)} to ${ddLabel(range.max)}`;
  return range.fromAllHeights
    ? `DD ${ddLabel(dd)} for ${what} at ${h} has to be between ${span}. There are no official World Aquatics dives at ${h}, so that's the range every official dive uses`
    : `DD ${ddLabel(dd)} for ${what} at ${h} has to be between ${span}, the range the official World Aquatics dives at ${h} use`;
}

// Create / edit check. Returns the message, or null when the DD is fine.
async function customDdError(db, { height, dd, code = null, position = null }) {
  const range = await officialDdRange(db, Number(height));
  const n = Number(dd);
  if (range && n >= range.min && n <= range.max) return null;
  return outOfRangeMessage({ height, dd, code, position, range });
}

// Dive-list check. Of the given directory ids, the custom rows whose DD is
// outside their height's range, each with its message. Core rows and ids
// that aren't UUIDs are skipped (the callers' own directory checks deal
// with those). One query whatever the list length.
async function customDivesOutOfRange(db, diveIds) {
  const ids = [...new Set((diveIds || []).filter(isUuid))];
  if (!ids.length) return [];
  const r = await db.query(
    `WITH official AS (
       SELECT height, MIN(dd) AS lo, MAX(dd) AS hi
         FROM dive_directory WHERE NOT is_custom GROUP BY height
     ), overall AS (
       SELECT MIN(dd) AS lo, MAX(dd) AS hi FROM dive_directory WHERE NOT is_custom
     )
     SELECT d.id, d.dive_code, d.position, d.height, d.dd,
            COALESCE(o.lo, a.lo) AS lo, COALESCE(o.hi, a.hi) AS hi,
            o.height IS NULL AS from_all_heights
       FROM dive_directory d
       CROSS JOIN overall a
       LEFT JOIN official o ON o.height = d.height
      WHERE d.id = ANY($1::uuid[])
        AND d.is_custom
        AND (COALESCE(o.lo, a.lo) IS NULL
             OR d.dd < COALESCE(o.lo, a.lo)
             OR d.dd > COALESCE(o.hi, a.hi))`,
    [ids],
  );
  return r.rows.map((row) => ({
    id: row.id,
    dive_code: row.dive_code,
    position: row.position,
    height: Number(row.height),
    dd: Number(row.dd),
    message: outOfRangeMessage({
      height: row.height, dd: row.dd, code: row.dive_code, position: row.position,
      range: row.lo == null ? null : { min: Number(row.lo), max: Number(row.hi), fromAllHeights: row.from_all_heights },
    }),
  }));
}

module.exports = { officialDdRange, customDdError, customDivesOutOfRange, outOfRangeMessage };
