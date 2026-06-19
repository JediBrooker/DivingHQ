<script setup>
/* GuideView — `/guide`. A single-page, no-login, plain-English
 * primer for someone who just landed in the app and needs a
 * sketch of "what is this and how do I use it."
 *
 * Deliberately NOT a wiki replacement — the wiki at
 * https://github.com/JediBrooker/DivingHQ/wiki carries the
 * exhaustive material. This page is the 5-minute orientation
 * that gets a new user from "I have no idea where to click" to
 * "OK, I know which screen to open."
 *
 * Linked from:
 *   • Home (`/`) hero CTAs + footer
 *   • Dashboard (`/dashboard`) footer + top-menu link
 *   • Sign-in page footer
 *
 * Structure (matches the journey of a first-time user):
 *   1. Overview — what is DivingHQ
 *   2. "I'm a …" — role-by-role cards
 *   3. Quick actions — tile grid linking to common destinations,
 *      each with a thumbnail screenshot served from
 *      /public/guide-screenshots/. Lazy-loaded so the page above
 *      the fold stays cheap.
 *   4. Glossary — diving-specific vocabulary (DD, trim, synchro,
 *      redive, board heights) that newcomers will hit on day one.
 *   5. FAQ — common first questions, now a <details>/<summary>
 *      accordion so users can scan questions without scrolling
 *      past every answer.
 *   6. Wiki — links to the deep-dive material.
 *
 * Navigation:
 *   • A sticky table-of-contents sits on the left on desktop;
 *     on mobile it collapses into a horizontal scroll strip
 *     pinned beneath the page header. Each entry is a hash
 *     anchor (#overview, #roles, …) so individual sections are
 *     deep-linkable from the dashboard, wiki, or chat.
 *   • IntersectionObserver highlights the active section as the
 *     user scrolls; respects the reduced-motion preference by
 *     not animating the highlight transition.
 *
 * i18n: all prose is `$t('guide.*')`. Strings containing
 * <strong> use v-html (translation source is trusted — only
 * our own locale files); strings containing in-app links use
 * <i18n-t> with named slots so the RouterLink is preserved
 * but the wording stays translatable.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { RouterLink } from 'vue-router'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { Waves, Gavel, GraduationCap, MonitorPlay, Building2, Globe } from '@lucide/vue'

const WIKI = 'https://github.com/JediBrooker/DivingHQ/wiki'

// TOC entries match the in-template section ids. Order matters —
// it's the visual reading order. Keep the keys aligned with the
// `guide.toc.*` strings in en.json.
const SECTIONS = [
  { id: 'overview',      key: 'overview' },
  { id: 'roles',         key: 'roles' },
  { id: 'quick-actions', key: 'quick_actions' },
  { id: 'glossary',      key: 'glossary' },
  { id: 'faq',           key: 'faq' },
  { id: 'wiki',          key: 'wiki' },
]

// Quick-action tiles. Each links to a live in-app destination
// (RouterLink), pairs a screenshot served from /public, and
// renders an emoji glyph as a low-cost fallback if the image
// fails to load (offline, blocked, asset missing during dev).
// Subtitles live in i18n; titles reuse the role-card names where
// possible to keep the new key count tight.
const TILES = [
  { id: 'scoreboard',     to: '/scoreboard',      img: '/guide-screenshots/scoreboard.png',     glyph: '🌐' },
  { id: 'control_room',   to: '/control',         img: '/guide-screenshots/control-room.png',   glyph: '🎮' },
  { id: 'judge',          to: '/judge',           img: '/guide-screenshots/judge.png',          glyph: '🧑‍⚖️' },
  { id: 'coach',          to: '/coach',           img: '/guide-screenshots/coach.png',          glyph: '🎓' },
  { id: 'meet_manager',   to: '/manager',         img: '/guide-screenshots/meet-manager.png',   glyph: '📋' },
  { id: 'dive_directory', to: '/dive-directory',  img: '/guide-screenshots/dive-directory.png', glyph: '📖' },
]

// Glossary of diving-specific terms. Term labels are universal
// (DD, FINA codes, etc.) so they're hardcoded in the template;
// only definitions are i18n'd. Ordered roughly by how often a
// newcomer will run into them.
const GLOSSARY = [
  { term: 'DD',          defKey: 'dd' },
  { term: 'Trim',        defKey: 'trim' },
  { term: 'Synchro',     defKey: 'synchro' },
  { term: 'Redive',      defKey: 'redive' },
  { term: 'Failed dive', defKey: 'failed' },
  { term: 'Dive code',   defKey: 'dive_code' },
  { term: '1m / 3m / 5m / 7.5m / 10m', defKey: 'boards' },
  { term: 'Round',       defKey: 'round' },
  { term: 'Reference judge', defKey: 'reference_judge' },
  { term: 'Sign-off',    defKey: 'signoff' },
]

// Sticky-TOC active-section tracker. IntersectionObserver fires
// when a section's top edge crosses the upper-third viewport
// line; we record that section as "active" so the TOC entry can
// take its own highlight style. Falls back gracefully on
// browsers without IntersectionObserver (the TOC just stays
// unhighlighted, every link still works).
const activeSection = ref(SECTIONS[0].id)
let observer = null
onMounted(() => {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) activeSection.value = e.target.id
    }
  }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 })
  for (const s of SECTIONS) {
    const el = document.getElementById(s.id)
    if (el) observer.observe(el)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="guide-wrap">
    <!-- Top nav -->
    <div class="guide-nav">
      <RouterLink to="/" class="btn btn-ghost btn-sm">{{ $t('guide.back_to_home') }}</RouterLink>
      <a :href="WIKI" target="_blank" rel="noopener"
         class="btn btn-ghost btn-sm"
         v-tip:bottom="$t('guide.open_wiki_tip')">
        {{ $t('guide.open_wiki') }}
      </a>
      <div class="guide-nav-locale guide-nav-actions">
        <ThemeToggle compact />
        <LocaleSwitcher />
      </div>
    </div>

    <!-- Hero -->
    <section id="overview" class="guide-hero">
      <div class="guide-eyebrow">{{ $t('guide.title') }}</div>
      <h1 class="guide-title">{{ $t('guide.hero_welcome_prefix') }}
        <span class="guide-title-brand">Diving<span>HQ</span></span>
      </h1>
      <p class="guide-lede">{{ $t('guide.hero_lede') }}</p>
    </section>

    <!-- Two-column layout: sticky TOC (desktop) + content. On
         narrow viewports the TOC collapses into a horizontal
         scroll strip pinned above the content. -->
    <div class="guide-shell">
      <!-- Sticky table of contents -->
      <nav class="guide-toc" :aria-label="$t('guide.toc.label')">
        <div class="guide-toc-label">{{ $t('guide.toc.label') }}</div>
        <ul class="guide-toc-list">
          <li v-for="s in SECTIONS" :key="s.id">
            <a :href="`#${s.id}`"
               :class="['guide-toc-link', { 'is-active': activeSection === s.id }]">
              {{ $t(`guide.toc.${s.key}`) }}
            </a>
          </li>
        </ul>
      </nav>

      <div class="guide-content">
        <!-- "I'm a …" — role cards -->
        <section id="roles" class="guide-section">
          <h2 class="guide-h2">{{ $t('guide.section_roles') }}</h2>

          <div class="guide-roles">
            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><Waves /></div>
              <h3 class="role-name">{{ $t('guide.role.diver.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.diver.desc')"></p>
              <ol class="role-steps">
                <li v-html="$t('guide.role.diver.step_1')"></li>
                <li v-html="$t('guide.role.diver.step_2')"></li>
                <li v-html="$t('guide.role.diver.step_3')"></li>
                <li v-html="$t('guide.role.diver.step_4')"></li>
              </ol>
              <a :href="`${WIKI}/Diver-Portal`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.diver.cta') }}</a>
            </article>

            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><Gavel /></div>
              <h3 class="role-name">{{ $t('guide.role.judge.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.judge.desc')"></p>
              <ol class="role-steps">
                <li v-html="$t('guide.role.judge.step_1')"></li>
                <li v-html="$t('guide.role.judge.step_2')"></li>
                <li v-html="$t('guide.role.judge.step_3')"></li>
                <li v-html="$t('guide.role.judge.step_4')"></li>
              </ol>
              <a :href="`${WIKI}/Judging`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.judge.cta') }}</a>
            </article>

            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><GraduationCap /></div>
              <h3 class="role-name">{{ $t('guide.role.coach.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.coach.desc')"></p>
              <ol class="role-steps">
                <li v-html="$t('guide.role.coach.step_1')"></li>
                <li v-html="$t('guide.role.coach.step_2')"></li>
                <li v-html="$t('guide.role.coach.step_3')"></li>
                <li v-html="$t('guide.role.coach.step_4')"></li>
                <li v-html="$t('guide.role.coach.step_5')"></li>
              </ol>
              <a :href="`${WIKI}/Diver-Portal#coach-access`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.coach.cta') }}</a>
            </article>

            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><MonitorPlay /></div>
              <h3 class="role-name">{{ $t('guide.role.meet_manager.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.meet_manager.desc')"></p>
              <ol class="role-steps">
                <li v-html="$t('guide.role.meet_manager.step_1')"></li>
                <li v-html="$t('guide.role.meet_manager.step_2')"></li>
                <li v-html="$t('guide.role.meet_manager.step_3')"></li>
                <li v-html="$t('guide.role.meet_manager.step_4')"></li>
                <li v-html="$t('guide.role.meet_manager.step_5')"></li>
              </ol>
              <a :href="`${WIKI}/Running-a-Meet`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.meet_manager.cta') }}</a>
            </article>

            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><Building2 /></div>
              <h3 class="role-name">{{ $t('guide.role.org_admin.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.org_admin.desc')"></p>
              <ol class="role-steps">
                <i18n-t keypath="guide.role.org_admin.step_1" tag="li">
                  <template #link>
                    <RouterLink to="/register-org">/register-org</RouterLink>
                  </template>
                </i18n-t>
                <li v-html="$t('guide.role.org_admin.step_2')"></li>
                <li v-html="$t('guide.role.org_admin.step_3')"></li>
                <li v-html="$t('guide.role.org_admin.step_4')"></li>
              </ol>
              <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.org_admin.cta') }}</a>
            </article>

            <article class="role-card">
              <div class="role-icon" aria-hidden="true"><Globe /></div>
              <h3 class="role-name">{{ $t('guide.role.spectator.name') }}</h3>
              <p class="role-desc" v-html="$t('guide.role.spectator.desc')"></p>
              <ol class="role-steps">
                <i18n-t keypath="guide.role.spectator.step_1" tag="li">
                  <template #link>
                    <RouterLink to="/scoreboard">{{ $t('guide.role.spectator.step_1_link') }}</RouterLink>
                  </template>
                </i18n-t>
                <li v-html="$t('guide.role.spectator.step_2')"></li>
                <li v-html="$t('guide.role.spectator.step_3')"></li>
                <li v-html="$t('guide.role.spectator.step_4')"></li>
              </ol>
              <a :href="`${WIKI}/Scoreboard`" target="_blank" rel="noopener"
                 class="role-cta">{{ $t('guide.role.spectator.cta') }}</a>
            </article>
          </div>
        </section>

        <!-- Quick actions — clickable thumbnails into the most
             commonly-asked-for screens. Cheaper than scrolling
             back up to the dashboard for users who just want to
             jump straight into a view. -->
        <section id="quick-actions" class="guide-section">
          <h2 class="guide-h2">{{ $t('guide.section_quick_actions') }}</h2>
          <p class="guide-section-lede">{{ $t('guide.quick_actions.lede') }}</p>

          <div class="guide-tiles">
            <RouterLink v-for="tile in TILES" :key="tile.id" :to="tile.to" class="guide-tile">
              <div class="guide-tile-thumb">
                <img :src="tile.img" :alt="$t(`guide.tile.${tile.id}.label`)"
                     loading="lazy" decoding="async">
                <span class="guide-tile-glyph" aria-hidden="true">{{ tile.glyph }}</span>
              </div>
              <div class="guide-tile-body">
                <div class="guide-tile-label">{{ $t(`guide.tile.${tile.id}.label`) }}</div>
                <div class="guide-tile-sub">{{ $t(`guide.tile.${tile.id}.sub`) }}</div>
              </div>
            </RouterLink>
          </div>
        </section>

        <!-- Glossary — diving-specific vocabulary. Terms are
             universal (DD, synchro, redive, board heights) so
             they stay hardcoded; only the definitions go through
             i18n. -->
        <section id="glossary" class="guide-section">
          <h2 class="guide-h2">{{ $t('guide.section_glossary') }}</h2>
          <p class="guide-section-lede">{{ $t('guide.glossary.lede') }}</p>

          <dl class="guide-glossary">
            <template v-for="row in GLOSSARY" :key="row.defKey">
              <dt class="guide-glossary-term">{{ row.term }}</dt>
              <dd class="guide-glossary-def">{{ $t(`guide.glossary.${row.defKey}`) }}</dd>
            </template>
          </dl>
        </section>

        <!-- FAQ-lite — now a <details>/<summary> accordion so
             users can scan questions and only expand the ones
             they care about. Native semantics mean keyboard +
             screen-reader access for free; no JS required. -->
        <section id="faq" class="guide-section">
          <h2 class="guide-h2">{{ $t('guide.section_first_time') }}</h2>

          <div class="guide-faq">
            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.register_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.register_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.judge_device_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.judge_device_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.scoring_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.scoring_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.broadcast_q') }}</summary>
              <i18n-t keypath="guide.faq.broadcast_a" tag="div" class="guide-faq-body">
                <template #broadcast_all_link>
                  <RouterLink to="/broadcast/all">/broadcast/all</RouterLink>
                </template>
              </i18n-t>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.schedule_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.schedule_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.bug_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.bug_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.install_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.install_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.tfa_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.tfa_a')"></div>
            </details>

            <details class="guide-faq-item">
              <summary>{{ $t('guide.faq.account_q') }}</summary>
              <div class="guide-faq-body" v-html="$t('guide.faq.account_a')"></div>
            </details>
          </div>
        </section>

        <!-- Where to next -->
        <section id="wiki" class="guide-section guide-next">
          <h2 class="guide-h2">{{ $t('guide.section_finding') }}</h2>
          <i18n-t keypath="guide.next.lede" tag="p" class="guide-next-lede">
            <template #wiki_link>
              <a :href="WIKI" target="_blank" rel="noopener">{{ $t('guide.next.wiki_link_label') }}</a>
            </template>
          </i18n-t>
          <ul class="guide-next-list">
            <li>
              <a :href="`${WIKI}/Features`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_features') }}</a>
              — {{ $t('guide.next.bookmark_features_desc') }}
            </li>
            <li>
              <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_quickstart') }}</a>
              — {{ $t('guide.next.bookmark_quickstart_desc') }}
            </li>
            <li>
              <a :href="`${WIKI}/Roles-and-Permissions`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_roles') }}</a>
              — {{ $t('guide.next.bookmark_roles_desc') }}
            </li>
            <li>
              <a :href="`${WIKI}/FAQ`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_faq') }}</a>
              — {{ $t('guide.next.bookmark_faq_desc') }}
            </li>
            <li>
              <a :href="`${WIKI}/Keyboard-Shortcuts`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_shortcuts') }}</a>
              — {{ $t('guide.next.bookmark_shortcuts_desc') }}
            </li>
          </ul>

          <div class="guide-cta-row">
            <RouterLink to="/register" class="btn btn-primary">{{ $t('guide.next.cta_register') }}</RouterLink>
            <RouterLink to="/scoreboard" class="btn btn-ghost">{{ $t('guide.next.cta_scoreboard') }}</RouterLink>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-wrap {
  max-width: 1180px;
  margin: 0 auto;
  padding: 2rem;
}
.guide-nav {
  display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
  margin-bottom: 1.5rem;
}
/* Language picker sits at the inline-end of the nav row, opposite
   the Back / Wiki buttons (RTL-aware). */
.guide-nav-locale { margin-inline-start: auto; }
.guide-nav-actions { display: flex; align-items: center; gap: 0.5rem; }

/* Hero */
.guide-hero {
  padding: 2.25rem 0 2.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2.25rem;
  scroll-margin-top: 1rem;
}
.guide-eyebrow {
  font-family: var(--font-sans);
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 0.75rem;
}
.guide-title {
  font-family: var(--font-sans);
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 600; font-style: normal;
  letter-spacing: -0.02em;
  color: var(--fg); line-height: 1.15;
  margin: 0 0 1rem;
}
/* "Welcome to DivingHQ" — the brand mark sits inside the
   sentence. Outer span is the bold-italic brand wrap; inner
   span splits HQ into cyan so the colour rhythm matches the
   home-page hero (DIVING white, HQ cyan). */
.guide-title-brand { color: var(--text); }
.guide-title-brand span { color: var(--cyan); }
.guide-lede {
  font-family: var(--font-sans);
  font-size: 15px; line-height: 1.6;
  color: var(--fg-2);
  max-width: 680px;
  margin: 0;
}

/* Two-column shell: sticky TOC on the left + content on the
   right. Collapses to a single column on narrow viewports,
   with the TOC flipping to a horizontal scroll strip pinned
   above the content. */
.guide-shell {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 2.5rem;
  align-items: flex-start;
}
.guide-toc {
  position: sticky;
  top: 1rem;
  align-self: flex-start;
  font-family: var(--font-sans);
  font-size: 12.5px;
  border-inline-start: 1px solid var(--border);
  padding-inline-start: 1rem;
}
.guide-toc-label {
  font-family: var(--font-sans);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 0.75rem;
}
.guide-toc-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 0.45rem;
}
.guide-toc-link {
  display: block;
  color: var(--text-2);
  text-decoration: none;
  padding: 0.2rem 0;
  border-inline-start: 2px solid transparent;
  margin-inline-start: -1rem;
  padding-inline-start: 1rem;
  transition: color 0.12s, border-color 0.12s;
}
.guide-toc-link:hover { color: var(--text); }
.guide-toc-link.is-active {
  color: var(--cyan);
  border-inline-start-color: var(--cyan);
  font-weight: 600;
}

.guide-content { min-width: 0; }
.guide-section {
  margin-bottom: 2.75rem;
  /* Compensate for the sticky page chrome so anchor jumps
     don't bury the heading under the nav. */
  scroll-margin-top: 1rem;
}
.guide-h2 {
  font-family: var(--font-sans);
  font-size: 20px; font-weight: 600; font-style: normal;
  letter-spacing: -0.01em;
  color: var(--fg);
  margin: 0 0 1.25rem;
}
.guide-section-lede {
  font-family: var(--font-sans);
  font-size: 13.5px; line-height: 1.6;
  color: var(--fg-2);
  margin: 0 0 1.25rem;
  max-width: 680px;
}

/* Role cards */
.guide-roles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 1rem;
}
.role-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 1.25rem 1.35rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.65rem;
  transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.role-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.role-icon { line-height: 1; color: var(--accent); }
.role-icon svg { width: 28px; height: 28px; }
.role-name {
  font-family: var(--font-sans);
  font-size: 16px; font-weight: 600; font-style: normal;
  letter-spacing: -0.01em;
  color: var(--fg); margin: 0;
}
.role-desc {
  font-family: var(--font-sans);
  font-size: 13px; line-height: 1.6;
  color: var(--fg-2); margin: 0;
}
.role-desc strong { color: var(--fg); font-weight: 600; }
.role-steps {
  font-family: var(--font-sans);
  font-size: 13px; line-height: 1.55;
  color: var(--fg-2);
  margin: 0; padding-inline-start: 1.2rem;
  display: flex; flex-direction: column; gap: 0.35rem;
}
.role-steps strong {
  color: var(--fg);
  font-weight: 600;
  font-family: var(--font-sans);
  letter-spacing: 0;
}
.role-steps a { color: var(--cyan); text-decoration: none; }
.role-steps a:hover { text-decoration: underline; }
.role-cta {
  font-family: var(--font-sans);
  font-size: 12.5px; font-weight: 600;
  letter-spacing: 0; text-transform: none;
  color: var(--accent); text-decoration: none;
  margin-top: 0.35rem;
  align-self: flex-start;
  transition: color 0.12s, transform 0.12s;
}
.role-cta:hover { color: var(--accent-hover); transform: translateX(2px); }

/* Quick-action tiles */
.guide-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 1rem;
}
.guide-tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  display: flex; flex-direction: column;
  box-shadow: var(--shadow-sm);
  transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.guide-tile:hover {
  border-color: var(--border-2);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
.guide-tile-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: var(--surface-2, rgba(255,255,255,0.02));
  overflow: hidden;
  display: flex; align-items: center; justify-content: center;
}
.guide-tile-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.guide-tile-thumb img[alt]:after {
  /* If the image is unreachable the broken-image placeholder
     looks awful; this stacks the glyph fallback underneath so
     a failed image gracefully reveals an emoji. */
  content: '';
}
.guide-tile-glyph {
  position: absolute;
  inset: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 48px;
  z-index: 0;
  opacity: 0.5;
}
.guide-tile-thumb img { position: relative; z-index: 1; }
.guide-tile-body {
  padding: 0.85rem 1rem 1rem;
  display: flex; flex-direction: column; gap: 0.2rem;
}
.guide-tile-label {
  font-family: var(--font-sans);
  font-size: 14px; font-weight: 600; font-style: normal;
  color: var(--fg);
}
.guide-tile-sub {
  font-family: var(--font-sans);
  font-size: 12px; line-height: 1.5;
  color: var(--fg-2);
}

/* Keyboard shortcuts */
.guide-shortcuts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.55rem 1.25rem;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.guide-shortcut-keys {
  display: flex; gap: 0.3rem; flex-wrap: wrap;
  margin: 0;
  align-items: center;
}
.guide-shortcut-keys kbd {
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 700;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0.1rem 0.45rem;
  min-width: 1.6rem;
  text-align: center;
}
.guide-shortcut-desc {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--fg-2);
  align-self: center;
  line-height: 1.5;
}

/* Glossary */
.guide-glossary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.6rem 1.25rem;
  margin: 0;
}
.guide-glossary-term {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 500; font-style: normal;
  color: var(--accent);
  margin: 0;
  align-self: start;
  padding-top: 0.1rem;
}
.guide-glossary-def {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 13.5px; line-height: 1.6;
  color: var(--fg-2);
}

/* FAQ — <details>/<summary> accordion */
.guide-faq {
  display: flex; flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.guide-faq-item + .guide-faq-item {
  border-top: 1px solid var(--border);
}
.guide-faq-item summary {
  cursor: pointer;
  list-style: none;
  padding: 0.9rem 1rem;
  font-family: var(--font-sans);
  font-size: 14px; font-weight: 600; font-style: normal;
  color: var(--fg);
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem;
  transition: background-color 0.12s;
}
.guide-faq-item summary::-webkit-details-marker { display: none; }
.guide-faq-item summary::after {
  content: '+';
  font-family: var(--font-mono);
  font-size: 18px; font-weight: 700;
  color: var(--cyan);
  transition: transform 0.15s;
}
.guide-faq-item[open] summary::after {
  content: '−';
}
.guide-faq-item summary:hover {
  background: var(--surface-hover);
}
.guide-faq-body {
  padding: 0 1rem 1rem;
  font-family: var(--font-sans);
  font-size: 13.5px; line-height: 1.65;
  color: var(--fg-2);
  border-inline-start: 2px solid var(--accent-soft-2);
  margin: 0 1rem 0.6rem;
  padding-inline-start: 1rem;
}
.guide-faq-body strong { color: var(--fg); font-weight: 600; }
.guide-faq-body a { color: var(--cyan); text-decoration: none; }
.guide-faq-body a:hover { text-decoration: underline; }

/* Where-to-next */
.guide-next-lede {
  font-family: var(--font-sans);
  font-size: 14px; line-height: 1.65;
  color: var(--fg-2);
  margin: 0 0 0.85rem;
}
.guide-next-lede a {
  color: var(--cyan); text-decoration: none; font-weight: 600;
}
.guide-next-lede a:hover { text-decoration: underline; }
.guide-next-list {
  margin: 0 0 1.5rem; padding-inline-start: 1.2rem;
  display: flex; flex-direction: column; gap: 0.5rem;
  font-family: var(--font-sans);
  font-size: 13.5px; line-height: 1.6;
  color: var(--fg-2);
}
.guide-next-list a {
  color: var(--cyan); text-decoration: none; font-weight: 600;
}
.guide-next-list a:hover { text-decoration: underline; }
.guide-cta-row {
  display: flex; gap: 0.75rem; flex-wrap: wrap;
  margin-top: 1rem;
}

/* Narrow viewports: collapse the TOC into a horizontal scroll
   strip pinned above the content. The strip is still sticky
   but slimmer, and the link spacing turns horizontal. */
@media (max-width: 860px) {
  .guide-shell {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .guide-toc {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg);
    border-inline-start: none;
    border-bottom: 1px solid var(--border);
    padding: 0.65rem 0;
    margin: 0 -2rem 0.5rem;
    padding-inline: 2rem;
    overflow-x: auto;
  }
  .guide-toc-label { display: none; }
  .guide-toc-list {
    flex-direction: row;
    gap: 1.2rem;
    white-space: nowrap;
  }
  .guide-toc-link {
    border-inline-start: none;
    border-bottom: 2px solid transparent;
    margin: 0;
    padding: 0.25rem 0;
  }
  .guide-toc-link.is-active {
    border-bottom-color: var(--cyan);
    border-inline-start-color: transparent;
  }
}

@media (max-width: 600px) {
  .guide-roles { grid-template-columns: 1fr; }
  .role-card { padding: 1rem 1rem 0.9rem; }
  .guide-shortcuts,
  .guide-glossary { grid-template-columns: 1fr; gap: 0.2rem 0; }
  .guide-shortcuts .guide-shortcut-desc { margin-bottom: 0.6rem; }
  .guide-glossary .guide-glossary-def { margin-bottom: 0.6rem; }
}

@media (prefers-reduced-motion: reduce) {
  .role-card, .guide-tile,
  .role-cta, .guide-toc-link {
    transition: none;
  }
}
</style>
