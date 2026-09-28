// lib/pdf-document: what the PDF exports do with text Helvetica can't
// print. With no Unicode font configured (the default, and this test's
// environment), names are folded to WinAnsi and translated headers fall
// back to English, instead of printing mojibake. DB-less.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

delete process.env.PDF_FONT_REGULAR;
const { winAnsiSafe, isWinAnsi, pdfTranslate, createPdfDocument, _resetFontsForTest } = require("../lib/pdf-document");
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

test("createPdfDocument writes the folded name into the page", async () => {
  const doc = createPdfDocument({ margin: 50, size: "A4" });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((r) => doc.on("end", r));
  doc.font("Helvetica-Bold").text("Łukasz Иванов");
  doc.end();
  await done;
  const raw = Buffer.concat(chunks).toString("latin1");
  const drawn = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body;
    try { body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { continue; }
    for (const tj of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      drawn.push([...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
    }
  }
  assert.ok(drawn.join("\n").includes("Lukasz Ivanov"), drawn.join("\n"));
});
