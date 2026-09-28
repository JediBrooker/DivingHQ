// lib/pdf-document.js: PDFKit documents that can print everyone's name.
//
// PDFKit's built-in Helvetica only covers WinAnsi (roughly Latin-1). The
// exports print translated headers in 26 locales and every diver, judge,
// club and meet name verbatim, so Cyrillic, Greek, CJK, Arabic and even a
// Polish Ł came out as mojibake. Two ways out, picked once per process:
//
//   * Unicode fonts, one per script (lib/pdf-fonts): Noto Sans for Latin,
//     Cyrillic and Greek, Noto Sans Arabic, Noto Sans Hebrew and Noto Sans
//     CJK, from the fonts-noto-core and fonts-noto-cjk packages. The routes
//     keep asking for "Helvetica-Bold" and friends; createPdfDocument maps
//     that onto a style and, for every string drawn or measured, has
//     lib/pdf-scripts cut it into runs that each go out in the font that
//     has their glyphs. Runs no installed font covers are folded as below,
//     so a box with only fonts-noto-core still prints Cyrillic properly and
//     CJK as "?". PDFKit embeds only the glyphs a document uses.
//
//   * No font files at all. Text is made WinAnsi-safe before it reaches
//     PDFKit (lib/pdf-fold): accents outside WinAnsi are dropped (Ł to L),
//     Cyrillic and Greek are transliterated, and anything left prints as
//     "?" rather than garbage. This is the exact path the app had before
//     fonts, kept as it was.
//
// Either way pdfTranslate falls back to the English header when the
// requested locale has characters the PDF can't draw.
//
// What the font path can't do, and why:
//   * PDFKit has no bidi. lib/pdf-scripts reorders right-to-left stretches
//     inside a left-to-right line itself and fontkit shapes the Arabic
//     (joining forms, lam-alef), which is right for names and headers. A
//     line doesn't become a right-to-left paragraph, though, and Arabic
//     runs are drawn without letter-spacing (the spaced-out section
//     headers would pull the joined letters apart).
//   * Lines that mix fonts are drawn piece by piece on the base font's
//     baseline. align left, center and right work; justify and wordSpacing
//     fall back to plain left-aligned spacing on those lines. Nothing in
//     the exports uses either.

const PDFDocument = require("pdfkit");
const { t: serverTranslate } = require("./server-i18n");
const { winAnsiSafe, isWinAnsi } = require("./pdf-fold");
const pdfFonts = require("./pdf-fonts");
const { planPieces, cjkRegion, canPrint } = require("./pdf-scripts");

const HELVETICA_TO = {
  Helvetica: "regular",
  "Helvetica-Bold": "bold",
  "Helvetica-Oblique": "italic",
  "Helvetica-BoldOblique": "bold",
};

const ASCII = /^[\x20-\x7e]*$/;

// How far below the top of the line the baseline sits, in points, for
// PDFKit's baseline option. The same switch PDFKit's _fragment has, done
// once with the base font so a Chinese name and the Latin text beside it
// sit on one line instead of each font's own ascender.
function baselineOffset(font, size, baseline) {
  if (typeof baseline === "number") return -baseline;
  let dy;
  switch (baseline) {
    case "svg-middle": dy = 0.5 * font.xHeight; break;
    case "middle":
    case "svg-central": dy = 0.5 * (font.descender + font.ascender); break;
    case "bottom":
    case "ideographic": dy = font.descender; break;
    case "alphabetic": dy = 0; break;
    case "mathematical": dy = 0.5 * font.ascender; break;
    case "hanging": dy = 0.8 * font.ascender; break;
    default: dy = font.ascender;
  }
  return (dy / 1000) * size;
}

const codePoints = (s) => [...s].length;

// Teach one document to draw each script in its own font. Four PDFKit
// methods get wrapped: font (Helvetica names become a style), widthOfString
// and _fragment (split into pieces, measured and drawn with the same
// fonts, so column fitting and line wrapping see the widths that get
// drawn), and text & co (which CJK face this string wants).
function installScriptFonts(doc, fonts) {
  const origFont = doc.font;
  const origWidth = doc.widthOfString;
  const origFragment = doc._fragment;
  const cjkDefault = fonts.cjkDefaultRegion();
  const opened = new Map(); // font key -> PDFKit font object
  let style = null;         // "regular" | "bold" | "italic", null for a font the caller named itself
  let region = null;        // CJK region of the text() call in progress

  // The PDFKit font for a lib/pdf-fonts font, registered on first use.
  // Opening one moves doc._font, so put it back: this is bookkeeping, not
  // a font change the caller asked for.
  function pdfkitFont(f) {
    let pf = opened.get(f.key);
    if (pf) return pf;
    const saved = [doc._font, doc._fontSource, doc._fontFamily];
    if (f.standard) {
      origFont.call(doc, f.name);
    } else {
      doc.registerFont(`DHQ:${f.key}`, f.buffer, f.face || undefined);
      origFont.call(doc, `DHQ:${f.key}`);
    }
    pf = doc._font;
    [doc._font, doc._fontSource, doc._fontFamily] = saved;
    opened.set(f.key, pf);
    return pf;
  }

  function pieces(text) {
    if (ASCII.test(text)) return [{ text, font: doc._font, rtl: false }];
    return planPieces(text, fonts.provider(style), region || cjkRegion(text, cjkDefault))
      .map((p) => ({ ...p, font: pdfkitFont(p.font) }));
  }

  doc.font = function (name, ...rest) {
    const wanted = typeof name === "string" ? HELVETICA_TO[name] : undefined;
    if (!wanted) {
      style = null;
      return origFont.call(this, name, ...rest);
    }
    style = wanted;
    const base = fonts.baseFont(wanted);
    pdfkitFont(base);
    return origFont.call(this, base.standard ? base.name : `DHQ:${base.key}`, ...rest);
  };

  doc.widthOfString = function (string, options = {}) {
    if (!style) return origWidth.call(this, string, options);
    const text = `${string}`;
    const ps = pieces(text);
    if (ps.length === 1 && ps[0].font === this._font && !ps[0].rtl && ps[0].text === text) {
      return origWidth.call(this, text, options);
    }
    let width = 0;
    let spaced = 0;
    for (const p of ps) {
      width += p.font.widthOfString(p.text, this._fontSize, p.rtl ? [] : options.features);
      if (!p.rtl) spaced += codePoints(p.text);
    }
    const cs = options.characterSpacing || 0;
    return ((width + cs * Math.max(0, spaced - 1)) * (options.horizontalScaling || 100)) / 100;
  };

  doc._fragment = function (text, x, y, options) {
    if (!style) return origFragment.call(this, text, x, y, options);
    const line = `${text}`.replace(/\n/g, "");
    if (!line) return undefined;
    const base = this._font;
    const ps = pieces(line);
    if (ps.length === 1 && ps[0].font === base && !ps[0].rtl) {
      return origFragment.call(this, ps[0].text, x, y, options);
    }

    // Where the line starts, worked out once for the whole line the way
    // _fragment would. The line wrapper measured textWidth through our
    // widthOfString, so centring lands where it should.
    const align = options.align || "left";
    if (options.width) {
      if (align === "right") x += options.lineWidth - this.widthOfString(line.replace(/\s+$/, ""), options);
      else if (align === "center") x += options.lineWidth / 2 - options.textWidth / 2;
    }
    const size = this._fontSize;
    const baseline = -baselineOffset(base, size, options.baseline);
    const cs = options.characterSpacing || 0;
    const scale = (options.horizontalScaling || 100) / 100;
    let cx = x;
    try {
      ps.forEach((p, i) => {
        // A right-to-left run is laid out whole (features switch off
        // PDFKit's word-by-word layout, which would flip each word on its
        // own and leave the spaces on the wrong side).
        const features = p.rtl ? [] : options.features;
        const spacing = p.rtl ? 0 : cs;
        const w = p.font.widthOfString(p.text, size, features);
        this._font = p.font;
        origFragment.call(this, p.text, cx, y, {
          ...options,
          align: "left",
          baseline,
          features,
          characterSpacing: spacing,
          wordSpacing: 0,
          textWidth: w,
          wordCount: 1,
          destination: i === 0 ? options.destination : undefined,
        });
        cx += (w + spacing * codePoints(p.text)) * scale;
      });
    } finally {
      this._font = base;
    }
    return undefined;
  };

  for (const method of ["text", "heightOfString", "boundsOfString"]) {
    const orig = doc[method];
    doc[method] = function (str, ...rest) {
      if (!style || region) return orig.call(this, str, ...rest);
      region = cjkRegion(`${str ?? ""}`, cjkDefault);
      try {
        return orig.call(this, str, ...rest);
      } finally {
        region = null;
      }
    };
  }
}

// A PDFDocument the routes can use exactly like `new PDFDocument(options)`.
// `fonts` is lib/pdf-fonts; the tests hand in a fake table instead.
function createPdfDocument(options, { fonts = pdfFonts } = {}) {
  const doc = new PDFDocument(options);
  if (fonts.anyFontFile()) {
    installScriptFonts(doc, fonts);
    doc.font("Helvetica");
  } else {
    const text = doc.text.bind(doc);
    doc.text = (str, ...rest) => text(winAnsiSafe(str), ...rest);
  }
  return doc;
}

// Can the installed fonts draw every character of s, with nothing folded?
function canPrintText(s) {
  if (isWinAnsi(s)) return true;
  if (!pdfFonts.anyFontFile()) return false;
  return canPrint(s, pdfFonts.provider("regular"), cjkRegion(s, pdfFonts.cjkDefaultRegion()));
}

// serverTranslate for a PDF header. A locale the PDF can't print (Japanese
// on a box without fonts-noto-cjk, Russian on one with no fonts at all)
// gets the English header instead of question marks.
function pdfTranslate(req, key, params) {
  const s = serverTranslate(req, key, params);
  if (canPrintText(s)) return s;
  return serverTranslate({ headers: { "accept-language": "en" } }, key, params);
}

module.exports = {
  createPdfDocument, pdfTranslate, winAnsiSafe, isWinAnsi, canPrintText,
  // For tests: forget the cached font lookup after changing the env.
  _resetFontsForTest: () => pdfFonts._resetForTest(),
};
