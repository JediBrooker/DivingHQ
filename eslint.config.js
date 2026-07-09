/* ESLint flat config (ESLint 9). Faithful port of the previous minimal
 * .eslintrc.cjs gate:
 *   - only parse-correctness + `no-undef` are errors;
 *   - `no-unused-vars` is a warning (warnings don't fail the gate, FYI
 *     no --max-warnings is passed);
 *   - everything parsed as an ES module, which also accepts CommonJS
 *     require/module.exports;
 *   - browser + node globals everywhere; <script setup> compiler macros
 *     added for .vue so no-undef doesn't fire on valid SFCs.
 *
 * `plugin:vue/base` -> eslint-plugin-vue's `flat/base` (vue-eslint-parser
 * + the .vue processor, no opinionated vue/* rules). Green on the current
 * tree by construction, same as before.
 */
const globals = require("globals");
const pluginVue = require("eslint-plugin-vue");

module.exports = [
  {
    // Global ignores (ported from .eslintignore). Must be its own object.
    ignores: [
      "node_modules/**",
      "dist/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      "wiki/**",
      "**/*.min.js",
      "src/locales/**",
    ],
  },
  ...pluginVue.configs["flat/base"],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
    },
  },
  {
    // <script setup> compiler macros (defineProps/defineEmits/…) must be
    // known globals or no-undef fires on valid SFCs. This replaces
    // the old `env: { "vue/setup-compiler-macros": true }`.
    files: ["**/*.vue"],
    languageOptions: {
      globals: {
        defineProps: "readonly",
        defineEmits: "readonly",
        defineExpose: "readonly",
        defineOptions: "readonly",
        defineSlots: "readonly",
        defineModel: "readonly",
        withDefaults: "readonly",
      },
    },
  },
];
