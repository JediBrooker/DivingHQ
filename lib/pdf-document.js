// lib/pdf-document.js: PDFKit documents that can print everyone's name.
//
// PDFKit's built-in Helvetica only covers WinAnsi (roughly Latin-1). The
// exports print translated headers in 26 locales and every diver, judge,
// club and meet name verbatim, so Cyrillic, Greek, CJK, Arabic and even a
// Polish Ł came out as mojibake. Two ways out, picked once per process:
//
//   * Unicode fonts. Set PDF_FONT_REGULAR (and ideally PDF_FONT_BOLD and
//     PDF_FONT_ITALIC) to TTF/OTF files, e.g. Noto Sans from the distro's
//     fonts-noto package. createPdfDocument registers them and quietly maps
//     the Helvetica names the routes ask for onto them, so nothing in the
//     routes has to change. PDFKit embeds only the glyphs a file uses.
//
//   * No fonts configured (the default). Text is made WinAnsi-safe before
//     it reaches PDFKit: accents outside WinAnsi are dropped (Ł to L, ś to
//     s), Cyrillic and Greek are transliterated, and anything left (CJK,
//     Arabic) prints as "?" rather than garbage. pdfTranslate falls back
//     to the English header when the requested locale can't be printed.
//
// Fonts aren't shipped in the repo (Noto with CJK and Arabic is tens of
// MB), which is why the second path exists at all.

const fs = require("node:fs");
const PDFDocument = require("pdfkit");
const { t: serverTranslate } = require("./server-i18n");

// Code points WinAnsi can print besides 0x20-0x7E and 0xA0-0xFF, the same
// table PDFKit's standard fonts encode with.
const WIN_ANSI_EXTRA = new Set([
  402, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225, 8226,
  8230, 8364, 8240, 8249, 8250, 710, 8482, 338, 339, 732, 352, 353, 376, 381, 382,
]);

function isWinAnsiChar(cp) {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp)
    || cp === 0x0a || cp === 0x0d || cp === 0x09;
}

function isWinAnsi(str) {
  for (const ch of String(str)) {
    if (!isWinAnsiChar(ch.codePointAt(0))) return false;
  }
  return true;
}

// Letters NFKD won't take apart, plus a couple of symbols the exports use.
const SPECIAL = {
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ħ": "H", "ħ": "h", "ı": "i", "Ŧ": "T", "ŧ": "t",
  "Ŋ": "N", "ŋ": "n", "ĸ": "k", "ſ": "s", "Ə": "E", "ə": "e", "ƒ": "f",
  "≤": "<=", "≥": ">=", "✓": "v", "×": "x", "−": "-",
};

// Russian, Ukrainian, Belarusian, Serbian and Macedonian Cyrillic, close to
// the passport-style transliteration most federations already use.
const CYRILLIC = {
  А: "A", Б: "B", В: "V", Г: "G", Ґ: "G", Д: "D", Ђ: "Dj", Ѓ: "Gj", Е: "E", Ё: "E", Є: "Ye",
  Ж: "Zh", З: "Z", Ѕ: "Dz", И: "I", І: "I", Ї: "Yi", Й: "Y", Ј: "J", К: "K", Л: "L", Љ: "Lj",
  М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T", Ћ: "C", Ќ: "Kj", У: "U",
  Ў: "U", Ф: "F", Х: "Kh", Ц: "Ts", Ч: "Ch", Џ: "Dz", Ш: "Sh", Щ: "Shch", Ъ: "", Ы: "Y",
  Ь: "", Э: "E", Ю: "Yu", Я: "Ya",
};
for (const [k, v] of Object.entries(CYRILLIC)) CYRILLIC[k.toLowerCase()] = v.toLowerCase();

const GREEK = {
  Α: "A", Β: "V", Γ: "G", Δ: "D", Ε: "E", Ζ: "Z", Η: "I", Θ: "Th", Ι: "I", Κ: "K", Λ: "L",
  Μ: "M", Ν: "N", Ξ: "X", Ο: "O", Π: "P", Ρ: "R", Σ: "S", Τ: "T", Υ: "Y", Φ: "F", Χ: "Ch",
  Ψ: "Ps", Ω: "O",
};
for (const [k, v] of Object.entries(GREEK)) GREEK[k.toLowerCase()] = v.toLowerCase();
GREEK["ς"] = "s";

// One character in, printable WinAnsi text out.
function foldChar(ch) {
  if (isWinAnsiChar(ch.codePointAt(0))) return ch;
  if (SPECIAL[ch] !== undefined) return SPECIAL[ch];
  // Before any decomposition: й isn't "и with a breve" in any
  // transliteration people recognise.
  if (CYRILLIC[ch] !== undefined) return CYRILLIC[ch];
  if (GREEK[ch] !== undefined) return GREEK[ch];
  const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (CYRILLIC[base] !== undefined) return CYRILLIC[base];
  if (GREEK[base] !== undefined) return GREEK[base];
  if (base !== ch && isWinAnsi(base)) return base;
  const compat = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  if (compat !== ch && compat && isWinAnsi(compat)) return compat;
  return "?";
}

function winAnsiSafe(str) {
  if (typeof str !== "string" || isWinAnsi(str)) return str;
  // Greek ου reads "ou" (Papadopoulos), not letter by letter.
  const src = str.replace(/([Οο])([ΥυΎύ])/g, (_m, o, u) =>
    (o === "Ο" ? "O" : "o") + (u === "Υ" || u === "Ύ" ? "U" : "u"));
  let out = "";
  for (const ch of src) out += foldChar(ch);
  return out;
}

// The configured Unicode font files, or null. Read once: a font set that
// changes needs a restart anyway.
let fontsCache;
function unicodeFonts() {
  if (fontsCache !== undefined) return fontsCache;
  const readable = (p) => {
    if (!p) return null;
    try { fs.accessSync(p, fs.constants.R_OK); return p; } catch { return null; }
  };
  const regular = readable(process.env.PDF_FONT_REGULAR);
  if (!regular) {
    if (process.env.PDF_FONT_REGULAR) {
      console.warn(`[pdf] PDF_FONT_REGULAR (${process.env.PDF_FONT_REGULAR}) isn't readable, using Helvetica`);
    }
    fontsCache = null;
    return fontsCache;
  }
  const bold = readable(process.env.PDF_FONT_BOLD) || regular;
  fontsCache = { regular, bold, italic: readable(process.env.PDF_FONT_ITALIC) || regular };
  return fontsCache;
}

const HELVETICA_TO = {
  Helvetica: "regular",
  "Helvetica-Bold": "bold",
  "Helvetica-Oblique": "italic",
  "Helvetica-BoldOblique": "bold",
};

// A PDFDocument the routes can use exactly like `new PDFDocument(options)`.
function createPdfDocument(options) {
  const doc = new PDFDocument(options);
  const fonts = unicodeFonts();
  if (fonts) {
    for (const [name, file] of Object.entries(fonts)) doc.registerFont(`DHQ-${name}`, file);
    const font = doc.font.bind(doc);
    doc.font = (name, ...rest) => font(HELVETICA_TO[name] ? `DHQ-${HELVETICA_TO[name]}` : name, ...rest);
    doc.font("Helvetica");
  } else {
    const text = doc.text.bind(doc);
    doc.text = (str, ...rest) => text(winAnsiSafe(str), ...rest);
  }
  return doc;
}

// serverTranslate for a PDF header. Without a Unicode font, a locale the
// PDF can't print (Russian, Japanese, Greek…) gets the English header
// instead of garbage.
function pdfTranslate(req, key, params) {
  const s = serverTranslate(req, key, params);
  if (unicodeFonts() || isWinAnsi(s)) return s;
  return serverTranslate({ headers: { "accept-language": "en" } }, key, params);
}

module.exports = {
  createPdfDocument, pdfTranslate, winAnsiSafe, isWinAnsi,
  // For tests: forget the cached font lookup after changing the env.
  _resetFontsForTest: () => { fontsCache = undefined; },
};
