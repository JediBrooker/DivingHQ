/* Minimal, high-signal lint gate (P0 of the meet-day redesign).
 *
 * Green on the current tree BY CONSTRUCTION: the only error-level
 * signals are parse correctness (ESLint always reports a parse error as
 * an error, independent of rules) and `no-undef` (which cannot fire on
 * valid, already-running source given the environments + compiler-macro
 * globals configured below). Everything opinionated -- including the
 * dead-import / unused-vars rule the audit wants -- is `warn`, and
 * warnings do NOT fail the gate (no --max-warnings is passed).
 *
 * Ratchet rule: a rule graduates from `warn` to `error` ONLY in the
 * later phase that actually touches the files it governs (modal-a11y
 * rules in P2 with BaseModal; SFC-structure rules in P5+ on
 * ControlViewV2). It is never tightened tree-wide here. No rule may
 * force an edit to ControlView.vue or ManagerView.vue in P0.
 * See DESIGN-OUGHT-2026-06-18/REDESIGN-PLAN.md, phase P0.
 */
module.exports = {
  root: true,
  // Permissive on purpose. Both browser (src/**, .vue, e2e page
  // callbacks) and node (server, lib, scripts, unit tests, config)
  // globals are allowed everywhere, and everything is parsed as an ES
  // module -- which also parses CommonJS `require`/`module.exports`
  // without complaint. The net effect: this gate is green on the
  // current tree BY CONSTRUCTION; the only errors it can raise are real
  // syntax errors and genuinely-undefined identifiers (typos / missing
  // imports), neither of which exists in already-running source.
  //
  // The dead-import / unused-vars signal is `warn`, and warnings do NOT
  // fail the gate (no --max-warnings). Per-area env tightening and the
  // graduation of rules to `error` are a ratchet for the later phase
  // that touches the relevant files -- never tree-wide here, and never
  // forcing an edit to ControlView.vue or ManagerView.vue in P0.
  // See DESIGN-OUGHT-2026-06-18/REDESIGN-PLAN.md, phase P0.
  env: { browser: true, node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  // plugin:vue/base wires up vue-eslint-parser + the directive
  // processor for .vue without enabling any opinionated vue/* rule.
  extends: ["plugin:vue/base"],
  rules: {
    "no-undef": "error",
    "no-unused-vars": "warn",
  },
  overrides: [
    {
      // <script setup> compiler macros (defineProps/defineEmits/etc.)
      // must be known globals or no-undef would fire on valid SFCs.
      files: ["**/*.vue"],
      env: {
        browser: true,
        node: true,
        es2022: true,
        "vue/setup-compiler-macros": true,
      },
    },
  ],
};
