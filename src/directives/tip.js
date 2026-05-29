// v-tip — instant tooltip directive.
//
// Why this exists: the native `title` attribute has a hard-coded
// ~500ms+ delay before the bubble appears, and on busy pages
// (scoreboard with hundreds of chips, manager with rows of
// icons) that delay is what reads as "the page feels slow."
// Replacing every `title="…"` with `v-tip="…"` swaps that
// browser-default tooltip for a CSS-only one that renders on
// the very first hover frame.
//
// What the directive does on every mount/update:
//
//   1. Sets `data-tip="<value>"` on the element.
//      The matching ::after pseudo-element CSS lives in
//      src/styles/app.css and renders the bubble immediately
//      on :hover / :focus-visible.
//
//   2. Mirrors the same string into `aria-label` (only if the
//      caller hasn't set their own aria-label). Screen readers
//      get the tooltip text just like they did with `title`.
//
//   3. Drops any existing `title` attribute. If we left it on,
//      the browser would double-render — instant CSS bubble +
//      slow native bubble fading in 500ms later.
//
// Edge cases:
//
//   * Empty / null value → all three attributes are cleared
//     so a v-tip with a falsy reactive value behaves like
//     no tooltip at all (vs. an empty bubble).
//
//   * SVG hosts → the directive still sets the attributes,
//     but ::before/::after pseudos don't render on SVG nodes.
//     Live with it — there are no SVG title= sites in the
//     codebase to migrate.
//
// Usage:
//   <button v-tip="'Refresh'">↻</button>
//   <span v-tip="`J${n} — ${name}`">{{ score }}</span>
//
// Two existing patterns map cleanly to v-tip:
//   title="static"     → v-tip="'static'"
//   :title="expr"      → v-tip="expr"
//
// Registration: src/main.js calls app.directive('tip', tipDirective).

function apply(el, value, pos) {
  if (value == null || value === "") {
    el.removeAttribute("data-tip");
    el.removeAttribute("data-tip-pos");
    if (el.__tipAriaApplied) {
      el.removeAttribute("aria-label");
      el.__tipAriaApplied = false;
    }
    return;
  }
  const text = String(value);
  el.setAttribute("data-tip", text);

  // Optional placement via directive arg: `v-tip:bottom="…"`.
  // Default (no arg) keeps the historical above-the-host bubble.
  // `bottom` renders below — use it for tooltips on hosts near
  // the top of the viewport (e.g. a page's top nav) that would
  // otherwise be clipped off the top edge. CSS in app.css.
  if (pos) el.setAttribute("data-tip-pos", pos);
  else el.removeAttribute("data-tip-pos");

  // aria-label management — the subtle part.
  //
  // Setting aria-label aggressively was the bug that broke the
  // round-dives e2e: a `<button v-tip="t.description">…{{ t.name
  // }}…</button>` had its accessible name silently reassigned
  // from the visible text (t.name) to the tooltip blurb
  // (t.description), so Playwright's getByRole({ name: /t.name/ })
  // couldn't find it.
  //
  // Rule: only mirror to aria-label when the element doesn't
  // already have a visible text accessible name. Heuristic:
  //   * If textContent.trim() is non-empty → visible text wins,
  //     don't touch aria-label.
  //   * If textContent is empty (icon-only buttons, symbol
  //     elements) → set aria-label to the tooltip text so
  //     screen readers have something to announce.
  // Caller-set aria-label is always respected.
  const visibleText = (el.textContent || "").trim();
  const existingAria = el.getAttribute("aria-label");
  const callerSetAria = existingAria && !el.__tipAriaApplied;

  if (callerSetAria) {
    /* leave it alone */
  } else if (!visibleText) {
    el.setAttribute("aria-label", text);
    el.__tipAriaApplied = true;
  } else if (el.__tipAriaApplied) {
    // Element used to be empty (we set aria-label) and now has
    // visible text — strip our aria-label so the natural
    // accessible name (from text content) takes over.
    el.removeAttribute("aria-label");
    el.__tipAriaApplied = false;
  }

  // Drop native title — its 500ms+ delay is the entire reason
  // this directive exists.
  if (el.hasAttribute("title")) el.removeAttribute("title");
}

export const tipDirective = {
  mounted(el, binding) { apply(el, binding.value, binding.arg); },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return;
    apply(el, binding.value, binding.arg);
  },
  unmounted(el) {
    el.removeAttribute("data-tip");
    if (el.__tipAriaApplied) el.removeAttribute("aria-label");
    delete el.__tipAriaApplied;
  },
};

export default tipDirective;
