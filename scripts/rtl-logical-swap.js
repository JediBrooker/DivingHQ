#!/usr/bin/env node
// One-shot transformer: physical-direction CSS -> logical-property
// equivalents so the app mirrors correctly under <html dir="rtl">.
//
// Scope of changes (all string substitutions, we keep the diff
// reviewable that way). For each Vue file we split out three contexts:
//
//   1. <style ...> ... </style>          CSS, full sweep
//   2. style="..."                       inline CSS attribute
//   3. <script ...> ... </script> + JS   skipped; logical-property
//      keys in Vue :style object syntax need camelCase keys, which
//      isn't a safe automated swap (they may appear in larger
//      expressions). We handle the remaining .vue script blocks
//      with targeted manual edits afterwards.
//
// Pure .css files get the full sweep.
//
// Rules applied (in both CSS contexts):
//   margin-left / margin-right       -> margin-inline-start / -end
//   padding-left / padding-right     -> padding-inline-start / -end
//   border-left / border-right       -> border-inline-start / -end
//   border-left-* / border-right-*   -> border-inline-start-* / -end-*
//   text-align: left/right           -> text-align: start / end
//   absolute left:/right:            -> inset-inline-start / -end
//
// We deliberately do NOT rewrite shorthand `margin: a b c d`,
// `padding: ...`, or `inset: ...`, those still need a human look.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

const TARGETS = [];
walk(SRC);

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      walk(p);
    } else if (/\.(vue|css)$/.test(name)) {
      TARGETS.push(p);
    }
  }
}

let totalFiles = 0;
let totalRules = 0;
const fileBreakdown = [];

for (const file of TARGETS) {
  const original = fs.readFileSync(file, "utf8");
  const { output, count } = transformFile(file, original);
  if (count > 0 && output !== original) {
    fs.writeFileSync(file, output);
    totalFiles += 1;
    totalRules += count;
    fileBreakdown.push({ file: path.relative(ROOT, file), count });
  }
}

console.log(`Touched ${totalFiles} files, swapped ${totalRules} rules.`);
for (const row of fileBreakdown) {
  console.log(`  ${row.file}: ${row.count}`);
}

function transformFile(file, src) {
  if (file.endsWith(".css")) {
    return transformCss(src);
  }

  // Vue file, so only transform inside <style ...> blocks and
  // style="..." attribute values.
  let totalCount = 0;
  let out = src;

  // 1) <style> blocks
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (match, body) => {
    const { output, count } = transformCss(body);
    totalCount += count;
    const headEnd = match.indexOf(">") + 1;
    const tail = "</style>";
    return match.slice(0, headEnd) + output + tail;
  });

  // 2) Inline style="..." attribute (single quotes too)
  out = out.replace(/\bstyle=("([^"]*)"|'([^']*)')/g, (match, _q, dq, sq) => {
    const inner = dq != null ? dq : sq;
    const { output, count } = transformInlineStyle(inner);
    if (count === 0) return match;
    totalCount += count;
    const quote = dq != null ? '"' : "'";
    return `style=${quote}${output}${quote}`;
  });

  return { output: out, count: totalCount };
}

function transformCss(src) {
  let count = 0;
  const propertyReplacements = [
    // Long-form border-{color,width,style} must precede border-left.
    [/\bborder-left-color\b/g, "border-inline-start-color"],
    [/\bborder-right-color\b/g, "border-inline-end-color"],
    [/\bborder-left-width\b/g, "border-inline-start-width"],
    [/\bborder-right-width\b/g, "border-inline-end-width"],
    [/\bborder-left-style\b/g, "border-inline-start-style"],
    [/\bborder-right-style\b/g, "border-inline-end-style"],

    [/\bmargin-left\b/g, "margin-inline-start"],
    [/\bmargin-right\b/g, "margin-inline-end"],
    [/\bpadding-left\b/g, "padding-inline-start"],
    [/\bpadding-right\b/g, "padding-inline-end"],
    [/\bborder-left\b/g, "border-inline-start"],
    [/\bborder-right\b/g, "border-inline-end"],

    [/\btext-align:\s*left\b/g, "text-align: start"],
    [/\btext-align:\s*right\b/g, "text-align: end"],
  ];

  for (const [re, to] of propertyReplacements) {
    src = src.replace(re, () => {
      count += 1;
      return to;
    });
  }

  // Absolute positioning: bare `left:` / `right:` properties.
  // Must follow start-of-line, whitespace, `;`, `{`, or `(` so we
  // don't touch `padding-left:` (the `-` blocks the boundary) or
  // anything mid-identifier. We already swapped padding/margin/etc
  // above, so by the time we get here whatever `left:` / `right:`
  // is left over is a positioning declaration.
  src = src.replace(/(^|[\s;{(])left:/g, (m, pre) => {
    count += 1;
    return `${pre}inset-inline-start:`;
  });
  src = src.replace(/(^|[\s;{(])right:/g, (m, pre) => {
    count += 1;
    return `${pre}inset-inline-end:`;
  });

  return { output: src, count };
}

function transformInlineStyle(src) {
  // Inline style attribute is CSS but with `;`-separated
  // declarations, so we can just reuse transformCss.
  return transformCss(src);
}
