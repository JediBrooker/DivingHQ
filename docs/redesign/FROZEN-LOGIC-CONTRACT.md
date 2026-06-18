# Frozen-Logic Contract — Meet-Day Redesign

**Status: binding for phases P0–P9** (and P10 for Manager). Authored in
P0 of `DESIGN-OUGHT-2026-06-18/REDESIGN-PLAN.md`.

The Stage-Rail redesign is a **re-layout of state that already exists**.
Every seam listed here keeps its current inputs, outputs, and the test
that covers it. The redesign moves *where* this state is rendered, never
*what* it computes.

## The rule

> A change to any frozen seam must be a **presentational re-layout** that
> leaves the listed test green **and the cited source logic unmodified**.
> If a phase needs to change a frozen seam's behaviour, it stops and the
> plan is revised first — the change is out of scope for this redesign.

Enforced mechanically: `git diff --stat -- src/` is empty through P0,
and each later phase's diff to a frozen file must be presentation-only
with the seam's test still green.

## Frozen seams

| # | Seam | Source (frozen) | Covering test |
|---|------|-----------------|---------------|
| 1 | World Aquatics judge trim + score bucketing | `src/composables/useScoreTrim.js` (`annotateJudgeRows`), `src/composables/useScoreCategories.js` (`scoreCategory`) | `test/score-trim.test.js` |
| 2 | Dive description / position labelling | `src/composables/useDiveLabel.js` (`diveDescription`) | `test/dive-label.test.js` |
| 3 | Per-dive scoring SQL builders | `lib/scoring-sql.js` (`perDivePointsExpr`/`perDiveJoins`/`perDiveSelect`/`perDivePointsCte`) | `test/scoring-sql.test.js` |
| 4 | Postgres scoring function | `calc_dive_points` / `calc_event_dive_points` (`init.sql` + tail migrations) | `test/calc.test.js` (DB; self-skips without Postgres) |
| 5 | Live dive/run totals + projected line | `src/views/ControlView.vue` `liveDiveTotal` (~706–731), `projectedLine` (~1826–1947), `panelMultiplier` | `test/e2e/scoring.spec.js` |
| 6 | Readiness + go-live gating | `src/views/ControlView.vue` `readinessItems` (~1061–1169), `startBlockers`/`startBlocked` (~1171–1178), `orderWorkflowState`/`workflowMode` (~835–850) | `test/e2e/workflow-readiness-rehearsal.spec.js` |
| 7 | Live socket scoring path | `src/views/ControlView.vue` `score_received` (~2084–2154), `judge_signal` (~2165–2172) | `test/e2e/scoring.spec.js` |
| 8 | Destructive-action consequences + undo | `src/views/ControlView.vue` `finaliseEvent` (~2471–2492), `withdrawRosterRow` (~1396–1439) | e2e (control flows) |
| 9 | Referee keyboard shortcuts | `src/views/ControlView.vue` `onKeydown` (~2391–2469) | e2e (control flows) |
| 10 | Offline outbox net | `src/composables/useHttpOutbox.js` / `useOutbox.js`; `ConflictReviewTray` / `OfflineBanner` / `LateArrivalReviewTray` | `test/outbox.test.js`, `test/idempotency.test.js` |
| 11 | Auth / RBAC | `lib/middleware.js`; `src/App.vue` `useShell` (41–46); router `beforeEach` + `bounceToLogin ?next=` guard | `test/middleware-auth.test.js` + e2e |

ControlView line ranges are as-audited; the file is frozen until P9, so
they do not move during the redesign.

## Recorded baselines (for P9 / P10 reduction criteria)

- Interactive-element counts (`DESIGN-IS-2026-06-18/02-scorecard.md`,
  `01-evidence.md`, `03-verdict.md:9`): **Control 69**, **Manager 101**,
  **Scoreboard 43**; 343 total across the scoped surfaces.
- Per-route + vendor JS chunk sizes: `scripts/bundle-size-baseline.json`
  (written from the P0 flag-on build). The `/control` chunk size is the
  starting number for P9's live-route weight criterion.
- Known-unguarded recurring-animation sites:
  `scripts/reduced-motion-baseline.json` — the P1 burn-down list.

## Enforcement primitives (added in P0)

- `npm test` / `npm run test:safe` — the units above (glob-discovered via
  `scripts/run-tests.js`, so no unit can be silently orphaned).
- `npm run check:motion` — fails on NEW unguarded recurring animation.
- `npm run check:size` — per-chunk weight budget, incl. the `/control` route.
- `npm run lint` — server syntax-check + the minimal frontend ESLint gate.
