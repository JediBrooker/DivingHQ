<script setup>
import { useI18n } from 'vue-i18n'
import { ClipboardCheck } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import WorkflowCard from './WorkflowCard.vue'
import EventRow from './EventRow.vue'

defineProps({
  refereeDesk: { type: Object, default: null },
})

const { t } = useI18n()

function signoffMeta(req) {
  return t('dashboard.referee.signoff_requested_by', {
    name: req.requested_by_name || t('dashboard.referee.meet_manager_fallback'),
  })
}
</script>

<template>
  <section class="panel">
    <div v-if="refereeDesk?.pending_signoffs?.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.waiting_for_you') }}</div>
      <WorkflowCard
        v-for="req in refereeDesk.pending_signoffs"
        :key="req.request_id"
        :to="`/control?signoff_request=${req.request_id}`"
        :title="req.event_name"
        :meta="signoffMeta(req)"
        :count="$t('dashboard.actions.sign_off')"
        ready
      />
    </div>

    <div v-if="refereeDesk?.live_events?.length" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.live_now') }}</div>
      <EventRow
        v-for="ev in refereeDesk.live_events"
        :key="ev.event_id"
        :to="`/control?event=${ev.event_id}`"
        status="Live"
        status-label="LIVE"
        :name="ev.event_name"
        :meta="$t('dashboard.actions.open_control')"
      />
    </div>

    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.as_referee') }}</div>
      <p class="panel-blurb">{{ $t('dashboard.blurbs.referee') }}</p>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.go_to') }}</div>
      <div class="goto-grid">
        <GotoTile to="/sign-off-codes" tone="amber" :icon="ClipboardCheck"
          :title="$t('dashboard.tiles.sign_off_title')" :desc="$t('dashboard.tiles.sign_off_desc')" />
      </div>
    </div>
  </section>
</template>
