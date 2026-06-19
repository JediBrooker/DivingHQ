# Verdict

REDESIGN. DivingHQ is useful and technically mature, but the meet-day UI has become too dense to remain understandable under pressure; the redesign should preserve the operating capability while removing visible decision load.

## Top Moves

1. Make the Control Room understandable first. Replace jargon-led controls with a stage model that answers: what is live now, what is the next required action, what is blocked, and what recovery action is safe.

2. Reduce the number of visible paths. The current scoped evidence has 343 interactive elements, with 101 in Manager and 69 in Control. Move low-frequency actions into predictable secondary places and keep the primary meet-day lane visible.

3. Consolidate modal and broadcast patterns. Broadcast, OBS, Daktronics, signoff, score correction, check-in, random draw, and inline Control Room modals should share a small set of flows and component primitives instead of separate one-off panels.

4. Keep the honest operational state vocabulary. Preserve the strong parts: status pills, active diver state, judge score chips, public scoreboard labels, undo/confirm patterns, and explicit consequences for destructive actions.

5. Treat motion and weight as product quality. Gate recurring animations behind `prefers-reduced-motion`, reduce idle visual movement, and keep route chunks aligned with actual role workflows.

## Evidence Anchors

- Scope: `DESIGN-IS-2026-06-18/00-scope.md`
- Evidence: `DESIGN-IS-2026-06-18/01-evidence.md`
- Scorecard: `DESIGN-IS-2026-06-18/02-scorecard.md`
