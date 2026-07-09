<script setup>
/* Empty-state card with a built-in next-action affordance.
 *
 * Empty state is the highest-leverage place to teach a new user
 * what to do next. This component standardises the look and
 * forces every empty state in app to specify a concrete
 * "do this next" link or button rather than just saying "no
 * results".
 *
 * Usage:
 *
 *   <EmptyState
 *     icon="trophy"
 *     v-tip="'No events yet'"
 *     body="Create your first competition to start collecting
 *           dives and scores."
 *     action-label="Create event"
 *     action-to="/manager?new=1"
 *   />
 *
 *   or, when the action is a function (modal opener etc.):
 *
 *   <EmptyState ... :on-action="() => openCreateModal()" />
 *
 *   or, no action (truly informational):
 *
 *   <EmptyState icon="mailbox" v-tip="'Inbox zero'" body="…" />
 *
 * The component is intentionally generic, pages with bespoke
 * needs (the Org Admin "All quiet" panel) keep their own markup.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  icon:        { type: String, default: '✦' },
  title:       { type: String, required: true },
  body:        { type: String, default: '' },
  /* Action: pass exactly one of these:
     - actionTo:    router-link target (string or RouteLocation)
     - actionHref:  external link (anchor)
     - onAction:    callback fired on click
   */
  actionTo:    { type: [String, Object], default: null },
  actionHref:  { type: String, default: null },
  onAction:    { type: Function, default: null },
  actionLabel: { type: String, default: null },
  /* Visual variant: 'card' (default, bordered) or 'inline'
     (no border, used inside an existing panel). */
  variant:     { type: String, default: 'card' },
})

const hasAction = computed(() =>
  !!(props.actionLabel && (props.actionTo || props.actionHref || props.onAction))
)
</script>

<template>
  <div :class="['empty-state', `empty-state-${variant}`]">
    <div class="empty-state-icon" aria-hidden="true">{{ icon }}</div>
    <div class="empty-state-title">{{ title }}</div>
    <div v-if="body" class="empty-state-body">{{ body }}</div>
    <RouterLink
      v-if="hasAction && actionTo"
      :to="actionTo"
      class="btn btn-primary empty-state-action"
    >{{ actionLabel }} →</RouterLink>
    <a
      v-else-if="hasAction && actionHref"
      :href="actionHref"
      class="btn btn-primary empty-state-action"
    >{{ actionLabel }} →</a>
    <button
      v-else-if="hasAction"
      type="button"
      class="btn btn-primary empty-state-action"
      @click="onAction"
    >{{ actionLabel }} →</button>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex; flex-direction: column; align-items: center; gap: 0.55rem;
  padding: 2rem 1.5rem;
  text-align: center;
  max-width: 480px;
  margin: 1rem auto;
}
.empty-state-card {
  background: var(--surface, #0f172a);
  border: 1px dashed var(--border-2, #334155);
  border-radius: var(--radius-lg, 12px);
}
.empty-state-icon {
  font-size: 32px; line-height: 1;
}
.empty-state-title {
  font-family: var(--font-display, sans-serif);
  font-size: 16px; font-weight: 800; font-style: italic;
  color: var(--text, #f8fafc);
}
.empty-state-body {
  font-family: var(--font-mono, monospace);
  font-size: 13px; line-height: 1.55;
  color: var(--text-3, #94a3b8);
  max-width: 380px;
}
.empty-state-action {
  margin-top: 0.85rem;
  text-decoration: none;
}
</style>
