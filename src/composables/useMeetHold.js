// Meet hold / resume, lifted out of the old all-in-one ControlView.
// Broadcasts pause state to judges + the spectator scoreboard
// (meet_hold / meet_resume) and mirrors server-pushed hold state for
// multi-operator setups. The server only replays an existing hold to a
// socket that asks with get_meet_hold, and asking is the caller's job:
// the judge screen and the scoreboard do, and the Control Room asks for
// every live pool it wires up (and again after a reconnect).
//
// Hold state is kept per event, in `store` (event_id -> { reason }). The
// Control Room passes one store to its own focused instance and, through
// provide/inject, to every pool card, so the focused banner, the 'h'
// hotkey and each card read the same answer for the same event. It used to
// be one isHeld ref per instance: the focused one never followed a change
// of focus, so pool A's hold showed on pool B and 'h' on B sent
// meet_resume for B. Callers that don't pass a store get a private one.
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
//   store             : optional shared reactive map, see above.
//
// Relative import (not @/) so node:test can load this file directly.
import { ref, computed, reactive } from 'vue'
import { useSocketEvent } from './useSocketEvent.js'

// provide/inject key for the Control Room's shared store
export const MEET_HOLD_STORE = Symbol('meetHoldStore')

export function useMeetHold({ socket, event, onHold = () => {}, queueSocketAction, store = null }) {
  const holds = store || reactive({})
  const idOf = () => {
    const ev = event()
    return ev && ev.id != null ? String(ev.id) : null
  }
  const isHeld = computed(() => {
    const id = idOf()
    return !!(id && holds[id])
  })
  const holdReason = computed(() => {
    const id = idOf()
    return (id && holds[id]?.reason) || ''
  })
  const holdPromptOpen = ref(false)
  const holdReasonInput = ref('')

  function openHoldPrompt() {
    holdReasonInput.value = ''
    holdPromptOpen.value = true
  }
  function confirmHold() {
    const id = idOf()
    if (!id) return
    const reason = holdReasonInput.value.trim()
    holds[id] = { reason }
    queueSocketAction('meet_hold', { event_id: event().id, reason: reason || null })
    holdPromptOpen.value = false
    // Pause the shot clock, diver can't be "on the clock" during a hold
    onHold()
  }
  function resumeMeet() {
    const id = idOf()
    if (!id) return
    delete holds[id]
    queueSocketAction('meet_resume', { event_id: event().id })
  }

  // Hold-state sync: for multi-operator setups + late-joining
  // Control Room sessions. The server replays meet_held when we
  // ask for it. Every broadcast is recorded under its own event, not
  // just the one this instance is looking at right now.
  useSocketEvent(socket, 'meet_held', (data) => {
    if (!data || data.event_id == null) return
    holds[String(data.event_id)] = { reason: data.reason || '' }
  })
  useSocketEvent(socket, 'meet_resumed', (data) => {
    if (!data || data.event_id == null) return
    delete holds[String(data.event_id)]
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
