<script setup>
import { RouterLink } from 'vue-router'
import { Waves, User, GitCompare, CalendarDays } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import DashboardEmptyState from './DashboardEmptyState.vue'

defineProps({
  diverNextMeet: { type: Object, default: null },
  /* The Live event, if there is one. When it's set we render the
     meet-day CTA card at the top of the panel, deep-linking to
     /me/meet/:eventId. The endpoint 403s for divers who aren't
     entered, so hiding this card for non-entrants happens
     server-side instead of some client-side predicate. */
  diverLiveMeet: { type: Object, default: null },
  fmtCloses:     { type: Function, required: true },
  /* The diver's profile has no date of birth or gender. Entry
     eligibility needs both for a men's / women's / age-group event,
     so the prompt sits above everything else until they're set. */
  detailsMissing: { type: Boolean, default: false },
})
</script>

<template>
  <section class="panel">
    <div v-if="detailsMissing" class="panel-section">
      <RouterLink to="/profile" class="diver-next-card details-prompt" data-test-id="details-prompt">
        <div class="details-prompt-ic" aria-hidden="true"><CalendarDays /></div>
        <div>
          <div class="diver-next-name">{{ $t('dashboard.diver_panel.details_title') }}</div>
          <div class="diver-next-meta">{{ $t('dashboard.diver_panel.details_body') }}</div>
        </div>
        <div class="diver-next-arrow" aria-hidden="true">→</div>
      </RouterLink>
    </div>

    <!-- Meet day card, shows up whenever a Live event is on. Diver
         opens this from the warm-up area or the deck and gets a
         focused "next dive / rank / what to score" view, way
         better than refreshing the public scoreboard. -->
    <div v-if="diverLiveMeet" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.meet_day_live') }}</div>
      <RouterLink :to="`/me/meet/${diverLiveMeet.id}`" class="diver-next-card md-cta">
        <div class="diver-next-name">{{ diverLiveMeet.name }}</div>
        <div class="diver-next-meta">{{ $t('dashboard.diver_panel.live_meta') }}</div>
        <div class="diver-next-arrow" aria-hidden="true">→</div>
      </RouterLink>
    </div>

    <div v-if="diverNextMeet" class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.your_next_meet') }}</div>
      <RouterLink to="/competitor" class="diver-next-card">
        <div class="diver-next-name">{{ diverNextMeet.name }}</div>
        <div class="diver-next-meta">
          {{ fmtCloses(diverNextMeet.entries_close_at) || $t('dashboard.diver_panel.next_fallback') }}
        </div>
        <div class="diver-next-arrow" aria-hidden="true">→</div>
      </RouterLink>
    </div>
    <DashboardEmptyState
      v-else-if="!diverLiveMeet"
      :icon="Waves"
      :title="$t('dashboard.empty.diver_title')"
      :body="$t('dashboard.empty.diver_body')"
    />

    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.go_to') }}</div>
      <div class="goto-grid">
        <GotoTile to="/competitor" tone="green" :icon="Waves"
          :title="$t('dashboard.tiles.competitor_title')" :desc="$t('dashboard.tiles.competitor_desc')" />
        <GotoTile to="/profile" tone="cyan" :icon="User"
          :title="$t('dashboard.tiles.profile_title')" :desc="$t('dashboard.tiles.profile_desc')" />
        <GotoTile to="/compare" tone="amber" :icon="GitCompare"
          :title="$t('dashboard.tiles.compare_title')" :desc="$t('dashboard.tiles.compare_desc')" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.details-prompt { display: flex; align-items: center; gap: 12px; border-color: var(--warn-fg); }
.details-prompt-ic { width: 34px; height: 34px; flex-shrink: 0; border-radius: var(--radius); background: var(--bg-sunken); color: var(--warn-fg); display: grid; place-items: center; }
</style>
