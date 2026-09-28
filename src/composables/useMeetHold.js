// Meet hold / resume, lifted out of the old all-in-one ControlView.
// Broadcasts pause state to judges + the spectator scoreboard
// (meet_hold / meet_resume) and mirrors server-pushed hold state for
// multi-operator setups. The server only replays an existing hold to a
// socket that asks with get_meet_hold, and asking is the caller's job:
// the judge screen and the scoreboard do, and the Control Room asks for
// every live pool it wires up (and again after a reconnect).
//
// Must be called synchronously during component setup: the
// meet_held / meet_resumed listeners register via useSocketEvent,
// which relies on the active effect scope (onScopeDispose) for
// auto-cleanup.
//
// Options:
//   socket            : the pooled socket from useSocket(), only used
//                       to listen for meet_held / meet_resumed
//   event             : getter returning the current event row (or null)
//   onHold            : called after a hold is broadcast; the pool card
//                       passes a shot-clock reset here ("diver can't be
//                       on the clock during a hold")
//   queueSocketAction : the outbox sender from useHttpOutbox(). Both
//                       emits go through it so a hold survives a wifi
//                       blip; there's no raw socket.emit fallback.
import { ref } from 'vue'
import { useSocketEvent } from '@/composables/useSocketEvent'

export function useMeetHold({ socket, event, onHold = () => {}, queueSocketAction }) {
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
    queueSocketAction('meet_hold', { event_id: event().id, reason: holdReason.value || null })
    holdPromptOpen.value = false
    // Pause the shot clock, diver can't be "on the clock" during a hold
    onHold()
  }
  function resumeMeet() {
    if (!event()) return
    isHeld.value = false
    holdReason.value = ''
    queueSocketAction('meet_resume', { event_id: event().id })
  }

  // Hold-state sync: for multi-operator setups + late-joining
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
