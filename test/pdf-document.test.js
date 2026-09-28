// lib/pdf-document: what the PDF exports do with text Helvetica can't
// print. With no font files (forced here with PDF_FONT_DIR=none, so a box
// that does have Noto installed runs the same test) names are folded to
// WinAnsi and translated headers fall back to English, instead of
// printing mojibake. With fonts, every line is drawn and measured piece
// by piece in each script's font. DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const PDFDocument = require("pdfkit");

process.env.PDF_FONT_DIR = "none";
delete process.env.PDF_FONT_REGULAR;
delete process.env.PDF_FONT_BOLD;
delete process.env.PDF_FONT_ITALIC;
const { winAnsiSafe, isWinAnsi, pdfTranslate, createPdfDocument, _resetFontsForTest } = require("../lib/pdf-document");
const { isWinAnsiChar } = require("../lib/pdf-fold");
_resetFontsForTest();

test("WinAnsi text passes through untouched", () => {
  for (const s of ["José Müller", "Zoë Ørsted", "Šárka Žáková", "Ana · 3m — Final", "Œuvre"]) {
    assert.equal(winAnsiSafe(s), s);
  }
});

test("other Latin letters lose only their accent", () => {
  assert.equal(winAnsiSafe("Łukasz Świątek"), "Lukasz Swiatek");
  assert.equal(winAnsiSafe("Jiří Dvořák"), "Jirí Dvorák", "í and á are WinAnsi already");
  assert.equal(winAnsiSafe("Đorđe Nguyễn"), "Dorde Nguyen");
});

test("Cyrillic and Greek are transliterated", () => {
  assert.equal(winAnsiSafe("Иван Петров"), "Ivan Petrov");
  assert.equal(winAnsiSafe("Йордан Щукин"), "Yordan Shchukin");
  assert.equal(winAnsiSafe("Ђорђе Јовановић"), "Djordje Jovanovic");
  assert.equal(winAnsiSafe("Γιώργος Παπαδόπουλος"), "Giorgos Papadopoulos");
});

test("scripts with no Latin form print as question marks, not garbage", () => {
  assert.equal(winAnsiSafe("李娜"), "??");
  assert.equal(winAnsiSafe("DD ≤ 2.0"), "DD <= 2.0");
  assert.ok(isWinAnsi(winAnsiSafe("محمد 李娜 Ωmega ✓")));
});

test("a header the PDF can't print falls back to English", () => {
  const ru = { headers: { "accept-language": "ru" } };
  const de = { headers: { "accept-language": "de" } };
  const en = pdfTranslate({ headers: {} }, "pdf.program.header_event_schedule");
  assert.equal(pdfTranslate(ru, "pdf.program.header_event_schedule"), en);
  assert.ok(isWinAnsi(pdfTranslate(de, "pdf.program.header_event_schedule")));
});

function drawnText(buf) {
  const raw = buf.toString("latin1");
  const drawn = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const tj of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      drawn.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
    }
  }
  return drawn;
}

test("createPdfDocument writes the folded name into the page", async () => {
  const doc = createPdfDocument({ margin: 50, size: "A4" });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((r) => doc.on("end", r));
  doc.font("Helvetica-Bold").text("Łukasz Иванов");
  doc.end();
  await done;
  const drawn = drawnText(Buffer.concat(chunks));
  assert.ok(drawn.join("\n").includes("Lukasz Ivanov"), drawn.join("\n"));
});

// Every piece PDFKit's own _fragment gets asked to draw, with the font it
// was drawn in. Patched on the prototype before the document exists, so
// the wrapper in lib/pdf-document calls through this.
function recordFragments(fn) {
  const orig = PDFDocument.prototype._fragment;
  const calls = [];
  PDFDocument.prototype._fragment = function (text, x, y, options) {
    calls.push({ text, x, y, font: this._font, size: this._fontSize, options });
    return orig.call(this, text, x, y, options);
  };
  try {
    fn();
  } finally {
    PDFDocument.prototype._fragment = orig;
  }
  return calls;
}

// A fake font table built from PDFKit's standard fonts, so the glue can
// be tested without font files. Helvetica is the base; Courier stands in
// for the CJK font and "has" the CJK characters plus § and ×, which the
// fake base pretends not to have. Courier's glyphs are wider than
// Helvetica's, so a width measured in the wrong font shows. Times plays
// the Arabic font; it can't draw the letters, but the tests only look at
// how each piece is handed to PDFKit.
function fakeFonts() {
  const std = (name, has) => ({ key: name, standard: true, name, has });
  const baseHas = (cp) => isWinAnsiChar(cp) && cp !== 0xa7 && cp !== 0xd7;
  const cjkHas = (cp) => (cp >= 0x4e00 && cp <= 0x9fff) || cp === 0xa7 || cp === 0xd7 || cp === 0x20;
  const arabicHas = (cp) => cp >= 0x600 && cp <= 0x6ff;
  const base = { regular: std("Helvetica", baseHas), bold: std("Helvetica-Bold", baseHas), italic: std("Helvetica-Oblique", baseHas) };
  const cjk = { regular: std("Courier", cjkHas), bold: std("Courier-Bold", cjkHas), italic: std("Courier", cjkHas) };
  const arabic = std("Times-Roman", arabicHas);
  const asked = [];
  return {
    asked,
    anyFontFile: () => true,
    cjkDefaultRegion: () => "SC",
    baseFont: (style) => base[style],
    provider: (style) => ({
      base: base[style],
      font: (slot, region) => {
        asked.push(`${slot}:${region}:${style}`);
        if (slot === "arabic") return arabic;
        return slot === "cjk" ? cjk[style] : null;
      },
    }),
  };
}

const standardWidth = (name, text, size) => {
  const d = new PDFDocument();
  d.font(name).fontSize(size);
  return d.widthOfString(text);
};

test("widths are measured with the font each piece is drawn in", () => {
  const doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts: fakeFonts() });
  doc.font("Helvetica").fontSize(10);
  const want = standardWidth("Helvetica", "Ab ", 10) + standardWidth("Courier", "李§§", 10);
  assert.ok(Math.abs(doc.widthOfString("Ab 李§§") - want) < 1e-9);
  assert.notEqual(want, standardWidth("Helvetica", "Ab 李§§", 10), "Helvetica alone would measure it differently");
  assert.equal(doc.widthOfString("Plain ASCII"), standardWidth("Helvetica", "Plain ASCII", 10), "ASCII is untouched");
  doc.end();
});

test("a mixed line is drawn piece by piece on one baseline, centred as a whole", () => {
  let doc;
  const calls = recordFragments(() => {
    doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts: fakeFonts() });
    doc.font("Helvetica").fontSize(10).text("Ab 李§§ Cd", 50, 100, { width: 400, align: "center" });
  });
  assert.deepEqual(calls.map((c) => [c.text, c.font.name]), [
    ["Ab ", "Helvetica"], ["李§§", "Courier"], [" Cd", "Helvetica"],
  ]);
  const w = calls.map((c) => standardWidth(c.font.name, c.text, 10));
  const total = w[0] + w[1] + w[2];
  assert.ok(Math.abs(calls[0].x - (50 + (400 - total) / 2)) < 1e-6, "centred on the width actually drawn");
  assert.ok(Math.abs(calls[1].x - (calls[0].x + w[0])) < 1e-6);
  assert.ok(Math.abs(calls[2].x - (calls[1].x + w[1])) < 1e-6);
  // Courier's ascender is 629, Helvetica's 718: without a shared baseline
  // the Courier piece would sit higher than the text around it.
  const baselines = new Set(calls.map((c) => c.options.baseline));
  assert.equal(baselines.size, 1);
  assert.ok(Math.abs([...baselines][0] + 7.18) < 1e-9, "Helvetica's ascender at 10pt");
  assert.equal(new Set(calls.map((c) => c.y)).size, 1);
  assert.equal(doc._font.name, "Helvetica", "the base font is current again afterwards");
  doc.end();
});

test("right alignment and continued text use the mixed widths", () => {
  let doc;
  const calls = recordFragments(() => {
    doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts: fakeFonts() });
    // The results.pdf standings row: name, then the total pushed right.
    doc.font("Helvetica").fontSize(10).text("1. 李§", 50, 100, { continued: true, width: 350 })
      .font("Helvetica-Bold").text("512.30", { align: "right" });
    doc.text("李§ Right", 50, 200, { width: 300, align: "right" });
  });
  const row = calls.filter((c) => c.y === 100);
  assert.deepEqual(row.map((c) => c.text), ["1. ", "李§", "512.30"]);
  const nameWidth = standardWidth("Helvetica", "1. ", 10) + standardWidth("Courier", "李§", 10);
  assert.ok(Math.abs(row[2].x - (50 + nameWidth)) < 1e-6, "the total carries on where the name ended");
  assert.ok(Math.abs(row[2].x + row[2].options.lineWidth - 400) < 1e-6, "and is right-aligned to the same box");

  const last = calls.filter((c) => c.y === 200);
  assert.deepEqual(last.map((c) => c.font.name), ["Courier-Bold", "Helvetica-Bold"], "bold asks for the bold CJK face");
  const right = last[1].x + standardWidth("Helvetica-Bold", last[1].text, 10);
  assert.ok(Math.abs(right - 350) < 1e-6, `the line ends at the right edge (${right})`);
  doc.end();
});

test("the CJK region is worked out per string and a style per font call", () => {
  const fonts = fakeFonts();
  const doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts });
  doc.font("Helvetica-Bold").text("山田はなこ");
  doc.font("Helvetica-Oblique").text("李娜");
  doc.end();
  assert.ok(fonts.asked.includes("cjk:JP:bold"));
  assert.ok(fonts.asked.includes("cjk:SC:italic"));
  assert.ok(!fonts.asked.includes("cjk:SC:bold"), "the kanji in 山田 went to the Japanese face");
});

test("a font the caller names itself is left alone", () => {
  const calls = recordFragments(() => {
    const doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts: fakeFonts() });
    doc.font("Times-Roman").text("Ab 李§");
    doc.end();
  });
  assert.deepEqual(calls.map((c) => [c.text, c.font.name]), [["Ab 李§", "Times-Roman"]]);
});

// The real-font test further down proves the shaping, but only on a Mac.
// This pins the part that makes it work, everywhere: a right-to-left run
// reaches PDFKit with an empty feature list (so PDFKit hands fontkit the
// whole run to shape and flip, not one word at a time) and without
// letter-spacing, which would pull joined Arabic letters apart.
test("right-to-left runs go to PDFKit whole and without letter-spacing", () => {
  let doc;
  const calls = recordFragments(() => {
    doc = createPdfDocument({ margin: 50, size: "A4" }, { fonts: fakeFonts() });
    doc.font("Helvetica").fontSize(10).text("Ab محمد علي", 50, 100, { characterSpacing: 2 });
  });
  assert.deepEqual(calls.map((c) => [c.text, c.font.name]), [
    ["Ab ", "Helvetica"], ["علي", "Times-Roman"], [" ", "Helvetica"], ["محمد", "Times-Roman"],
  ]);
  for (const c of calls) {
    const rtl = c.font.name === "Times-Roman";
    assert.deepEqual(c.options.features, rtl ? [] : undefined, `features for ${c.text}`);
    assert.equal(c.options.characterSpacing, rtl ? 0 : 2, `letter-spacing for ${c.text}`);
  }
  doc.end();
});

// Optional, and only on a Mac: Arial Unicode stands in for Noto Sans,
// Noto Sans Arabic and Noto Sans Hebrew, and Hiragino Sans GB for the CJK
// collection. Proves the real thing end to end: files found, TTC face
// chosen, Arabic shaped and ordered, widths from the fonts that draw.
const ARIAL_UNICODE = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
const HIRAGINO = "/System/Library/Fonts/Hiragino Sans GB.ttc";
const haveMacFonts = fs.existsSync(ARIAL_UNICODE) && fs.existsSync(HIRAGINO);

test("real fonts: every script drawn in its own font", { skip: !haveMacFonts && "no macOS system fonts here" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-fonts-"));
  for (const name of ["NotoSans-Regular.ttf", "NotoSansArabic-Regular.ttf", "NotoSansHebrew-Regular.ttf"]) {
    fs.symlinkSync(ARIAL_UNICODE, path.join(dir, name));
  }
  fs.symlinkSync(HIRAGINO, path.join(dir, "NotoSansCJK-Regular.ttc"));
  process.env.PDF_FONT_DIR = dir;
  _resetFontsForTest();
  try {
    let doc;
    const calls = recordFragments(() => {
      doc = createPdfDocument({ margin: 50, size: "A4" });
      doc.font("Helvetica").fontSize(12);
      doc.text("Иван Петров");
      doc.text("李娜 (CHN)");
      doc.text("محمد علي (EGY)");
      doc.text("רחל כהן 2024");
    });
    const lines = new Map();
    for (const c of calls) lines.set(c.y, [...(lines.get(c.y) || []), c]);
    const [cyr, han, ar, he] = [...lines.values()].map((l) => l.map((c) => [c.text, c.font.name]));
    assert.deepEqual(cyr, [["Иван Петров", "ArialUnicodeMS"]]);
    assert.deepEqual(han, [["李娜", "HiraginoSansGB-W3"], [" (CHN)", "ArialUnicodeMS"]]);
    assert.deepEqual(ar.map((p) => p[0]), ["علي", " ", "محمد", " (EGY)"], "right to left, then the code");
    assert.deepEqual(he.map((p) => p[0]), ["2024 ", "כהן", " ", "רחל"]);

    // fontkit shaped the Arabic: joining forms, not the isolated letters
    // a character-by-character lookup would give.
    const arPiece = calls.find((c) => c.text === "محمد");
    assert.deepEqual(arPiece.options.features, [], "laid out as one run");
    const shaped = arPiece.font.font.layout("محمد", []).glyphs.map((g) => g.id);
    const isolated = [..."محمد"].map((ch) => arPiece.font.font.glyphForCodePoint(ch.codePointAt(0)).id).reverse();
    assert.equal(shaped.length, 4);
    assert.notDeepEqual(shaped, isolated);

    // The widths the line wrapper sees are the ones that get drawn.
    const hanLine = calls.filter((c) => c.text === "李娜" || c.text === " (CHN)");
    const sum = hanLine.reduce((s, c) => s + c.font.widthOfString(c.text, 12), 0);
    assert.ok(Math.abs(doc.widthOfString("李娜 (CHN)") - sum) < 1e-9);
    doc.end();

    const ru = pdfTranslate({ headers: { "accept-language": "ru" } }, "pdf.program.header_event_schedule");
    assert.ok(!isWinAnsi(ru), `Russian headers print in Russian now (${ru})`);
  } finally {
    process.env.PDF_FONT_DIR = "none";
    _resetFontsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
