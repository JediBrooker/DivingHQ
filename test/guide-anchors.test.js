// In-guide links: every "/guide/<topic>" link has to name a real topic, and
// every "#heading" link has to land on a heading that exists. Headings get
// their ids from src/lib/markdown.js (GitHub's slug rules). Before that,
// marked wrote no ids at all and every anchor in the guide was dead, which
// nobody noticed because the page just didn't scroll.
//
// Pure file reads, no DB, so it runs in test:safe too.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const CONTENT = path.join(__dirname, "..", "src", "guide", "content");
const TOPICS_JS = path.join(__dirname, "..", "src", "guide", "topics.js");

let headingSlug, headingIds, renderMarkdown;
test.before(async () => {
  ({ headingSlug, headingIds, renderMarkdown } = await import("../src/lib/markdown.js"));
});

function topics() {
  const out = {};
  for (const f of fs.readdirSync(CONTENT).filter((n) => n.endsWith(".md"))) {
    out[f.replace(/\.md$/, "")] = fs.readFileSync(path.join(CONTENT, f), "utf8");
  }
  return out;
}

test("slugs follow GitHub's rules", () => {
  assert.equal(headingSlug("Setup"), "setup");
  assert.equal(headingSlug("\"I forgot my password\""), "i-forgot-my-password");
  assert.equal(headingSlug("Hold / resume banner"), "hold--resume-banner");
  assert.equal(headingSlug("Judge Analysis — how am I tracking?"), "judge-analysis--how-am-i-tracking");
  assert.equal(headingSlug("🏛️ Org admin"), "-org-admin");
  assert.equal(headingSlug("🧑‍⚖️ Judge"), "-judge");
  assert.equal(headingSlug("1. Create your account and your club"), "1-create-your-account-and-your-club");
});

test("headings render with ids, from the visible text, de-duplicated", () => {
  const html = renderMarkdown("## Completed Meets Index (`/scoreboard`)\n\n## Notes\n\n## Notes\n\n### Q&A\n");
  assert.match(html, /<h2 id="completed-meets-index-scoreboard">/);
  assert.match(html, /<h2 id="notes">/);
  assert.match(html, /<h2 id="notes-1">/);
  assert.match(html, /<h3 id="qa">/);
});

test("every topic in topics.js has a content file, and the other way round", () => {
  const listed = [...fs.readFileSync(TOPICS_JS, "utf8").matchAll(/slug: '([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, Object.keys(topics()).sort());
});

test("every in-guide link and anchor resolves", () => {
  const all = topics();
  const ids = Object.fromEntries(Object.entries(all).map(([slug, md]) => [slug, headingIds(md)]));
  const broken = [];
  for (const [slug, md] of Object.entries(all)) {
    // ](/guide/topic), ](/guide/topic#heading) and ](#heading)
    for (const m of md.matchAll(/\]\((?:\/guide\/([a-z0-9-]+))?(#[^)\s]*)?\)/g)) {
      const [link, target, hash] = m;
      if (!target && !hash) continue;
      const where = target || slug;
      if (!ids[where]) { broken.push(`${slug}: ${link} (no such topic)`); continue; }
      if (hash && !ids[where].has(hash.slice(1))) broken.push(`${slug}: ${link} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
