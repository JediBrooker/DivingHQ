<script setup>
/* Top-of-view banner showing offline + queue status.
 *
 * Visible when:
 *   * The socket is disconnected, OR
 *   * The outbox has any pending / failed / conflict entries
 *     (even when online, because that means a drain is in flight
 *     or just hit a transient failure).
 *
 * Driven by the useOutbox() composable so multiple views share
 * the same state without re-querying IDB.
 *
 * Place at the top of any view that initiates writes the outbox
 * tracks (JudgeView, ControlView, CoachView, CompetitorView).
 * Doesn't render anything when the feature flag is off or there's
 * nothing to show.
 */
import { computed } from 'vue'
import { useOutbox } from '@/composables/useOutbox'

const {
  enabled,
  hasActivity,
  isOffline,
  offlineSince,
  pendingCount,
  failedCount,
  conflictCount,
} = useOutbox()

// Human-readable elapsed time since disconnect. Updates every
// minute via the composable's 30s refresh tick; resolution to the
// minute is fine for the user-facing display.
const offlineDurationLabel = computed(() => {
  if (!offlineSince.value) return ''
  const elapsedSec = Math.floor((Date.now() - offlineSince.value.getTime()) / 1000)
  if (elapsedSec < 60) return `${elapsedSec}s`
  const mins = Math.floor(elapsedSec / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
})
</script>

<template>
  <Transition name="offline-banner">
    <div v-if="enabled && hasActivity.value"
         :class="['offline-banner', {
           'offline-banner--offline': isOffline.value,
           'offline-banner--conflict': conflictCount.value > 0,
           'offline-banner--failed': failedCount.value > 0 && conflictCount.value === 0,
         }]"
         role="status"
         aria-live="polite">
      <div class="offline-banner-pulse" aria-hidden="true"></div>
      <div class="offline-banner-text">
        <strong v-if="isOffline.value">
          {{ $t('offline_banner.offline_since', { duration: offlineDurationLabel }) }}
        </strong>
        <strong v-else>
          {{ $t('offline_banner.online_with_pending') }}
        </strong>
        <span class="offline-banner-meta">
          <template v-if="pendingCount.value > 0">
            ·
            {{ pendingCount.value === 1
              ? $t('offline_banner.queued_one')
              : $t('offline_banner.queued_many', { n: pendingCount.value }) }}
          </template>
          <template v-if="failedCount.value > 0">
            ·
            <span class="offline-banner-failed">
              {{ failedCount.value === 1
                ? $t('offline_banner.failed_one')
                : $t('offline_banner.failed_many', { n: failedCount.value }) }}
            </span>
          </template>
          <template v-if="conflictCount.value > 0">
            ·
            <span class="offline-banner-conflict">
              {{ conflictCount.value === 1
                ? $t('offline_banner.conflict_one')
                : $t('offline_banner.conflict_many', { n: conflictCount.value }) }}
            </span>
          </template>
        </span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.offline-banner {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.85rem;
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.4);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.4;
  position: sticky; top: 0; z-index: 10;
}
.offline-banner--offline {
  background: rgba(239, 68, 68, 0.12);
  border-bottom-color: rgba(239, 68, 68, 0.45);
}
.offline-banner--failed {
  background: rgba(239, 68, 68, 0.1);
  border-bottom-color: rgba(239, 68, 68, 0.4);
}
.offline-banner--conflict {
  background: rgba(217, 70, 239, 0.12);
  border-bottom-color: rgba(217, 70, 239, 0.45);
}

.offline-banner-pulse {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
  animation: pulse 1.5s ease-in-out infinite;
  flex: 0 0 auto;
}
.offline-banner--offline .offline-banner-pulse {
  background: #ef4444;
  box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
}
.offline-banner--conflict .offline-banner-pulse {
  background: #d946ef;
  box-shadow: 0 0 8px rgba(217, 70, 239, 0.6);
}

.offline-banner-text {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem;
  min-width: 0;
}
.offline-banner-text strong {
  font-family: var(--font-display);
  font-weight: 800; font-style: italic;
  font-size: 12px;
  letter-spacing: 0.02em;
}
.offline-banner-meta {
  color: var(--text-2);
  font-size: 11.5px;
}
.offline-banner-failed { color: #ef4444; font-weight: 600; }
.offline-banner-conflict { color: #d946ef; font-weight: 600; }

@keyframes pulse {
  0%, 100% { transform: scale(1);   opacity: 1;   }
  50%      { transform: scale(1.4); opacity: 0.4; }
}

/* Slide-down transition when the banner appears or hides. */
.offline-banner-enter-active,
.offline-banner-leave-active {
  transition: transform 0.18s ease-out, opacity 0.18s ease-out;
}
.offline-banner-enter-from,
.offline-banner-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .offline-banner-pulse { animation: none; }
  .offline-banner-enter-active,
  .offline-banner-leave-active { transition: none; }
}
</style>
