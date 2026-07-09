// i18n parity gate.
//
// This test fails the build when any commit adds new keys to
// src/locales/en.json without also adding translations for them
// to every other supported locale. It exists because adding new
// UI strings during feature work is so frequent that "I'll
// translate them later" has, historically, meant "they ship in
// English in 24 languages forever."
//
// The contract:
//
//   * Every locale must have EVERY key that en.json has. Missing
//     keys are a hard failure.
//   * The locale's value SHOULD differ from en.json's value
//     (otherwise it's still English). A tolerance budget is
//     allowed because some strings are universal cognates
//     ("OK", "DD", "Status", proper nouns) or — in the case of
//     tl (Filipino) — intentional English code-mix for technical
//     UI labels. The tolerance limits below match the documented
//     intent.
//   * Every {placeholder} in a translation MUST match en.json's
//     placeholder set verbatim. A reordered or renamed placeholder
//     is a hard failure (vue-i18n would render it as broken text
//     at runtime).
//
// When the english-stuck subtest fails because you added new keys:
//
//   1. DO the translations. Don't bump the tolerance.
//   2. Three valid paths — pick whichever fits the moment:
//      (a) Claude in chat translates the new keys inline. Works
//          without any API key; produces the same diving-domain
//          vocabulary established in each locale; lands in the
//          same commit as the keys. Best for "I just added 5 new
//          strings while building feature X."
//      (b) `npm run translate -- --locales <list>` — batch tool,
//          supports both Anthropic (`ANTHROPIC_API_KEY=sk-…`) and
//          OpenAI (`OPENAI_API_KEY=sk-…`) providers, auto-detected
//          from env. Best for refreshing many locales after
//          several commits have accumulated stuck keys, or for
//          federations self-hosting who want to manage their own
//          translations without a Claude session in the loop.
//      (c) Let the deploy-time background translator handle it.
//          deploy.sh runs the translator AFTER the health check
//          (fire-and-forget) and auto-commits the result; English
//          placeholders are tolerated for the brief window between
//          push and translator completion. To allow a deploy to
//          proceed with stuck keys, set SKIP_I18N_STUCK_CHECK=1
//          when invoking npm run test:safe (deploy.sh does this).
//          The other three subtests in this file (structural
//          parity, no-extras, placeholder integrity) still run,
//          since those would render brokenly at runtime.
//
// The tolerance budget is intentionally tight so it can't drift
// upward silently. Bump it in this file only with a comment
// explaining what specifically pushed past the limit and why.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const SOURCE = "en";

// 25 supported locales (en is the source). Must match the
// SUPPORTED_LOCALES list in src/i18n/index.js. Updating that list
// requires updating this one too — there is no reflective import
// because src/i18n/index.js pulls in Vue-side modules a Node test
// can't load without a bundler.
const LOCALES = [
  "es", "fr", "de", "it", "pt", "pl", "cs",
  "ru", "uk",
  "fi", "sv", "da", "no", "hu",
  "hr", "sr",
  "zh", "ja", "ko",
  "id", "ms", "tl",
  "ar", "tr", "el",
];

// Tolerance budget per locale: maximum number of keys whose
// value is allowed to equal the English source. Anything beyond
// this means new English strings were added without translation.
//
// Most locales: 30. Covers the long-tail of true cognates ("OK",
// "DD", "Status", "Admin", "Branding", proper nouns like
// "Daktronics" / "OBS Studio", placeholder-only strings like
// "—" / "↔" / "{start} – {end}").
//
// tl (Tagalog): 40. Filipino sport coverage uses natural English
// code-mix for technical UI labels (Round, Meet, Event, DD,
// Code, Dashboard, Inbox, Coach, Diver, Judge, Manager, etc.).
// Intentional — see docs/privacy-policy.md §6 + previous translation
// commits where this was documented.
const STUCK_TOLERANCE = Object.fromEntries(LOCALES.map(code => [
  code, code === "tl" ? 40 : 30,
]));

// ---- helpers ---------------------------------------------------

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function leaves(obj, prefix = []) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, leaves(v, [...prefix, k]));
    } else {
      out[[...prefix, k].join(".")] = v;
    }
  }
  return out;
}

function placeholders(s) {
  return [...String(s).matchAll(/\{[\w'@]+\}/g)]
    .map(m => m[0])
    .sort()
    .join(",");
}

// Load source dictionary once, share across the per-locale tests
// below so we're not re-parsing en.json N times.
const enLeaves = leaves(loadJson(path.join(LOCALES_DIR, `${SOURCE}.json`)));
const enKeys = Object.keys(enLeaves);

// ---- structural parity ----------------------------------------

test("every locale has every key from en.json", () => {
  const missing = {};
  for (const code of LOCALES) {
    const t = leaves(loadJson(path.join(LOCALES_DIR, `${code}.json`)));
    const gaps = enKeys.filter(k => !(k in t));
    if (gaps.length) missing[code] = gaps;
  }
  assert.deepEqual(missing, {},
    "Locales with missing keys (run the translator or hand-translate):\n" +
    Object.entries(missing).map(([code, keys]) =>
      `  ${code}: ${keys.length} missing — first 3: ${keys.slice(0, 3).join(", ")}`
    ).join("\n"));
});

test("no locale has extra keys not in en.json", () => {
  const extras = {};
  for (const code of LOCALES) {
    const t = leaves(loadJson(path.join(LOCALES_DIR, `${code}.json`)));
    const extra = Object.keys(t).filter(k => !(k in enLeaves));
    if (extra.length) extras[code] = extra;
  }
  assert.deepEqual(extras, {},
    "Locales with keys NOT in en.json — either the source dropped a key " +
    "(remove from these locales too) or a translator added one out of band:\n" +
    Object.entries(extras).map(([code, keys]) =>
      `  ${code}: ${keys.slice(0, 5).join(", ")}`
    ).join("\n"));
});

// ---- placeholder integrity ------------------------------------

test("placeholders in every translation match en.json verbatim", () => {
  const enPh = Object.fromEntries(Object.entries(enLeaves).map(
    ([k, v]) => [k, placeholders(v)],
  ));
  const mismatches = [];
  for (const code of LOCALES) {
    const t = leaves(loadJson(path.join(LOCALES_DIR, `${code}.json`)));
    for (const [k, v] of Object.entries(t)) {
      if (!(k in enPh)) continue;  // extras already caught above
      const got = placeholders(v);
      if (got !== enPh[k]) {
        mismatches.push(`  ${code}.${k}: en=[${enPh[k]}] but locale=[${got}]`);
      }
    }
  }
  assert.equal(mismatches.length, 0,
    "Placeholder mismatches (vue-i18n will render these as broken):\n" +
    mismatches.slice(0, 20).join("\n") +
    (mismatches.length > 20 ? `\n  ... and ${mismatches.length - 20} more` : ""));
});

// ---- english-stuck guard --------------------------------------
//
// Skipped when SKIP_I18N_STUCK_CHECK=1. deploy.sh sets this env
// var when running npm run test:safe, because the deploy-time
// background translator fills in stuck keys post-deploy (see
// section 8 of deploy.sh). The other three parity subtests still
// run — those guard runtime correctness, not UX quality.

test("english-stuck key count is within tolerance for every locale", {
  skip: process.env.SKIP_I18N_STUCK_CHECK === '1'
    ? 'SKIP_I18N_STUCK_CHECK=1 — deploy.sh defers to background translator'
    : false,
}, () => {
  const overBudget = [];
  for (const code of LOCALES) {
    const t = leaves(loadJson(path.join(LOCALES_DIR, `${code}.json`)));
    let stuck = 0;
    const stuckSample = [];
    for (const k of enKeys) {
      if (enLeaves[k] === t[k]) {
        stuck++;
        if (stuckSample.length < 5) stuckSample.push(k);
      }
    }
    const limit = STUCK_TOLERANCE[code];
    if (stuck > limit) {
      overBudget.push(
        `  ${code}: ${stuck} stuck (limit ${limit}) — ` +
        `first 5: ${stuckSample.join(", ")}`,
      );
    }
  }
  assert.equal(overBudget.length, 0,
    "Locales with too many English-stuck keys. Translate the new keys " +
    "(don't raise the limit):\n" + overBudget.join("\n"));
});
