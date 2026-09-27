<script setup>
import { computed, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setPageTitle } from '@/lib/pageTitle'
import { GUIDE_SECTIONS, getTopicBySlug, getAdjacentTopics } from './topics.js'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import MarkdownArticle from '@/components/MarkdownArticle.vue'

const route = useRoute()

const slug = computed(() => route.params.topic)
const topic = computed(() => getTopicBySlug(slug.value))
const adjacent = computed(() => getAdjacentTopics(slug.value))

watch(slug, () => nextTick(() => window.scrollTo(0, 0)))

// The route only knows it's "User Guide"; the tab should say which topic.
// flush 'post' so this lands after the router's own title hook, which also
// re-runs on a language switch.
const { locale } = useI18n()
watch([topic, locale], ([t]) => {
  if (t) setPageTitle(t.title)
}, { immediate: true, flush: 'post' })
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

      <article class="gt-body">
        <MarkdownArticle :md="topic.md" />

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
