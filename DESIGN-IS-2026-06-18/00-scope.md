# Scope

Date: 2026-06-18

## What Was Audited

DivingHQ's existing web application design, scoped to the primary meet-day operating surfaces implemented in this repository:

- `src/components/AppShell.vue`
- `src/views/DashboardView.vue`
- `src/views/ManagerView.vue`
- `src/views/ControlView.vue`
- `src/views/ScoreboardView.vue`
- `src/components/dashboard/*`
- `src/components/control/*`
- `src/components/scoreboard/*`
- Shared visual system in `src/styles/app.css`, `src/views/ControlView.css`, `src/views/ManagerView.css`, and `src/views/ScoreboardView.css`

No live URL or Figma frame was supplied. Evidence is therefore source-level, with bundle weight measured from a local production build where available.

## Primary User

Meet-day operators: meet managers, referees, judges, and scoreboard/broadcast operators working under time pressure during a live diving event.

## Primary Task

Set up, run, score, monitor, and present a diving meet with minimal ambiguity and fast recovery when live-state, scoring, roster, schedule, or device issues occur.

## Constraints

- Existing Vue 3 + Vite frontend and Express/Socket.IO backend.
- Existing design-system conventions in `docs/design-system.md` and `src/styles/app.css`.
- World Aquatics diving workflows and terminology are load-bearing.
- Mobile, tablet, desktop, projector, and broadcast display contexts all matter.
- No implementation is part of this audit; the design-is handoff ends at a `/make-plan` prompt.

## References

No external reference designs or competitors were provided. The audit evaluates the shipped design against Dieter Rams' ten principles using the code and measurable repository artifacts as evidence.
