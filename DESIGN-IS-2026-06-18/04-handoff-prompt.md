# Handoff Prompt

```text
/make-plan

Plan a REDESIGN for DivingHQ's primary meet-day web app surfaces.

Context:
- Repository: /Users/cbrooker/Code/DivingHQ
- Design audit artifacts:
  - DESIGN-IS-2026-06-18/00-scope.md
  - DESIGN-IS-2026-06-18/01-evidence.md
  - DESIGN-IS-2026-06-18/02-scorecard.md
  - DESIGN-IS-2026-06-18/03-verdict.md
- Primary user: meet-day operators: meet managers, referees, judges, broadcast operators, and spectators.
- Primary task: set up, run, score, monitor, recover, and present a diving meet with minimal ambiguity during live operations.

Verdict:
REDESIGN. DivingHQ is useful and technically mature, but the meet-day UI has become too dense to remain understandable under pressure; the redesign should preserve the operating capability while removing visible decision load.

Rams scorecard:
- Total: 15 / 30
- Critical failed principle: #4 Good design makes a product understandable scored 1.
- Other weak principles: #3 aesthetic, #5 unobtrusive, #7 long-lasting, #9 environmentally friendly, #10 as little design as possible all scored 1.

Preserve:
- DivingHQ brand and app-shell direction in src/components/AppShell.vue:130-204 and src/components/AppShell.vue:220-365.
- Core role-aware routing and shell/chromeless split in src/App.vue:1-59 and src/router/index.js:4-120.
- Honest live-state vocabulary: status pills, connection state, active diver, shot clock, judge score chips, standings, hold state, and explicit destructive-action consequences.
- Existing auth/RBAC, socket, offline outbox, and scoring architecture. Do not redesign business logic first.
- Public scoreboard clarity around live/upcoming/completed states, current performer, on-deck, standings, and export actions.

Discard or radically simplify:
- The monolithic Control Room surface where event selection, workflow, active diver, roster, broadcast, sponsor, score correction, check-in, random draw, hold, signoff, and recovery flows all compete.
- One-off modal and panel variants across BroadcastModal, SignoffModal, ScoreCorrectionModal, RandomiseDrawModal, CheckInModal, inline ControlView modals, and SuperFinal panels.
- Emoji/glyph-heavy action labels and recurring pulse animation as primary meaning carriers.
- Hidden-hover explanations as the main way to understand critical controls.
- Any duplicated visual vocabulary that exists only because a feature was added locally rather than through a shared primitive.

Design priorities:
1. Understandability: create a staged meet-day operating model. The first screen should always answer: current state, next required action, blockers, and safe recovery paths.
2. Usefulness: keep every role's critical task reachable, but separate setup, live operation, recovery, and broadcast into explicit lanes.
3. Simplicity: reduce visible controls on the main live surface and consolidate secondary actions into predictable menus, drawers, or task-specific panels.
4. Thoroughness: include keyboard, focus, reduced-motion, loading, empty, error, offline, and mobile behavior in the plan.
5. Weight: define performance budgets for initial route JS, live screen animation, polling, and socket/fetch fan-out.

Required discovery before planning:
- Read docs/design-system.md.
- Read AGENTS.md.
- Inspect src/components/AppShell.vue, src/views/DashboardView.vue, src/views/ManagerView.vue, src/views/ControlView.vue, src/views/ScoreboardView.vue, src/components/control/*, src/components/dashboard/*, src/components/scoreboard/*, and src/styles/app.css.
- Use the audit evidence files above instead of restarting the critique.

Output:
- A phased implementation plan that redesigns the UX without changing scoring rules.
- Include files likely to change, migration risk, test strategy, browser verification strategy, and rollout order.
- Explicitly call out what should not be touched in the first implementation pass.
```
