<script setup>
// Light / Dark theme switch, two shapes:
//   <ThemeToggle />          — segmented Light|Dark control (sidebar footer, profile)
//   <ThemeToggle compact />  — single icon button (top bar, sign-in screen)
// Backed by the Pinia UI store so every instance stays in sync
// and the choice persists. Icons are inline outline SVGs in the
// Lucide “sun” / “moon” style (24px, 2px stroke, currentColor).
import { computed } from 'vue'
import { useUiStore } from '@/stores/ui'

defineProps({
  compact: { type: Boolean, default: false },
})

const ui = useUiStore()
const isDark = computed(() => ui.theme === 'dark')
</script>

<template>
  <button
    v-if="compact"
    type="button"
    class="tt-compact"
    :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
    v-tip:bottom="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
    @click="ui.toggleTheme()"
  >
    <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  </button>

  <div v-else class="theme-toggle" role="group" aria-label="Theme">
    <button type="button" :class="{ on: !isDark }" @click="ui.setTheme('light')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
      Light
    </button>
    <button type="button" :class="{ on: isDark }" @click="ui.setTheme('dark')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
      Dark
    </button>
  </div>
</template>

<style scoped>
/* Segmented control — sidebar footer / profile preferences */
.theme-toggle {
  display: flex;
  gap: 3px;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 3px;
}
.theme-toggle button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-2);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.theme-toggle button svg { width: 14px; height: 14px; }
.theme-toggle button:hover { color: var(--fg); }
.theme-toggle button.on {
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow-xs);
}

/* Compact single-button — top bar / sign-in */
.tt-compact {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg-2);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.tt-compact:hover { background: var(--surface-hover); color: var(--fg); }
.tt-compact svg { width: 18px; height: 18px; }
</style>
