// v-tip: instant tooltip directive.
//
// Why this exists: the native `title` attribute has a hard-coded
// ~500ms+ delay before the bubble shows up, and on busy pages
// (scoreboard with hundreds of chips, manager with rows of
// icons) that delay is what reads as "the page feels slow."
// Swap `title="…"` for `v-tip="…"` and you get the same tooltip
// text but CSS-only, rendering on the very first hover frame
// instead of waiting on the browser's default timer.
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
//      the browser would double-render: instant CSS bubble plus
//      the slow native one fading in 500ms later.
//
// Edge cases:
//
//   * Empty / null value → all three attributes are cleared
//     so a v-tip with a falsy reactive value behaves like
//     no tooltip at all (vs. an empty bubble).
//
//   * SVG hosts → the directive still sets the attributes,
//     but ::before/::after pseudos don't render on SVG nodes.
//     Living with it for now, there are no SVG title= sites in
//     the codebase to migrate anyway.
//
// Usage:
//   <button v-tip="'Refresh'">↻</button>
//   <span v-tip="`J${n}: ${name}`">{{ score }}</span>
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
  // `bottom` renders below, use it for tooltips on hosts near
  // the top of the viewport (e.g. a page's top nav) that would
  // otherwise get clipped off the top edge. CSS in app.css.
  if (pos) el.setAttribute("data-tip-pos", pos);
  else el.removeAttribute("data-tip-pos");

  // aria-label management, this is the subtle part.
  //
  // Setting aria-label aggressively was the bug that broke the
  // round-dives e2e: a `<button v-tip="t.description">…{{ t.name
  // }}…</button>` had its accessible name silently reassigned
  // from the visible text (t.name) to the tooltip blurb
  // (t.description), so Playwright's getByRole({ name: /t.name/ })
  // couldn't find it. Took a while to track down tbh.
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
    // visible text, so strip our aria-label and let the natural
    // accessible name (from text content) take over.
    el.removeAttribute("aria-label");
    el.__tipAriaApplied = false;
  }

  // Drop native title: its 500ms+ delay is the whole reason this
  // directive exists in the first place.
  if (el.hasAttribute("title")) el.removeAttribute("title");
}

// =============================================================
// Fixed-position bubble, opt in with `v-tip.fixed="…"`.
//
// The default tooltip is a CSS ::after pseudo on the host, which a
// scrolling/overflow ancestor clips (e.g. the wide judge-ranking
// matrix uses overflow-x:auto, so cell tooltips get cut off at the
// container edge). In fixed mode the bubble is a position:fixed
// node appended to <body>, positioned off the host's bounding
// rect, so nothing clips it. Sits above the host by default and
// flips below if it would run off the top of the viewport.
// =============================================================
function positionFixedTip(el, bubble) {
  const r = el.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  // Honour v-tip:bottom.fixed (data-tip-pos="bottom") so a host near
  // the top of the page keeps its bubble below it, otherwise default
  // to above. Each branch flips to the other side if it would run off
  // the viewport edge.
  let top;
  if (el.getAttribute("data-tip-pos") === "bottom") {
    top = r.bottom + 8;
    if (top + bh > window.innerHeight - 4) top = r.top - bh - 8;
  } else {
    top = r.top - bh - 8;
    if (top < 4) top = r.bottom + 8;
  }
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
  bubble.style.top = `${Math.round(top)}px`;
  bubble.style.left = `${Math.round(left)}px`;
}
function showFixedTip(el) {
  const text = el.getAttribute("data-tip");
  if (!text) return;
  hideFixedTip(el);
  const bubble = document.createElement("div");
  bubble.className = "tip-fixed";
  bubble.setAttribute("role", "tooltip");
  bubble.textContent = text;
  document.body.appendChild(bubble);
  el.__tipFixedNode = bubble;
  positionFixedTip(el, bubble);
  requestAnimationFrame(() => bubble.classList.add("tip-fixed-show"));
}
function hideFixedTip(el) {
  if (el.__tipFixedNode) {
    el.__tipFixedNode.remove();
    el.__tipFixedNode = null;
  }
}
function attachFixed(el) {
  // Mark the host so the CSS ::after bubble is suppressed (see
  // app.css [data-tip-fixed]). Without this the host would render
  // BOTH the clipped ::after and the fixed bubble on a partially
  // clipped host, giving you a visible double tooltip.
  el.setAttribute("data-tip-fixed", "");
  if (el.__tipFixedHandlers) return;
  const show = () => showFixedTip(el);
  const hide = () => hideFixedTip(el);
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focusin", show);
  el.addEventListener("focusout", hide);
  // A scroll anywhere can slide the host out from under the bubble.
  window.addEventListener("scroll", hide, true);
  el.__tipFixedHandlers = { show, hide };
}
function detachFixed(el) {
  const h = el.__tipFixedHandlers;
  if (!h) return;
  el.removeEventListener("mouseenter", h.show);
  el.removeEventListener("mouseleave", h.hide);
  el.removeEventListener("focusin", h.show);
  el.removeEventListener("focusout", h.hide);
  window.removeEventListener("scroll", h.hide, true);
  el.__tipFixedHandlers = null;
  el.removeAttribute("data-tip-fixed");
  hideFixedTip(el);
}

export const tipDirective = {
  mounted(el, binding) {
    apply(el, binding.value, binding.arg);
    if (binding.modifiers && binding.modifiers.fixed) attachFixed(el);
  },
  updated(el, binding) {
    if (binding.value !== binding.oldValue) apply(el, binding.value, binding.arg);
    if (binding.modifiers && binding.modifiers.fixed) attachFixed(el);
  },
  unmounted(el) {
    detachFixed(el);
    el.removeAttribute("data-tip");
    if (el.__tipAriaApplied) el.removeAttribute("aria-label");
    delete el.__tipAriaApplied;
  },
};

export default tipDirective;
