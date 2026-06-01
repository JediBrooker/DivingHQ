import { defineStore } from 'pinia'

// Client-only presentation state introduced by the "Marine CRM"
// redesign: the colour theme (light / dark) and whether the app
// shell's left sidebar is collapsed. Both persist to localStorage
// and apply to <html> so they survive reloads.
//
// The theme is ALSO applied by a tiny inline script in index.html
// before first paint (avoids a flash of the wrong theme). This
// store reads the same localStorage key, so the two never
// disagree; the store owns runtime changes after mount.
const THEME_KEY = 'dhq-theme'
const SIDEBAR_KEY = 'dhq-sidebar'

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    theme: readTheme(),
    sidebarCollapsed: readSidebarCollapsed(),
  }),
  actions: {
    // Reflect the current theme onto <html data-theme>. Safe to
    // call repeatedly; the dark token block keys off this attribute.
    applyTheme() {
      try {
        document.documentElement.dataset.theme = this.theme
      } catch {
        /* SSR / no-DOM guard — never throws in the browser. */
      }
    },
    setTheme(theme) {
      this.theme = theme === 'dark' ? 'dark' : 'light'
      try {
        localStorage.setItem(THEME_KEY, this.theme)
      } catch {
        /* private-mode / quota — non-fatal, theme still applies this session. */
      }
      this.applyTheme()
    },
    toggleTheme() {
      this.setTheme(this.theme === 'dark' ? 'light' : 'dark')
    },
    setSidebarCollapsed(collapsed) {
      this.sidebarCollapsed = !!collapsed
      try {
        localStorage.setItem(SIDEBAR_KEY, this.sidebarCollapsed ? '1' : '0')
      } catch {
        /* non-fatal */
      }
    },
    toggleSidebar() {
      this.setSidebarCollapsed(!this.sidebarCollapsed)
    },
  },
})
