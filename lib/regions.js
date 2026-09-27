// Regions: the optional state / province / home-nation layer between a
// country's org and its clubs (migration 088).
//
// Where a country has one, its list lives in regions.json, keyed by the
// same ISO alpha-3 code as organisations.country_code. Rows get copied
// into the regions table on demand:
//   * automatically, for an unclaimed country account (the clubs started
//     it, nobody else is going to set it up), the first time signup
//     touches it;
//   * by a federation's org admin (or the sysadmin) pressing "set up
//     regions", for a real federation, which may not want them.
// Adding a country is just adding it to the JSON.
const CATALOG = require("./regions.json");

function catalogFor(countryCode) {
  if (typeof countryCode !== "string") return null;
  return CATALOG[countryCode.toUpperCase()] || null;
}

// Copy the catalogue's regions into this org and set its region_label.
// Idempotent: existing rows (matched on short_code) are left alone, so a
// region a federation renamed keeps its name. Returns how many were new.
async function materializeRegions(db, orgId, countryCode) {
  const cat = catalogFor(countryCode);
  if (!cat) return 0;
  let added = 0;
  for (const r of cat.regions) {
    const ins = await db.query(
      `INSERT INTO regions (org_id, name, short_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, short_code) DO NOTHING
       RETURNING id`,
      [orgId, r.name, r.code],
    );
    added += ins.rows.length;
  }
  await db.query(
    "UPDATE organisations SET region_label = COALESCE(region_label, $2) WHERE id = $1",
    [orgId, cat.label],
  );
  return added;
}

module.exports = { catalogFor, materializeRegions };
