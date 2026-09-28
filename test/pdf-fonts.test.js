// lib/pdf-fonts: finding the per-script font files and picking a face out
// of the CJK collection. DB-less. Discovery runs against a fake file list
// (there are no Noto files on a dev Mac and the tests mustn't need any);
// the loading tests use a garbage file and, when the Mac has it, a system
// collection standing in for Noto Sans CJK.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findFontFiles, pickFace, DEBIAN_DIRS, cjkDefaultRegion } = require("../lib/pdf-fonts");

const CORE = "/usr/share/fonts/truetype/noto";
const CJK = "/usr/share/fonts/opentype/noto";

// Every file fonts-noto-core and fonts-noto-cjk install that we look for,
// at the paths packages.debian.org lists for bookworm and trixie.
const DEBIAN = [
  `${CORE}/NotoSans-Regular.ttf`, `${CORE}/NotoSans-Bold.ttf`, `${CORE}/NotoSans-Italic.ttf`,
  `${CORE}/NotoSansArabic-Regular.ttf`, `${CORE}/NotoSansArabic-Bold.ttf`,
  `${CORE}/NotoNaskhArabic-Regular.ttf`, `${CORE}/NotoNaskhArabic-Bold.ttf`,
  `${CORE}/NotoSansHebrew-Regular.ttf`, `${CORE}/NotoSansHebrew-Bold.ttf`,
  `${CJK}/NotoSansCJK-Regular.ttc`, `${CJK}/NotoSansCJK-Bold.ttc`,
];

const find = (list, env = {}) => {
  const warnings = [];
  const files = findFontFiles({ env, readable: (p) => list.includes(p), warn: (m) => warnings.push(m) });
  return { files, warnings };
};

test("the Debian package paths are the default", () => {
  assert.deepEqual(DEBIAN_DIRS, [CORE, CJK]);
  const { files } = find(DEBIAN);
  assert.deepEqual(files.sans, {
    regular: `${CORE}/NotoSans-Regular.ttf`, bold: `${CORE}/NotoSans-Bold.ttf`, italic: `${CORE}/NotoSans-Italic.ttf`,
  });
  assert.equal(files.arabic.regular, `${CORE}/NotoSansArabic-Regular.ttf`, "Sans before Naskh");
  assert.equal(files.arabic.italic, files.arabic.regular, "no italic Arabic, the regular stands in");
  assert.equal(files.hebrew.bold, `${CORE}/NotoSansHebrew-Bold.ttf`);
  assert.equal(files.cjk.regular, `${CJK}/NotoSansCJK-Regular.ttc`);
  assert.equal(files.cjk.bold, `${CJK}/NotoSansCJK-Bold.ttc`);
});

test("only fonts-noto-core installed: CJK is simply missing", () => {
  const { files } = find(DEBIAN.filter((p) => p.startsWith(CORE)));
  assert.equal(files.cjk.regular, null);
  assert.equal(files.cjk.bold, null);
  assert.ok(files.sans.regular);
});

test("nothing installed: every slot is empty", () => {
  const { files } = find([]);
  for (const slot of Object.values(files)) assert.deepEqual(slot, { regular: null, bold: null, italic: null });
});

test("PDF_FONT_DIR replaces the default directories", () => {
  const mine = ["/srv/fonts/NotoSans-Regular.ttf", "/opt/cjk/NotoSansCJK-Regular.ttc"];
  const { files } = find([...mine, ...DEBIAN], { PDF_FONT_DIR: "/srv/fonts:/opt/cjk" });
  assert.equal(files.sans.regular, mine[0]);
  assert.equal(files.sans.bold, mine[0], "bold falls back to the regular file");
  assert.equal(files.cjk.regular, mine[1]);
  assert.equal(files.arabic.regular, null, "the Debian dirs aren't searched any more");

  const off = find(DEBIAN, { PDF_FONT_DIR: "none" }).files;
  assert.equal(off.sans.regular, null, "none switches discovery off");
});

test("PDF_FONT_REGULAR / BOLD / ITALIC still pick the sans files, as a set", () => {
  const wide = "/fonts/Wide.ttf";
  const { files } = find([wide, ...DEBIAN], { PDF_FONT_REGULAR: wide });
  assert.deepEqual(files.sans, { regular: wide, bold: wide, italic: wide },
    "no Noto bold sneaking in next to a hand-picked regular");
  assert.equal(files.cjk.regular, `${CJK}/NotoSansCJK-Regular.ttc`, "other scripts still come from the dirs");

  const all = find(["/f/R.ttf", "/f/B.ttf", "/f/I.ttf"], {
    PDF_FONT_REGULAR: "/f/R.ttf", PDF_FONT_BOLD: "/f/B.ttf", PDF_FONT_ITALIC: "/f/I.ttf", PDF_FONT_DIR: "none",
  }).files;
  assert.deepEqual(all.sans, { regular: "/f/R.ttf", bold: "/f/B.ttf", italic: "/f/I.ttf" });
});

test("an unreadable PDF_FONT_REGULAR warns and leaves discovery alone", () => {
  const { files, warnings } = find(DEBIAN, { PDF_FONT_REGULAR: "/nope.ttf" });
  assert.equal(files.sans.regular, `${CORE}/NotoSans-Regular.ttf`);
  assert.match(warnings.join("\n"), /PDF_FONT_REGULAR \(\/nope\.ttf\) isn't readable/);
});

test("PDF_FONT_CJK_REGION picks the Han default, SC unless it's a known region", () => {
  assert.equal(cjkDefaultRegion({}), "SC");
  assert.equal(cjkDefaultRegion({ PDF_FONT_CJK_REGION: "tc" }), "TC");
  assert.equal(cjkDefaultRegion({ PDF_FONT_CJK_REGION: "JP" }), "JP");
  assert.equal(cjkDefaultRegion({ PDF_FONT_CJK_REGION: "XX" }), "SC");
});

// The faces of Debian's NotoSansCJK-Regular.ttc: five regions, each with a
// Mono twin.
const NOTO_CJK = ["JP", "KR", "SC", "TC", "HK"].flatMap((r) => [
  { postscriptName: `NotoSansCJK${r.toLowerCase()}-Regular`, familyName: `Noto Sans CJK ${r}`, subfamilyName: "Regular" },
  { postscriptName: `NotoSansMonoCJK${r.toLowerCase()}-Regular`, familyName: `Noto Sans Mono CJK ${r}`, subfamilyName: "Regular" },
]);

test("pickFace finds the region's proportional face in the Noto CJK collection", () => {
  for (const r of ["SC", "TC", "HK", "JP", "KR"]) {
    assert.equal(NOTO_CJK[pickFace(NOTO_CJK, r)].postscriptName, `NotoSansCJK${r.toLowerCase()}-Regular`);
  }
  const monoFirst = [...NOTO_CJK].reverse();
  assert.equal(monoFirst[pickFace(monoFirst, "KR")].postscriptName, "NotoSansCJKkr-Regular", "never the Mono twin");
});

test("pickFace takes the right weight from an all-weights collection", () => {
  const weights = ["Thin", "Light", "Regular", "Medium", "Bold", "Black"].map((w) => ({
    postscriptName: `NotoSansCJKjp-${w}`, familyName: "Noto Sans CJK JP", subfamilyName: w,
  }));
  assert.equal(weights[pickFace(weights, "JP", "regular")].postscriptName, "NotoSansCJKjp-Regular");
  assert.equal(weights[pickFace(weights, "JP", "bold")].postscriptName, "NotoSansCJKjp-Bold");
});

test("pickFace copes with a collection that isn't Noto", () => {
  // macOS's Hiragino Sans GB, as fontkit reports it.
  const hiragino = [
    { postscriptName: "HiraginoSansGB-W3", familyName: "Hiragino Sans GB W3", subfamilyName: "Regular" },
    { postscriptName: ".HiraginoSansGBInterface-W3", familyName: ".Hiragino Sans GB Interface W3", subfamilyName: "Regular" },
    { postscriptName: "HiraginoSansGB-W6", familyName: "Hiragino Sans GB W6", subfamilyName: "Bold" },
  ];
  assert.equal(pickFace(hiragino, "SC", "regular"), 0);
  assert.equal(pickFace(hiragino, "SC", "bold"), 2);
  assert.equal(pickFace([], "SC"), -1);
});

// The loading half goes through the real module state, so these reset it
// around themselves.
function withFontDir(dir, fn) {
  const pdfFonts = require("../lib/pdf-fonts");
  const saved = { dir: process.env.PDF_FONT_DIR, reg: process.env.PDF_FONT_REGULAR };
  process.env.PDF_FONT_DIR = dir;
  delete process.env.PDF_FONT_REGULAR;
  pdfFonts._resetForTest();
  try {
    return fn(pdfFonts);
  } finally {
    if (saved.dir === undefined) delete process.env.PDF_FONT_DIR; else process.env.PDF_FONT_DIR = saved.dir;
    if (saved.reg !== undefined) process.env.PDF_FONT_REGULAR = saved.reg;
    pdfFonts._resetForTest();
  }
}

test("a broken font file is skipped with a warning, not a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-fonts-"));
  fs.writeFileSync(path.join(dir, "NotoSansHebrew-Regular.ttf"), "not a font at all");
  const warn = console.warn;
  const seen = [];
  console.warn = (m) => seen.push(String(m));
  try {
    withFontDir(dir, (pdfFonts) => {
      assert.equal(pdfFonts.anyFontFile(), true, "the file is there");
      assert.equal(pdfFonts.slotFont("hebrew", "regular"), null, "but it doesn't load");
      assert.equal(pdfFonts.baseFont("bold").key, "Helvetica-Bold", "no sans file, Helvetica it is");
    });
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(seen.join("\n"), /couldn't load .*NotoSansHebrew-Regular\.ttf/);
});

// Optional: a real collection, if this machine has one. macOS ships
// Hiragino Sans GB as a CFF-flavoured TTC, the same kind of file as Noto
// Sans CJK. Skips anywhere else (CI, the Debian box).
const HIRAGINO = "/System/Library/Fonts/Hiragino Sans GB.ttc";
test("a real TTC loads the chosen face and answers coverage", { skip: !fs.existsSync(HIRAGINO) && "no Hiragino Sans GB here" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dhq-fonts-"));
  fs.symlinkSync(HIRAGINO, path.join(dir, "NotoSansCJK-Regular.ttc"));
  try {
    withFontDir(dir, (pdfFonts) => {
      const regular = pdfFonts.slotFont("cjk", "regular", "SC");
      const bold = pdfFonts.slotFont("cjk", "bold", "SC");
      assert.equal(regular.face, "HiraginoSansGB-W3");
      assert.equal(bold.face, "HiraginoSansGB-W6", "bold falls back to the regular file, bold face");
      assert.equal(regular.has("李".codePointAt(0)), true);
      assert.equal(regular.has("ก".codePointAt(0)), false);
      assert.equal(pdfFonts.slotFont("cjk", "regular", "SC"), regular, "one object per face");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
