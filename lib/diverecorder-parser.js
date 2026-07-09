// Pure HTML parsers for the DiveRecorder Meet Explorer archive
// (diverecorder.co.uk/meetexplorer). The markup is simple, static,
// server-rendered tables, so lightweight regex extraction is enough.
// No DOM dependency needed, which keeps the importer dependency-free
// and the parsing unit-testable against saved HTML fixtures.
//
// Four page types, mirroring the source's drill-down:
//   selectmeet.php                 -> parseMeetList   -> [{ mref, name, dateLabel }]
//   selectevent.php?mref           -> parseEventList  -> [{ eref, name }]
//   selectsheet.php?mref&eref      -> parseSheetList  -> { meetName, eventName, eventDate, divers:[{dref,rank,name,club,total}] }
//   showsheet.php?mref&eref&dref   -> parseDiveSheet  -> { diver, club, birthYear, judgeCount, rank, dives:[...] }
//
// Every parser is defensive: a malformed row is skipped, not thrown,
// so one bad sheet never aborts a whole meet import.

// --- small shared helpers ---------------------------------------

// Strip tags, decode the handful of entities the source emits, and
// collapse whitespace. Good enough for the plain-text cells here.
function cellText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// DiveRecorder renders half-marks with the Unicode "½" glyph, e.g.
// "5½" = 5.5, "6" = 6. Returns a Number or null.
function parseHalfMark(raw) {
  const t = cellText(raw);
  if (!t) return null;
  const m = t.match(/^(\d+)\s*(½)?$/);
  if (!m) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return Number(m[1]) + (m[2] ? 0.5 : 0);
}

function toNumber(raw) {
  const t = cellText(raw);
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toInt(raw) {
  const n = toNumber(raw);
  return n === null ? null : Math.trunc(n);
}

// Split a row's inner HTML into an array of <td> inner-HTML strings.
function cells(rowHtml) {
  const out = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(m[1]);
  return out;
}

function rows(tableHtml) {
  const out = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(tableHtml)) !== null) out.push(m[1]);
  return out;
}

// "24th October 2021" / "2nd May 2026" -> "2021-10-24" (ISO) or null.
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
function parseLongDate(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2].toLowerCase()];
  const year = Number(m[3]);
  if (!mon) return null;
  return `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The meet-list rows show a short date like "May 24" with no year;
// the year comes from the enclosing <h3> section header. Combine
// the two into an ISO date, or null if unparseable.
const SHORT_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function parseShortDate(label, year) {
  if (!label || !year) return null;
  const m = String(label).trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})$/);
  if (!m) return null;
  const mon = SHORT_MONTHS[m[1].toLowerCase()];
  if (!mon) return null;
  return `${year}-${String(mon).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

// nat code -> display label, as published in the Meet Explorer
// "Filter by Country" sidebar (selectmeet.php?nat=XXX). Stable set
// for now; parseCountryList() can refresh it from a live page just
// in case the sidebar ever changes.
const COUNTRIES = [
  { nat: "AUS", name: "Australia" },
  { nat: "BUL", name: "България / Bŭlgariya" },
  { nat: "SRB", name: "Српски / Srpski" },
  { nat: "CZE", name: "Česky" },
  { nat: "ESP", name: "España" },
  { nat: "FINA", name: "AQUA / FINA" },
  { nat: "FRA", name: "France" },
  { nat: "GBR", name: "Great Britain" },
  { nat: "CRO", name: "Hrvatski" },
  { nat: "IRL", name: "Ireland" },
  { nat: "ITA", name: "Italia" },
  { nat: "LEN", name: "LEN" },
  { nat: "HUN", name: "Magyar" },
  { nat: "MAS", name: "Malaysia" },
  { nat: "NED", name: "Nederlands" },
  { nat: "NZL", name: "New Zealand" },
  { nat: "NOR", name: "Norge" },
  { nat: "POL", name: "Polska" },
  { nat: "AUT", name: "Österreich" },
  { nat: "RUS", name: "Россия" },
  { nat: "SWE", name: "Sverige" },
  { nat: "INT", name: "International" },
];

// Parse the country sidebar off any selectmeet page.
function parseCountryList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+href="selectmeet\.php\?nat=([A-Z]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const nat = m[1];
    if (seen.has(nat)) continue;
    seen.add(nat);
    out.push({ nat, name: cellText(m[2]) });
  }
  return out;
}

// --- page parsers -----------------------------------------------

// selectmeet.php renders a sequence of year sections:
//   <h3>2026</h3><table class="meetgrid">…rows…</table>
//   <h3>2025</h3><table class="meetgrid">…rows…</table>
// Each row is <td>dateLabel</td><td>&nbsp;<a href="selectevent.php?mref=N">Name</a></td>.
// We walk the markup in order, tracking the current year from the
// most recent <h3>, so every meet carries a full ISO meetDate
// (year + short date label) as well as the raw dateLabel + year.
function parseMeetList(html) {
  const out = [];
  // Tokenise into year headers and meet rows, preserving order.
  const re = /<h3>\s*(\d{4})\s*<\/h3>|<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let year = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      year = Number(m[1]);
      continue;
    }
    const row = m[2];
    const link = row.match(/<a\s+href="selectevent\.php\?mref=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const c = cells(row);
    const dateLabel = c.length ? cellText(c[0]) : "";
    out.push({
      mref: Number(link[1]),
      name: cellText(link[2]),
      dateLabel,
      year,
      meetDate: parseShortDate(dateLabel, year),
    });
  }
  return out;
}

// selectevent.php has many anchors to selectsheet.php?mref=N&eref=M.
function parseEventList(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s+href="selectsheet\.php\?mref=\d+&(?:amp;)?eref=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const eref = Number(m[1]);
    if (seen.has(eref)) continue;
    seen.add(eref);
    out.push({ eref, name: cellText(m[2]) });
  }
  return out;
}

// Pull "<event>, <gender>/<height>/<phase>" hints out of an event
// name like "Girls Group A+ 1m, Final" or "Boys 14/15 Platform,
// Preliminary". All best-effort; any field may come back null.
function parseEventMeta(name) {
  const n = name || "";
  let gender = null;
  if (/\b(girls?|women|female|ladies)\b/i.test(n)) gender = "Female";
  else if (/\b(boys?|men|male)\b/i.test(n)) gender = "Male";
  else if (/\bmixed\b/i.test(n)) gender = "Mixed";

  let height = null;
  if (/\bplatform\b/i.test(n) || /\b(5|7\.5|10)\s*m\b/i.test(n)) height = "Platform";
  else if (/\b3\s*m\b/i.test(n)) height = "3m";
  else if (/\b1\s*m\b/i.test(n)) height = "1m";

  let phase = null;
  if (/\bprelim/i.test(n)) phase = "Preliminary";
  else if (/\bsemi/i.test(n)) phase = "Semifinal";
  else if (/\bfinal\b/i.test(n)) phase = "Final";

  return { gender, height, phase };
}

// selectsheet.php returns the ranked diver list for one event, plus
// the meet/event titles and full event date from the <h2>/<h3>.
function parseSheetList(html) {
  // Two <h2>s exist: a banner tagline and the the content meet title.
  // The meet title is the last <h2>, immediately before the <h3>.
  const h2all = html.match(/<h2>([\s\S]*?)<\/h2>/gi) || [];
  const meetName = h2all.length
    ? h2all[h2all.length - 1].replace(/<\/?h2>/gi, "")
    : "";
  const h3 = (html.match(/<h3>([\s\S]*?)<\/h3>/i) || [, ""])[1];
  const h3text = cellText(h3);
  // "Girls Group A+ 1m, Final -- 24th October 2021"
  const split = h3text.split(/\s+--\s+/);
  const eventName = cellText(split[0] || "");
  const eventDate = parseLongDate(split[1] || h3text);

  const tableMatch = html.match(/<table class="grid"[^>]*summary="List of Dive Sheets"[\s\S]*?<\/table>/i)
    || html.match(/<table class="grid"[\s\S]*?<\/table>/i);
  const divers = [];
  if (tableMatch) {
    for (const row of rows(tableMatch[0])) {
      const link = row.match(/<a\s+href="showsheet\.php\?mref=\d+&(?:amp;)?eref=\d+&(?:amp;)?dref=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const c = cells(row);
      // cells: [rank, name(anchor), club, total?]
      const rank = c.length ? toInt(c[0]) : null;
      const club = c.length >= 3 ? cellText(c[2]) : "";
      const total = c.length >= 4 ? toNumber(c[3]) : null;
      divers.push({
        dref: Number(link[1]),
        rank,
        name: cellText(link[2]),
        club,
        total,
      });
    }
  }
  return { meetName: cellText(meetName), eventName, eventDate, divers };
}

// showsheet.php parses one diver's full sheet. Header row defines
// the judge columns (J1..Jn), so we never hard-code the panel size.
function parseDiveSheet(html) {
  // "<strong>Emma Bolton</strong>, Southampton Diving Academy, 2004"
  const meta = html.match(/<p>\s*<strong>([\s\S]*?)<\/strong>\s*,\s*([\s\S]*?)<\/p>/i);
  let diver = "";
  let club = "";
  let birthYear = null;
  if (meta) {
    diver = cellText(meta[1]);
    const rest = cellText(meta[2]); // "Southampton Diving Academy, 2004"
    const ym = rest.match(/^(.*?),\s*(\d{4})\s*$/);
    if (ym) {
      club = ym[1].trim();
      birthYear = Number(ym[2]);
    } else {
      club = rest;
    }
  }

  const tableMatch = html.match(/<table class="grid"[^>]*summary="Dive Sheet"[\s\S]*?<\/table>/i)
    || html.match(/<table class="grid"[\s\S]*?<\/table>/i);
  const dives = [];
  let judgeCount = 0;
  let rank = null;

  if (tableMatch) {
    const allRows = rows(tableMatch[0]);
    // Header row: locate the J1..Jn columns and the surrounding
    // fixed columns by their labels, so column shifts don't break us.
    const header = allRows.length ? cells(allRows[0]).map(cellText) : [];
    const judgeIdx = [];
    header.forEach((h, i) => { if (/^J\d+$/i.test(h)) judgeIdx.push(i); });
    judgeCount = judgeIdx.length;
    const idxOf = (label) => header.findIndex((h) => h.toLowerCase() === label);
    const iRound = idxOf("round");
    const iDive = idxOf("dive");
    const iPos = header.findIndex((h) => h === "#");
    const iDD = idxOf("dd");
    const iPoints = idxOf("points");
    const iScore = idxOf("score");

    for (let r = 1; r < allRows.length; r++) {
      const c = cells(allRows[r]);
      const joined = cellText(allRows[r]);
      // Trailing "Rank N" row closes the sheet.
      const rk = joined.match(/^Rank\s+(\d+)$/i);
      if (rk) { rank = Number(rk[1]); continue; }
      if (c.length < judgeCount + 3) continue; // not a dive row
      const roundNumber = iRound >= 0 ? toInt(c[iRound]) : r;
      if (roundNumber === null) continue;
      const judgeScores = judgeIdx
        .map((i) => parseHalfMark(c[i]))
        .filter((v) => v !== null);
      dives.push({
        roundNumber,
        diveCode: iDive >= 0 ? cellText(c[iDive]) : null,
        position: iPos >= 0 ? cellText(c[iPos]) : null,
        degreeOfDifficulty: iDD >= 0 ? toNumber(c[iDD]) : null,
        judgeScores,
        divePoints: iPoints >= 0 ? toNumber(c[iPoints]) : null,
        runningTotal: iScore >= 0 ? toNumber(c[iScore]) : null,
      });
    }
  }
  return { diver, club, birthYear, judgeCount, rank, dives };
}

module.exports = {
  cellText,
  parseHalfMark,
  parseLongDate,
  parseShortDate,
  COUNTRIES,
  parseCountryList,
  parseMeetList,
  parseEventList,
  parseEventMeta,
  parseSheetList,
  parseDiveSheet,
};
