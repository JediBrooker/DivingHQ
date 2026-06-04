<script setup>
// Org Admin tab panel. Lifted out of DashboardView so the
// chunk loads only when the user activates this tab. Shared
// CSS lives in src/styles/app.css (panel/, action-card/,
// activity-/ etc.). Attention-card copy is composed (and
// translated) by the parent and arrives ready to render.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Calendar, MonitorPlay, UserCog, ScrollText, Building2, Users, Gavel } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import WorkflowCard from './WorkflowCard.vue'

const props = defineProps({
  attentionCards:  { type: Array, default: () => [] },
  workflowActions: { type: Array, default: () => [] },
  recentActivity:  { type: Array, default: () => [] },
  fmtRelative:     { type: Function, required: true },
})

const { t } = useI18n()

function actionMeta(item) {
  const label = item.next_action?.label || t('dashboard.actions.open_event')
  return item.next_action?.hint ? `${label} · ${item.next_action.hint}` : label
}
function actionCount(item) {
  return item.ready ? t('dashboard.actions.ready') : t('dashboard.actions.left', { count: item.blockers?.length || 0 })
}
function scoreVerb(action) {
  if (action === 'update') return t('dashboard.activity.score_update')
  if (action === 'delete') return t('dashboard.activity.score_delete')
  return t('dashboard.activity.score_add')
}
</script>

<template>
  <section class="panel">
    <div v-if="!attentionCards.length && !workflowActions.length && !recentActivity.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">📊</div>
      <div class="empty-state-title">{{ $t('dashboard.empty.org_admin_title') }}</div>
      <div class="empty-state-body">{{ $t('dashboard.empty.org_admin_body') }}</div>
    </div>

    <div v-if="attentionCards.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.attention') }}</div>
      <RouterLink
        v-for="card in attentionCards"
        :key="card.id"
        :to="card.to"
        :class="['action-card', `action-card-${card.kind}`]"
      >
        <span class="action-card-icon">{{ card.icon }}</span>
        <span class="action-card-title">{{ card.title }}</span>
        <span v-if="card.meta" class="action-card-meta">{{ card.meta }}</span>
        <span class="action-card-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div v-if="workflowActions.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.event_readiness') }}</div>
      <WorkflowCard
        v-for="item in workflowActions.slice(0, 6)"
        :key="item.event_id"
        :to="item.next_action?.to || `/control?event=${item.event_id}`"
        :title="item.event_name"
        :meta="actionMeta(item)"
        :count="actionCount(item)"
        :ready="item.ready"
        :live="item.status === 'Live'"
      />
    </div>

    <div v-if="recentActivity.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.recent_activity') }}</div>
      <ul class="activity-list">
        <li v-for="r in recentActivity" :key="`${r.kind}-${r.id}`" class="activity-item">
          <span class="activity-time">{{ fmtRelative(r.created_at) }}</span>
          <span class="activity-text">
            <template v-if="r.kind === 'score'">
              <strong>{{ r.competitor_name || $t('dashboard.activity.competitor_fallback') }}</strong>
              {{ scoreVerb(r.action) }}
              {{ r.event_name }}<template v-if="r.round_number"> · R{{ r.round_number }}</template>
            </template>
            <template v-else-if="r.kind === 'role'">
              <strong>{{ r.role }}</strong> {{ r.action }} {{ r.action === 'granted' ? $t('dashboard.activity.role_to') : $t('dashboard.activity.role_from') }} <strong>{{ r.target_name }}</strong>
            </template>
            <template v-else>
              <strong>{{ r.entity_name || r.entity_type }}</strong> · {{ r.action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ') }}
            </template>
          </span>
        </li>
      </ul>
      <RouterLink to="/audit" class="panel-section-link">{{ $t('dashboard.activity.view_full_log') }}</RouterLink>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.go_to') }}</div>
      <div class="goto-grid">
        <GotoTile to="/manager" tone="amber" :icon="Calendar"
          :title="$t('dashboard.tiles.manager_title')" :desc="$t('dashboard.tiles.manager_desc')" />
        <GotoTile to="/control" tone="cyan" :icon="MonitorPlay"
          :title="$t('dashboard.tiles.control_title')" :desc="$t('dashboard.tiles.control_desc')" />
        <GotoTile to="/users" tone="purple" :icon="UserCog"
          :title="$t('dashboard.tiles.users_title')" :desc="$t('dashboard.tiles.users_desc')" />
        <GotoTile to="/audit" tone="amber" :icon="ScrollText"
          :title="$t('dashboard.tiles.audit_title')" :desc="$t('dashboard.tiles.audit_desc')" />
        <GotoTile to="/clubs" tone="green" :icon="Building2"
          :title="$t('dashboard.tiles.clubs_title')" :desc="$t('dashboard.tiles.clubs_desc')" />
        <GotoTile to="/teams" tone="purple" :icon="Users"
          :title="$t('dashboard.tiles.teams_title')" :desc="$t('dashboard.tiles.teams_desc')" />
        <GotoTile to="/assign-judges" tone="cyan" :icon="Gavel"
          :title="$t('dashboard.tiles.assign_judges_title')" :desc="$t('dashboard.tiles.assign_judges_desc')" />
      </div>
    </div>
  </section>
</template>
