// Lets a node:test file import src/ modules the way Vite does.
//
// Most of src/ is plain ESM, but it leans on two Vite-isms Node doesn't
// understand: the '@/...' alias for src/, and extensionless relative
// imports ('./useSocket'). Without this, only leaf modules with no
// internal imports could be unit tested, which is why the stores and
// the socket-aware composables had no DB-less tests at all.
//
// Uses module.registerHooks (sync, in-thread), which landed in Node
// 22.15. Returns false on an older runtime so the caller can skip
// instead of failing with a confusing resolution error.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const nodeModule = require("node:module");

const SRC = path.join(__dirname, "..", "..", "src");
let registered = false;

function firstFile(base) {
  for (const p of [base, `${base}.js`, path.join(base, "index.js")]) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not this one */ }
  }
  return null;
}

function registerSrcAlias() {
  if (registered) return true;
  if (typeof nodeModule.registerHooks !== "function") return false;
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("@/")) {
        const hit = firstFile(path.join(SRC, specifier.slice(2)));
        if (hit) return next(pathToFileURL(hit).href, context);
      }
      // Extensionless relative import from inside src/.
      if (
        (specifier.startsWith("./") || specifier.startsWith("../"))
        && !path.extname(specifier)
        && context.parentURL
        && context.parentURL.startsWith("file:")
      ) {
        const parent = fileURLToPath(context.parentURL);
        if (parent.startsWith(SRC)) {
          const hit = firstFile(path.resolve(path.dirname(parent), specifier));
          if (hit) return next(pathToFileURL(hit).href, context);
        }
      }
      return next(specifier, context);
    },
  });
  registered = true;
  return true;
}

module.exports = { registerSrcAlias };
