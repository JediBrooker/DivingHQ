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
const BY_A2 = new Map(COUNTRIES.map((c) => [c.a2, c]));

function countryByCode(code) {
  if (typeof code !== "string") return null;
  return BY_A3.get(code.toUpperCase()) || null;
}

// For a code read back off an organisations row, never for user input
// (that has to be alpha-3). country_code is char(3), so a 2-letter code
// comes back padded, and a row migration 093 hasn't reached yet can
// still hold the old alpha-2 form.
function countryFromStored(code) {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  return BY_A3.get(c) || BY_A2.get(c) || null;
}

module.exports = { COUNTRIES, countryByCode, countryFromStored };
