<script setup>
import { computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { marked } from 'marked'
import { GUIDE_SECTIONS, getTopicBySlug, getAdjacentTopics } from './topics.js'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

const route = useRoute()
const router = useRouter()

const slug = computed(() => route.params.topic)
const topic = computed(() => getTopicBySlug(slug.value))
const adjacent = computed(() => getAdjacentTopics(slug.value))

const rendered = computed(() => {
  if (!topic.value) return ''
  return marked.parse(topic.value.md, { breaks: false, gfm: true })
})

function handleClick(e) {
  const a = e.target.closest('a[href]')
  if (!a) return
  const href = a.getAttribute('href')
  if (href?.startsWith('/')) {
    e.preventDefault()
    router.push(href)
  }
}

watch(slug, () => nextTick(() => window.scrollTo(0, 0)))
</script>

<template>
  <div class="gt-wrap" v-if="topic">
    <div class="gt-top">
      <router-link to="/guide" class="btn btn-ghost btn-sm">← Guide</router-link>
      <div class="gt-top-actions">
        <ThemeToggle compact />
        <LocaleSwitcher />
      </div>
    </div>

    <div class="gt-shell">
      <nav class="gt-sidebar">
        <router-link to="/guide" class="gt-home-link">User Guide</router-link>
        <template v-for="section in GUIDE_SECTIONS" :key="section.label">
          <div class="gt-group-label">{{ section.label }}</div>
          <ul class="gt-group-list">
            <li v-for="t in section.topics" :key="t.slug">
              <router-link
                :to="`/guide/${t.slug}`"
                :class="['gt-nav-link', { 'is-active': t.slug === slug }]"
              >{{ t.title }}</router-link>
            </li>
          </ul>
        </template>
      </nav>

      <article class="gt-body" @click="handleClick">
        <div class="gt-content" v-html="rendered"></div>

        <nav class="gt-pager">
          <router-link v-if="adjacent.prev" :to="`/guide/${adjacent.prev.slug}`" class="gt-pager-link gt-pager-prev">
            <span class="gt-pager-dir">← Previous</span>
            <span class="gt-pager-title">{{ adjacent.prev.title }}</span>
          </router-link>
          <span v-else></span>
          <router-link v-if="adjacent.next" :to="`/guide/${adjacent.next.slug}`" class="gt-pager-link gt-pager-next">
            <span class="gt-pager-dir">Next →</span>
            <span class="gt-pager-title">{{ adjacent.next.title }}</span>
          </router-link>
        </nav>
      </article>
    </div>
  </div>

  <div v-else class="gt-wrap gt-not-found">
    <p>Topic not found.</p>
    <router-link to="/guide" class="btn btn-primary">Back to Guide</router-link>
  </div>
</template>

<style scoped>
.gt-wrap {
  max-width: 1220px;
  margin: 0 auto;
  padding: 1.5rem 2rem 3rem;
}
.gt-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}
.gt-top-actions {
  margin-inline-start: auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.gt-shell {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 2.5rem;
  align-items: flex-start;
}
.gt-sidebar {
  position: sticky;
  top: 1rem;
  font-family: var(--font-sans);
  font-size: 12.5px;
  max-height: calc(100vh - 2rem);
  overflow-y: auto;
  padding-inline-end: 0.5rem;
}
.gt-home-link {
  display: block;
  font-weight: 700;
  font-size: 14px;
  color: var(--fg);
  text-decoration: none;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}
.gt-home-link:hover { color: var(--cyan); }
.gt-group-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin: 1rem 0 0.4rem;
}
.gt-group-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.gt-nav-link {
  display: block;
  padding: 0.25rem 0 0.25rem 0.75rem;
  color: var(--text-2);
  text-decoration: none;
  border-inline-start: 2px solid transparent;
  transition: color 0.1s, border-color 0.1s;
}
.gt-nav-link:hover { color: var(--text); }
.gt-nav-link.is-active {
  color: var(--cyan);
  border-inline-start-color: var(--cyan);
  font-weight: 600;
}

.gt-body { min-width: 0; }

.gt-content {
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--fg);
}
.gt-content :deep(h1) {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 0.75rem;
  line-height: 1.2;
  color: var(--fg);
}
.gt-content :deep(h2) {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 2rem 0 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--fg);
}
.gt-content :deep(h3) {
  font-size: 16px;
  font-weight: 600;
  margin: 1.5rem 0 0.5rem;
  color: var(--fg);
}
.gt-content :deep(h4) {
  font-size: 14px;
  font-weight: 600;
  margin: 1.25rem 0 0.4rem;
  color: var(--fg);
}
.gt-content :deep(p) {
  margin: 0 0 0.85rem;
  color: var(--fg-2);
}
.gt-content :deep(ul),
.gt-content :deep(ol) {
  margin: 0 0 1rem;
  padding-inline-start: 1.5rem;
  color: var(--fg-2);
}
.gt-content :deep(li) {
  margin-bottom: 0.3rem;
}
.gt-content :deep(li > ul),
.gt-content :deep(li > ol) {
  margin-top: 0.3rem;
  margin-bottom: 0.3rem;
}
.gt-content :deep(strong) {
  color: var(--fg);
  font-weight: 600;
}
.gt-content :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.gt-content :deep(pre) {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem;
  overflow-x: auto;
  margin: 0 0 1rem;
  font-size: 13px;
  line-height: 1.5;
}
.gt-content :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}
.gt-content :deep(a) {
  color: var(--cyan);
  text-decoration: none;
}
.gt-content :deep(a:hover) {
  text-decoration: underline;
}
.gt-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  margin: 0.5rem 0 1rem;
  display: block;
}
.gt-content :deep(blockquote) {
  border-inline-start: 3px solid var(--accent);
  margin: 0 0 1rem;
  padding: 0.5rem 1rem;
  color: var(--fg-2);
  background: var(--surface);
  border-radius: 0 var(--radius) var(--radius) 0;
}
.gt-content :deep(blockquote p:last-child) {
  margin-bottom: 0;
}
.gt-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1rem;
  font-size: 13.5px;
  display: block;
  overflow-x: auto;
}
.gt-content :deep(th),
.gt-content :deep(td) {
  text-align: start;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
}
.gt-content :deep(th) {
  background: var(--surface);
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
}
.gt-content :deep(td) {
  color: var(--fg-2);
}
.gt-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2rem 0;
}

.gt-pager {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
}
.gt-pager-link {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  text-decoration: none;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: border-color 0.12s, box-shadow 0.12s;
  max-width: 50%;
}
.gt-pager-link:hover {
  border-color: var(--cyan);
  box-shadow: var(--shadow-sm);
}
.gt-pager-next { text-align: end; margin-inline-start: auto; }
.gt-pager-dir {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-3);
}
.gt-pager-title {
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 600;
  color: var(--cyan);
}

.gt-not-found {
  text-align: center;
  padding-top: 4rem;
  font-family: var(--font-sans);
  color: var(--fg-2);
}

@media (max-width: 860px) {
  .gt-shell {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .gt-sidebar {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 0.75rem 0;
    margin: 0 -2rem 1.5rem;
    padding-inline: 2rem;
    max-height: none;
    overflow-x: auto;
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .gt-home-link {
    margin: 0;
    padding: 0;
    border: none;
    font-size: 13px;
    flex-shrink: 0;
  }
  .gt-group-label { display: none; }
  .gt-group-list {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .gt-nav-link {
    border: none;
    padding: 0.2rem 0.5rem;
    font-size: 12px;
    border-radius: var(--radius);
    white-space: nowrap;
  }
  .gt-nav-link.is-active {
    background: var(--surface);
    border: none;
  }
}
</style>
