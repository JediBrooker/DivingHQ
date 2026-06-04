<script setup>
import { useI18n } from 'vue-i18n'
import { GraduationCap, GitCompare } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import WorkflowCard from './WorkflowCard.vue'
import DashboardEmptyState from './DashboardEmptyState.vue'

defineProps({
  coachData:      { type: Object, default: null },
  coachWorkbench: { type: Object, default: null },
})

const { t } = useI18n()

const roundsMeta = (row) => t('dashboard.coach.rounds_meta', {
  event: row.event_name, entered: row.rows_entered, total: row.total_rounds,
})
const closingMeta = (row) => t('dashboard.coach.closing_soon', { event: row.event_name })
</script>

<template>
  <section class="panel">
    <DashboardEmptyState
      v-if="!coachData?.divers?.length"
      :icon="GraduationCap"
      :title="$t('dashboard.empty.coach_title')"
      :body="$t('dashboard.empty.coach_body')"
    />
    <div v-if="coachData?.divers?.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.your_divers', { count: coachData.divers.length }) }}</div>
      <p class="panel-blurb">{{ $t('dashboard.blurbs.coach_divers') }}</p>
    </div>

    <div v-if="coachWorkbench?.live?.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.live_squad') }}</div>
      <WorkflowCard
        v-for="row in coachWorkbench.live.slice(0, 5)"
        :key="`live-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        :title="row.diver_name"
        :meta="row.event_name"
        :count="$t('dashboard.actions.live')"
        live
      />
    </div>

    <div v-if="coachWorkbench?.incomplete_lists?.length || coachWorkbench?.closing_soon?.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.dive_list_workbench') }}</div>
      <WorkflowCard
        v-for="row in coachWorkbench.incomplete_lists.slice(0, 6)"
        :key="`missing-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        :title="row.diver_name"
        :meta="roundsMeta(row)"
        :count="$t('dashboard.actions.fix_list')"
      />
      <WorkflowCard
        v-for="row in coachWorkbench.closing_soon.slice(0, 4)"
        :key="`closing-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        :title="row.diver_name"
        :meta="closingMeta(row)"
        :count="$t('dashboard.actions.review')"
        ready
      />
    </div>

    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.go_to') }}</div>
      <div class="goto-grid">
        <GotoTile to="/coach" tone="purple" :icon="GraduationCap"
          :title="$t('dashboard.tiles.coach_title')" :desc="$t('dashboard.tiles.coach_desc')" />
        <GotoTile to="/compare" tone="amber" :icon="GitCompare"
          :title="$t('dashboard.tiles.compare_title')" :desc="$t('dashboard.tiles.compare_desc')" />
      </div>
    </div>
  </section>
</template>
