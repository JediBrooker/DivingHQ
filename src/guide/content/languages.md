# Languages & Translation

DivingHQ ships with **26 supported languages** out of the box. Every page — login, registration, the diver portal, the operator Control Room, the judge terminal, the scoreboard, the coach console — can be rendered in any of them. The language a user picks persists across sign-in / sign-out, follows them to every page in the same session, and auto-detects on first visit from the browser's `navigator.language`.

This page covers:

- The full language list
- How to switch language in the app
- What persists, where, and across what
- Right-to-left (RTL) support
- How federation admins / developers can add new languages or refresh existing ones via the AI translation pipeline

If you only want to use DivingHQ in another language, read [Supported languages](#supported-languages), [Switching language](#switching-language), and [Right-to-left](#right-to-left-arabic). The translation-runner sections are for maintainers.

## Supported languages

| Region | Languages |
|---|---|
| 🌍 Western Europe | 🇬🇧 English · 🇪🇸 Español · 🇫🇷 Français · 🇩🇪 Deutsch · 🇮🇹 Italiano · 🇵🇹 Português |
| 🌍 Northern Europe | 🇫🇮 Suomi · 🇸🇪 Svenska · 🇩🇰 Dansk · 🇳🇴 Norsk |
| 🌍 Central / Eastern Europe | 🇵🇱 Polski · 🇨🇿 Čeština · 🇭🇷 Hrvatski · 🇷🇸 Српски · 🇭🇺 Magyar · 🇬🇷 Ελληνικά · 🇹🇷 Türkçe |
| 🌍 East Slavic | 🇷🇺 Русский · 🇺🇦 Українська |
| 🌏 East Asia | 🇨🇳 中文 *(Simplified Mandarin)* · 🇯🇵 日本語 · 🇰🇷 한국어 |
| 🌏 Southeast Asia | 🇮🇩 Bahasa Indonesia · 🇲🇾 Bahasa Melayu · 🇵🇭 Tagalog |
| 🌍 Middle East | 🇸🇦 العربية *(RTL — full right-to-left layout flip)* |

English is the source of truth — every other locale is translated against it. AI-assisted translations were generated against the diving-specific vocabulary in each language (e.g. Italian `tuffatore`, Czech `skokan`, Mandarin `跳水运动员`, Japanese `飛び込み選手`, Arabic `غطّاس`, Tagalog uses natural English code-mix for technical scoreboard terms as is idiomatic in Filipino sport coverage).

## Switching language

Three entry points carry the language switcher:

- **The home page** — top-right of the hero. Visible before sign-in so spectators / new users can pick their language before doing anything.
- **The login page** — top-right next to the wordmark, for the same reason.
- **Your diver profile** — in the Preferences section ("Language"), accessible from the sidebar account menu → My Profile → Preferences. This is the per-user locale control for signed-in users; the signed-in app shell top bar carries the **theme toggle** (light/dark) instead.

The switcher is a flag-prefixed dropdown. Tap the flag, pick a language, the entire app re-renders into the new locale immediately — no reload required.

## What persists

The chosen language is written to `localStorage('locale')` on every change. That means:

- **Across pages within the same session** — instant. The vue-i18n locale is a globally reactive ref; every page that uses `$t(...)` re-renders the moment the locale changes.
- **Across reload / sign-in / sign-out** — covered by `localStorage`. Returning users see their language immediately on the next visit, even before they sign in.
- **Across devices** — currently no. Each browser keeps its own `localStorage`. Cross-device persistence will land when the `users.locale` server-side column is rolled out alongside server-side i18n for email templates and PDF exports.

### First-visit auto-detect

If a user has never explicitly picked a language, the app reads `navigator.language` (e.g. `fr-FR`, `ja`, `zh-CN`) and tries to match the 2-letter prefix against the supported set. So a phone set to French lands on French, a phone set to Japanese lands on Japanese, etc. Falls back to English if no match is found.

## Right-to-left (Arabic)

Arabic is the only RTL language in the supported set. When you switch to it:

- `<html dir="rtl">` is set at the document root
- `<html lang="ar">` is set in lockstep
- The whole page mirrors automatically — buttons flow right-to-left, headings align right, columns swap, etc.

This is achieved with CSS *logical properties* (`padding-inline-end`, `inset-inline-end`, `margin-inline-start`, etc.) throughout the layout, so no per-component RTL stylesheet is needed. Per-page chrome (event-picker chevrons, arrow indicators, menu pop-out direction) all flip correctly.

If you spot a layout glitch in Arabic that doesn't flip cleanly, file a bug and tag it `bug` + `rtl`.

## Adding a new language

Adding a brand-new locale is a six-step process:

1. **Register the locale (client)** in `src/i18n/index.js`:
   - Add a lazy loader to the `loaders` map: `xx: () => import('@/locales/xx.json')` — every non-English locale is code-split and fetched on demand; only `en` is bundled synchronously
   - Add a `SUPPORTED_LOCALES` entry: `{ code: 'xx', label: 'Native Name', flag: '🇽🇽' }`
   - If RTL, set `rtl: true` on the entry
2. **Register the locale (server)** for error messages, email templates, and PDF column headers:
   - Add `xx` to the `SUPPORTED` array in `lib/server-i18n.js`
   - Create `src/locales/server-xx.json`, mirroring the smaller `server-en.json` structure
   - Bump the supported-count assertions in `test/server-i18n.test.js`
3. **Add the language to the translation script** (`scripts/translate-locales.js`) — append `xx: "English description for the AI prompt"` to `TARGET_LANGUAGES`. This is what the AI translator uses to pick voice and register.
4. **Add the locale to the parity gate** — append `"xx"` to the `LOCALES` list in `test/i18n-parity.test.js`. This test fails the build if any `en.json` key is missing, extra, or has a mismatched placeholder in the new locale.
5. **Run the translator**:
   ```bash
   ANTHROPIC_API_KEY=sk-… npm run translate -- --locales xx
   ```
   The script reads every key from `en.json` and writes a fully-translated `src/locales/xx.json`. JSON structure, placeholders (`{n}`, `{minutes}`, `{round}`, `{name}`, …), the `{'@'}` email-placeholder escape, emoji and special characters all preserved verbatim.
6. **Validate + build**:
   ```bash
   npm run build
   ```
   Vite + `@intlify/unplugin-vue-i18n` precompile the new dictionary at build time. If a translation broke a placeholder or introduced a JSON syntax error the build fails loudly.

That's it — every page in the app now renders in the new language.

## Choosing a provider

The translation script supports **two LLM backends** — pick whichever key you have. The provider is selected automatically from the env vars at run time:

| Provider | Activation | Default model | Override env |
|---|---|---|---|
| **Anthropic** (default when both keys present) | `ANTHROPIC_API_KEY=sk-ant-…` | `claude-sonnet-4-5` | `ANTHROPIC_MODEL` |
| **OpenAI** | `OPENAI_API_KEY=sk-…` (only, no Anthropic key) | `gpt-5-mini` | `OPENAI_MODEL` or `OPENAI_TRANSLATE_MODEL` |

Force OpenAI when you have both keys set:

```bash
TRANSLATE_PROVIDER=openai OPENAI_API_KEY=sk-… npm run translate
```

For enterprise / self-hosted OpenAI-compatible endpoints, set `OPENAI_BASE_URL` (must be `https://` and on the allowlist: `openai.com`, `azure.com`, `localhost`). Extend the allowlist via `OPENAI_BASE_URL_ALLOW="my-corp-host.example,…"` if you have a legitimate endpoint elsewhere.

## Refreshing existing translations

Same script handles top-up translations when new keys are added to `en.json`:

```bash
# Preview what would be translated — no API calls, no key needed
node scripts/translate-locales.js --dry-run

# Translate any new English keys into every locale at once
ANTHROPIC_API_KEY=sk-… npm run translate

# Restrict to specific locales
ANTHROPIC_API_KEY=sk-… npm run translate -- --locales fr,de,zh

# Side-file mode — writes .new.json next to each locale so you can
# diff + proofread before promoting:
#   mv src/locales/fr.new.json src/locales/fr.json
ANTHROPIC_API_KEY=sk-… npm run translate -- --diff
```

Behavior:

- **Idempotent** — already-translated keys are skipped unless `--force` is passed.
- **Atomic per locale** — if the model returns malformed JSON for one locale the script aborts that locale only; other locales aren't affected.
- **Cheap** — about USD 0.05 per locale at current Anthropic Sonnet 4.5 pricing for the full ~980-key dictionary, less for incremental top-ups. Similar with `gpt-5-mini` on OpenAI.

## How translations are stored

```
src/locales/
├── en.json    ← English source of truth (~980 keys)
├── es.json    ← Spanish
├── fr.json    ← French
├── de.json    ← German
├── …
└── ar.json    ← Arabic (RTL)
```

Each file mirrors the same nested namespace structure. Top-level namespaces include:

| Namespace | Coverage |
|---|---|
| `common.*` | Shared chrome — loading / saving / cancel / save / etc. |
| `auth.login.*`, `auth.register.*`, `auth.forgot.*`, `auth.reset.*`, `auth.confirm_email.*` | The five auth pages |
| `home.*` | Home page (hero, live strip, feature cards, how-it-works, footer) |
| `dashboard.*` | Dashboard header + role tabs |
| `coach.dashboard.*`, `coach.dive_lists.*` | Coach console + on-behalf-of dive-list editor |
| `scoreboard.*` | Public scoreboard chrome |
| `control.*`, `manager.*`, `user_manager.*`, `audit_log.*` | Operator surfaces |
| `judge.*` | Judge terminal |
| `competitor.*`, `meet_day.*` | Diver portal + meet-day view |
| `inbox.*`, `compare.*`, `guide.*`, `dive_directory.*`, `judges_directory.*`, `clubs.*`, `teams.*`, `setup.*`, `score_audit.*` | Smaller surfaces |
| `role.*` | Shared persona chips (Public / Diver / Judge / Referee / Manager / Admin) |
| `errors.*`, `actions.*`, `status.*` | Shared error / action / status terminology |

## How it works under the hood

DivingHQ ships with the **runtime-only** vue-i18n build. The full vue-i18n distribution includes a JIT message compiler that uses `new Function(...)` to turn message templates into render functions at runtime — but our SPA enforces a strict `script-src 'self'` Content Security Policy that blocks all `eval`-style script generation, so a runtime-compiled message would crash the page on first translation lookup.

The fix is **build-time AST precompilation**. `@intlify/unplugin-vue-i18n` transforms every `src/locales/*.json` import at Vite build time into a module of pre-baked AST functions. The browser never invokes a parser; it just executes the compiled functions. Net effect:

- Strict CSP intact — no `'unsafe-eval'` ever
- Smaller runtime bundle — the parser is left out entirely
- Faster first translation — the AST is ready at module load

The trade-off: a malformed message in a locale file (broken `{placeholder}`, stray `@` character, etc.) fails the **build**, not the runtime. That's intentional — it catches translation regressions before they ship.

### The `@` escape

vue-i18n's message format treats a literal `@` as the start of a *linked-message reference* (e.g. `@:foo.bar` means "render the `foo.bar` message here"). Email placeholders like `you@example.com` would silently break the message compiler. So every email placeholder in every locale file is escaped:

```json
"email_placeholder": "you{'@'}example.com"
```

The `{'@'}` escape renders as a literal `@` at runtime; the wire-shape stays unchanged. If you add a new key with a literal `@`, escape it the same way.

## See also

- [Roles & Permissions](/guide/roles-and-permissions) — the source of truth for what each role can / can't do, in every language
- [Features](/guide/features) — every feature in the app, grouped by role / by section
- The main repository README — the README's own short summary
