// Topic bodies load on demand, one small chunk per topic. Importing them
// all with ?raw put every topic's markdown (about 300KB) into the chunk you
// download to read just one of them. Filenames match slugs, which
// test/guide-anchors.test.js checks.
//
// Keep each topic literal on one line with slug before feature:
// lib/spa-shell.js reads this file as text to find the gated ones.
const BODIES = import.meta.glob('./content/*.md', { query: '?raw', import: 'default' })

export function loadTopicBody(slug) {
  const load = BODIES[`./content/${slug}.md`]
  return load ? load() : Promise.resolve(null)
}

export const GUIDE_SECTIONS = [
  {
    label: 'Start here',
    topics: [
      { slug: 'quick-start', title: 'Quick Start' },
      { slug: 'features', title: 'Features' },
    ],
  },
  {
    label: 'Meet managers',
    topics: [
      { slug: 'setting-up-a-meet', title: 'Setting Up a Meet' },
      { slug: 'session-scheduler', title: 'Session Scheduler' },
      { slug: 'running-a-meet', title: 'Running a Meet' },
      { slug: 'keyboard-shortcuts', title: 'Keyboard Shortcuts' },
      { slug: 'offline-competitions', title: 'Offline Competitions' },
    ],
  },
  {
    label: 'Officials, divers, spectators',
    topics: [
      { slug: 'judging', title: 'Judging' },
      { slug: 'diver-portal', title: 'Diver Portal' },
      { slug: 'scoreboard', title: 'Scoreboard' },
    ],
  },
  {
    label: 'Payments & classes',
    topics: [
      { slug: 'payments', title: 'Payments', feature: 'payments' },
      { slug: 'classes', title: 'Classes', feature: 'classes' },
    ],
  },
  {
    label: 'Administration',
    topics: [
      { slug: 'roles-and-permissions', title: 'Roles & Permissions' },
      { slug: 'admin-tasks', title: 'Admin Tasks' },
      { slug: 'languages', title: 'Languages & Translation' },
    ],
  },
  {
    label: 'Reference',
    topics: [
      { slug: 'venue-integration', title: 'Venue Integration' },
      { slug: 'faq', title: 'FAQ & Troubleshooting' },
    ],
  },
]

// A topic with a `feature` only exists while that kill switch is on
// (src/stores/features). `isOn` is the store's enabled(); leave it out and
// every topic counts, which is what a caller without the store wants.
// Sections whose topics all drop out go with them, so there's no empty
// "Payments & classes" header in the sidebar.
export function visibleSections(isOn = () => true) {
  return GUIDE_SECTIONS
    .map(s => ({ ...s, topics: s.topics.filter(t => !t.feature || isOn(t.feature)) }))
    .filter(s => s.topics.length)
}

function visibleTopics(isOn) {
  return visibleSections(isOn).flatMap(s => s.topics)
}

export function getTopicBySlug(slug, isOn) {
  return visibleTopics(isOn).find(t => t.slug === slug) ?? null
}

export function getAdjacentTopics(slug, isOn) {
  const all = visibleTopics(isOn)
  const idx = all.findIndex(t => t.slug === slug)
  return {
    prev: idx > 0 ? all[idx - 1] : null,
    next: idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null,
  }
}
