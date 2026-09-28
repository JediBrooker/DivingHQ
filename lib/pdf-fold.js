// lib/pdf-fold.js: making text safe for PDFKit's built-in Helvetica.
//
// Helvetica only covers WinAnsi (roughly Latin-1). Whatever the PDF can't
// draw in a real font gets folded here: accents outside WinAnsi are
// dropped (Ł to L, ś to s), Cyrillic and Greek are transliterated, and
// anything left (CJK, Arabic, Hebrew) prints as "?" rather than garbage.
//
// lib/pdf-document.js used to hold this. It moved out so the per-script
// run planner (lib/pdf-scripts.js) can fold just the runs no font covers,
// not the whole string.

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


module.exports = { winAnsiSafe, isWinAnsi, isWinAnsiChar };
