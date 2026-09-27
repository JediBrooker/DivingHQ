<script setup>
// Renders one of our own markdown documents with the shared prose styles:
// the guide topics (src/guide/content) and the privacy policy and terms
// (docs/). Pulled out of GuideTopicView when the legal pages needed the
// same look, so there's one set of prose rules instead of two drifting.
//
// The source is always a file from this repo imported with ?raw, never
// anything a user typed, which is why v-html is acceptable here. Don't feed
// it user content without a sanitiser in front.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { marked } from 'marked'

const props = defineProps({
  md: { type: String, required: true },
})

const router = useRouter()
const html = computed(() => marked.parse(props.md, { breaks: false, gfm: true }))

// In-app links in the markdown ("/guide/faq", "/privacy") are plain <a>
// tags, so route them through the router instead of reloading the SPA.
// Leave modified clicks alone: cmd/ctrl/shift-click should still open a tab.
function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const a = e.target.closest('a[href]')
  if (!a || a.target === '_blank') return
  const href = a.getAttribute('href')
  if (href?.startsWith('/') && !href.startsWith('//')) {
    e.preventDefault()
    router.push(href)
  }
}
</script>

<template>
  <div class="md-article" v-html="html" @click="onClick"></div>
</template>

<style scoped>
.md-article {
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--fg);
}
.md-article :deep(h1) {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
  line-height: 1.2;
  color: var(--fg);
}
.md-article :deep(h2) {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 2rem 0 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--fg);
}
.md-article :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 1.5rem 0 0.5rem;
  color: var(--fg);
}
.md-article :deep(h4) {
  font-size: 14px;
  font-weight: 600;
  margin: 1.25rem 0 0.4rem;
  color: var(--fg);
}
.md-article :deep(p) {
  margin: 0 0 0.85rem;
  color: var(--fg-2);
}
.md-article :deep(ul),
.md-article :deep(ol) {
  margin: 0 0 1rem;
  padding-inline-start: 1.5rem;
  color: var(--fg-2);
}
.md-article :deep(li) {
  margin-bottom: 0.3rem;
}
.md-article :deep(li > ul),
.md-article :deep(li > ol) {
  margin-top: 0.3rem;
  margin-bottom: 0.3rem;
}
.md-article :deep(strong) {
  color: var(--fg);
  font-weight: 600;
}
.md-article :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.md-article :deep(pre) {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem;
  overflow-x: auto;
  margin: 0 0 1rem;
  font-size: 13px;
  line-height: 1.5;
}
.md-article :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
.md-article :deep(a) {
  color: var(--cyan);
  text-decoration: none;
}
.md-article :deep(a:hover) {
  text-decoration: underline;
}
.md-article :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  margin: 0.5rem 0 1rem;
  display: block;
}
.md-article :deep(blockquote) {
  border-inline-start: 3px solid var(--accent);
  margin: 0 0 1rem;
  padding: 0.5rem 1rem;
  color: var(--fg-2);
  background: var(--surface);
  border-radius: 0 var(--radius) var(--radius) 0;
}
.md-article :deep(blockquote p:last-child) {
  margin-bottom: 0;
}
.md-article :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1rem;
  font-size: 13.5px;
  display: block;
  overflow-x: auto;
}
.md-article :deep(th),
.md-article :deep(td) {
  text-align: start;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
}
.md-article :deep(th) {
  background: var(--surface);
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
}
.md-article :deep(td) {
  color: var(--fg-2);
}
.md-article :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2rem 0;
}
</style>
