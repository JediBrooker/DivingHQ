<script setup>
/* Pre-meet readiness checklist, a compact "are we ready?" panel
 * for an event sitting in Setup status. Each row is one
 * prerequisite for Start Event. Clicking a not-done row jumps
 * you over to whatever surface fixes it.
 *
 * Items come in via props rather than being computed inline, so
 * the parent (usually ControlView or ManagerView) can translate
 * its own event/dive-list state into the small subset this
 * component actually needs. Keeps this component dumb and easy
 * to reuse elsewhere.
 *
 * Each item:
 *   { key, label, done, hint?, onFix?, severity?, blocking? }
 *
 * - key:   stable id (also used for storage)
 * - label: short imperative ("Roster locked")
 * - done:  boolean, checks the box and dims the row
 * - hint:  optional text shown when not done
 * - onFix: optional click handler to jump into the fix surface
 * - severity: optional 'critical' | 'warning' | 'info'
 * - blocking: optional false when the row is advisory only
 */
import { computed } from 'vue'

const props = defineProps({
  items:    { type: Array, required: true },
  /* Once everything's done, the checklist collapses into a
     single "Ready to start" line. Set to false to keep all rows
     visible anyway. */
  collapseWhenDone: { type: Boolean, default: true },
})

const total      = computed(() => props.items.length)
const doneCount  = computed(() => props.items.filter(i => i.done).length)
const allDone    = computed(() => total.value > 0 && doneCount.value === total.value)
const remaining  = computed(() => total.value - doneCount.value)

function itemSeverity(item) {
  if (item.done) return 'ok'
  return item.severity || (item.blocking === false ? 'info' : 'warning')
}

function severityLabel(item) {
  const severity = itemSeverity(item)
  if (severity === 'critical') return 'Critical'
  if (severity === 'warning') return 'Warning'
  if (severity === 'info') return 'Info'
  return ''
}
</script>

<template>
  <section
    class="readiness"
    :class="{ 'readiness-collapsed': allDone && collapseWhenDone, 'readiness-ready': allDone }"
  >
    <header class="readiness-header">
      <span class="readiness-title">
        <span class="readiness-emoji" aria-hidden="true">{{ allDone ? '✅' : '🚦' }}</span>
        <span v-if="allDone">Ready to start</span>
        <span v-else>Pre-meet checks · <strong>{{ doneCount }}</strong>/{{ total }}</span>
      </span>
      <span class="readiness-meter" v-if="!allDone">
        <span
          class="readiness-meter-fill"
          :style="{ width: total ? `${(doneCount / total) * 100}%` : '0%' }"
        />
      </span>
    </header>

    <ul v-if="!(allDone && collapseWhenDone)" class="readiness-list">
      <li
        v-for="item in items"
        :key="item.key"
        :class="[
          'readiness-row',
          `readiness-severity-${itemSeverity(item)}`,
          {
            'is-done': item.done,
            'is-actionable': !item.done && item.onFix,
            'is-advisory': !item.done && item.blocking === false,
          },
        ]"
        @click="!item.done && item.onFix && item.onFix()"
        @keydown.enter="!item.done && item.onFix && item.onFix()"
        :tabindex="!item.done && item.onFix ? 0 : -1"
        role="button"
      >
        <span class="readiness-check" aria-hidden="true">{{ item.done ? '☑' : '☐' }}</span>
        <span class="readiness-copy">
          <span class="readiness-label">{{ item.label }}</span>
          <span v-if="!item.done && item.hint" class="readiness-hint">{{ item.hint }}</span>
        </span>
        <span v-if="!item.done && severityLabel(item)" class="readiness-severity">
          {{ severityLabel(item) }}
        </span>
        <span v-if="!item.done && item.onFix" class="readiness-fix">Fix →</span>
      </li>
    </ul>

    <p v-if="allDone && !collapseWhenDone" class="readiness-ready-note">
      All prerequisites met. Start Event when you're ready.
    </p>
  </section>
</template>

<style scoped>
.readiness {
  align-self: stretch;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  background: var(--surface, #0f172a);
  border: 1px solid var(--border, #1e293b);
  border-inline-start: 4px solid #f59e0b;
  border-radius: var(--radius, 6px);
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  letter-spacing: 0;
  text-transform: none;
  transition: border-color 0.2s, padding 0.2s;
}
.readiness-ready { border-inline-start-color: var(--green, #10b981); }
.readiness-collapsed { padding: 0.55rem 1rem; }

.readiness-header {
  display: flex; align-items: center; gap: 0.85rem;
  min-width: 0;
  font-family: var(--font-display, sans-serif);
  font-size: 12px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-2, #cbd5e1);
}
.readiness-title {
  display: inline-flex; align-items: center; gap: 0.5rem;
  min-width: 0;
  flex: 0 1 auto;
}
.readiness-title > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.readiness-title strong { color: var(--text, #f8fafc); font-size: 13px; }
.readiness-emoji { font-size: 14px; }

.readiness-meter {
  flex: 1 1 auto;
  height: 4px;
  background: var(--bg-3, #1e293b);
  border-radius: 999px;
  overflow: hidden;
}
.readiness-meter-fill {
  display: block; height: 100%;
  background: linear-gradient(90deg, #f59e0b, var(--green, #10b981));
  transition: width 0.3s;
}

.readiness-list {
  list-style: none; padding: 0; margin: 0.85rem 0 0.1rem 0;
  display: flex; flex-direction: column; gap: 0.35rem;
  min-width: 0;
}

.readiness-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.15rem 0.65rem;
  min-width: 0;
  padding: 0.45rem 0.55rem;
  border-radius: var(--radius, 6px);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-2, #cbd5e1);
  transition: background 0.1s, color 0.1s;
}
.readiness-row.is-actionable { cursor: pointer; }
.readiness-row.is-actionable:hover,
.readiness-row.is-actionable:focus-visible {
  background: var(--bg-3, #1e293b);
  color: var(--text, #f8fafc);
  outline: none;
}
.readiness-row.is-done {
  color: var(--text-3, #94a3b8);
  text-decoration: line-through;
  text-decoration-color: var(--text-3, #94a3b8);
}
.readiness-row.is-advisory {
  border-inline-start: 2px solid var(--cyan, #06b6d4);
  padding-inline-start: 0.45rem;
}
.readiness-row.readiness-severity-critical:not(.is-done) {
  border-inline-start: 2px solid var(--red, #ef4444);
  padding-inline-start: 0.45rem;
}
.readiness-row.readiness-severity-warning:not(.is-done) {
  border-inline-start: 2px solid var(--amber, #f59e0b);
  padding-inline-start: 0.45rem;
}
.readiness-row.readiness-severity-info:not(.is-done) {
  border-inline-start: 2px solid var(--cyan, #06b6d4);
  padding-inline-start: 0.45rem;
}
.readiness-check { font-size: 15px; flex-shrink: 0; width: 18px; text-align: center; }
.readiness-row.is-done .readiness-check { color: var(--green, #10b981); }
.readiness-copy {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  text-align: start;
}
.readiness-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.readiness-hint  {
  display: block;
  min-width: 0;
  font-size: 11px; color: var(--text-3, #94a3b8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.readiness-severity {
  justify-self: end;
  border: 1px solid var(--border, #1e293b);
  border-radius: 999px;
  padding: 0.1rem 0.35rem;
  font-family: var(--font-display, sans-serif);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-2, #cbd5e1);
  background: var(--bg-3, #1e293b);
}
.readiness-severity-critical .readiness-severity {
  color: var(--red, #ef4444);
  border-color: color-mix(in srgb, var(--red, #ef4444) 45%, transparent);
}
.readiness-severity-warning .readiness-severity {
  color: var(--amber, #f59e0b);
  border-color: color-mix(in srgb, var(--amber, #f59e0b) 45%, transparent);
}
.readiness-severity-info .readiness-severity {
  color: var(--cyan, #06b6d4);
  border-color: color-mix(in srgb, var(--cyan, #06b6d4) 45%, transparent);
}
.readiness-fix {
  justify-self: end;
  font-family: var(--font-display, sans-serif);
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  color: var(--cyan, #06b6d4);
  text-transform: uppercase;
}

.readiness-ready-note {
  margin: 0.5rem 0 0 0;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--green, #10b981);
}
</style>
