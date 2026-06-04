<script setup>
import { RouterLink } from 'vue-router'
import { Waves, User, GitCompare } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
import DashboardEmptyState from './DashboardEmptyState.vue'

defineProps({
  diverNextMeet: { type: Object, default: null },
  /* The Live event (if any) — when present we render the
     meet-day CTA card at the top of the panel, deep-linking to
     /me/meet/:eventId. The endpoint 403s for divers who aren't
     entered, so this card hiding itself for non-entrants
     happens server-side rather than via a client predicate. */
  diverLiveMeet: { type: Object, default: null },
  fmtCloses:     { type: Function, required: true },
})
</script>

<template>
  <section class="panel">
    <!-- Meet day card — visible whenever a Live event is on.
         The diver opens this from the warm-up area or the deck
         and gets a focused "next dive / rank / what to score"
         view that beats refreshing the public scoreboard. -->
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
