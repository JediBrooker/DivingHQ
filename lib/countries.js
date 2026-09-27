// ISO 3166-1 country list for the club-first signup.
//
// countries.json holds { a3, a2, name } per country, English names
// generated once from Intl.DisplayNames. organisations.country_code is
// alpha-3, so that's the key everywhere; a2 is only there so the SPA
// can ask Intl.DisplayNames for the name in the viewer's own language.
// Uninhabited territories (Antarctica, Bouvet Island...) are left out
// on purpose, nobody's running a diving club there.
//
// The SPA imports the same JSON file, so the two lists can't drift.
const COUNTRIES = require("./countries.json");

const BY_A3 = new Map(COUNTRIES.map((c) => [c.a3, c]));

function countryByCode(code) {
  if (typeof code !== "string") return null;
  return BY_A3.get(code.toUpperCase()) || null;
}

module.exports = { COUNTRIES, countryByCode };
