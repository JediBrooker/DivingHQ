// lib/pdf-scripts.js: which font draws which part of a string, and in
// what order the parts go on the page.
//
// No single font covers every name a meet prints. Noto Sans does Latin,
// Cyrillic and Greek; Arabic, Hebrew and CJK each live in their own Noto
// file. So lib/pdf-document.js hands every string it draws or measures to
// planPieces(), which:
//
//   1. gives each character a font: its script's font if that has the
//      glyph, else the base (Latin) font if that does, else nothing;
//   2. folds the characters nothing can draw (lib/pdf-fold: Иван to Ivan,
//      李 to ?) and puts them in the base font, which is today's behaviour
//      for a box without the fonts;
//   3. lays the runs out left to right, flipping right-to-left stretches.
//
// Step 3 is a small slice of the Unicode bidi algorithm, enough for names:
// every line is a left-to-right paragraph (the PDFs are), and a stretch
// that starts with an Arabic or Hebrew letter runs right to left up to
// the last RTL letter or number before the next left-to-right letter.
// Inside it the order of words, spaces and numbers is reversed, numbers
// stay readable left to right, and brackets swap. fontkit does the rest:
// handed a run of Arabic it shapes the joining forms and returns the
// glyphs in visual order. What's not here: explicit embeddings (LRE, RLI
// and friends are dropped), right-to-left paragraphs (a line that starts
// in Arabic still reads from the left margin) and mirroring anything but
// the common brackets. Fine for "محمد علي (EGY)", not for typesetting an
// Arabic paragraph.
//
// Everything in here is pure. Fonts come in as { key, has(codePoint) }
// objects, so the tests can use a fake table instead of real font files.

const { winAnsiSafe } = require("./pdf-fold");

const SANS = "sans";       // Latin, Cyrillic, Greek: the base font
const ARABIC = "arabic";
const HEBREW = "hebrew";
const HAN = "han";
const KANA = "kana";
const HANGUL = "hangul";
const CJK = "cjk";         // CJK punctuation, fullwidth forms, bopomofo
const COMMON = "common";   // spaces, digits, punctuation, symbols
const MARK = "mark";       // combining marks, joiners, variation selectors
const FORMAT = "format";   // invisible bidi and width controls, dropped
const OTHER = "other";     // anything else (Thai, Devanagari, emoji...)

// [first, last, script], sorted. Not the whole of Unicode's Scripts.txt,
// just the blocks a diver's name or a translated header can plausibly use.
const RANGES = [
  [0x0000, 0x0040, COMMON], [0x0041, 0x005a, SANS], [0x005b, 0x0060, COMMON],
  [0x0061, 0x007a, SANS], [0x007b, 0x00bf, COMMON], [0x00c0, 0x00d6, SANS],
  [0x00d7, 0x00d7, COMMON], [0x00d8, 0x00f6, SANS], [0x00f7, 0x00f7, COMMON],
  [0x00f8, 0x02ff, SANS], [0x0300, 0x036f, MARK], [0x0370, 0x0482, SANS],
  [0x0483, 0x0489, MARK], [0x048a, 0x052f, SANS], [0x0590, 0x05ff, HEBREW],
  [0x0600, 0x06ff, ARABIC], [0x0750, 0x077f, ARABIC], [0x0870, 0x08ff, ARABIC],
  [0x1100, 0x11ff, HANGUL], [0x1ab0, 0x1aff, MARK], [0x1c80, 0x1c8f, SANS],
  [0x1d00, 0x1dbf, SANS], [0x1dc0, 0x1dff, MARK], [0x1e00, 0x1fff, SANS],
  [0x2000, 0x200a, COMMON], [0x200b, 0x200b, FORMAT], [0x200c, 0x200d, MARK],
  [0x200e, 0x200f, FORMAT], [0x2010, 0x2029, COMMON], [0x202a, 0x202e, FORMAT],
  [0x202f, 0x205f, COMMON], [0x2060, 0x206f, FORMAT], [0x2070, 0x20cf, COMMON],
  [0x20d0, 0x20ff, MARK], [0x2100, 0x2bff, COMMON], [0x2c60, 0x2c7f, SANS],
  [0x2de0, 0x2dff, MARK], [0x2e00, 0x2e7f, COMMON], [0x2e80, 0x2fdf, HAN],
  [0x2ff0, 0x3004, CJK], [0x3005, 0x3005, HAN], [0x3006, 0x3006, CJK],
  [0x3007, 0x3007, HAN], [0x3008, 0x3020, CJK], [0x3021, 0x3029, HAN],
  [0x302a, 0x302f, MARK], [0x3030, 0x3037, CJK], [0x3038, 0x303b, HAN],
  [0x303c, 0x303f, CJK], [0x3040, 0x30ff, KANA], [0x3100, 0x312f, CJK],
  [0x3130, 0x318f, HANGUL], [0x3190, 0x31ef, CJK], [0x31f0, 0x31ff, KANA],
  [0x3200, 0x33ff, CJK], [0x3400, 0x4dbf, HAN], [0x4dc0, 0x4dff, COMMON],
  [0x4e00, 0x9fff, HAN], [0xa640, 0xa69f, SANS], [0xa720, 0xa7ff, SANS],
  [0xa960, 0xa97f, HANGUL], [0xab30, 0xab6f, SANS], [0xac00, 0xd7ff, HANGUL],
  [0xf900, 0xfaff, HAN], [0xfb00, 0xfb06, SANS], [0xfb1d, 0xfb4f, HEBREW],
  [0xfb50, 0xfdff, ARABIC], [0xfe00, 0xfe0f, MARK], [0xfe10, 0xfe1f, CJK],
  [0xfe20, 0xfe2f, MARK], [0xfe30, 0xfe4f, CJK], [0xfe50, 0xfe6f, COMMON],
  [0xfe70, 0xfefe, ARABIC], [0xfeff, 0xfeff, FORMAT], [0xff00, 0xff65, CJK],
  [0xff66, 0xff9f, KANA], [0xffa0, 0xffdf, HANGUL], [0xffe0, 0xffef, CJK],
  [0x1b000, 0x1b16f, KANA], [0x1f200, 0x1f2ff, CJK], [0x20000, 0x3ffff, HAN],
  [0xe0100, 0xe01ef, MARK],
];

function scriptOf(cp) {
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last, script] = RANGES[mid];
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return script;
  }
  return OTHER;
}

// Which font slot (lib/pdf-fonts) a script's characters want. Latin and
// friends, and whatever has no slot, go to the base font.
const SLOT_OF = { [ARABIC]: "arabic", [HEBREW]: "hebrew", [HAN]: "cjk", [KANA]: "cjk", [HANGUL]: "cjk", [CJK]: "cjk" };

// The CJK collection has one face per region, and the same ideograph is
// drawn differently in each. Kana only exist in Japanese and Hangul in
// Korean, so those always get their own face. Han characters follow the
// rest of the string: 山田はなこ is Japanese, 李娜 is whatever the
// fallback says (Simplified Chinese unless PDF_FONT_CJK_REGION changes it).
function cjkRegion(text, fallback = "SC") {
  let hangul = false;
  for (const ch of String(text)) {
    const s = scriptOf(ch.codePointAt(0));
    if (s === KANA) return "JP";
    if (s === HANGUL) hangul = true;
  }
  return hangul ? "KR" : fallback;
}

function regionFor(script, region) {
  if (script === KANA) return "JP";
  if (script === HANGUL) return "KR";
  return region;
}

function isDigit(cp) {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x660 && cp <= 0x669) || (cp >= 0x6f0 && cp <= 0x6f9);
}

// Where a symbol the base font lacks is looked for next. CJK first, it
// has by far the most symbols.
const BORROW_FROM = ["cjk", "arabic", "hebrew"];

function firstWith(fonts, cp) {
  for (const f of fonts) if (f && f.has(cp)) return f;
  return null;
}

// Step 1: a font per character. font === null means "fold it", drop means
// leave it out altogether (an invisible control, or a mark nothing draws).
function assignFonts(text, provider, region) {
  const { base } = provider;
  const cells = [];
  let prev = null;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const script = scriptOf(cp);
    const c = { ch, cp, script, font: null, drop: false };
    cells.push(c);
    if (script === FORMAT) {
      c.drop = true;
      continue;
    }
    if (cp < 0x20) {
      c.font = base; // tabs and newlines, PDFKit strips them itself
    } else if (script === MARK) {
      // Marks follow whatever they sit on: folded with a folded letter,
      // dropped if the letter's font can't draw them.
      if (prev && prev.font === null) c.font = null;
      else if (prev && prev.font.has(cp)) c.font = prev.font;
      else c.drop = true;
    } else if (script === COMMON) {
      // Spaces, digits and punctuation stay in the base font, so they
      // look the same next to a Chinese name as next to a Latin one. A
      // symbol the base font lacks tries the script fonts in a fixed
      // order, never "whatever's next to it": the line wrapper measures
      // word by word, and a word has to come out the same width on its
      // own as it does on the line.
      c.font = base.has(cp) ? base : firstWith(BORROW_FROM.map((slot) => provider.font(slot, region)), cp);
    } else if (SLOT_OF[script]) {
      c.font = firstWith([provider.font(SLOT_OF[script], regionFor(script, region)), base], cp);
    } else {
      c.font = firstWith([base], cp);
    }
    if (!c.drop) prev = c;
  }
  return cells;
}

// Step 2: runs of one font, in logical order. Folded runs land in the
// base font; winAnsiSafe works on the whole run so "ου" still reads "ou".
function logicalRuns(text, provider, region) {
  const runs = [];
  for (const c of assignFonts(text, provider, region)) {
    if (c.drop) continue;
    const fold = c.font === null;
    const last = runs[runs.length - 1];
    if (last && last.fold === fold && (fold || last.font === c.font)) last.text += c.ch;
    else runs.push({ text: c.ch, font: fold ? provider.base : c.font, fold });
  }
  const merged = [];
  for (const r of runs) {
    const text = r.fold ? winAnsiSafe(r.text) : r.text;
    const last = merged[merged.length - 1];
    if (last && last.font === r.font) last.text += text;
    else merged.push({ text, font: r.font });
  }
  return merged.filter((r) => r.text);
}

// True when every character has a real font: nothing folds, nothing turns
// into "?". pdfTranslate uses it to pick between a header and English.
function canPrint(text, provider, region) {
  return assignFonts(text, provider, region).every((c) => c.drop || c.font !== null);
}

const MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«", "‹": "›", "›": "‹" };
const CLOSER = { "(": ")", "[": "]", "{": "}" };
// Separators that keep a number together: 12.5, 1,000, 10:30, 3/4.
const NUMBER_SEP = new Set([".", ",", ":", "/", "٫", "٬"]);

function bidiClass(cp, script) {
  if (isDigit(cp)) return "N";
  if (script === ARABIC || script === HEBREW) return "R";
  if (script === MARK) return "M";
  if (script === COMMON || script === FORMAT || cp < 0x20) return "W";
  return "L";
}

// Step 3: the pieces to draw, left to right. Each is { text, font, rtl };
// rtl pieces are letters in logical order that fontkit will shape and
// flip. solo pieces are Arabic-Indic digits, one at a time wherever they
// sit, because fontkit would flip "١٢" too.
function visualOrder(runs) {
  const cells = [];
  for (const r of runs) {
    for (const ch of r.text) {
      const cp = ch.codePointAt(0);
      const script = scriptOf(cp);
      let cls = bidiClass(cp, script);
      if (cls === "M") cls = cells.length ? cells[cells.length - 1].cls : "W";
      cells.push({ ch, cp, script, font: r.font, cls });
    }
  }

  const out = [];
  const push = (piece) => {
    const last = out[out.length - 1];
    if (last && !piece.rtl && !piece.solo && !last.rtl && !last.solo && last.font === piece.font) {
      last.text += piece.text;
    } else {
      out.push({ ...piece });
    }
  };

  let i = 0;
  while (i < cells.length) {
    if (cells[i].cls !== "R") {
      // Arabic-Indic digits with no Arabic letter in front of them ("Round
      // ١٢", "١٢ محمد") go one at a time as well. fontkit only sees Arabic
      // script and flips the run, so "١٢" came out reading 21.
      push({ text: cells[i].ch, font: cells[i].font, rtl: false, solo: cells[i].script === ARABIC });
      i++;
      continue;
    }
    // A right-to-left stretch: from this letter to the last RTL letter or
    // number before the next left-to-right letter. Trailing spaces and
    // punctuation stay outside, on the left-to-right side.
    let end = i;
    for (let j = i; j < cells.length && cells[j].cls !== "L"; j++) {
      if (cells[j].cls === "R" || cells[j].cls === "N") end = j;
    }
    // A bracket opened inside the stretch and closed after it belongs to
    // the stretch too (the bidi algorithm's rule N0), or "محمد (علي)"
    // would leave its closing bracket stranded on the left-to-right side.
    const open = [];
    for (let k = i; k <= end; k++) {
      const ch = cells[k].ch;
      if (CLOSER[ch]) open.push(CLOSER[ch]);
      else if (open.length && ch === open[open.length - 1]) open.pop();
    }
    for (let j = end + 1; open.length && j < cells.length && cells[j].cls !== "L"; j++) {
      if (cells[j].ch === open[open.length - 1]) { open.pop(); end = j; }
    }
    const units = [];
    let k = i;
    while (k <= end) {
      const c = cells[k];
      if (c.cls === "R") {
        let text = "";
        while (k <= end && cells[k].cls === "R" && cells[k].font === c.font) text += cells[k++].ch;
        units.push([{ text, font: c.font, rtl: true }]);
      } else if (c.cls === "N") {
        const unit = [];
        while (k <= end && (cells[k].cls === "N"
          || (NUMBER_SEP.has(cells[k].ch) && cells[k - 1].cls === "N" && k + 1 <= end && cells[k + 1].cls === "N"))) {
          const d = cells[k++];
          const solo = d.script === ARABIC;
          const last = unit[unit.length - 1];
          if (last && !solo && !last.solo && last.font === d.font) last.text += d.ch;
          else unit.push({ text: d.ch, font: d.font, rtl: false, solo });
        }
        units.push(unit);
      } else {
        units.push([{ text: MIRROR[c.ch] || c.ch, font: c.font, rtl: false }]);
        k++;
      }
    }
    for (const unit of units.reverse()) for (const piece of unit) push(piece);
    i = end + 1;
  }
  return out;
}

// The whole pipeline: text in, pieces to draw left to right out.
function planPieces(text, provider, region) {
  return visualOrder(logicalRuns(text, provider, region));
}

module.exports = {
  scriptOf, cjkRegion, assignFonts, logicalRuns, visualOrder, planPieces, canPrint,
  SCRIPTS: { SANS, ARABIC, HEBREW, HAN, KANA, HANGUL, CJK, COMMON, MARK, FORMAT, OTHER },
};
