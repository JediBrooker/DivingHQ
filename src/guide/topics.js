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
      { slug: 'payments', title: 'Payments', md: payments },
      { slug: 'classes', title: 'Classes', md: classes },
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

const ALL_TOPICS = GUIDE_SECTIONS.flatMap(s => s.topics)

export function getTopicBySlug(slug) {
  return ALL_TOPICS.find(t => t.slug === slug) ?? null
}

export function getAdjacentTopics(slug) {
  const idx = ALL_TOPICS.findIndex(t => t.slug === slug)
  return {
    prev: idx > 0 ? ALL_TOPICS[idx - 1] : null,
    next: idx >= 0 && idx < ALL_TOPICS.length - 1 ? ALL_TOPICS[idx + 1] : null,
  }
}
