<script setup>
import { useI18n } from 'vue-i18n'
import { Calendar, MonitorPlay, Gavel } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import WorkflowCard from './WorkflowCard.vue'
import EventRow from './EventRow.vue'

const props = defineProps({
  operatorEvents: { type: Array, default: () => [] },
  workflowActions: { type: Array, default: () => [] },
  fmtCloses:      { type: Function, required: true },
})

const { t } = useI18n()

// Compose "<label> · <hint>" for a workflow action, falling back to
// a translated "Open event" when the server didn't supply a label.
function actionMeta(item) {
  const label = item.next_action?.label || t('dashboard.actions.open_event')
  return item.next_action?.hint ? `${label} · ${item.next_action.hint}` : label
}
function actionCount(item) {
  return item.ready ? t('dashboard.actions.ready') : t('dashboard.actions.left', { count: item.blockers?.length || 0 })
}
function eventMeta(ev) {
  if (ev.status === 'Upcoming' && ev.entries_close_at) return props.fmtCloses(ev.entries_close_at)
  if (ev.status === 'Completed') return t('dashboard.actions.completed')
  if (ev.status === 'Live') return t('dashboard.actions.open_control')
  return ''
}
</script>

<template>
  <section class="panel">
    <div v-if="!operatorEvents.length && !workflowActions.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">📅</div>
      <div class="empty-state-title">{{ $t('dashboard.empty.meet_manager_title') }}</div>
      <div class="empty-state-body">{{ $t('dashboard.empty.meet_manager_body') }}</div>
    </div>

    <div v-if="workflowActions.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.next_actions') }}</div>
      <WorkflowCard
        v-for="item in workflowActions.slice(0, 8)"
        :key="item.event_id"
        :to="item.next_action?.to || `/control?event=${item.event_id}`"
        :title="item.event_name"
        :pill="item.is_rehearsal ? $t('dashboard.actions.rehearsal') : ''"
        :meta="actionMeta(item)"
        :count="actionCount(item)"
        :ready="item.ready"
        :live="item.status === 'Live'"
      />
    </div>

    <div v-if="operatorEvents.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.your_events') }}</div>
      <EventRow
        v-for="ev in operatorEvents"
        :key="ev.id"
        :to="ev.status === 'Completed' ? `/scoreboard/${ev.id}` : `/control?event=${ev.id}`"
        :status="ev.status"
        :name="ev.name"
        :meta="eventMeta(ev)"
      />
    </div>

    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.go_to') }}</div>
      <div class="goto-grid">
        <GotoTile to="/manager" tone="amber" :icon="Calendar"
          :title="$t('dashboard.tiles.manager_title')" :desc="$t('dashboard.tiles.manager_desc')" />
        <GotoTile to="/control" tone="cyan" :icon="MonitorPlay"
          :title="$t('dashboard.tiles.control_title')" :desc="$t('dashboard.tiles.control_desc')" />
        <GotoTile to="/assign-judges" tone="cyan" :icon="Gavel"
          :title="$t('dashboard.tiles.assign_judges_title')" :desc="$t('dashboard.tiles.assign_judges_desc')" />
      </div>
    </div>
  </section>
</template>
