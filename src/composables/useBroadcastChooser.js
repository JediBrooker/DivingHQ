/* Broadcast chooser: state for the "..." menu's Broadcast
 * modal in Control Room.
 *
 * Five flavours surfaced to the operator:
 *   1. Operator broadcast (this screen, kiosk layout), handled
 *      inline in the template via a RouterLink, no composable
 *      state needed beyond `broadcastChoiceOpen`.
 *   2. Audience broadcast for THIS event → new window
 *      /scoreboard/<id>/broadcast.
 *   3. Multi-event audience broadcast → expands a sub-picker
 *      that lets the operator tick which Live events to project,
 *      then opens /broadcast/all?ids=<comma-list> in a new window.
 *      Skipped when there are 0 or 1 Live events (the canonical
 *      /broadcast/all URL is opened directly).
 *   4. Stream to OBS / live-streaming app → expands a sub-panel
 *      with the chroma-key overlay URL (`/scoreboard/<id>?overlay=1`)
 *      and step-by-step Browser Source setup so the operator can
 *      composite the live scoreboard into their broadcast graphics.
 *   5. Venue hardware bridge → ControlView owns the event-specific
 *      Daktronics command panel locally since it doesn't need
 *      event-list picker state.
 *
 * Lifted out of ControlView.vue when that file crossed 7,500
 * lines and reading it through cost real agent tokens. The state
 * is self-contained, only outside coupling is a single
 * `closeHeaderMenu()` callback the caller passes in so we can
 * collapse the ⋯ overflow when the operator commits to opening
 * a broadcast window.
 *
 * Usage in ControlView:
 *   const {
 *     broadcastChoiceOpen, broadcastPickerOpen,
 *     broadcastLiveEvents, broadcastLiveLoading, broadcastLiveError,
 *     broadcastSelection, broadcastOpenDisabled,
 *     openBroadcastInNewWindow, pickBroadcastAll,
 *     toggleBroadcastSelection, broadcastSelectAll, broadcastSelectNone,
 *     confirmBroadcastPicker,
 *   } = useBroadcastChooser({
 *     closeHeaderMenu: () => { headerMenuOpen.value = false },
 *   })
 *
 * `closeHeaderMenu` is captured as a closure so it's safe to
 * reference `headerMenuOpen` before that ref is declared further
 * down the script; the callback only fires on user click, well
 * after the script body has run end-to-end.
 */
import { ref, computed } from 'vue'

const NEW_WINDOW_OPTS = 'width=1600,height=900,menubar=no,toolbar=no,location=no'

export function useBroadcastChooser({ closeHeaderMenu = () => {} } = {}) {
  const broadcastChoiceOpen = ref(false)
  // Sub-picker state for option 3. When the operator clicks the
  // "ALL Live events" row we fetch the Live-events list and ask
  // them to tick exactly which events should appear in the grid.
  // `broadcastLiveEvents` holds the fetched rows; `broadcastSelection`
  // is a Set<string> of event ids; `broadcastPickerOpen` toggles the
  // inline picker panel inside the same modal so the operator never
  // jumps between dialogs.
  const broadcastPickerOpen = ref(false)
  const broadcastLiveEvents = ref([])
  const broadcastLiveLoading = ref(false)
  const broadcastLiveError = ref('')
  const broadcastSelection = ref(new Set())
  // Sub-panel state for option 4 (OBS / streaming-app setup
  // instructions). Static content, just a how-to with the
  // chroma-key overlay URL, so no fetch / selection state needed.
  const obsInstructionsOpen = ref(false)

  function openBroadcastInNewWindow(path) {
    // Aim for an undecorated popup, with reasonable defaults that
    // still allow the operator to resize / drag onto the projector.
    // No noopener here so the new window can still read the auth
    // session from the same origin (the broadcast page itself is
    // anonymous-friendly anyway, so there's no real risk).
    window.open(path, '_blank', NEW_WINDOW_OPTS)
    broadcastChoiceOpen.value = false
    broadcastPickerOpen.value = false
    obsInstructionsOpen.value = false
    closeHeaderMenu()
  }

  // Click handler for the third chooser row. Fetches the current
  // Live events, then either:
  //   - skips the picker entirely (0 or 1 Live events, so there's no
  //     subset to choose from, just open the canonical
  //     /broadcast/all URL), or
  //   - opens the in-modal picker with every Live event preselected.
  async function pickBroadcastAll() {
    broadcastLiveLoading.value = true
    broadcastLiveError.value = ''
    try {
      const res = await fetch('/api/events', { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const live = (data || []).filter((e) => e.status === 'Live')
      broadcastLiveEvents.value = live
      if (live.length <= 1) {
        // Nothing to pick, fall through to the canonical URL.
        openBroadcastInNewWindow('/broadcast/all')
        return
      }
      // Default: every Live event selected, matching the the prior
      // single-click behaviour. The operator unticks what they
      // don't want.
      broadcastSelection.value = new Set(live.map((e) => String(e.id)))
      broadcastPickerOpen.value = true
    } catch (err) {
      broadcastLiveError.value = err?.message || 'Failed to load Live events'
    } finally {
      broadcastLiveLoading.value = false
    }
  }

  function toggleBroadcastSelection(id) {
    const key = String(id)
    // Re-assign so Vue's reactivity sees the change, since mutating
    // a Set in-place doesn't trigger reactivity on its own.
    const next = new Set(broadcastSelection.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    broadcastSelection.value = next
  }

  function broadcastSelectAll() {
    broadcastSelection.value = new Set(
      broadcastLiveEvents.value.map((e) => String(e.id)),
    )
  }
  function broadcastSelectNone() {
    broadcastSelection.value = new Set()
  }

  const broadcastOpenDisabled = computed(
    () => broadcastSelection.value.size === 0,
  )

  // Confirm-the-picker handler. Builds /broadcast/all?ids=<csv>.
  // If the operator happens to have ticked every Live event, drop
  // the ?ids= param entirely so newly-Live events still auto-join
  // the grid (the "I want everything" intent is well served by
  // the canonical URL).
  function confirmBroadcastPicker() {
    const allIds = broadcastLiveEvents.value.map((e) => String(e.id))
    const picked = allIds.filter((id) => broadcastSelection.value.has(id))
    if (picked.length === 0) return
    const everyone = picked.length === allIds.length
    const path = everyone
      ? '/broadcast/all'
      : `/broadcast/all?ids=${picked.join(',')}`
    openBroadcastInNewWindow(path)
  }

  return {
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
  }
}
