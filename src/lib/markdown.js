// Markdown to HTML for our own documents: the guide topics and the legal
// pages (see MarkdownArticle.vue).
//
// marked stopped writing id attributes on headings a few majors ago, so
// every "#setup" style link in the guide went nowhere. This puts them back,
// using GitHub's slug rules, because that's how the links in
// src/guide/content were written (and how they read on GitHub).
//
// No Vue in here, so node:test can import it (test/guide-anchors.test.js
// checks that every in-guide link lands on a real heading).
import { Marked } from 'marked'

// Same shape as github-slugger: lower-case, drop anything that isn't a
// letter, number, underscore, hyphen or space, then spaces become hyphens.
// No trimming or collapsing, so "Hold / resume" gives "hold--resume" like
// GitHub does. Emoji go too, and so do the joiners and variation selectors
// glued to them (those count as marks, and would otherwise survive), which
// is why "### 🏛️ Org admin" is linked as #-org-admin.
export function headingSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‍︎️]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

// The slug comes from what the reader sees, so render the heading's inline
// markdown first, then drop the tags (a `code` span keeps its text).
function plainText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
}

// A fresh parser per document, so duplicate headings get -1, -2 suffixes
// counted within that document only.
export function renderMarkdown(md) {
  const seen = new Map()
  const marked = new Marked({ gfm: true, breaks: false })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const base = headingSlug(plainText(inner))
        const n = seen.get(base) || 0
        seen.set(base, n + 1)
        const id = n ? `${base}-${n}` : base
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`
      },
    },
  })
  return marked.parse(md)
}

// Every heading id a document ends up with, for the anchor test.
export function headingIds(md) {
  const html = renderMarkdown(md)
  return new Set([...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]))
}
