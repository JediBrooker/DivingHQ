// lib/csv.js: the CSV cell escaping and export-filename slug the PDF /
// CSV export routes share (routes/pdf.js, routes/judge-ranking.js).
// They each had a copy with a note to pull it out once a third one
// turned up; it had.
//
// csvCell also guards against spreadsheet formula injection. Excel,
// Numbers and Sheets all treat a cell starting with =, +, -, @, tab or
// CR as a formula, so a diver registering as "=cmd|'/c calc'!A0" would
// run on every operator's machine that opened the export. A leading
// single quote makes the spreadsheet show it as plain text; the
// apostrophe doesn't render, and it's still valid CSV.

function csvCell(s) {
  if (s == null) return "";
  let text = String(s);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  if (dangerous) text = "'" + text;
  if (/[",\n\r]/.test(text) || dangerous) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(cells) { return cells.map(csvCell).join(",") + "\n"; }

// Download filename slug: lowercase, runs of anything else become one
// underscore, no leading or trailing underscores. `fallback` stands in
// for a missing name ("meet", "event", "diver" depending on the export).
function slugify(s, fallback = "event") {
  return String(s || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

module.exports = { csvCell, csvRow, slugify };
