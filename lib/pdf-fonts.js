// lib/pdf-fonts.js: where the PDF exports get their fonts from.
//
// One font per script, looked up once per process:
//
//   slot     draws                          Debian file (package)
//   sans     Latin, Cyrillic, Greek         NotoSans-*.ttf (fonts-noto-core)
//   arabic   Arabic                         NotoSansArabic-*.ttf (fonts-noto-core)
//   hebrew   Hebrew                         NotoSansHebrew-*.ttf (fonts-noto-core)
//   cjk      Chinese, Japanese, Korean      NotoSansCJK-*.ttc (fonts-noto-cjk)
//
// fonts-noto-core installs into /usr/share/fonts/truetype/noto and
// fonts-noto-cjk into /usr/share/fonts/opentype/noto, so those are where
// we look unless PDF_FONT_DIR names other directories (colon separated,
// or "none" to look nowhere). PDF_FONT_REGULAR / _BOLD / _ITALIC still
// pick the sans files by hand and win over whatever the directories hold;
// they predate the rest and a box set up with them keeps working.
//
// The CJK file is a collection: one face per region (Noto Sans CJK SC,
// TC, HK, JP, KR, and Mono variants of each), since the same ideograph is
// drawn differently in each. pickFace chooses by region, which
// lib/pdf-scripts works out per string. PDF_FONT_CJK_REGION sets the one
// used for Han characters with no kana or Hangul beside them (SC unless
// a federation wants TC, HK, JP or KR).
//
// A slot whose file is missing, unreadable or broken just isn't there:
// its characters get folded the way they always were (Иван to Ivan, 李
// to ?), so a box without the packages keeps printing. Nothing here is
// fatal.

const fs = require("node:fs");
const path = require("node:path");
const { isWinAnsiChar } = require("./pdf-fold");

const DEBIAN_DIRS = ["/usr/share/fonts/truetype/noto", "/usr/share/fonts/opentype/noto"];

// First readable name wins. Naskh is the other Arabic design in
// fonts-noto-core, fine if someone only copied that one across.
const FILE_NAMES = {
  sans: {
    regular: ["NotoSans-Regular.ttf"],
    bold: ["NotoSans-Bold.ttf"],
    italic: ["NotoSans-Italic.ttf"],
  },
  arabic: {
    regular: ["NotoSansArabic-Regular.ttf", "NotoNaskhArabic-Regular.ttf"],
    bold: ["NotoSansArabic-Bold.ttf", "NotoNaskhArabic-Bold.ttf"],
  },
  hebrew: {
    regular: ["NotoSansHebrew-Regular.ttf"],
    bold: ["NotoSansHebrew-Bold.ttf"],
  },
  cjk: {
    regular: ["NotoSansCJK-Regular.ttc"],
    bold: ["NotoSansCJK-Bold.ttc"],
  },
};

const SANS_ENV = { regular: "PDF_FONT_REGULAR", bold: "PDF_FONT_BOLD", italic: "PDF_FONT_ITALIC" };
const REGIONS = ["SC", "TC", "HK", "JP", "KR"];
const STANDARD = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique" };

function fontDirs(env) {
  const raw = String(env.PDF_FONT_DIR || "").trim();
  if (!raw) return DEBIAN_DIRS;
  if (raw.toLowerCase() === "none") return [];
  return raw.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

function cjkDefaultRegion(env = process.env) {
  const r = String(env.PDF_FONT_CJK_REGION || "").trim().toUpperCase();
  return REGIONS.includes(r) ? r : "SC";
}

function isReadable(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// { slot: { regular, bold, italic } } of file paths or null. Pure apart
// from `readable`, which the tests swap for a fake file list.
function findFontFiles({ env = process.env, readable = isReadable, warn = console.warn } = {}) {
  const dirs = fontDirs(env);
  const files = {};
  for (const [slot, styles] of Object.entries(FILE_NAMES)) {
    files[slot] = { regular: null, bold: null, italic: null };
    for (const [style, names] of Object.entries(styles)) {
      search: for (const name of names) {
        for (const dir of dirs) {
          const p = path.join(dir, name);
          if (readable(p)) { files[slot][style] = p; break search; }
        }
      }
    }
  }

  // Hand-picked sans files replace the discovered ones as a set, so a box
  // that pointed PDF_FONT_REGULAR at one wide font doesn't suddenly get a
  // Noto bold next to it. Same rules as before: bold and italic fall back
  // to the regular file.
  if (env.PDF_FONT_REGULAR) {
    const picked = {};
    for (const [style, key] of Object.entries(SANS_ENV)) {
      if (!env[key]) continue;
      if (readable(env[key])) picked[style] = env[key];
      else warn(`[pdf] ${key} (${env[key]}) isn't readable, ignoring it`);
    }
    if (picked.regular) files.sans = { regular: picked.regular, bold: picked.bold || null, italic: picked.italic || null };
  }

  for (const slot of Object.values(files)) {
    slot.bold = slot.bold || slot.regular;
    slot.italic = slot.italic || slot.regular;
  }
  return files;
}

// Which face of a collection to use. faces are { postscriptName,
// familyName, subfamilyName }; returns an index, or -1 for an empty list.
// Region first (NotoSansCJKsc-Regular, or a family ending "CJK SC"), then
// not the Mono variant, then the weight. Faces whose names start with a
// dot are system-private (macOS has a few) and only used as a last resort.
function pickFace(faces, region = "SC", style = "regular") {
  const r = String(region).toLowerCase();
  const byRegion = new RegExp(`^NotoSans(Mono)?CJK${r}-`, "i");
  const familyRegion = new RegExp(`CJK ${r}$`, "i");
  const exact = style === "bold" ? /^bold$/i : /^regular$/i;
  const near = style === "bold" ? /bold/i : /book|normal|roman/i;
  let best = -1;
  let bestScore = -Infinity;
  faces.forEach((f, i) => {
    const ps = String(f.postscriptName || "");
    const family = String(f.familyName || "");
    const weights = [String(f.subfamilyName || ""), ps.split("-").pop()];
    let score = 0;
    if (ps.startsWith(".") || family.startsWith(".")) score -= 16;
    if (byRegion.test(ps) || familyRegion.test(family)) score += 4;
    if (!/mono/i.test(`${ps} ${family}`)) score += 2;
    if (weights.some((w) => exact.test(w))) score += 1;
    else if (weights.some((w) => near.test(w))) score += 0.5;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

// fontkit comes with PDFKit and isn't a dependency of ours, so ask for the
// copy PDFKit itself resolves. It's the same parser that will embed the
// font, so the coverage answers below match what gets drawn.
let fontkit;
function loadFontkit() {
  if (!fontkit) {
    fontkit = require(require.resolve("fontkit", { paths: [path.dirname(require.resolve("pdfkit"))] }));
  }
  return fontkit;
}

// The CJK collections are ~20MB each. Read once and handed to every
// document as a Buffer, instead of PDFKit re-reading the file per PDF.
const buffers = new Map();
function readBuffer(file) {
  let buf = buffers.get(file);
  if (!buf) { buf = fs.readFileSync(file); buffers.set(file, buf); }
  return buf;
}

// A font the planner can use and the document can register:
// { key, file, face, buffer, has(cp) }, or for Helvetica
// { key, standard: true, name, has(cp) }.
function openFont(file, region, style) {
  const buffer = readBuffer(file);
  const top = loadFontkit().create(buffer);
  let font = top;
  let face = null;
  if (Array.isArray(top.fonts)) {
    const all = top.fonts;
    const i = pickFace(all.map((f) => ({
      postscriptName: String(f.postscriptName || ""),
      familyName: String(f.familyName || ""),
      subfamilyName: String(f.subfamilyName || ""),
    })), region || cjkDefaultRegion(), style);
    if (i < 0) throw new Error("empty font collection");
    font = all[i];
    face = String(font.postscriptName);
  }
  return {
    key: face ? `${file}#${face}` : file,
    file, face, buffer,
    has: (cp) => font.hasGlyphForCodePoint(cp),
  };
}

let files;          // findFontFiles(), once
const opened = new Map();   // file|region|style -> font or null
const byKey = new Map();    // one object per face, so the planner can compare fonts with ===
const standard = {};
const warned = new Set();

function table() {
  if (!files) {
    files = findFontFiles();
    // One line on the first PDF, so whoever just ran apt install can see
    // it took. Silent when nothing's there, which is the default.
    const found = Object.entries(files).filter(([, s]) => s.regular);
    if (found.length) {
      const missing = Object.keys(files).filter((slot) => !files[slot].regular);
      console.log(`[pdf] fonts: ${found.map(([slot, s]) => `${slot} ${path.basename(s.regular)}`).join(", ")}`
        + (missing.length ? `; none for ${missing.join(", ")}, folded instead` : ""));
    }
  }
  return files;
}

function load(file, region, style) {
  const id = `${file}|${region || ""}|${style}`;
  if (opened.has(id)) return opened.get(id);
  let font = null;
  try {
    font = openFont(file, region, style);
    font = byKey.get(font.key) || (byKey.set(font.key, font), font);
  } catch (err) {
    if (!warned.has(file)) {
      warned.add(file);
      console.warn(`[pdf] couldn't load ${file} (${err.message}), text it would draw is folded instead`);
    }
  }
  opened.set(id, font);
  return font;
}

function standardFont(style) {
  const name = STANDARD[style] || STANDARD.regular;
  if (!standard[name]) standard[name] = { key: name, standard: true, name, has: isWinAnsiChar };
  return standard[name];
}

// The base font for a style: Noto Sans (or the hand-picked file), else
// the Helvetica PDFKit has built in.
function baseFont(style = "regular") {
  const file = table().sans[style] || table().sans.regular;
  return (file && load(file, null, style)) || standardFont(style);
}

// A script's own font, or null when there isn't one.
function slotFont(slot, style = "regular", region = cjkDefaultRegion()) {
  const entry = table()[slot];
  const file = entry && (entry[style] || entry.regular);
  if (!file) return null;
  return load(file, slot === "cjk" ? region : null, style);
}

// What lib/pdf-scripts wants: { base, font(slot, region) }.
function provider(style = "regular") {
  return {
    base: baseFont(style),
    font: (slot, region) => slotFont(slot, style, region),
  };
}

// Is there any Unicode font at all? Without one, lib/pdf-document keeps
// the plain Helvetica path it always had.
function anyFontFile() {
  return Object.values(table()).some((s) => s.regular || s.bold || s.italic);
}

module.exports = {
  findFontFiles, pickFace, provider, baseFont, slotFont, anyFontFile, cjkDefaultRegion,
  fontFiles: () => table(),
  DEBIAN_DIRS, FILE_NAMES,
  // For tests: forget what was found after changing the env.
  _resetForTest: () => { files = undefined; opened.clear(); byKey.clear(); warned.clear(); buffers.clear(); },
};
