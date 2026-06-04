<script setup>
import { Trophy, BookOpen, GitCompare } from '@lucide/vue'
import GotoTile from './GotoTile.vue'
</script>

<template>
  <section class="panel">
    <div class="panel-section">
      <div class="panel-section-label">{{ $t('dashboard.sections.other_surfaces') }}</div>
      <div class="goto-grid">
        <GotoTile to="/scoreboard" tone="red" :icon="Trophy"
          :title="$t('dashboard.tiles.scoreboard_title')" :desc="$t('dashboard.tiles.scoreboard_desc')" />
        <GotoTile to="/dive-directory" tone="cyan" :icon="BookOpen"
          :title="$t('dashboard.tiles.dive_directory_title')" :desc="$t('dashboard.tiles.dive_directory_desc')" />
        <GotoTile to="/compare" tone="amber" :icon="GitCompare"
          :title="$t('dashboard.tiles.compare_title')" :desc="$t('dashboard.tiles.compare_desc')" />
      </div>
    </div>
  </section>
</template>
