// lib/pdf-scripts: cutting a string into runs, one per font, and laying
// right-to-left stretches out the way a reader expects. DB-less, and no
// font files: every font here is a fake { key, has(codePoint) } built
// from code point ranges, so the rules are tested apart from what any
// real font happens to contain.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  scriptOf, cjkRegion, logicalRuns, planPieces, canPrint, SCRIPTS,
} = require("../lib/pdf-scripts");
const { isWinAnsiChar } = require("../lib/pdf-fold");

const fake = (key, ...ranges) => ({ key, has: (cp) => ranges.some(([a, b]) => cp >= a && cp <= b) });

// Roughly what the Noto files cover: Noto Sans has Latin, Cyrillic, Greek
// and the usual punctuation; the others have their own script and a space.
const sans = fake("sans", [0x20, 0x7e], [0xa0, 0x52f], [0x1e00, 0x1fff], [0x2000, 0x206f], [0x20ac, 0x20ac]);
const arabic = fake("arabic", [0x20, 0x20], [0x600, 0x6ff], [0xfe70, 0xfeff]);
const hebrew = fake("hebrew", [0x20, 0x20], [0x590, 0x5ff]);
const cjk = {};
for (const r of ["SC", "TC", "HK", "JP", "KR"]) {
  cjk[r] = fake(`cjk-${r}`, [0x20, 0x7e], [0x3000, 0x9fff], [0xac00, 0xd7af], [0xff00, 0xffef]);
}
const helvetica = { key: "Helvetica", has: isWinAnsiChar };

// A provider as lib/pdf-fonts builds one: a base font and a lookup per
// slot. `slots` says which script fonts are "installed".
function provider(base, slots = {}) {
  const asked = [];
  return {
    asked,
    base,
    font(slot, region) {
      asked.push(`${slot}:${region}`);
      const f = slots[slot];
      return typeof f === "function" ? f(region) : f || null;
    },
  };
}
const everything = () => provider(sans, { arabic, hebrew, cjk: (r) => cjk[r] });
const nothing = () => provider(helvetica);

const show = (pieces) => pieces.map((p) => `${p.font.key}${p.rtl ? "<" : ""}${p.solo ? "!" : ""}:${p.text}`);
const plan = (text, prov) => show(planPieces(text, prov, cjkRegion(text)));

test("scripts are sorted into the slots the fonts come in", () => {
  const s = (ch) => scriptOf(ch.codePointAt(0));
  assert.equal(s("A"), SCRIPTS.SANS);
  assert.equal(s("Ł"), SCRIPTS.SANS);
  assert.equal(s("Ж"), SCRIPTS.SANS);
  assert.equal(s("Ω"), SCRIPTS.SANS);
  assert.equal(s("ễ"), SCRIPTS.SANS, "Vietnamese is Latin Extended Additional");
  assert.equal(s("م"), SCRIPTS.ARABIC);
  assert.equal(s("ש"), SCRIPTS.HEBREW);
  assert.equal(s("李"), SCRIPTS.HAN);
  assert.equal(s("𠀋"), SCRIPTS.HAN, "astral ideographs too");
  assert.equal(s("は"), SCRIPTS.KANA);
  assert.equal(s("ｶ"), SCRIPTS.KANA, "halfwidth katakana");
  assert.equal(s("김"), SCRIPTS.HANGUL);
  assert.equal(s("、"), SCRIPTS.CJK);
  assert.equal(s("7"), SCRIPTS.COMMON);
  assert.equal(s(" "), SCRIPTS.COMMON);
  assert.equal(s("́"), SCRIPTS.MARK);
  assert.equal(s("‏"), SCRIPTS.FORMAT);
  assert.equal(s("ก"), SCRIPTS.OTHER, "Thai has no slot");
});

test("the CJK face follows the string: kana is Japanese, Hangul Korean", () => {
  assert.equal(cjkRegion("山田はなこ"), "JP");
  assert.equal(cjkRegion("김연아"), "KR");
  assert.equal(cjkRegion("李娜"), "SC");
  assert.equal(cjkRegion("李娜", "TC"), "TC", "PDF_FONT_CJK_REGION sets the Han default");
  assert.equal(cjkRegion("Ivan"), "SC");

  const p = everything();
  planPieces("山田はなこ", p, cjkRegion("山田はなこ"));
  assert.deepEqual([...new Set(p.asked)], ["cjk:JP"], "the kanji ride with the kana");
  const q = everything();
  planPieces("李娜 김연아", q, "SC");
  assert.deepEqual([...new Set(q.asked)].sort(), ["cjk:KR", "cjk:SC"], "Hangul is Korean whatever the string says");
});

test("each script goes out in its own font, punctuation in the base font", () => {
  const p = everything();
  assert.deepEqual(plan("Ivan Petrov", p), ["sans:Ivan Petrov"]);
  assert.deepEqual(plan("Иван Петров", p), ["sans:Иван Петров"]);
  assert.deepEqual(plan("李娜 (CHN)", p), ["cjk-SC:李娜", "sans: (CHN)"]);
  assert.deepEqual(plan("山田はなこ JPN", p), ["cjk-JP:山田はなこ", "sans: JPN"]);
  assert.deepEqual(plan("김연아", p), ["cjk-KR:김연아"]);
  assert.deepEqual(plan("Kubok 李娜 Cup", p), ["sans:Kubok ", "cjk-SC:李娜", "sans: Cup"]);
});

test("a symbol the base font lacks is borrowed from a script font, whatever sits next to it", () => {
  // ① is a common symbol, not CJK, but here only the CJK font has it.
  const withSymbol = provider(sans, {
    arabic,
    cjk: fake("cjk-SC", [0x20, 0x7e], [0x2460, 0x2460], [0x3000, 0x9fff]),
  });
  assert.deepEqual(plan("李①", withSymbol), ["cjk-SC:李①"]);
  // Same font on its own or next to Arabic: the line wrapper measures
  // word by word, so the answer can't depend on the neighbours.
  assert.deepEqual(plan("①", withSymbol), ["cjk-SC:①"]);
  assert.deepEqual(plan("Ab ①", withSymbol), ["sans:Ab ", "cjk-SC:①"]);
  // The ideographic comma is CJK punctuation, so it wants that font anyway.
  assert.deepEqual(plan("李、娜", everything()), ["cjk-SC:李、娜"]);
});

test("with no font for a script, that run folds exactly as before", () => {
  const coreOnly = provider(sans, { arabic, hebrew }); // fonts-noto-core without fonts-noto-cjk
  assert.deepEqual(plan("李娜 (CHN)", coreOnly), ["sans:?? (CHN)"]);
  assert.deepEqual(plan("Иван 李", coreOnly), ["sans:Иван ?"], "Cyrillic keeps its own letters");

  const none = nothing();
  assert.deepEqual(plan("Иван Петров", none), ["Helvetica:Ivan Petrov"]);
  assert.deepEqual(plan("Γιώργος Παπαδόπουλος", none), ["Helvetica:Giorgos Papadopoulos"], "ου still reads ou");
  assert.deepEqual(plan("Łukasz 李娜 محمد", none), ["Helvetica:Lukasz ?? ????"]);
  assert.deepEqual(plan("Jiří", none), ["Helvetica:Jirí"]);
});

test("only CJK installed: Latin-extended and Cyrillic still fold in Helvetica", () => {
  const cjkOnly = provider(helvetica, { cjk: (r) => cjk[r] });
  assert.deepEqual(plan("Łukasz 李娜", cjkOnly), ["Helvetica:Lukasz ", "cjk-SC:李娜"]);
  assert.deepEqual(plan("Иван", cjkOnly), ["Helvetica:Ivan"]);
});

test("a wide base font (one PDF_FONT_REGULAR for everything) still draws what it has", () => {
  const wide = fake("wide", [0x20, 0x7e], [0xa0, 0x52f], [0x600, 0x6ff], [0x4e00, 0x9fff]);
  const p = provider(wide); // no per-script files at all
  assert.deepEqual(plan("李娜 Ivan", p), ["wide:李娜 Ivan"]);
  assert.deepEqual(plan("김연아", p), ["wide:???"], "what it lacks still folds");
  assert.deepEqual(plan("محمد", p), ["wide<:محمد"], "right to left even in the base font");
});

test("a script font missing one glyph hands it to the base font, then folds", () => {
  const thin = fake("cjk-thin", [0x20, 0x7e], [0x674e, 0x674e]); // has 李, not 娜
  const withBase = provider(fake("wide", [0x20, 0x7e], [0x5a1c, 0x5a1c]), { cjk: thin });
  assert.deepEqual(plan("李娜", withBase), ["cjk-thin:李", "wide:娜"]);
  const without = provider(sans, { cjk: thin });
  assert.deepEqual(plan("李娜", without), ["cjk-thin:李", "sans:?"]);
});

test("invisible controls are dropped, marks stay on their letter", () => {
  const p = everything();
  assert.deepEqual(plan("é ‏x", p), ["sans:é x"]);
  assert.deepEqual(plan("é", nothing()), ["Helvetica:e"], "folded with the letter under it");
  const noMarks = provider(fake("sans", [0x20, 0x7e]));
  assert.deepEqual(plan("é", noMarks), ["sans:e"], "a mark nothing draws goes, not a ?");
});

test("right-to-left names read right to left inside a left-to-right line", () => {
  const p = everything();
  // Pieces are listed left to right as drawn. "<" marks a run fontkit
  // shapes and flips itself, so its text stays in logical order.
  assert.deepEqual(plan("محمد", p), ["arabic<:محمد"]);
  assert.deepEqual(plan("محمد علي", p), ["arabic<:علي", "sans: ", "arabic<:محمد"],
    "the first word ends up on the right");
  assert.deepEqual(plan("محمد علي (EGY)", p), ["arabic<:علي", "sans: ", "arabic<:محمد", "sans: (EGY)"]);
  assert.deepEqual(plan("Ali محمد", p), ["sans:Ali ", "arabic<:محمد"]);
  assert.deepEqual(plan("רחל כהן ISR", p), ["hebrew<:כהן", "sans: ", "hebrew<:רחל", "sans: ISR"]);
});

test("numbers inside a right-to-left stretch stay left to right", () => {
  const p = everything();
  assert.deepEqual(plan("فريق 12.5", p), ["sans:12.5 ", "arabic<:فريق"]);
  assert.deepEqual(plan("Cup محمد 2024 X", p), ["sans:Cup 2024 ", "arabic<:محمد", "sans: X"],
    "the number joins the Arabic, the space before X doesn't");
  assert.deepEqual(plan("2024 محمد", p), ["sans:2024 ", "arabic<:محمد"], "a number before it is just LTR");
  // Arabic-Indic digits come from the Arabic font, which fontkit would
  // flip as a run, so they go one at a time.
  assert.deepEqual(plan("بطولة ١٢", p), ["arabic!:١", "arabic!:٢", "sans: ", "arabic<:بطولة"]);
});

test("brackets inside a right-to-left stretch swap sides", () => {
  const p = everything();
  assert.deepEqual(plan("محمد (علي)", p), ["sans:(", "arabic<:علي", "sans:) ", "arabic<:محمد"]);
  assert.deepEqual(plan("(محمد)", p), ["sans:(", "arabic<:محمد", "sans:)"], "at the start they stay put");
});

test("logicalRuns keeps reading order and merges folded text into the base", () => {
  const coreOnly = provider(sans, { arabic, hebrew });
  const runs = logicalRuns("A李B", coreOnly, "SC");
  assert.deepEqual(runs.map((r) => [r.font.key, r.text]), [["sans", "A?B"]]);
});

test("canPrint says whether anything would fold", () => {
  assert.equal(canPrint("Расписание", everything(), "SC"), true);
  assert.equal(canPrint("Расписание", nothing(), "SC"), false);
  assert.equal(canPrint("イベント", provider(sans, { arabic, hebrew }), "JP"), false);
  assert.equal(canPrint("جدول", everything(), "SC"), true);
  assert.equal(canPrint("a‏b", nothing(), "SC"), true, "a dropped control isn't a fold");
});
