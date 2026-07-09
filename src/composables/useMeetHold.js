// Meet hold / resume — extracted from ControlView.vue. Broadcasts
// pause state to judges + the spectator scoreboard (meet_hold /
// meet_resume) and mirrors server-pushed hold state for
// multi-operator setups + late-joining Control Room sessions
// (the server replays meet_held when the view emits
// get_meet_hold on event switch — that emit stays with the
// caller's onEventChange).
//
// Must be called synchronously during component setup: the
// meet_held / meet_resumed listeners register via useSocketEvent,
// which relies on the active effect scope (onScopeDispose) for
// auto-cleanup — the leak-fix property ControlView's listeners
// were migrated to.
//
// Options:
//   socket — the pooled socket from useSocket()
//   event  — getter returning the current event row (or null)
//   onHold — called after a hold is broadcast; the Control Room
//            passes a shot-clock pause here ("diver can't be on
//            the clock during a hold")
import { ref } from 'vue'
import { useSocketEvent } from '@/composables/useSocketEvent'

export function useMeetHold({ socket, event, onHold = () => {}, queueSocketAction = null }) {
  const isHeld = ref(false)
  const holdReason = ref('')
  const holdPromptOpen = ref(false)
  const holdReasonInput = ref('')

  function openHoldPrompt() {
    holdReasonInput.value = ''
    holdPromptOpen.value = true
  }
  function confirmHold() {
    if (!event()) return
    isHeld.value = true
    holdReason.value = holdReasonInput.value.trim()
    const holdPayload = { event_id: event().id, reason: holdReason.value || null }
    if (queueSocketAction) queueSocketAction('meet_hold', holdPayload)
    else socket.emit('meet_hold', holdPayload)
    holdPromptOpen.value = false
    // Pause the shot clock — diver can't be "on the clock" during a hold
    onHold()
  }
  function resumeMeet() {
    if (!event()) return
    isHeld.value = false
    holdReason.value = ''
    const resumePayload = { event_id: event().id }
    if (queueSocketAction) queueSocketAction('meet_resume', resumePayload)
    else socket.emit('meet_resume', resumePayload)
  }

  // Hold-state sync — for multi-operator setups + late-joining
  // Control Room sessions. The server replays meet_held when we
  // ask for it.
  useSocketEvent(socket, 'meet_held', (data) => {
    if (event() && data.event_id === event().id) {
      isHeld.value = true
      holdReason.value = data.reason || ''
    }
  })
  useSocketEvent(socket, 'meet_resumed', (data) => {
    if (event() && data.event_id === event().id) {
      isHeld.value = false
      holdReason.value = ''
    }
  })

  return {
    isHeld,
    holdReason,
    holdPromptOpen,
    holdReasonInput,
    openHoldPrompt,
    confirmHold,
    resumeMeet,
  }
}
