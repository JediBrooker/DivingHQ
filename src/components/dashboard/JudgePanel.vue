<script setup>
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Gavel } from '@lucide/vue'
import EventRow from './EventRow.vue'
import DashboardEmptyState from './DashboardEmptyState.vue'

defineProps({
  judgeEvents: { type: Array, default: () => [] },
})

const { t } = useI18n()

const roundsJudges = (ev) => t('dashboard.judge_panel.rounds_judges', {
  rounds: ev.total_rounds, judges: ev.number_of_judges,
})
</script>

<template>
  <section class="panel">
    <DashboardEmptyState
      v-if="!judgeEvents.length"
      :icon="Gavel"
      :title="$t('dashboard.empty.judge_title')"
      :body="$t('dashboard.empty.judge_body')"
    />

    <!-- Self-service Judge Analysis link — surfaces independently of
         live assignments so a judge can review their tracking
         between meets. The metrics on /judge-profile compare each
         award against the panel-kept mean (post World Aquatics trim,
         PART FOUR Article 13). -->
    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.your_tools') }}</div>
      <RouterLink to="/judge-profile" class="judge-tool-row">
        <span class="judge-tool-icon">📊</span>
        <span class="judge-tool-text">
          <span class="judge-tool-title">{{ $t('dashboard.judge_panel.analysis_title') }}</span>
          <span class="judge-tool-desc">{{ $t('dashboard.judge_panel.analysis_desc') }}</span>
        </span>
        <span class="event-row-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div v-if="judgeEvents.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.your_assigned_events') }}</div>
      <EventRow
        v-for="ev in judgeEvents"
        :key="ev.id"
        :to="`/judge?event=${ev.id}`"
        :status="ev.status"
        :name="ev.name"
        :meta="roundsJudges(ev)"
      />
    </div>
  </section>
</template>

<style scoped>
.judge-tool-row {
  display: grid;
  grid-template-columns: 32px 1fr 24px;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: var(--bg-2, #0f172a);
  border: 1px solid var(--border, rgba(148,163,184,0.18));
  border-radius: var(--radius);
  text-decoration: none;
  transition: all 0.15s;
}
.judge-tool-row:hover {
  border-color: var(--cyan, #06b6d4);
  background: rgba(6,182,212,0.06);
}
.judge-tool-icon { font-size: 22px; line-height: 1; }
.judge-tool-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.judge-tool-title {
  font-family: var(--font-display); font-size: 13px; font-weight: 800;
  color: var(--text); letter-spacing: 0.05em;
}
.judge-tool-desc {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  line-height: 1.35;
}
</style>
