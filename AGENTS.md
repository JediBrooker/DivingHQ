# Agent guide

A short orientation for AI agents (and humans-doing-AI-work) on this codebase.
Read once at the start of a session. Keeps you from rediscovering the same
patterns and bugs that already cost previous sessions real cycles.

If anything in this file looks wrong vs. the code, **the code is the source
of truth** — fix this file as part of the same commit.

---

## ⚠️ World Aquatics rules — required reading before diving-rules work

The official **World Aquatics Competition Regulations** (in force as of
February 2026) are committed at:

> [`docs/2026-02-18_World-Aquatics_CR-Final.pdf`](./docs/2026-02-18_World-Aquatics_CR-Final.pdf)

**Diving rules live in PART FOUR (page 123 onwards).** Before designing,
implementing, fixing, or auditing anything that touches:

- Competition format (preliminary / semi-final / final)
- Stage progression / advancement / reserves
- Dive lists / Statement of Dives / change-of-dives windows
- Start order, dive order, withdrawal handling
- Judging, scoring rules, panel sizes, trim algorithm
- Synchro pairs, team events, age-group eligibility
- Degree of Difficulty, dive-code designations, position codes
- Anything cited as a "WA Rule" or "Article" in code or UI

…**read the PDF first**. Don't rely on memory and don't paraphrase rule
numbers — quote the specific Article number after verifying it in the
document. The Article numbering in PART FOUR is `4.x.x`, `6.x.x` etc., NOT
`Rule 2.1.x` (which belongs to general competitions / swimming and does
not govern diving). Past sessions have shipped wrong citations by guessing;
that mistake is permanently called out here so it doesn't happen again.

Quick PDF read: `pdftotext docs/2026-02-18_World-Aquatics_CR-Final.pdf - | awk '/^PART FOUR: DIVING RULES$/,/^PART FIVE/' | less`
gets you the diving section as plain text on stdout. Add `grep -n` for
specific search terms.

Pin the most-referenced articles here as a hint, but **always re-confirm
in the PDF** before citing:

| Article | Topic |
|---|---|
| 4.1.8 | Semi-final start order — reverse of preliminary ranking |
| 4.1.10 | Subsequent stages — reverse-rank from the previous stage |
| 4.1.12 | Advancement when a qualifier withdraws |
| 4.1.13 | Points reset at the start of each subsequent stage |
| 6.6.x  | Statement of Dives — initial submission deadlines (24h / 3h) |
| 6.7.3  | Change-of-dives — 30 min after end of previous stage |
| 6.10   | Synchro/team substitution window |
| 7      | Technical officials |
| 10     | Refereeing and judging dives |
| 11     | Synchronisation judging |

**Diving World Cup Super Final** has its own additional regulations
in `docs/2026.03.05-…-Super-Final…pdf` Appendix 3:

| Section | Topic |
|---|---|
| §1.1   | Top-12 qualification + max 2 per Federation |
| §1.2   | Three-stage chain: H2H → SF → F (3 / 2-3 / 5-6 dives) |
| §2.1   | H2H pairing (12v1, 11v2, …) + group split (G1/G2) + dive sequence within a group |
| §2.2   | SF — 6 winners regroup; reverse-rank within group; carry forward H2H |
| §2.3   | F — top-2 per SF group; scores reset; reverse-rank from SF |
| §3     | Score carry rules (H2H→SF carries; F resets) |
| §4.1   | F change-of-dives window — 15 min between SF and F, latest 5 min before F |
| §5.1   | Pre-Super-Final reserve replacement (synchro pool) |
| §6     | Dive-offs — single-dive tie-break at end of H2H or SF |
| §7     | Final 1-12 ranking layout: 1-4 from F; 5-6 from H2H+SF; 7-12 from H2H |

If you're not sure whether a feature touches WA rules, err toward reading
the PDF section. Better to spend a minute confirming a citation than to
ship code (or docs) that misrepresents the rule.

---

## Where things live

| Folder | What's there |
|---|---|
| `server.js`           | Express + Socket.IO bootstrap, route mounts, socket handlers. Has a TOC at the top with `[SECTION: NAME]` anchors — Cmd-F for any of them to jump straight there. ~5,000 lines. |
| `routes/`             | Route modules extracted from `server.js`: `auth.js`, `scoreboard.js`, `diver-search.js`. Pattern: factory function returning an Express router. |
| `lib/middleware.js`   | The auth + RBAC + payload-validation perimeter. Every gate the API uses to reject a request lives here. **Read this whole file** when reviewing security. |
| `db/queries.js`       | Shared SQL CTE templates (`PER_DIVE`, `FULL_FIELD_RANKING`). Used by the analytics endpoint. |
| `migrations/`         | Numbered SQL migration files (`0NN_*.sql`). Run via `npm run migrate`. |
| `init.sql`            | Schema bootstrap baseline from empty, currently pinned at version 53; run migrations above that baseline to reach HEAD. Do not bump `schema_meta.version` unless the later migrations are ported into this file. |
| `scripts/migrate.js`  | Migration runner. Reads `schema_meta.version`, applies pending files in order. `npm run migrate -- --dry` for plan-only. |
| `src/types.js`        | JSDoc `@typedef`s for every API response shape. Reference via `/** @type {import('@/types').DiverProfile} */`. |
| `src/composables/`    | Vue composables. **ESM** (sub-package.json `type: module`). Pure logic ones (`useScoreTrim`, `useScoreCategories`) are unit-tested in `test/score-trim.test.js`. |
| `docs/design-system.md` | Frontend token/component conventions. Read before adding new view CSS, shared UI classes, or reusable components. |
| `docs/socket-events.md` | Socket.IO event registry — every event the server listens for or emits, the role gate, and the payload shape. **Update this in the same commit when you add or change an event.** |
| `test/`               | `node:test` suites. `syntax`, `calc`, `score-trim` run without a DB; `integration` skips when DB unreachable. |

---

## Stack at a glance

- **Backend**: Node 20 + Express 5 + Socket.IO 4 + node-postgres (`pg`).
  PostgreSQL 14+ with `uuid-ossp` and `pgcrypto`. Auth via JWT in the
  `Authorization: Bearer …` header.
- **Frontend**: Vue 3 (`<script setup>`) + Vite 6 + Vue Router + Pinia.
  PWA via `public/sw.js` (cache v3, network-first navigation).
  IndexedDB stale-while-revalidate via `src/lib/idbCache.js`.
- **Tests**: `node:test` runner. Two suites today — `test/syntax.test.js`
  (no DB needed) and `test/calc.test.js` (skips when DB unreachable).
  CI runs both against a Postgres service container.

---

## Invariants you must not break

### JWT payload shape

`verifyToken` decodes the JWT into `req.user`:

```ts
{
  id: string,                    // ← UUID. NOT user_id, NOT userId, NOT uid.
  username: string,
  full_name: string,
  org_id: string,                // primary org
  org_roles: string[],           // ['org_admin', 'meet_manager', 'judge', ...]
  is_system_admin: boolean,
}
```

**The single most common bug in this repo's history is using
`req.user.user_id`.** Don't. The audit pass found three handlers doing
this; if you find a fourth, fix it and grep the rest of the file.

### Sysadmin bypass pattern

Every org-scoped query uses this exact shape:

```sql
WHERE id = $1 AND ($2::boolean OR org_id = $3)
-- params: [id, !!req.user.is_system_admin, req.user.org_id]
```

When you write a new query against an org-scoped resource, use this pattern.
Don't invent a different one. There's also a route-level helper
`ensureEventOrgGate(req, res, paramName)` for the simple "is this event in
my org?" case.

### Org-resource cross-checks

When an endpoint lets one user attach another (manager, judge, team) to an
event, you **must** confirm the attachee's org matches the event's org.
The helper is `isInSameOrg(db, eventOrgId, id, kind)`. Without this you've
opened an IDOR — the audit caught three of these.

### Role gates on socket events

Socket handlers that mutate state (`submit_score`, `set_active_diver`,
`referee_*`, `meet_hold`, `meet_resume`, `announce_score`) must call
`socketRequireRole(socket, [...])` first. Anonymous spectators connect
without a token and that's intentional, but they can only listen, never
emit. **Don't fall back to `data.judge_id`** — that's the spoof the audit
closed.

### Score validation

Any code path that accepts a score must validate `0 ≤ n ≤ 10` in 0.5
increments. Helper is `isValidScore(s)` in `server.js`. The HTTP and
Socket paths must agree, otherwise one becomes a back-door.

### Schema migrations

Every change goes in **two** places:

1. **`migrations/0NN_<name>.sql`** — a numbered file that brings an existing
   DB up to the same version. Idempotent (`IF NOT EXISTS`, `ON CONFLICT`).
   End with the standard `INSERT INTO schema_meta … ON CONFLICT (id) DO
   UPDATE` block bumping `version`.
2. **`init.sql`** — today this is a pinned bootstrap baseline, not HEAD.
   Do not change the version stamp unless you also port every later migration
   into the file. If a task explicitly moves the baseline forward, update the
   column defs, indexes, and `INSERT INTO public.schema_meta (id, version)`
   line together.

Run `npm run migrate` against a target DB to apply pending migrations in
order. The runner reads `schema_meta.version` and applies any numbered file
above it.

---

## Repeated patterns and where the helpers live

| Job | Helper | File |
|---|---|---|
| Decode JWT | `verifyToken` middleware | `lib/middleware.js` |
| Require any of N org roles | `requireOrgRole([...])` | `lib/middleware.js` |
| Require event manager OR same-org admin | `requireEventManager()` | `lib/middleware.js` |
| Require sysadmin only | `requireSystemAdmin` | `lib/middleware.js` |
| Confirm event ID belongs to caller's org (read paths) | `ensureEventOrgGate(req, res, paramName)` | `lib/middleware.js` |
| Confirm a target user/team belongs to the event's org | `isInSameOrg(db, eventOrgId, id, kind)` | `lib/middleware.js` |
| Auth gate for socket events | `socketRequireRole(socket, [...])` | `lib/middleware.js` |
| Validate a score from the wire (0–10, half-points) | `isValidScore(s)` | `lib/middleware.js` |
| Parse `?from_date=&to_date=` query params | `parseDateRange(query)` | `lib/middleware.js` |
| Per-query catch-and-log (analytics) | `runQuery(label, sql, params)` | inline in `/api/divers/:id/analytics` |
| Standard analytics CTE for per-dive rows | `PER_DIVE` | `db/queries.js` |
| Standard analytics CTE for full-field ranking | `FULL_FIELD_RANKING` | `db/queries.js` |
| Computed dive points (server) | `calc_event_dive_points(...)` SQL function | `init.sql` |
| Auth-aware fetch with auto-redirect on 401 | `auth.apiFetch(url, opts)` | `src/stores/auth.js` |
| Stale-while-revalidate fetch | `cachedFetch(url, opts, { onUpdate })` | `src/lib/idbCache.js` |
| Wipe per-user IndexedDB cache | `idbClear()` | `src/lib/idbCache.js` |
| Trim & tag judges' scores (World Aquatics rules) | `annotateJudgeRows(judges, n, eventType)` | `src/composables/useScoreTrim.js` |
| Bucket a score into a World Aquatics category | `scoreCategory(s)` | `src/composables/useScoreCategories.js` |
| Judge analytics — one row per (judge, dive) with kept-mean + drop flags | `JUDGE_PER_DIVE` CTE | `db/queries.js` |
| Instant tooltip (no native `title` lag) | `v-tip="…"` directive | `src/directives/tip.js` + `src/styles/app.css` |
| Shared frontend tokens and primitives | Design-system guide | `docs/design-system.md` + `src/styles/app.css` |

If you write the third copy of any of these, **stop and consolidate** into
a helper. The repo has bled time on duplicated patterns.

---

## API response shapes

JSDoc `@typedef`s for the half-dozen shapes the frontend reads from the
API live in `src/types.js`. Reference them via:

```js
/** @type {import('@/types').DiverProfile} */
```

When you change a response, update `src/types.js` in the same commit so
TypeScript-aware editors flag the consumers.

---

## Things that have bitten previous sessions

A non-exhaustive list of "the bug came back because the next agent didn't
know X":

1. **`recent_form` / `placings` / `streak` / `year_over_year` rank against
   the FULL field of competitors, not the diver alone.** The temptation
   is to feed `RANK()` a CTE that's already filtered to the diver, which
   silently makes every meet rank 1st-of-1. Use the
   `analyticsRankingCTE(eventIdsSubquery)` helper.
2. **The World Aquatics category boundaries are duplicated.** Source of truth is
   `src/composables/useScoreCategories.js`; the test mirror at
   `test/syntax.test.js` is intentional and detects drift in the
   composable. Don't add a third copy.
3. **The trim algorithm is duplicated.** Source of truth is
   `src/composables/useScoreTrim.js`. If you need to tag judges' scores
   as kept/dropped client-side, import that.
4. **`JWT_SECRET` must be set in `.env` and ≥ 32 chars in production.** The
   server boots with a warning at < 32 chars and refuses to boot at all
   if the secret is missing or the placeholder. PM2 will crash-loop and
   Cloudflare will return 502 — see commit `ba83226` for the diagnosis.
5. **`helmet` is a runtime dependency.** If a deploy didn't run
   `npm install`, the server crashes on require. Always
   `git pull && npm install && pm2 restart`.
6. **Modal pattern — wrap `BaseModal`.** New dialogs wrap
   `src/components/BaseModal.vue` (Teleport + the `.lb-backdrop`/`.lb-modal`
   frame + `role=dialog`/`aria-modal`, focus-trap, Esc-to-close,
   focus-restore) with `<ModalHeader>` for the header — don't hand-roll a
   `.lb-*` frame. BaseModal supports both `v-if` and always-mounted
   (`:open`) consumers, takes a `max-width` prop, and does NOT own
   scroll-lock (the parent refcounts `useBodyScrollLock`). The 7 control
   modals were migrated onto it in the meet-day redesign (P2) and the
   Manager dialogs in P10. The global `.lb-*` frame rules were re-homed
   from `ControlView.css` to `src/styles/lb-modal.css` (imported in
   `main.js`), so every BaseModal consumer is styled. **Control Room view:**
   `/control` serves the Stage-Rail `ControlViewV2.vue` — now the only
   Control Room. The legacy all-in-one `ControlView.vue` (+ `.css`) and the
   `VITE_CONTROL_V2` build flag were removed at cutover; `control-v2-*.spec.js`
   is the full Control Room suite.
   Historical hand-rolled pattern: commit `e45c227`.
7. **The IndexedDB cache is keyed per-user.** Don't write a frontend that
   bypasses `cachedFetch` for a sensitive endpoint without thinking about
   the leak window between user A logout and user B login.

---

## When you change X, also check Y

A non-exhaustive checklist:

| If you change… | Also check… |
|---|---|
| `users` table columns | `routes/auth.js` (the SELECTs that build the JWT payload), `src/types.js`, `init.sql` + a new `migrations/0NN_*.sql` |
| Super Final endpoints (`/seed-h2h`, `/seed-semi`, `/seed-final`, `/super-final/*`, `/dive-offs`, `/synchro-reserve-pool`) | `docs/2026.03.05-…-Super-Final…pdf` Appendix 3 (re-quote the rule, don't paraphrase), `routes/events.js`, `src/views/ManagerView.vue`, `src/views/ControlView.vue`, `test/e2e/super-final-*.spec.js` |
| The JWT payload shape | Every `req.user.X` reference in `server.js` (grep), `src/stores/auth.js`'s `user` computed |
| A `/api/...` response shape | `src/types.js`, every consumer view (grep for the URL) |
| A SQL function | `init.sql`, all migrations that touch it, `test/calc.test.js` if there's a closed-form test |
| `KNOWN_WIDGETS` (diver) | `WIDGET_CATALOG` in `src/views/DiverProfileView.vue` |
| `KNOWN_WIDGETS` in `routes/judge-analytics.js` | `JUDGE_WIDGET_CATALOG` in `src/views/JudgeProfileView.vue` |
| A socket event | `socketRequireRole` gate, every consumer (`socket.on('eventName')` grep), `docs/socket-events.md` |
| Anything in `src/composables/` | The handful of consumers, since composables aren't auto-typed |
| A user-visible feature, screen, or role capability (e.g. coach phases, scheduler, broadcast modes) | `src/views/GuideView.vue` — the in-app `/guide` primer should still describe what each role does. Linked from the dashboard top menu, footer, sign-in page, and home hero. Most prose is hardcoded English today; if you add new `$t('guide.*')` keys, also drop the English source into `src/locales/en.json` and **translate to every other locale** (see below). |
| Adding any new `$t('…')` key | The same key must exist in `src/locales/en.json` AND every other locale file under `src/locales/`, with a real translation — NOT an English placeholder. Two valid paths: (1) **the default during a Claude conversation** — translate the new keys inline in the same commit that adds them. The diving vocabulary is established in each locale; read existing translated strings in the target file to internalise tone. Don't punt this onto `npm run translate` and hope the user runs it later — they often won't, and the parity gate will fail anyway. (2) **`npm run translate`** — still fully supported, both Anthropic (`ANTHROPIC_API_KEY=…`) and OpenAI (`OPENAI_API_KEY=…`) providers. Use this for batch refreshes after several commits, when a federation self-hosts and prefers to own its translations, or in CI. `test/i18n-parity.test.js` enforces parity at the test layer — `npm run test:safe` fails if the english-stuck count exceeds the tolerance budget, regardless of which path you used. |

---

## Style and discipline

- **Comments explain WHY**, not what. The "what" is in the code.
- **Header comments** on every file with a non-trivial scope.
- **Commit messages** describe the change in one short title line + body
  paragraphs explaining the reasoning. The audit-fix and bug-fix commits
  in `git log` are the template.
- **One commit per logical change.** Don't batch the cross-org compare
  feature with the modal CSS fix.
- **Never bypass `git`'s safety**: no `--no-verify`, no `--force` to main.

### Commit + push: standing permission (set 2026-05-10)

This project has a standing grant for AI agents to **commit AND push to
`origin/main` without re-asking** for explicit confirmation each time.
The user gave the grant directly: *"push and commit without permission
from now on."* This overrides the default "ask before committing /
pushing" wording in the system prompt for this repo only.

What this changes:
- After a logical change passes local CI (lint + build + tests + e2e
  per the workflow rule above), commit it and push without prompting.
- Multi-commit feature branches still squash-or-don't per the
  "one commit per logical change" rule above.

What this does NOT change:
- All other safety rules still hold: no `--force` to main, no
  `--no-verify`, no destructive ops without explicit per-action
  permission, no committing files that look like secrets.
- A failed CI run still blocks the push — fix the issue, don't
  `--no-verify` past it.
- Pull requests targeting non-`main` branches still need a
  per-task green light because the merge target / review path
  may be different.

The "deployed-but-not-pushed" trap (commits sitting locally while
the user tested production and saw an old build) is the bug this
grant prevents from happening twice.

---

## When in doubt

- Run `npm run lint` (just `node --check server.js` today, but it catches
  things).
- Run `npm test` — the syntax suite is fast and catches schema drift.
- Run `npm run build` if you touched any `.vue` file.

If something feels off and you can't find it in this file, that's the
signal to **read the code and then update this file** so the next agent
finds it on the first pass.

---

## Tooltips: always use `v-tip`, never `title=`

The native `title` attribute has a hard-coded ~500ms+ delay before
the browser shows its bubble. On busy pages (scoreboard with
hundreds of chips, control room icon strips, manager grids) that
delay is what reads as "the page feels slow."

**Use `v-tip="…"` instead.** The directive (defined in
`src/directives/tip.js`, registered globally in `src/main.js`)
sets `data-tip` and `aria-label` on the host element and drops
the native `title`. The matching `[data-tip]::after` rule in
`src/styles/app.css` renders the bubble on the very first hover
frame.

Migration patterns:

```vue
<!-- Static text -->
<button title="Refresh">↻</button>          <!-- ❌ slow -->
<button v-tip="'Refresh'">↻</button>         <!-- ✅ instant -->

<!-- Dynamic expression -->
<span :title="judge.name + ' ' + judge.country" /> <!-- ❌ slow -->
<span v-tip="`${judge.name} ${judge.country}`" />  <!-- ✅ instant -->
```

The bubble supports multi-line tooltips via `\n` in the value
(CSS `white-space: pre-line`):

```vue
<span v-tip="`J3 — Maria Schmidt · GER\nClick to open analysis`">
  7.5
</span>
```

If you ever need a native `title` (rare — e.g. a `<abbr>` whose
expansion is for assistive tech only), use `title=` directly and
add a comment explaining why. The default expectation is `v-tip`.

---

## Claude Preview: live UI verification

`.claude/launch.json` is committed to the repo (the only file
under `.claude/` that is — see `.gitignore`). It declares a
preview-server config that the `mcp__Claude_Preview__*` tools
use to spin up a real Chrome rendering the SPA against the
test DB:

```bash
PORT=3097 \
RATE_LIMIT_DISABLED=true \
APP_BASE_URL=http://127.0.0.1:3097 \
DB_DATABASE=divinghq_test \
JWT_SECRET=local-test-secret-do-not-use-in-prod-aaaaa \
  node server.js
```

Useful for verifying any change that's "did the tooltip / chip /
modal / animation actually render right" — Playwright runs
headless, so a screenshot from `mcp__Claude_Preview__preview_screenshot`
is the right tool when the question is visual rather than
behavioural.

A typical agent loop:

1. Edit a Vue file.
2. `mcp__Claude_Preview__preview_start` (config name `scoreboard-preview`).
3. `mcp__Claude_Preview__preview_eval` to navigate to the page
   under test (`location.href = '/scoreboard/<id>'`).
4. `mcp__Claude_Preview__preview_screenshot` or `…inspect` to
   verify rendering.
5. `mcp__Claude_Preview__preview_click` to drive interactions.
6. `mcp__Claude_Preview__preview_stop` when done.

Don't replace Playwright e2e with this — Playwright is the
contract. Preview is the "did that look right?" loop while
iterating.

---

## Verification: run CI locally before pushing

**Workflow rule (set 2026-05-09):** every change has to pass the
test suite **on the local Mac** before it gets pushed. Don't rely
on the GitHub Actions round-trip — push-then-watch-CI is a 15-minute
loop that hides bugs behind merge commits and is twice as slow as
running locally.

Project lives at `~/Code/DivingHQ` (local disk, not Google
Drive — an earlier copy on Drive caused 2-5 min Node module-load
hangs). Cold boot is ~1 second; full local-CI cycle is ~3 min.

The fast local verification wrapper is:

```bash
npm run verify:local
```

It runs `npm run lint`, `npm run build`, and `npm run test:safe`
in sequence. To append a focused Playwright check, pass `--e2e`
followed by normal Playwright args:

```bash
npm run verify:local -- --e2e test/e2e/authz-privileged-writes.spec.js --project=chromium
```

The local equivalent of `.github/workflows/ci.yml`:

```bash
# 1. Lint + build (fast, no DB) — sub-second.
npm run lint
npm run build

# 2. Integration tests (requires Postgres at $DB_DATABASE,
#    default divinghq_test). Boots server.js in-process.
DB_DATABASE=divinghq_test \
  JWT_SECRET=local-test-secret-do-not-use-in-prod-aaaaa \
  npm test

# 3. End-to-end (Playwright + Chromium). Boots its own server
#    on :3097 via webServer config; reuses if one's already
#    running. RATE_LIMIT_DISABLED=true is REQUIRED — the e2e
#    suite hits auth from 127.0.0.1 enough times to trip the
#    20/15min default limiter and 429 every login. The
#    playwright.config.js webServer.env already sets it for the
#    auto-spawned server, but if you pre-boot, set it yourself.
PORT=3097 RATE_LIMIT_DISABLED=true APP_BASE_URL=http://127.0.0.1:3097 \
  node server.js &
DB_DATABASE=divinghq_test E2E_HIGHLIGHT=0 npx playwright test
```

A change is "ready to push" only after all three are green.
