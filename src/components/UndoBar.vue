<script setup>
// Global notify snackbar. Single instance mounted once at the
// top of App.vue. Reads from the shared useNotify state ref so
// any view's call to showNotify / showSuccess / showError /
// showWarning / showUndo lands here without prop-drilling.
//
// File name kept as UndoBar.vue for back-compat, the first
// shipped version was an Undo-only snackbar. The component now
// renders the full notify family.
import {
  useNotifyState,
  fireAction,
  dismissNotify,
} from '@/composables/useNotify'

const state = useNotifyState()

// Per-kind leading icon, empty for plain info so the toast
// stays quiet for incidental notifications.
const ICONS = {
  success: '✓',
  info:    '',
  warn:    '⚠',
  error:   '✕',
}
function iconFor(kind) { return ICONS[kind] ?? '' }
</script>

<template>
  <TransitionGroup name="notify-bar" tag="div" class="notify-stack">
    <div
      v-for="t in state"
      :key="t.id"
      :class="['notify-bar', `notify-bar-${t.kind}`]"
      role="status"
      aria-live="polite"
    >
      <span v-if="iconFor(t.kind)" class="notify-bar-icon">{{ iconFor(t.kind) }}</span>
      <span class="notify-bar-message">{{ t.message }}</span>
      <button
        v-if="t.onAction && t.actionLabel"
        class="notify-bar-action"
        @click="fireAction(t.id)"
        v-tip="`${t.actionLabel} this action`"
      >{{ t.actionLabel }}</button>
      <button
        class="notify-bar-close"
        @click="dismissNotify(t.id)"
        v-tip="'Dismiss'"
        aria-label="Dismiss"
      >✕</button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
/* Bottom-centre snackbar STACK, high z-index so it floats above
   modals and dropdowns, fixed to the viewport so it survives route
   changes inside the app shell. column-reverse keeps the newest toast
   lowest (where a single toast used to sit) and stacks the older ones on top. */
.notify-stack {
  position: fixed;
  inset-inline-start: 50%;
  /* Sit above the iOS home-indicator gesture zone on notch
     iPhones, falls back to design's 1.5rem on devices without insets. */
  bottom: max(1.5rem, calc(env(safe-area-inset-bottom, 0px) + 0.75rem));
  transform: translateX(-50%);
  z-index: 1000;
  display: flex; flex-direction: column-reverse; align-items: center; gap: 0.5rem;
  pointer-events: none;
}
.notify-bar {
  pointer-events: auto;
  display: flex; align-items: center; gap: 0.7rem;
  padding-block: 0.7rem;
  padding-inline: 1.1rem 1rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-inline-start-width: 4px;
  border-radius: 999px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font-family: var(--font-display);
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text);
  max-width: calc(100vw - 2rem);
}

/* Per-kind accent: left border + icon colour. Background
   stays consistent so the snackbar still reads as one family of
   chrome. */
.notify-bar-success { border-inline-start-color: var(--green); }
.notify-bar-success .notify-bar-icon { color: var(--green); }
.notify-bar-info    { border-inline-start-color: var(--cyan); }
.notify-bar-info    .notify-bar-icon { color: var(--cyan); }
.notify-bar-warn    { border-inline-start-color: var(--amber); }
.notify-bar-warn    .notify-bar-icon { color: var(--amber); }
.notify-bar-error   { border-inline-start-color: var(--red); }
.notify-bar-error   .notify-bar-icon { color: var(--red); }

.notify-bar-icon {
  font-size: 14px; line-height: 1;
  flex-shrink: 0;
}

.notify-bar-message {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 60vw;
}

.notify-bar-action {
  background: transparent;
  border: 1px solid rgba(6, 182, 212, 0.5);
  color: var(--cyan);
  font-family: inherit; font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  /* WCAG 2.5.5 minimum 44×44, this button is the user's last
     line of defence after an accidental destructive action. */
  min-height: 44px;
  padding: 0 1rem;
  display: inline-flex; align-items: center;
  border-radius: 999px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.notify-bar-action:hover { background: var(--cyan); color: var(--bg); }

.notify-bar-close {
  background: transparent; border: 0;
  color: var(--text-3); cursor: pointer;
  font-size: 14px; line-height: 1;
  padding: 0.2rem 0.4rem;
  transition: color 0.12s;
}
.notify-bar-close:hover { color: var(--text); }

.notify-bar-enter-active,
.notify-bar-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.notify-bar-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.notify-bar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
