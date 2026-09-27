import quickStart from './content/quick-start.md?raw'
import features from './content/features.md?raw'
import rolesAndPermissions from './content/roles-and-permissions.md?raw'
import settingUpAMeet from './content/setting-up-a-meet.md?raw'
import sessionScheduler from './content/session-scheduler.md?raw'
import runningAMeet from './content/running-a-meet.md?raw'
import keyboardShortcuts from './content/keyboard-shortcuts.md?raw'
import judging from './content/judging.md?raw'
import diverPortal from './content/diver-portal.md?raw'
import scoreboard from './content/scoreboard.md?raw'
import adminTasks from './content/admin-tasks.md?raw'
import languages from './content/languages.md?raw'
import payments from './content/payments.md?raw'
import classes from './content/classes.md?raw'
import offlineCompetitions from './content/offline-competitions.md?raw'
import venueIntegration from './content/venue-integration.md?raw'
import faq from './content/faq.md?raw'

export const GUIDE_SECTIONS = [
  {
    label: 'Start here',
    topics: [
      { slug: 'quick-start', title: 'Quick Start', md: quickStart },
      { slug: 'features', title: 'Features', md: features },
    ],
  },
  {
    label: 'Meet managers',
    topics: [
      { slug: 'setting-up-a-meet', title: 'Setting Up a Meet', md: settingUpAMeet },
      { slug: 'session-scheduler', title: 'Session Scheduler', md: sessionScheduler },
      { slug: 'running-a-meet', title: 'Running a Meet', md: runningAMeet },
      { slug: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', md: keyboardShortcuts },
      { slug: 'offline-competitions', title: 'Offline Competitions', md: offlineCompetitions },
    ],
  },
  {
    label: 'Officials, divers, spectators',
    topics: [
      { slug: 'judging', title: 'Judging', md: judging },
      { slug: 'diver-portal', title: 'Diver Portal', md: diverPortal },
      { slug: 'scoreboard', title: 'Scoreboard', md: scoreboard },
    ],
  },
  {
    label: 'Payments & classes',
    topics: [
      { slug: 'payments', title: 'Payments', md: payments, feature: 'payments' },
      { slug: 'classes', title: 'Classes', md: classes, feature: 'classes' },
    ],
  },
  {
    label: 'Administration',
    topics: [
      { slug: 'roles-and-permissions', title: 'Roles & Permissions', md: rolesAndPermissions },
      { slug: 'admin-tasks', title: 'Admin Tasks', md: adminTasks },
      { slug: 'languages', title: 'Languages & Translation', md: languages },
    ],
  },
  {
    label: 'Reference',
    topics: [
      { slug: 'venue-integration', title: 'Venue Integration', md: venueIntegration },
      { slug: 'faq', title: 'FAQ & Troubleshooting', md: faq },
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
