<script setup>
/* BroadcastModal — the Control Room broadcast chooser, extracted
 * from ControlView.vue. Covers the five operator scenarios:
 * operator broadcast (this screen), single-event audience window,
 * multi-event picker, OBS / streaming overlay instructions, and
 * the Daktronics venue-bridge command panel.
 *
 * State boundary: chooser/picker state comes from
 * @/composables/useBroadcastChooser (called HERE now, not in the
 * view); the OBS overlay-URL + venue-bridge command state is
 * owned here. The parent opens the modal imperatively via the
 * exposed open() — it has no other coupling besides the `event`
 * prop and the close-header-menu emit (legacy ⋯-menu cleanup the
 * chooser fires when the operator commits to a broadcast window).
 *
 * Body-scroll lock: registered here for the chooser + venue
 * panel; the composable refcounts, so the lock composes with the
 * parent's lockWhile exactly as before the extraction.
 */
import { ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useBroadcastChooser } from '@/composables/useBroadcastChooser'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'

const props = defineProps({
  event: { type: Object, default: null },
})
const emit = defineEmits(['close-header-menu'])

const {
  broadcastChoiceOpen,
  broadcastPickerOpen,
  broadcastLiveEvents,
  broadcastLiveLoading,
  broadcastLiveError,
  broadcastSelection,
  broadcastOpenDisabled,
  obsInstructionsOpen,
  openBroadcastInNewWindow,
  pickBroadcastAll,
  toggleBroadcastSelection,
  broadcastSelectAll,
  broadcastSelectNone,
  confirmBroadcastPicker,
} = useBroadcastChooser({
  closeHeaderMenu: () => emit('close-header-menu'),
})

// OBS / streaming-app instructions panel — option 4 in the
// broadcast chooser. The chroma-key overlay URL is the existing
// `/scoreboard/<id>?overlay=1` endpoint; we surface it here as
// an absolute URL the operator can paste straight into OBS
// Studio's Browser Source dialog. `obsCopyState` drives the
// transient "Copied!" feedback on the copy button.
const obsCopyState = ref('idle') // 'idle' | 'copied' | 'failed'
const obsOverlayUrl = computed(() => {
  const id = props.event?.id
  if (!id) return ''
  // Absolute URL — when pasted into OBS it has to resolve from
  // outside this app context, so build from window.location.
  const origin = typeof window !== 'undefined' && window.location
    ? window.location.origin
    : ''
  return `${origin}/scoreboard/${id}?overlay=1`
})
async function copyObsUrl() {
  const url = obsOverlayUrl.value
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    obsCopyState.value = 'copied'
  } catch {
    obsCopyState.value = 'failed'
  }
  setTimeout(() => { obsCopyState.value = 'idle' }, 1800)
}

// Venue hardware bridge instructions — option 5 in the
// Broadcast chooser. The browser cannot start a process on the
// venue laptop, so this panel turns the selected event into
// copyable bridge commands and a direct diagnostic URL.
const daktronicsInstructionsOpen = ref(false)
const daktronicsCopyState = ref('') // '' | 'dry' | 'udp' | 'json' | 'snapshot' | 'failed'
const bridgeAppUrl = computed(() => (
  typeof window !== 'undefined' && window.location
    ? window.location.origin
    : ''
))
const venueStateUrl = computed(() => {
  const id = props.event?.id
  if (!id || !bridgeAppUrl.value) return ''
  return `${bridgeAppUrl.value}/api/venue/scoreboard-state/${id}`
})
const bridgeBaseCommand = computed(() => {
  const id = props.event?.id
  if (!id || !bridgeAppUrl.value) return ''
  return `npm run venue:daktronics -- --app-url ${bridgeAppUrl.value} --event-id ${id}`
})
const daktronicsDryRunCommand = computed(() => (
  bridgeBaseCommand.value ? `${bridgeBaseCommand.value} --once` : ''
))
const daktronicsUdpCommand = computed(() => (
  bridgeBaseCommand.value
    ? `${bridgeBaseCommand.value} --transport udp --host 192.168.0.255 --broadcast --data-source 0`
    : ''
))
const daktronicsJsonCommand = computed(() => (
  bridgeBaseCommand.value
    ? `${bridgeBaseCommand.value} --transport tcp --host 192.168.1.50 --port 21000 --format json`
    : ''
))
async function copyDaktronicsText(kind, text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    daktronicsCopyState.value = kind
  } catch {
    daktronicsCopyState.value = 'failed'
  }
  setTimeout(() => { daktronicsCopyState.value = '' }, 1800)
}

// Same lock terms the parent's composed computed used to carry
// for this modal.
useBodyScrollLock().lockWhile(computed(() =>
  broadcastChoiceOpen.value ||
  daktronicsInstructionsOpen.value
))

// Imperative opener — the header Broadcast button calls this via
// a template ref.
function open() {
  broadcastChoiceOpen.value = true
}
defineExpose({ open })
</script>

<template>
  <!-- Broadcast chooser. Covers the realistic operator scenarios:
       kiosk this screen, audience projector, multi-event projector,
       streaming overlay, and venue hardware bridge setup. -->
  <BaseModal :open="broadcastChoiceOpen" max-width="min(96vw, 760px)"
             @close="broadcastChoiceOpen = false; broadcastPickerOpen = false; obsInstructionsOpen = false; daktronicsInstructionsOpen = false">
    <template #default="{ titleId }">
      <ModalHeader
        :title-id="titleId"
        :title="$t('control.modals.broadcast_title')"
        @close="broadcastChoiceOpen = false; broadcastPickerOpen = false; obsInstructionsOpen = false; daktronicsInstructionsOpen = false"
      >
        <template v-if="broadcastPickerOpen">{{ $t('control.modals.broadcast_sub_picker') }}</template>
        <template v-else-if="obsInstructionsOpen">{{ $t('control.modals.broadcast_sub_obs') }}</template>
        <template v-else-if="daktronicsInstructionsOpen">{{ $t('control.modals.broadcast_sub_dak') }}</template>
        <template v-else>{{ $t('control.modals.broadcast_sub_default') }}</template>
      </ModalHeader>
      <!-- Default chooser body. Hidden while either sub-panel
           (multi-event picker, OBS instructions, venue hardware
           instructions) is open so the operator sees one panel
           at a time. -->
      <div v-if="!broadcastPickerOpen && !obsInstructionsOpen && !daktronicsInstructionsOpen" class="lb-body broadcast-chooser-body">
        <!-- 1. Operator broadcast — inline on this screen. -->
        <RouterLink
          to="/control?broadcast=1"
          class="broadcast-option"
          @click="broadcastChoiceOpen = false; $emit('close-header-menu')">
          <div class="broadcast-option-glyph">🖥️</div>
          <div class="broadcast-option-text">
            <div class="broadcast-option-title">{{ $t('control.modals.broadcast_option_operator_title') }}</div>
            <div class="broadcast-option-desc">
              {{ $t('control.modals.broadcast_option_operator_desc') }}
            </div>
          </div>
        </RouterLink>

        <!-- 2. Audience broadcast for THIS event in a new window. -->
        <button class="broadcast-option"
                type="button"
                @click="openBroadcastInNewWindow(`/scoreboard/${event.id}/broadcast`)">
          <div class="broadcast-option-glyph">📡</div>
          <div class="broadcast-option-text">
            <div class="broadcast-option-title">{{ $t('control.modals.broadcast_option_event_title') }}</div>
            <div class="broadcast-option-desc">
              {{ $t('control.modals.broadcast_option_event_desc_prefix') }}
              <strong>{{ event?.name || $t('control.modals.broadcast_option_event_fallback') }}</strong>
              {{ $t('control.modals.broadcast_option_event_desc_suffix') }}
            </div>
          </div>
        </button>

        <!-- 3. Multi-event audience broadcast. Expands an inline
             sub-picker so the operator can tick the subset of
             Live events to project. With 0 or 1 Live events the
             picker is skipped (handled in pickBroadcastAll). -->
        <button class="broadcast-option"
                type="button"
                :disabled="broadcastLiveLoading"
                @click="pickBroadcastAll">
          <div class="broadcast-option-glyph">📺</div>
          <div class="broadcast-option-text">
            <div class="broadcast-option-title">
              {{ $t('control.modals.broadcast_option_pick_title') }}
            </div>
            <div class="broadcast-option-desc">
              <template v-if="broadcastLiveLoading">{{ $t('control.modals.broadcast_option_pick_loading') }}</template>
              <template v-else>
                {{ $t('control.modals.broadcast_option_pick_desc') }}
              </template>
            </div>
            <div v-if="broadcastLiveError" class="broadcast-picker-error">
              {{ broadcastLiveError }}
            </div>
          </div>
        </button>

        <!-- 4. OBS / live-streaming setup instructions. Doesn't
             open a new window — expands an inline sub-panel
             with the chroma-key overlay URL and a Browser
             Source how-to. Disabled when no event is selected
             (the overlay URL needs an event id to compose). -->
        <button class="broadcast-option"
                type="button"
                :disabled="!event"
                @click="obsInstructionsOpen = true">
          <div class="broadcast-option-glyph">🎬</div>
          <div class="broadcast-option-text">
            <div class="broadcast-option-title">
              {{ $t('control.modals.broadcast_option_obs_title') }}
            </div>
            <div class="broadcast-option-desc">
              {{ $t('control.modals.broadcast_option_obs_desc') }}
            </div>
          </div>
        </button>

        <!-- 5. Venue hardware bridge setup. Expands an inline
             panel with copyable commands for the local bridge
             process that feeds Daktronics RTD / ERTD ingest. -->
        <button class="broadcast-option"
                type="button"
                :disabled="!event"
                @click="daktronicsInstructionsOpen = true">
          <div class="broadcast-option-glyph">▣</div>
          <div class="broadcast-option-text">
            <div class="broadcast-option-title">
              {{ $t('control.modals.broadcast_option_dak_title') }}
            </div>
            <div class="broadcast-option-desc">
              {{ $t('control.modals.broadcast_option_dak_desc') }}
            </div>
          </div>
        </button>
      </div>

      <!-- Sub-picker: appears when the operator clicks option 3
           and there are 2+ Live events. Every Live event ticked
           by default so the operator unticks what they don't
           want. "Select all / None" affordances at the top. -->
      <div v-else-if="broadcastPickerOpen" class="lb-body broadcast-picker">
        <div class="broadcast-picker-head">
          <span class="broadcast-picker-count">
            {{ $t('control.modals.picker_selected_count', { selected: broadcastSelection.size, total: broadcastLiveEvents.length }) }}
          </span>
          <div class="broadcast-picker-bulk">
            <button class="btn btn-ghost btn-sm" type="button"
                    :disabled="broadcastSelection.size === broadcastLiveEvents.length"
                    @click="broadcastSelectAll">{{ $t('control.modals.picker_select_all') }}</button>
            <button class="btn btn-ghost btn-sm" type="button"
                    :disabled="broadcastSelection.size === 0"
                    @click="broadcastSelectNone">{{ $t('control.modals.picker_select_none') }}</button>
          </div>
        </div>
        <ul class="broadcast-picker-list">
          <li v-for="ev in broadcastLiveEvents" :key="ev.id">
            <label class="broadcast-picker-row">
              <input type="checkbox"
                     :checked="broadcastSelection.has(String(ev.id))"
                     @change="toggleBroadcastSelection(ev.id)">
              <span class="broadcast-picker-name">{{ ev.name }}</span>
              <span v-if="ev.height" class="broadcast-picker-meta">{{ ev.height }}</span>
              <span v-if="ev.gender" class="broadcast-picker-meta">{{ ev.gender }}</span>
            </label>
          </li>
        </ul>
        <div class="broadcast-picker-actions">
          <button class="btn btn-ghost" type="button"
                  @click="broadcastPickerOpen = false">{{ $t('control.modals.back') }}</button>
          <button class="btn btn-primary" type="button"
                  :disabled="broadcastOpenDisabled"
                  @click="confirmBroadcastPicker">
            {{ $t('control.modals.picker_open_btn', { n: broadcastSelection.size }) }}
          </button>
        </div>
      </div>

      <!-- OBS / streaming-app setup panel: appears when the
           operator clicks option 4. Shows the chroma-key overlay
           URL with a one-click Copy button, plus the standard
           OBS Studio Browser Source steps. The same URL works
           in any tool that supports Browser Source / web overlay
           (Streamlabs, vMix, Restream Studio, …). -->
      <div v-else-if="obsInstructionsOpen" class="lb-body obs-instructions">
        <p class="obs-lead">
          {{ $t('control.modals.obs_lead_html_prefix') }} <strong>{{ $t('control.modals.obs_lead_chroma_key') }}</strong>
          {{ $t('control.modals.obs_lead_html_suffix') }}
        </p>

        <div class="obs-url-block">
          <label class="obs-url-label">{{ $t('control.modals.obs_overlay_url_label_prefix') }}
            <strong>{{ event?.name || $t('control.modals.obs_overlay_event_fallback') }}</strong></label>
          <div class="obs-url-row">
            <input class="obs-url-input"
                   type="text"
                   readonly
                   :value="obsOverlayUrl"
                   @focus="$event.target.select()">
            <button class="btn btn-primary btn-sm obs-url-copy"
                    type="button"
                    @click="copyObsUrl">
              <template v-if="obsCopyState === 'copied'">{{ $t('control.modals.obs_copied') }}</template>
              <template v-else-if="obsCopyState === 'failed'">{{ $t('control.modals.obs_copy_failed') }}</template>
              <template v-else>{{ $t('control.modals.obs_copy') }}</template>
            </button>
          </div>
          <p class="obs-url-hint">
            {{ $t('control.modals.obs_url_hint') }}
          </p>
        </div>

        <ol class="obs-steps">
          <li class="obs-step">
            <span class="obs-step-num">1</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.obs_step1_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.obs_step1_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">2</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.obs_step2_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.obs_step2_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">3</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.obs_step3_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.obs_step3_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">4</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.obs_step4_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.obs_step4_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">5</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.obs_step5_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.obs_step5_desc') }}
              </div>
            </div>
          </li>
        </ol>

        <div class="obs-help-note">
          {{ $t('control.modals.obs_help_note') }}
        </div>

        <div class="broadcast-picker-actions">
          <button class="btn btn-ghost" type="button"
                  @click="obsInstructionsOpen = false">{{ $t('control.modals.back') }}</button>
          <a class="btn btn-primary" target="_blank" rel="noopener"
             :href="obsOverlayUrl || '#'"
             :class="{ disabled: !obsOverlayUrl }"
             @click="!obsOverlayUrl && $event.preventDefault()">
            {{ $t('control.modals.obs_preview_btn') }}
          </a>
        </div>
      </div>

      <!-- Daktronics / venue hardware setup panel: appears when
           the operator clicks option 5. This does not launch the
           bridge from the browser; it gives the venue technician
           the exact event-specific command to run on the bridge
           laptop connected to the display network. -->
      <div v-else-if="daktronicsInstructionsOpen" class="lb-body obs-instructions venue-bridge-instructions">
        <p class="obs-lead">
          {{ $t('control.modals.dak_lead') }}
        </p>

        <div class="obs-url-block">
          <label class="obs-url-label">{{ $t('control.modals.dak_snapshot_label_prefix') }}
            <strong>{{ event?.name || $t('control.modals.dak_snapshot_event_fallback') }}</strong></label>
          <div class="obs-url-row">
            <input class="obs-url-input"
                   type="text"
                   readonly
                   :value="venueStateUrl"
                   @focus="$event.target.select()">
            <button class="btn btn-primary btn-sm obs-url-copy"
                    type="button"
                    @click="copyDaktronicsText('snapshot', venueStateUrl)">
              <template v-if="daktronicsCopyState === 'snapshot'">{{ $t('control.modals.obs_copied') }}</template>
              <template v-else-if="daktronicsCopyState === 'failed'">{{ $t('control.modals.obs_copy_failed') }}</template>
              <template v-else>{{ $t('control.modals.obs_copy') }}</template>
            </button>
          </div>
          <p class="obs-url-hint">
            {{ $t('control.modals.dak_url_hint') }}
          </p>
        </div>

        <div class="venue-command-grid">
          <section class="venue-command-block">
            <div class="venue-command-head">
              <div>
                <div class="venue-command-title">{{ $t('control.modals.dak_block1_title') }}</div>
                <p>{{ $t('control.modals.dak_block1_desc') }}</p>
              </div>
              <button class="btn btn-ghost btn-sm" type="button"
                      @click="copyDaktronicsText('dry', daktronicsDryRunCommand)">
                <template v-if="daktronicsCopyState === 'dry'">{{ $t('control.modals.obs_copied') }}</template>
                <template v-else>{{ $t('control.modals.obs_copy') }}</template>
              </button>
            </div>
            <pre class="venue-command"><code>{{ daktronicsDryRunCommand }}</code></pre>
          </section>

          <section class="venue-command-block">
            <div class="venue-command-head">
              <div>
                <div class="venue-command-title">{{ $t('control.modals.dak_block2_title') }}</div>
                <p>{{ $t('control.modals.dak_block2_desc') }}</p>
              </div>
              <button class="btn btn-ghost btn-sm" type="button"
                      @click="copyDaktronicsText('udp', daktronicsUdpCommand)">
                <template v-if="daktronicsCopyState === 'udp'">{{ $t('control.modals.obs_copied') }}</template>
                <template v-else>{{ $t('control.modals.obs_copy') }}</template>
              </button>
            </div>
            <pre class="venue-command"><code>{{ daktronicsUdpCommand }}</code></pre>
          </section>

          <section class="venue-command-block">
            <div class="venue-command-head">
              <div>
                <div class="venue-command-title">{{ $t('control.modals.dak_block3_title') }}</div>
                <p>{{ $t('control.modals.dak_block3_desc') }}</p>
              </div>
              <button class="btn btn-ghost btn-sm" type="button"
                      @click="copyDaktronicsText('json', daktronicsJsonCommand)">
                <template v-if="daktronicsCopyState === 'json'">{{ $t('control.modals.obs_copied') }}</template>
                <template v-else>{{ $t('control.modals.obs_copy') }}</template>
              </button>
            </div>
            <pre class="venue-command"><code>{{ daktronicsJsonCommand }}</code></pre>
          </section>
        </div>

        <ol class="obs-steps">
          <li class="obs-step">
            <span class="obs-step-num">1</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.dak_step1_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.dak_step1_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">2</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.dak_step2_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.dak_step2_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">3</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.dak_step3_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.dak_step3_desc') }}
              </div>
            </div>
          </li>
          <li class="obs-step">
            <span class="obs-step-num">4</span>
            <div class="obs-step-text">
              <div class="obs-step-title">{{ $t('control.modals.dak_step4_title') }}</div>
              <div class="obs-step-desc">
                {{ $t('control.modals.dak_step4_desc') }}
              </div>
            </div>
          </li>
        </ol>

        <div class="obs-help-note">
          {{ $t('control.modals.dak_help_note') }}
        </div>

        <div class="broadcast-picker-actions">
          <button class="btn btn-ghost" type="button"
                  @click="daktronicsInstructionsOpen = false">{{ $t('control.modals.back') }}</button>
          <router-link class="btn btn-primary" to="/guide/venue-integration">
            {{ $t('control.modals.dak_open_guide') }}
          </router-link>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* Broadcast / OBS / venue-bridge styles MOVED from
   ControlView.css (exclusive to this modal). The .lb-* modal
   frame at the bottom is COPIED — the pattern is shared by the
   modals that remain in ControlView. */

/* Broadcast chooser modal — big tappable rows so the
   operator picks the right destination at a glance. The modal
   width (min(96vw, 760px)) now rides BaseModal's max-width prop. */
.broadcast-chooser-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.75rem 1rem 1rem;
}
.broadcast-option {
  display: grid;
  grid-template-columns: 48px 1fr;
  align-items: center;
  gap: 0.85rem;
  padding: 0.85rem 1rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius);
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  text-align: start;
  font: inherit;
  transition: border-color 0.12s, transform 0.05s;
}
.broadcast-option:hover {
  border-color: var(--cyan);
  background: rgba(6, 182, 212, 0.06);
}
.broadcast-option:active { transform: scale(0.995); }
.broadcast-option-glyph {
  font-size: 28px;
  line-height: 1;
  text-align: center;
}
.broadcast-option-title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--text-1);
  margin-bottom: 0.2rem;
}
.broadcast-option-desc {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
}
.broadcast-option[disabled] {
  opacity: 0.5;
  cursor: progress;
}
.broadcast-picker-error {
  margin-top: 0.4rem;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--red, #ef4444);
}

/* Sub-picker inside the broadcast modal — list of Live events
   with per-row checkboxes. Same modal width as the chooser so
   the visual frame doesn't jump when the panel swaps. */
.broadcast-picker {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.75rem 1rem 1rem;
}
.broadcast-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.broadcast-picker-count {
  font-family: var(--font-display);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--text-3);
}
.broadcast-picker-bulk {
  display: flex;
  gap: 0.4rem;
}
.broadcast-picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  /* dvh: stable height on iOS Safari (see notes on .lb-modal).
     vh fallback for browsers older than ~Q4-2022. */
  max-height: 50vh;
  max-height: 50dvh;
  overflow-y: auto;
}
.broadcast-picker-row {
  display: grid;
  grid-template-columns: 24px 1fr auto auto;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  transition: border-color 0.12s;
}
.broadcast-picker-row:hover { border-color: var(--cyan); }
.broadcast-picker-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
  accent-color: var(--cyan);
  cursor: pointer;
}
.broadcast-picker-name {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.broadcast-picker-meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-3);
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--border-2);
  border-radius: 3px;
}
.broadcast-picker-actions {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--border-2);
}

/* OBS / streaming-app instructions panel — same modal frame as
   the multi-event picker so the visual shell doesn't jump when
   the sub-panel swaps. URL row + numbered Browser Source steps. */
.obs-instructions {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0.85rem 1rem 1rem;
}
.obs-lead {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-2);
}
.obs-lead strong { color: var(--cyan); font-weight: 700; }

.obs-url-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.85rem;
  background: var(--bg-2);
  border: 1px solid var(--cyan);
  border-radius: var(--radius);
}
.obs-url-label {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
}
.obs-url-label strong { color: var(--text-1); }
.obs-url-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  align-items: center;
}
.obs-url-input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background: var(--bg-3);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm, 4px);
  color: var(--text-1);
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.02em;
  user-select: all;
}
.obs-url-input:focus {
  outline: none;
  border-color: var(--cyan);
}
.obs-url-copy { min-width: 84px; text-align: center; }
.obs-url-hint {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.obs-url-hint code {
  background: var(--bg-3);
  border: 1px solid var(--border-2);
  border-radius: 3px;
  padding: 0.05rem 0.3rem;
  color: var(--cyan);
}

.obs-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.obs-step {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: 0.7rem;
  align-items: start;
  padding: 0.7rem 0.85rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm, 4px);
}
.obs-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--cyan);
  color: var(--bg-1, #030712);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 800;
}
.obs-step-title {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-1);
  margin-bottom: 0.25rem;
}
.obs-step-desc {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-3);
}
.obs-step-desc strong { color: var(--text-1); font-weight: 700; }
.obs-step-desc em { color: var(--text-2); font-style: italic; }

.obs-help-note {
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-3);
  padding: 0.6rem 0.75rem;
  background: var(--bg-3);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius-sm, 4px);
}
.obs-help-note code {
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: 3px;
  padding: 0.05rem 0.3rem;
  color: var(--cyan);
}

.venue-bridge-instructions {
  /* dvh: stable height on iOS Safari (see notes on .lb-modal).
     vh fallback for browsers older than ~Q4-2022. */
  max-height: min(72vh, 760px);
  max-height: min(72dvh, 760px);
  overflow-y: auto;
}
.venue-command-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.venue-command-block {
  padding: 0.75rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm, 4px);
}
.venue-command-head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.75rem;
  align-items: start;
  margin-bottom: 0.55rem;
}
.venue-command-title {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: var(--text-1);
}
.venue-command-head p {
  margin: 0.2rem 0 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--text-3);
}
.venue-command {
  margin: 0;
  padding: 0.65rem 0.7rem;
  background: var(--bg-3);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 4px;
  color: var(--cyan);
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.venue-command code {
  font: inherit;
  color: inherit;
}

.obs-instructions .broadcast-picker-actions .btn.disabled {
  opacity: 0.5;
  pointer-events: none;
}

@media (max-width: 480px) {
  .obs-url-row { grid-template-columns: 1fr; }
  .obs-url-copy { width: 100%; }
  .venue-command-head { grid-template-columns: 1fr; }
}

/* The lb-* modal frame now lives in BaseModal.vue (frame) + the global
   lb-header/lb-title/lb-event/lb-body in ControlView.css (P2). */
</style>
