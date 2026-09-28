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
// The WinAnsi folding lives in lib/pdf-fold, where the per-script run
// planner can use it too.
const { winAnsiSafe, isWinAnsi } = require("./pdf-fold");

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
