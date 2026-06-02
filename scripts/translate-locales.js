#!/usr/bin/env node
//
// translate-locales.js — AI-assisted i18n translation pipeline.
//
// Reads src/locales/en.json (the source of truth) and emits
// translated dictionaries for every other supported locale by
// asking an AI provider to translate the leaf strings, preserving
// JSON structure + ICU MessageFormat placeholders verbatim.
//
// Usage:
//   # OpenAI Responses API (default when OPENAI_API_KEY is set)
//   OPENAI_API_KEY=sk-… node scripts/translate-locales.js --provider openai
//
//   # Pick the model your OpenAI account should use for translation
//   OPENAI_API_KEY=sk-… OPENAI_MODEL=gpt-5-mini node scripts/translate-locales.js
//
//   # Anthropic Messages API (legacy/default when only ANTHROPIC_API_KEY is set)
//   ANTHROPIC_API_KEY=sk-… node scripts/translate-locales.js
//
//   # Limit to specific locales
//   OPENAI_API_KEY=sk-… node scripts/translate-locales.js --provider openai --locales es,fr
//
//   # Don't overwrite — write to .new.json side-files for diff/proofread
//   OPENAI_API_KEY=sk-… node scripts/translate-locales.js --provider openai --diff
//
//   # Dry-run: report what WOULD be translated without making API
//   # calls or writing files. No API key needed.
//   node scripts/translate-locales.js --dry-run --locales fr,de,it
//
// What counts as "needs translation":
//   1. Keys that are entirely absent from a locale file (rare — the
//      seed script copies the en.json structure into every locale).
//   2. Keys whose value EQUALS the English source — i.e. an
//      English placeholder waiting to be translated. The detector
//      treats these as untranslated and re-fills them in the next
//      run.
//
// Anything else (a hand-translated value that happens not to match
// the English) is left alone unless --force is passed.
//
// Design notes:
//
// • We send the WHOLE flattened dictionary in ONE prompt per locale.
//   At <2000 keys this fits comfortably in a single model call,
//   keeps surrounding-key context (so e.g. "Submit" near "Save"
//   gets the right verb tense), and costs ~$0.02 per locale.
//
// • Placeholders ({minutes}, {n}, etc.) are preserved verbatim —
//   we explicitly tell the model not to translate or reorder them.
//
// • The model's JSON output is parsed strictly; any malformed
//   response aborts that locale so a half-translated file never
//   lands in src/locales/.
//
// • Federations who'd rather hand-translate can skip this script
//   and edit the per-locale JSON directly. The script never blows
//   away their work without --force.

const fs = require("fs");
const path = require("path");

// Load .env from the project root so OPENAI_API_KEY / ANTHROPIC_API_KEY
// (and TRANSLATE_PROVIDER, OPENAI_MODEL, etc.) reach process.env when
// this script runs from any directory. Soft-required: if dotenv isn't
// installed the script keeps working — env vars set directly in the
// shell still resolve. dotenv is already a runtime dep of the server
// so the require should always succeed in a working tree.
try {
  const result = require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  // dotenv won't overwrite a var already present in process.env — correct for
  // a deliberately-exported value, but an EMPTY pre-existing var (e.g. a shell
  // profile or sandbox that exports `ANTHROPIC_API_KEY=`) would then shadow a
  // real key in .env and the script would wrongly report the key as missing.
  // Treat blank existing vars as unset and backfill them from the parsed .env;
  // a non-empty exported value still takes precedence.
  const parsed = (result && result.parsed) || {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v && !String(process.env[k] || "").trim()) process.env[k] = v;
  }
} catch { /* dotenv not installed — fall through, shell env still works */ }

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");
const SOURCE_LOCALE = "en";
const TARGET_LANGUAGES = {
  es: "Spanish (Spain — castellano)",
  fr: "French (international)",
  de: "German (standard German, formal Sie)",
  it: "Italian (standard Italian)",
  pt: "Portuguese (European Portuguese — Portugal)",
  pl: "Polish (standard Polish)",
  cs: "Czech (standard Czech, formal vy address)",
  ru: "Russian (standard Russian)",
  uk: "Ukrainian (standard Ukrainian)",
  fi: "Finnish (standard Finnish)",
  sv: "Swedish (rikssvenska)",
  da: "Danish (standard Danish)",
  no: "Norwegian (bokmål)",
  hu: "Hungarian (standard Hungarian)",
  hr: "Croatian (standard Croatian)",
  sr: "Serbian (standard Serbian, Cyrillic script)",
  zh: "Mandarin Chinese (Simplified Chinese, Mainland)",
  ja: "Japanese (standard Japanese, polite -masu form)",
  ko: "Korean (standard Korean, polite -습니다 form)",
  id: "Indonesian (Bahasa Indonesia)",
  ms: "Malay (Bahasa Melayu, Malaysia)",
  tl: "Tagalog (Filipino)",
  ar: "Arabic (Modern Standard Arabic)",
  tr: "Turkish (standard Turkish)",
  el: "Greek (modern Greek)",
};

const args = process.argv.slice(2);
const filterLocales = parseListArg(args, "--locales");
const providerArg = parseValueArg(args, "--provider");
const modelArg = parseValueArg(args, "--model");
const diffMode = args.includes("--diff");
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

async function main() {
  const provider = resolveProvider(providerArg);
  const model = resolveModel(provider, modelArg);
  const apiKey = provider === "openai"
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !dryRun) {
    const envName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    fail(`${envName} env var is required for --provider ${provider}. Use --dry-run to preview without an API key.`);
  }

  const sourceFile = path.join(LOCALES_DIR, `${SOURCE_LOCALE}.json`);
  if (!fs.existsSync(sourceFile)) {
    fail(`Missing source dictionary: ${sourceFile}`);
  }
  const sourceJson = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  console.log(`Source: ${SOURCE_LOCALE}.json (${countLeaves(sourceJson)} strings)`);
  console.log(`Provider: ${provider}${model ? ` (${model})` : ""}`);

  const targets = Object.entries(TARGET_LANGUAGES).filter(([code]) =>
    !filterLocales.length || filterLocales.includes(code));

  for (const [code, languageName] of targets) {
    const outFile = path.join(
      LOCALES_DIR,
      diffMode ? `${code}.new.json` : `${code}.json`,
    );

    if (!diffMode && !force && fs.existsSync(outFile)) {
      // Detect work to do. Two categories:
      //   - missing: key entirely absent from the locale file
      //   - english_stuck: value equals the English source (i.e. a
      //     placeholder waiting to be translated). The seed script
      //     fills every untranslated key with its English value so
      //     the JSON structure stays in sync; this detector picks
      //     those up so re-running the translator on a partly-
      //     hand-translated file finishes the job without nuking
      //     the hand work.
      const existing = safeParse(outFile);
      const missing = findMissingKeys(sourceJson, existing);
      const englishStuck = findEnglishStuckKeys(sourceJson, existing);
      const todo = [...missing, ...englishStuck];
      if (!todo.length) {
        console.log(`✓ ${code}.json — fully translated (${countLeaves(existing)} keys)`);
        continue;
      }
      const note = missing.length && englishStuck.length
        ? `${missing.length} missing + ${englishStuck.length} english-stuck`
        : missing.length
          ? `${missing.length} missing`
          : `${englishStuck.length} english-stuck`;
      if (dryRun) {
        console.log(`  ${code}.json — ${note} (would translate ${todo.length} key(s))`);
        continue;
      }
      console.log(`+ ${code}.json — ${note}, translating just those…`);
      const translated = await translateSubset(sourceJson, todo, code, languageName, {
        provider,
        apiKey,
        model,
      });
      const merged = deepMerge(existing, translated);
      fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + "\n");
      console.log(`✓ ${code}.json — merged ${todo.length} key(s)`);
      continue;
    }

    if (dryRun) {
      console.log(`  ${code}.json — file missing, would translate full ${countLeaves(sourceJson)} keys`);
      continue;
    }
    console.log(`→ Translating ${code} (${languageName})…`);
    const translated = await translateWhole(sourceJson, code, languageName, {
      provider,
      apiKey,
      model,
    });
    fs.writeFileSync(outFile, JSON.stringify(translated, null, 2) + "\n");
    console.log(`✓ ${path.basename(outFile)} — wrote ${countLeaves(translated)} strings`);
  }

  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  console.log(dryRun ? `\nDry-run complete. Re-run without --dry-run (and with ${keyName} set) to execute.` : "\nDone.");
  if (diffMode) {
    console.log("Tip: diff the .new.json files against the current dictionaries");
    console.log("     before promoting them with `mv src/locales/{xx,xx}.new.json src/locales/xx.json`.");
  }
}

async function translateWhole(source, locale, languageName, context) {
  const prompt = [
    `Translate the following JSON dictionary from English into ${languageName}.`,
    ``,
    `Rules:`,
    `1. Preserve the JSON structure EXACTLY — same keys, same nesting.`,
    `2. Translate ONLY the string VALUES, never the keys.`,
    `3. Preserve ALL placeholders verbatim: {n}, {minutes}, {round}, {name}, {event}, {date}, {rounds}, {height}, {total}, etc. Do NOT translate or reorder them.`,
    `4. Preserve emoji and special characters (✓, →, ←, …, ↻, R{round}) verbatim.`,
    `5. Preserve inline HTML tags (<strong>…</strong>, <em>…</em>, <a …>…</a>) verbatim — DO translate the text BETWEEN the tags, but never translate the tag names, attributes, or angle-brackets themselves.`,
    `6. Use the formal/respectful register that fits a sports federation context. In Spanish use second-person plural address (tu/tus) as it reads warmer for an athlete community. In German use the formal Sie form.`,
    `7. Output ONLY the translated JSON object. No prose before or after. No markdown fences.`,
    ``,
    `Source dictionary:`,
    JSON.stringify(source, null, 2),
  ].join("\n");

  const text = await callAiProvider(prompt, context);
  const json = safeJsonParse(text);
  if (!json || typeof json !== "object") {
    fail(`${context.provider} returned malformed JSON for locale ${locale}:\n${text.slice(0, 500)}…`);
  }
  return json;
}

async function translateSubset(source, missingPaths, locale, languageName, context) {
  // Build a minimal subset object containing just the missing
  // paths. Translate that, then merge with the existing dict.
  const subset = {};
  for (const pathArr of missingPaths) {
    setAtPath(subset, pathArr, getAtPath(source, pathArr));
  }
  return translateWhole(subset, locale, languageName, context);
}

async function callAiProvider(prompt, context) {
  if (context.provider === "openai") {
    return callOpenAI(prompt, context.apiKey, context.model);
  }
  return callClaude(prompt, context.apiKey, context.model);
}

async function callOpenAI(prompt, apiKey, model) {
  // Uses the OpenAI Responses API through native fetch so the repo
  // doesn't need an SDK dependency just for translation maintenance.
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  // Validate the base URL against an allowlist so a poisoned .env
  // (or stale shell rc) can't redirect the OPENAI_API_KEY at an
  // attacker-controlled host. https: + openai.com (or localhost
  // for tests / proxies) only. Override the allowlist if you have
  // a legitimate enterprise endpoint via OPENAI_BASE_URL_ALLOW
  // (comma-separated host suffixes).
  validateOpenAIBaseUrl(baseUrl);
  const maxOutputTokens = parsePositiveInt(process.env.TRANSLATE_MAX_TOKENS, 12000);
  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      max_output_tokens: maxOutputTokens,
      text: { format: { type: "json_object" } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`OpenAI API ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = await res.json();
  if (body?.error) {
    fail(`OpenAI API error: ${JSON.stringify(body.error).slice(0, 500)}`);
  }
  const text = extractOpenAIText(body);
  if (!text) {
    fail(`OpenAI API returned no text:\n${JSON.stringify(body).slice(0, 500)}`);
  }
  return text;
}

async function callClaude(prompt, apiKey, model) {
  // Use the public Anthropic messages API. Model picked for cost +
  // quality on short translation tasks. Increase max_tokens if a
  // future dictionary outgrows the default.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: parsePositiveInt(process.env.TRANSLATE_MAX_TOKENS, 8192),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text;
  if (!text) {
    fail(`Anthropic API returned no text:\n${JSON.stringify(body).slice(0, 500)}`);
  }
  return text;
}

// ---------- Helpers ----------

function resolveProvider(arg) {
  // Explicit --provider flag (or TRANSLATE_PROVIDER env) wins.
  const requested = (arg || process.env.TRANSLATE_PROVIDER || "").trim().toLowerCase();
  if (requested) {
    if (requested === "openai" || requested === "anthropic") return requested;
    fail(`Unknown translation provider "${requested}". Use --provider openai or --provider anthropic.`);
  }
  // Auto-detect: per the wiki Languages.md "Choosing a provider"
  // table, Anthropic is the default WHEN BOTH KEYS ARE PRESENT
  // (it was the original provider). OpenAI is picked only when
  // Anthropic is absent. This contract is intentional — set
  // `TRANSLATE_PROVIDER=openai` to override on a box that has
  // both keys but prefers OpenAI.
  if (process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) return "openai";
  return "anthropic";
}

function validateOpenAIBaseUrl(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { fail(`OPENAI_BASE_URL is not a valid URL: ${baseUrl}`); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    fail(`OPENAI_BASE_URL must be https:// (got ${parsed.protocol})`);
  }
  const allowed = [
    "openai.com",
    "azure.com",        // Azure OpenAI deployments
    "localhost",
    "127.0.0.1",
  ];
  const extra = (process.env.OPENAI_BASE_URL_ALLOW || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  const isAllowed = [...allowed, ...extra].some(suffix =>
    host === suffix || host.endsWith(`.${suffix}`));
  if (!isAllowed) {
    fail(
      `OPENAI_BASE_URL host '${host}' is not on the allowlist. ` +
      `If this is an intentional enterprise endpoint, set OPENAI_BASE_URL_ALLOW=` +
      `'<host-suffix>' (comma-separated) to include it.`,
    );
  }
}

function resolveModel(provider, arg) {
  if (arg) return arg;
  if (provider === "openai") {
    return process.env.OPENAI_MODEL || process.env.OPENAI_TRANSLATE_MODEL || "gpt-5-mini";
  }
  // Default to the latest Sonnet — was claude-3-5-sonnet-latest
  // until the 4.x line was promoted. Override with ANTHROPIC_MODEL
  // env if a specific snapshot is needed (e.g. for reproducible
  // re-runs across the same locale set).
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
}

function extractOpenAIText(body) {
  if (typeof body?.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }
  const chunks = [];
  for (const item of body?.output || []) {
    if (item?.type === "message") {
      for (const part of item.content || []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    } else if (item?.type === "output_text" && typeof item.text === "string") {
      chunks.push(item.text);
    }
  }
  return chunks.join("\n").trim();
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isSymbolOnly(value) {
  const withoutPlaceholders = value.replace(/\{[^}]+\}/g, "");
  return !/\p{L}|\p{N}/u.test(withoutPlaceholders);
}

function safeJsonParse(text) {
  // Strip markdown code fences if the model added them.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function safeParse(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}

function countLeaves(obj) {
  let n = 0;
  walk(obj, () => { n++; });
  return n;
}

function walk(obj, cb, pathArr = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v, cb, [...pathArr, k]);
    else cb([...pathArr, k], v);
  }
}

function findMissingKeys(source, target) {
  const missing = [];
  walk(source, (pathArr) => {
    if (getAtPath(target, pathArr) === undefined) missing.push(pathArr);
  });
  return missing;
}

// Detect keys whose value in the target matches the English
// source — i.e. an English placeholder waiting to be translated.
// Skips keys that don't exist in the target at all (those are
// already caught by findMissingKeys, so don't double-report).
function findEnglishStuckKeys(source, target) {
  const stuck = [];
  walk(source, (pathArr, sourceVal) => {
    const targetVal = getAtPath(target, pathArr);
    if (targetVal === undefined) return;
    if (typeof sourceVal === "string" && isSymbolOnly(sourceVal)) return;
    if (targetVal === sourceVal) stuck.push(pathArr);
  });
  return stuck;
}

function getAtPath(obj, pathArr) {
  let cur = obj;
  for (const seg of pathArr) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setAtPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    if (cur[pathArr[i]] == null) cur[pathArr[i]] = {};
    cur = cur[pathArr[i]];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

function deepMerge(base, overlay) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseListArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return [];
  return args[idx + 1].split(",").map(s => s.trim()).filter(Boolean);
}

function parseValueArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1];
}

function fail(msg) {
  console.error("✗", msg);
  process.exit(1);
}

main().catch((err) => fail(err.message || String(err)));
