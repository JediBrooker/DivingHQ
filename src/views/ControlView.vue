<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { useHttpOutbox } from '@/composables/useHttpOutbox'
import { idbInvalidate } from '@/lib/idbCache'
import { DIVE_DIRECTORY_TTL_MS, SCOREBOARD_LIVE_TTL_MS } from '@/lib/cache-policy'
import { rankClass } from '@/lib/format'
import { diveDescription } from '@/composables/useDiveLabel'
import { showUndo } from '@/composables/useUndo'
import { showSuccess, showError, showInfo } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import { useShotClock } from '@/composables/useShotClock'
import { useMeetHold } from '@/composables/useMeetHold'
import DiverIdentity from '@/components/DiverIdentity.vue'
import StatusPill from '@/components/StatusPill.vue'
import JudgeRankingTable from '@/components/JudgeRankingTable.vue'
import OfflineBanner from '@/components/OfflineBanner.vue'
import LateArrivalReviewTray from '@/components/LateArrivalReviewTray.vue'
import ConflictReviewTray from '@/components/ConflictReviewTray.vue'
import ManualScoreEntryForm from '@/components/ManualScoreEntryForm.vue'
import ReadinessChecklist from '@/components/ReadinessChecklist.vue'
import JudgePanelModal from '@/components/JudgePanelModal.vue'
import ReflowModal from '@/components/ReflowModal.vue'
import SponsorLogosManager from '@/components/manager/SponsorLogosManager.vue'
import SuperFinalPanels from '@/components/control/SuperFinalPanels.vue'
import SignoffModal from '@/components/control/SignoffModal.vue'
import BroadcastModal from '@/components/control/BroadcastModal.vue'
import LateEntryModal from '@/components/control/LateEntryModal.vue'
import RandomiseDrawModal from '@/components/control/RandomiseDrawModal.vue'
import CheckInModal from '@/components/control/CheckInModal.vue'
import ScoreCorrectionModal from '@/components/control/ScoreCorrectionModal.vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import {
  annotatedScores,
  annotatedSynchroScores,
  groupedSynchroScoresForDisplay,
  synchroJudgeGroups,
  synchroRoleForJudge,
  trimCount,
} from '@/composables/useScoreCategories'

const { t } = useI18n()
const auth = useAuthStore()
const socket = useSocket()
// HTTP outbox bridge — queueAction(...) for outbox-eligible
// writes (score correction, withdraw). When the feature flag is
// off, queueAction falls through to a direct fetch so the legacy
// behaviour is preserved.
const { queueAction } = useHttpOutbox()
const route = useRoute()
const router = useRouter()

// Operator broadcast mode: /control?broadcast=1 hides the
// chrome (header buttons, queue controls) and renders a
// projection-friendly view of just the active diver, judge
// tiles, and current standings. Toggled via URL so an operator
// can flip a back-of-house screen without leaving the page.
const opsBroadcast = computed(() => route.query.broadcast === '1')

// Active diver status — auto-derived from real signals so the
// operator never has to remember to click anything:
//   READY    — announced & on the board, no scores yet, the
//              60-second WA post-warning shot clock is still running
//   DIVING   — shot clock has expired (per WA the diver MUST
//              have started by then), still no scores in
//   JUDGING  — at least one judge has submitted a score for
//              this round
//
// Surfaces in the spectator scoreboard via set_active_diver
// emissions; a watcher below this declaration pushes a new
// emission every time the derived status flips so the
// audience-facing strip stays in sync without polling.
const activeStatus = computed(() => {
  if (!currentActive.value) return 'ready'
  // JUDGING wins: even if a single judge has tapped a score,
  // the dive is over and the panel is entering scores.
  if (Object.keys(scoresThisRound.value).length > 0) return 'judging'
  // Shot clock has hit zero (or was paused at zero) → the
  // referee's 60-second post-warning window per WA Article
  // 8.5.5 has elapsed, so the diver has begun their dive.
  if (shotClockExpired.value) return 'diving'
  return 'ready'
})

const events = ref([])

// Group events by their parent meet so the picker renders an
// <optgroup> per meet rather than one flat list of every event in
// the federation. /api/events returns meet_name + meet_start_date
// (LEFT JOIN meets). Events arrive ordered created_at DESC; we
// re-group preserving a sensible order — meets by start date (most
// recent first), events within a meet by their scheduled run time.
const eventGroups = computed(() => {
  const groups = new Map()
  for (const ev of events.value) {
    const key = ev.meet_id || '__none__'
    if (!groups.has(key)) {
      groups.set(key, {
        meetId: ev.meet_id || null,
        label: ev.meet_name || 'Other events',
        meetStart: ev.meet_start_date || null,
        events: [],
      })
    }
    groups.get(key).events.push(ev)
  }
  const list = [...groups.values()]
  for (const g of list) {
    g.events.sort((a, b) => {
      const ta = a.scheduled_at ? Date.parse(a.scheduled_at) : Infinity
      const tb = b.scheduled_at ? Date.parse(b.scheduled_at) : Infinity
      if (ta !== tb) return ta - tb
      return (a.name || '').localeCompare(b.name || '')
    })
  }
  // Meets most-recent-first; the meet-less catch-all group sinks
  // to the bottom.
  list.sort((a, b) => {
    if (!a.meetId) return 1
    if (!b.meetId) return -1
    const ta = a.meetStart ? Date.parse(a.meetStart) : 0
    const tb = b.meetStart ? Date.parse(b.meetStart) : 0
    return tb - ta
  })
  return list
})

const selectedEventId = ref('')
const roster = ref([])
const currentIndex = ref(-1)
const currentActive = ref(null)
const currentEvent = ref(null)
const scoresThisRound = ref({})
const historyCards = ref([])
const judgeTiles = ref([])
const scheduleConflicts = ref([])
const scheduleConflictsLoading = ref(false)
const scheduleConflictsError = ref('')
const lateArrivalReviewCount = ref(0)
const recentAuditRows = ref([])
const recentAuditLoading = ref(false)
const recentAuditError = ref('')
const canReadScheduleConflicts = computed(() =>
  auth.hasRole('meet_manager') || auth.hasRole('org_admin'),
)

const rosterFederationGroups = computed(() => {
  const groups = new Map()
  const entries = new Map()
  for (const row of roster.value) {
    const entryKey = row.team_id || row.competitor_id
    if (!entryKey) continue
    if (!entries.has(entryKey)) entries.set(entryKey, [])
    entries.get(entryKey).push(row)
  }

  for (const rowsForEntry of entries.values()) {
    const row = rowsForEntry[0]
    const orgId = row.competitor_org_id || 'unknown'
    if (!groups.has(orgId)) {
      const isHost = !!currentEvent.value?.org_id && orgId === currentEvent.value.org_id
      groups.set(orgId, {
        org_id: orgId,
        name: row.competitor_org_name || row.country_code || 'Unknown federation',
        country_code: row.country_code || '',
        is_host: isHost,
        active_count: 0,
        withdrawn_count: 0,
        missing_list_count: 0,
      })
    }
    const group = groups.get(orgId)
    const isWithdrawn = rowsForEntry.every((candidate) => candidate.withdrawn_at)
    if (isWithdrawn) group.withdrawn_count += 1
    else group.active_count += 1
    if (!isWithdrawn && rowsForEntry.some((candidate) => !candidate.dive_id)) {
      group.missing_list_count += 1
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.is_host !== b.is_host) return a.is_host ? -1 : 1
    return (a.country_code || a.name).localeCompare(b.country_code || b.name)
  })
})

const federationGroupsMissingLists = computed(() =>
  rosterFederationGroups.value.filter((group) => group.missing_list_count > 0),
)

const synchroPendingEntryCount = computed(() => {
  if (currentEvent.value?.event_type !== 'synchro_pair') return 0
  const entries = new Set()
  for (const row of roster.value) {
    if (row.withdrawn_at || row.partner_id) continue
    const entryKey = row.team_id || row.competitor_id
    if (entryKey) entries.add(entryKey)
  }
  return entries.size
})

const eventScheduleConflicts = computed(() => {
  const eventId = currentEvent.value?.id
  if (!eventId) return []
  return scheduleConflicts.value.filter((conflict) => {
    if (conflict.dismissed) return false
    return conflict.block_a?.event_id === eventId || conflict.block_b?.event_id === eventId
  })
})

const eventScheduleConflictCounts = computed(() => {
  const counts = { hard: 0, soft: 0 }
  for (const conflict of eventScheduleConflicts.value) {
    if (conflict.severity === 'soft') counts.soft += 1
    else counts.hard += 1
  }
  return counts
})

const scheduleConflictHint = computed(() => {
  if (scheduleConflictsLoading.value) return 'Checking schedule'
  if (scheduleConflictsError.value) return 'Could not load schedule conflicts'
  const { hard, soft } = eventScheduleConflictCounts.value
  if (!hard && !soft) return 'No active schedule conflicts'
  return [
    hard ? `${hard} hard` : '',
    soft ? `${soft} soft` : '',
  ].filter(Boolean).join(' · ')
})

const inlineAuditRows = computed(() => recentAuditRows.value.slice(0, 6))

async function loadScheduleConflictsForEvent() {
  const event = currentEvent.value
  if (!event?.meet_id || !canReadScheduleConflicts.value) {
    scheduleConflicts.value = []
    scheduleConflictsError.value = ''
    scheduleConflictsLoading.value = false
    return
  }
  const eventId = event.id
  scheduleConflictsLoading.value = true
  scheduleConflictsError.value = ''
  try {
    const body = await auth.apiFetch(`/api/meets/${event.meet_id}/conflicts`)
    if (currentEvent.value?.id !== eventId) return
    scheduleConflicts.value = Array.isArray(body?.conflicts) ? body.conflicts : []
  } catch (err) {
    if (currentEvent.value?.id !== eventId) return
    scheduleConflicts.value = []
    scheduleConflictsError.value = err.message || 'Failed to load schedule conflicts'
  } finally {
    if (currentEvent.value?.id === eventId) scheduleConflictsLoading.value = false
  }
}

async function loadRecentAuditRows() {
  const eventId = currentEvent.value?.id
  if (!eventId) {
    recentAuditRows.value = []
    recentAuditError.value = ''
    recentAuditLoading.value = false
    return
  }
  recentAuditLoading.value = true
  recentAuditError.value = ''
  try {
    const rows = await auth.apiFetch(`/api/events/${eventId}/audit-recent?limit=10`)
    if (currentEvent.value?.id !== eventId) return
    recentAuditRows.value = Array.isArray(rows) ? rows : []
  } catch (err) {
    if (currentEvent.value?.id !== eventId) return
    recentAuditRows.value = []
    recentAuditError.value = err.message || 'Failed to load recent audit'
  } finally {
    if (currentEvent.value?.id === eventId) recentAuditLoading.value = false
  }
}

function refreshRecentAuditSoon(delay = 350) {
  window.setTimeout(() => {
    loadRecentAuditRows()
  }, delay)
}

function openScheduleForEvent() {
  if (!currentEvent.value?.meet_id) return
  router.push(`/meet/${currentEvent.value.meet_id}/schedule`)
}

function onLateArrivalRowsLoaded(payload) {
  if (!payload?.eventId || payload.eventId !== currentEvent.value?.id) return
  const previous = lateArrivalReviewCount.value
  lateArrivalReviewCount.value = Number(payload.count) || 0
  if (lateArrivalReviewCount.value !== previous) loadRecentAuditRows()
}

function auditTitle(row) {
  if (row.kind === 'score') {
    const name = row.competitor_name || 'Competitor'
    if (row.reason?.startsWith('referee:failed')) return `${name} marked failed`
    if (row.reason?.startsWith('referee:cap')) return `${name} scores capped`
    if (row.reason?.startsWith('referee:redive')) return `${name} redive recorded`
    return `${name} score ${row.action === 'delete' ? 'deleted' : 'corrected'}`
  }
  const action = row.action || ''
  if (action === 'coach.submit_dive_list') return 'Coach submitted dive list'
  if (action === 'coach.withdraw_dive_list') return 'Coach withdrew diver'
  if (action === 'roster.withdrew') return `${row.entity_name || 'Diver'} withdrawn`
  if (action === 'roster.reinstated') return `${row.entity_name || 'Diver'} reinstated`
  if (action === 'roster.late_entry_added') return 'Late entry added'
  if (action === 'roster.dive_edited') return 'Dive list edited'
  if (action.startsWith('late_arrival.')) {
    return action === 'late_arrival.allowed'
      ? 'Late submission approved'
      : 'Late submission denied'
  }
  if (action === 'event.workflow_reset') return 'Pre-meet workflow reset'
  return action.replace(/[._]/g, ' ')
}

function auditMeta(row) {
  const actor = row.actor_name || 'System'
  const when = row.created_at ? new Date(row.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  }) : ''
  if (row.kind === 'score') {
    const scoreChange = row.old_score != null && row.new_score != null
      ? `${Number(row.old_score).toFixed(1)} -> ${Number(row.new_score).toFixed(1)}`
      : 'Score trail'
    return [scoreChange, row.round_number ? `Round ${row.round_number}` : '', actor, when]
      .filter(Boolean)
      .join(' · ')
  }
  const note = row.reason || row.metadata?.reason || ''
  return [actor, when, note].filter(Boolean).join(' · ')
}

// Manual-fallback entry modal state (P5). Opens a form where the
// operator types each judge's score, one row per panel member.
// Renders only when currentActive is populated (we need event +
// competitor + round to address the right scores).
const manualEntryOpen = ref(false)
function openManualEntry() {
  if (!currentActive.value) return
  manualEntryOpen.value = true
}
function closeManualEntry() {
  manualEntryOpen.value = false
}
function onManualEntrySaved(judgeId) {
  // Mirror what the socket score_received handler does so the
  // operator sees the panel tile flip immediately — the broadcast
  // will land too, but for a fallback-mode operator on a flaky
  // network we don't want to wait for it to round-trip.
  const tile = judgeTiles.value.find(t => t.judgeId === judgeId)
  if (tile) tile.scored = true
}
const lbShow = ref(false)
const lbRows = ref([])
// Judge Ranking Analysis — opens a full-screen modal hosting the
// JudgeRankingTable component. Only relevant for Completed events
// (the table is meaningless before every dive has been scored), so
// the button that flips this is gated on currentEvent.status.
const judgeRankingOpen = ref(false)

// Broadcast launcher — the chooser modal plus the OBS / venue-
// bridge panels live in @/components/control/BroadcastModal.vue
// (which calls useBroadcastChooser itself). The header button
// opens it through this template ref; the modal owns its own
// body-scroll lock terms.
const broadcastModal = ref(null)

// Sponsor branding modal — hosts the SponsorLogosManager from
// Phase 2 so the operator can swap a logo / fix alt text / pause
// rotation without leaving the Control Room. Gated on the
// current event having a meet (the sponsor lives at the meet
// level, not the event); the menu item hides for standalone
// events.
const sponsorBrandingOpen = ref(false)
// Phase 4 — Reflow modal state. Populated from the response of the
// PUT /api/events/:id/status call when the operator finalises an
// event that ran long. The modal closes via `onReflowClose`; on a
// successful confirm `onReflowSaved` pops a toast. Skipping the
// modal leaves the timeline untouched — manual edits in the
// scheduler view are always available as the fallback.
const reflowOpen = ref(false)
const reflowProposal = ref(null)
const reflowEventName = ref('')
function onReflowClose() {
  reflowOpen.value = false
  reflowProposal.value = null
  reflowEventName.value = ''
}
function onReflowSaved(payload) {
  const count = (payload && payload.count) || 0
  if (count > 0) {
    // Singular vs plural picked in JS — avoids vue-i18n's plural
    // overload which has shifted shape between v8 / v9 / v11. The
    // locale file has both forms under scheduler.reflow.
    const key = count === 1
      ? 'scheduler.reflow.shifted_toast_one'
      : 'scheduler.reflow.shifted_toast_many'
    showSuccess(t(key, { count }))
  }
  onReflowClose()
}
// Connection state lives on the singleton socket itself
// (`socket.isConnected`, a ref). A parallel `connStatus` ref
// would just shadow that state — and now that useSocket is a
// real singleton, two listeners on connect/disconnect (the
// composable's + this view's) would race.
const meetName = ref('')
const activeInfo = ref({ name: '—', code: '—', dd: 'DD —', desc: t('control.no_event') })
const nextBtnDisabled = ref(true)
const nextBtnText = ref(t('control.next_diver') + ' →')
const nextBtnComplete = ref(false)
// Finalise button state — driven by event status + whether
// the very last dive of the very last round has been scored.
// Was a pair of refs that an explicit updateFinaliseButton()
// kept in sync; now derived computeds so the visibility and
// label react automatically to (status, nextBtnComplete).
//
// Visibility rules:
//   - Upcoming     → hidden. "Finalise" makes no sense before
//                    the event has even started; the pre-meet
//                    workflow handles event start.
//   - Live mid-meet → hidden from the header chrome. The
//                    operator can still trigger an early
//                    finalise via the ⋯ menu's "Finalise event
//                    early" item (rare: postponement, cut
//                    short for safety, etc.). Centre column's
//                    Next Diver button is still the primary
//                    affordance to advance through the meet.
//   - Live + every dive scored → shown prominently. This is
//                    the natural finalise moment. The centre
//                    column's Next Diver button also morphs
//                    into "✓ Event Complete — Finalise & View
//                    Results" at the same time, so both
//                    affordances are available.
//   - Completed    → shown as "View Results" — opens the
//                    leaderboard modal.
const finaliseBtnShow = computed(() => {
  const ev = currentEvent.value
  if (!ev) return false
  if (ev.status === 'Completed') return true
  if (ev.status === 'Live' && nextBtnComplete.value) return true
  return false
})
const finaliseBtnText = computed(() =>
  currentEvent.value?.status === 'Completed' ? t('control.view_results') : t('control.finalise') + ' ✓',
)
const finaliseBtnTitle = computed(() =>
  currentEvent.value?.status === 'Completed'
    ? 'View final standings'
    : 'Every dive is in — click to publish the recap and send the "results posted" emails.',
)
// "Finalise event early" menu item — only relevant during
// Live, before the natural completion moment.
const finaliseEarlyVisible = computed(() =>
  !!currentEvent.value
  && currentEvent.value.status === 'Live'
  && !nextBtnComplete.value,
)

// Explanatory tooltip for the Next Diver button so a new
// operator can see WHY the button is disabled rather than
// having to guess. Computes a rich reason from the current
// state (no active diver / waiting for N more judge scores)
// and falls back to a "what does this do + keyboard shortcut"
// hint when enabled. Wired as :title on the button.
const nextBtnTitle = computed(() => {
  if (!nextBtnDisabled.value) {
    return nextBtnComplete.value
      ? 'All rounds complete — finalise the event'
      : 'Advance to the next diver (→ or Space)'
  }
  if (!currentActive.value) {
    return 'Pick an active diver from the queue first'
  }
  const need = parseInt(currentEvent.value?.number_of_judges) || 5
  const have = Object.keys(scoresThisRound.value).length
  const remaining = Math.max(0, need - have)
  if (remaining === 0) return 'Loading…'
  return `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}`
})

// =============================================================
// SHOT CLOCK — World Aquatics Article 8.5.5: 60-second
// post-warning window. The clock itself (timer handle,
// start/stop/pause/reset, colour-band class) lives in
// @/composables/useShotClock so this view doesn't carry the
// implementation. The shape returned here is identical to the
// inline declarations that used to live in this spot, so the
// downstream watchers / template references didn't have to
// change. activeStatus (just above) reads shotClockExpired
// reactively — Vue picks up the binding lexically.
// =============================================================
const {
  SHOT_CLOCK_DEFAULT,
  shotClock,
  shotClockRunning,
  shotClockExpired,
  shotClockClass,
  startShotClock,
  stopShotClock,
  pauseShotClock,
  resetShotClock,
} = useShotClock()

// Push status changes out to the spectator scoreboard. The
// initial set_active_diver emission (in setActive() below)
// already includes the starting status; this watcher covers
// every transition after that — clock-expired flip from READY
// to DIVING, first-score flip from DIVING to JUDGING, etc.
// Without this the audience-facing pill would freeze on
// whatever status was true the moment the diver was announced.
watch(activeStatus, (newStatus) => {
  if (!currentActive.value) return
  socket.emit('set_active_diver', {
    ...currentActive.value,
    status: newStatus,
  })
})

// =============================================================
// HOLD / RESUME — broadcast pause state to judges + scoreboard.
// State, prompt, and the meet_held / meet_resumed listeners
// live in @/composables/useMeetHold (registered synchronously
// here, so they keep the auto-cleanup-on-unmount property).
// The get_meet_hold replay request stays in onEventChange.
// =============================================================
const {
  isHeld,
  holdReason,
  holdPromptOpen,
  holdReasonInput,
  openHoldPrompt,
  confirmHold,
  resumeMeet,
} = useMeetHold({
  socket,
  event: () => currentEvent.value,
  // Pause the shot clock — diver can't be "on the clock"
  // during a hold.
  onHold: () => { if (shotClockRunning.value) stopShotClock() },
})

// =============================================================
// SCORE CORRECTION — manager-amend on a finalised dive. The
// modal (judge picker, live trim/points preview, outbox-queued
// PUT) lives in @/components/control/ScoreCorrectionModal.vue;
// it mutates the clicked history card in place on save, same
// as the inline version. The view owns the open flag + the
// clicked-card pointer (body-scroll lock + history click).
// =============================================================
const correctOpen = ref(false)
const correctTarget = ref(null)        // historyCard the operator clicked

function openCorrection(card) {
  correctTarget.value = card
  correctOpen.value = true
}
function closeCorrection() {
  correctOpen.value = false
  correctTarget.value = null
}

// =============================================================
// ROUND-END TRANSITION
// When the last dive of a round scores, prompt the operator to
// announce the standings. Watches the queue + history to detect
// "round N just completed".
// =============================================================
const roundEndPromptOpen = ref(false)
const roundEndForRound = ref(0)

function detectRoundEnd(justCompletedRound) {
  if (!roster.value.length || !justCompletedRound) return
  const completedInRound = historyCards.value.filter(
    h => h.round === justCompletedRound,
  ).length
  const expectedInRound = roster.value.filter(
    r => r.round_number === justCompletedRound,
  ).length
  if (completedInRound >= expectedInRound && expectedInRound > 0) {
    roundEndForRound.value = justCompletedRound
    roundEndPromptOpen.value = true
    // Same auto-advance contract as between dives: if the
    // operator has set a delay, fire announceRoundEnd after the
    // countdown so the meet keeps moving without a click.
    startAutoAdvance(announceRoundEnd)
  }
}

async function announceRoundEnd() {
  if (!currentEvent.value) return
  try {
    const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
    socket.emit('announce_score', {
      standings: data.standings,
      eventId: currentEvent.value.id,
      round_completed: roundEndForRound.value,
    })
  } catch { /* best effort */ }
  roundEndPromptOpen.value = false
  // Once round-end is dismissed, kick off the dive-advance
  // timer so the meet keeps rolling into round N+1's first
  // diver. Manual mode no-ops.
  cancelAutoAdvance()
  if (!nextBtnComplete.value) startAutoAdvance(nextDiver)
}

// =============================================================
// QUEUE MANAGEMENT — reorder, withdraw, late entry
// =============================================================

// =========================================================
// QUEUE LOCK — drag-reorder + ▲/▼ + randomise are only valid
// before the meet starts. Once the event flips out of
// 'Upcoming' the published start order is committed and any
// reshuffle would invalidate the spectator scoreboard. The
// server enforces this too (HTTP 409); the UI mirrors it so
// operators don't see a button that always errors.
// =========================================================
const canReorderQueue = computed(() =>
  currentEvent.value?.status === 'Upcoming',
)

// =========================================================
// DIVER START ORDER — the 1-based diving position shown in
// front of every name (active diver, completed-dive history
// cards, roster queue). The same diver keeps their order
// across all rounds, so a single competitor_id → number map
// is enough.
//
// Reads round_order (server-side ROW_NUMBER) ahead of
// display_order so an event randomised under the pre-fix SQL
// bug still shows clean 1..N labels rather than the stale
// values left in display_order. Falls back to display_order
// when the older response shape is in play.
// =========================================================
const competitorOrderMap = computed(() => {
  const map = new Map()
  for (const row of roster.value) {
    const pos = row.round_order ?? row.display_order
    if (pos != null && !map.has(row.competitor_id)) {
      map.set(row.competitor_id, pos)
    }
  }
  return map
})
function competitorOrder(competitorId) {
  if (!competitorId) return null
  return competitorOrderMap.value.get(competitorId) ?? null
}

// =========================================================
// SYNCHRO PANEL HELPERS
// Surface "is this a synchro event?" and the judge groupings
// once so every place that needs them — history cards, the live
// judge-tile grid, the dive-total calc — reads from the same
// source. groupedSynchroScoresForDisplay / synchroJudgeGroups
// live in the shared composable so the Scoreboard view's render
// stays byte-for-byte identical to ours.
// =========================================================
const isSynchroEvent = computed(() =>
  currentEvent.value?.event_type === 'synchro_pair',
)
// { a: [1,2,...], b: [...], sync: [...] } when synchro AND the
// panel size is 7, 9 or 11; null otherwise. The centre grid
// groups its tiles via this; the history rendering uses
// groupedSynchroScoresForDisplay (which wraps the same helper)
// so the chips stay in the official panel order.
const liveSynchroGroups = computed(() => {
  if (!isSynchroEvent.value) return null
  return synchroJudgeGroups(parseInt(currentEvent.value?.number_of_judges) || 0)
})
// Tiles split by role for the centre judge grid. Returns null
// when not synchro so the template's v-if can fall back to the
// flat grid.
const judgeTilesByGroup = computed(() => {
  const groups = liveSynchroGroups.value
  if (!groups) return null
  const idx = (jn) => judgeTiles.value.find(t => t.judgeIndex === jn) || null
  return [
    { role: 'a',    label: 'Exec A', tiles: groups.a.map(idx).filter(Boolean) },
    { role: 'b',    label: 'Exec B', tiles: groups.b.map(idx).filter(Boolean) },
    { role: 'sync', label: 'Sync',   tiles: groups.sync.map(idx).filter(Boolean) },
  ]
})

// =========================================================
// LIVE DIVE TOTAL — once every judge tile is filled, show the
// official dive total (trim_sum × DD) under the judge grid so
// the operator can see the scored result immediately rather
// than waiting for the audience scoreboard to refresh. Returns
// null until the panel is complete; the template hides the row
// when null.
// =========================================================
const liveDiveTotal = computed(() => {
  const tiles = judgeTiles.value
  const need = parseInt(currentEvent.value?.number_of_judges) || 0
  if (!need || tiles.length < need) return null
  if (!tiles.every(t => t.scored)) return null
  const dd = parseFloat(currentActive.value?.dd)
  if (!dd || Number.isNaN(dd)) return null
  const csv = tiles
    .slice()
    .sort((a, b) => a.judgeIndex - b.judgeIndex)
    .map(t => parseFloat(t.score))
    .filter(v => !Number.isNaN(v))
    .join(',')
  // Synchro events trim WITHIN each judge group (Exec A drops
  // 1+1 from a 3-judge sub-panel, Sync drops 1+1 from 5, etc.)
  // — same rule the scoreboard + server-side calc use. Falls
  // back to the flat individual rule for non-synchro panels.
  const annotated = isSynchroEvent.value
    ? annotatedSynchroScores(csv, need)
    : annotatedScores(csv, need)
  const trimSum = annotated
    .filter(j => !j.dropped)
    .reduce((sum, j) => sum + j.value, 0)
  if (!isSynchroEvent.value) return trimSum * dd
  return trimSum * dd * 0.6
})

// =========================================================
// AUTO-ADVANCE — operator-configurable auto-progression. When
// non-zero, the queue advances to the next diver N seconds
// after the last judge submits, and the round-end "Announce
// standings" prompt auto-confirms after the same delay. Lets
// a manager run a meet without keeping a hand on the queue —
// the operator can step in any time to cancel, change scores,
// fire a referee action, etc.
//
// Persisted via localStorage so the operator's preferred mode
// survives reload. Default is Manual (0) — every meet starts
// in the safest state until the operator opts in.
// =========================================================
const AUTO_ADVANCE_KEY = 'dr_control_auto_advance_seconds'
const autoAdvanceSeconds = ref(
  parseInt(localStorage.getItem(AUTO_ADVANCE_KEY) || '0', 10) || 0,
)
watch(autoAdvanceSeconds, (s) => {
  try { localStorage.setItem(AUTO_ADVANCE_KEY, String(s)) } catch { /* private mode */ }
  // Editing the dropdown mid-countdown cancels the in-flight
  // timer so the operator's intent is respected immediately.
  cancelAutoAdvance()
})
const autoAdvanceCountdown = ref(0)   // remaining seconds; 0 = idle
let autoAdvanceTimer = null
let autoAdvanceFire   = null          // callback to run on completion
function cancelAutoAdvance() {
  if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null }
  autoAdvanceCountdown.value = 0
  autoAdvanceFire = null
}
function startAutoAdvance(callback) {
  cancelAutoAdvance()
  if (!autoAdvanceSeconds.value) return            // Manual mode
  // Don't kick off the countdown while a judge is flagging the
  // referee — the operator's eyes need to be on the dive
  // resolution, not racing a timer.
  if (signalingJudges.value.length > 0) return
  autoAdvanceCountdown.value = autoAdvanceSeconds.value
  autoAdvanceFire = callback
  autoAdvanceTimer = setInterval(() => {
    autoAdvanceCountdown.value--
    if (autoAdvanceCountdown.value <= 0) {
      const fire = autoAdvanceFire
      cancelAutoAdvance()
      if (typeof fire === 'function') fire()
    }
  }, 1000)
}

// =========================================================
// SIGNAL-REFEREE OVERLAY — a judge tapping their keypad's
// Signal Referee button raises a red flag on their tile (see
// .judge-tile.signaled) AND blocks the auto-advance timer
// until the signal clears. The operator sees a centred banner
// telling them which judge needs attention; clearing happens
// either when the judge submits a fresh score (server emits
// judge_signal {signaled: false} via the JudgeView client) or
// when the operator advances to the next diver.
// =========================================================
const signalingJudges = computed(() =>
  judgeTiles.value.filter(t => t.signaled).map(t => t.judgeIndex),
)
watch(signalingJudges, (now, prev) => {
  // Going from any → none: re-arm auto-advance if the panel
  // was already complete (next button enabled, not at finalise).
  if (prev && prev.length && now.length === 0
      && !nextBtnDisabled.value && !nextBtnComplete.value) {
    startAutoAdvance(nextDiver)
  }
  // Going from none → any: kill the in-flight countdown.
  if (now.length > 0) cancelAutoAdvance()
})

// =========================================================
// PRE-MEET WORKFLOW
//
// Four sequential states that one button cycles through before
// the event flips Live (red → orange → yellow → green):
//
//   1. CHECK-IN — operator confirms attendance is recorded.
//                 Click opens the check-in modal; the modal's
//                 "Confirm Check-in Complete" footer button
//                 stamps check_in_done_at and advances.
//   2. RANDOM   — randomise (or confirm) the start order.
//                 Click shuffles via the existing endpoint and
//                 stamps dive_order_randomised_at.
//   3. SIGN-OFF — referee approves the published order.
//                 Click stamps dive_order_signed_off_at + by.
//   4. START    — flip the event status from Upcoming → Live.
//
// Re-randomising clears the sign-off because the order has
// changed and the referee must re-approve. A small "↺ Reset"
// link next to the button calls the /reset endpoint to walk
// back to state 1 — clears every workflow stamp.
// =========================================================
const orderBusy = ref(false)

// Effective state of the workflow. Kept as a computed off
// currentEvent so an external mutation (another operator, page
// reload) reflects immediately. 'live' covers any event past
// the Upcoming gate; the button hides itself in that case.
const orderWorkflowState = computed(() => {
  const ev = currentEvent.value
  if (!ev) return null
  if (ev.status !== 'Upcoming') return 'live'
  if (!ev.check_in_done_at)         return 'check-in'
  if (!ev.dive_order_randomised_at) return 'random'
  if (!ev.dive_order_signed_off_at) return 'sign-off'
  return 'start'
})

const workflowMode = computed(() => {
  const status = currentEvent.value?.status
  if (status === 'Live') return 'meet'
  if (status === 'Completed') return 'review'
  return 'setup'
})

// Stepper helper — classifies each pre-meet step as done /
// active / future relative to the current workflow state.
// Drives the four-pip indicator that renders ABOVE the action
// button so the operator sees the whole flow at a glance
// instead of having to remember the order red → orange →
// yellow → green carries.
const WORKFLOW_STEPS = ['check-in', 'random', 'sign-off', 'start']
function wfStepClass(stepName) {
  const cur = WORKFLOW_STEPS.indexOf(orderWorkflowState.value)
  const idx = WORKFLOW_STEPS.indexOf(stepName)
  if (cur === -1 || idx === -1) return 'wf-step-future'
  if (cur > idx) return 'wf-step-done'
  if (cur === idx) return 'wf-step-active'
  return 'wf-step-future'
}

// Replace the stamps on currentEvent (and the matching events
// list row) without re-fetching the whole list. Keeps the button
// in sync after every workflow step.
function patchCurrentEvent(patch) {
  if (!currentEvent.value) return
  Object.assign(currentEvent.value, patch)
  const row = events.value.find(e => e.id === currentEvent.value.id)
  if (row) Object.assign(row, patch)
}

// =============================================================
// RANDOM DIVE-ORDER DRAW (WA Article 4.1.6)
// The ceremony modal (preview → 5-sec shuffle reel → done)
// lives in @/components/control/RandomiseDrawModal.vue. The
// view keeps the open flag (body-scroll lock), the queue-lock
// guard, and applies the emitted result.
// =============================================================
const randomiseModalOpen = ref(false)

function openRandomiseDraw() {
  if (!currentEvent.value) return
  if (!canReorderQueue.value) {
    showInfo('The dive order is locked once the event has started.')
    return
  }
  randomiseModalOpen.value = true
}

// Applies a completed draw: same assignments the inline
// runRandomiseDraw used to make, in the same order.
function onRandomised(freshRoster) {
  roster.value = freshRoster
  currentIndex.value = -1
  currentActive.value = null
  patchCurrentEvent({
    dive_order_randomised_at: new Date().toISOString(),
    dive_order_signed_off_at: null,
    dive_order_signed_off_by: null,
  })
}

// Backwards-compatible alias — the workflow button still calls
// the old name. We just open the modal now.
async function randomizeStartOrder() {
  openRandomiseDraw()
}

// "Skip randomise" path — operator already arranged the order
// manually (e.g. seeded from a prior round) and just wants to
// advance to sign-off.
async function confirmDiveOrder() {
  if (!currentEvent.value) return
  if (!await confirmAction({
    title: 'Use current dive order?',
    body:  `Skip randomise — lock in the order you've already arranged for "${currentEvent.value.name}" and advance to sign-off.`,
    confirmLabel: 'Use current order',
    confirmKind:  'primary',
  })) return
  orderBusy.value = true
  try {
    await queueAction({
      method: 'POST',
      url: `/api/events/${currentEvent.value.id}/dive-order/confirm`,
      actionType: 'dive_order_confirm',
    })
    patchCurrentEvent({
      dive_order_randomised_at: new Date().toISOString(),
    })
  } catch (err) {
    showError('Failed: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// Referee sign-off — flow + state live in
// @/components/control/SignoffModal.vue now. The view only
// tracks the open flag (drives the body-scroll lock + the
// v-if mount) and applies the event-row patch the modal
// emits on success.
const signoffOpen = ref(false)

// Still a named function — the readiness checklist onFix and
// the pre-meet workflow button both reference it.
function signOffDiveOrder() {
  if (!currentEvent.value) return
  signoffOpen.value = true
}

// Pre-flight review modal — shown when the operator clicks the
// green "Start Event" workflow button. The four-step pre-meet
// stepper has already verified the procedural prerequisites
// (check-in, randomise, sign-off); this modal is the last-
// chance visual review of WHAT'S ABOUT TO GO LIVE — roster
// size, judge panel, referee status, plus a warnings list for
// anything that looks misconfigured (synchro on a 5-judge
// panel, divers with incomplete dive lists, etc.). Mirrors a
// pilot's pre-flight checklist before take-off.
const preFlightOpen = ref(false)
const preFlightSummary = computed(() => {
  const ev = currentEvent.value
  if (!ev) return null
  const totalRounds = parseInt(ev.total_rounds) || 0
  // Derive checked-in divers from the roster. Each row is one
  // diver-round, so group by competitor_id and count rounds.
  const byDiver = new Map()
  for (const row of roster.value) {
    if (row.withdrawn_at) continue
    const id = row.competitor_id || row.diver_id || row.dive_list_id
    if (!byDiver.has(id)) {
      byDiver.set(id, {
        id,
        name: row.full_name || row.diver_name || 'Diver',
        rows: 0,
        missingDive: 0,
      })
    }
    const e = byDiver.get(id)
    e.rows++
    if (!row.dive_code) e.missingDive++
  }
  const divers = [...byDiver.values()]
  const incompleteDivers = divers.filter(d =>
    d.rows < totalRounds || d.missingDive > 0,
  )
  // Warnings: anything that isn't an outright blocker but
  // deserves a second look before going Live.
  const warnings = []
  const judgeCount = parseInt(ev.number_of_judges) || 0
  if (ev.event_type === 'synchro_pair' && ![7, 9, 11].includes(judgeCount)) {
    warnings.push(
      `Synchro panel size is ${judgeCount}; use 7, 9 or 11 to fill the Exec A / Exec B / Sync sub-panels.`,
    )
  }
  if (incompleteDivers.length) {
    const n = incompleteDivers.length
    warnings.push(
      `${n} diver${n === 1 ? ' has' : 's have'} an incomplete dive list (missing rounds or dive codes).`,
    )
  }
  if (!ev.dive_order_signed_off_at) {
    warnings.push('Referee sign-off is missing.')
  }
  if (judgePanel.value.length < judgeCount) {
    warnings.push(
      `Only ${judgePanel.value.length} of ${judgeCount} judge slots are filled.`,
    )
  }
  return {
    eventName: ev.name,
    isRehearsal: !!ev.is_rehearsal,
    eventType: ev.event_type === 'synchro_pair' ? 'Synchro Pair'
             : ev.event_type === 'team'         ? 'Team'
             : 'Individual',
    height: ev.height,
    rounds: totalRounds,
    judgeCount,
    ageGroup: ev.age_group,
    diverCount: divers.length,
    incompleteDivers: incompleteDivers.slice(0, 5), // cap so the modal stays compact
    incompleteOverflow: Math.max(0, incompleteDivers.length - 5),
    judges: judgePanel.value.slice(0, 11),          // already capped at 11 in practice
    refereeSignedOff: !!ev.dive_order_signed_off_at,
    warnings,
  }
})

function openDiveOrderChecklistTarget() {
  diveOrderOpen.value = true
  requestAnimationFrame(() => {
    document
      .querySelector('[data-dive-order-panel]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

// Judge-panel picker modal — opened from the readiness checklist's
// "Judge panel seated" row when the panel isn't yet full. On save,
// re-fetch /api/events/:id/judges so judgePanel.value updates and
// the readiness check ticks green without a page refresh.
const judgePanelModalOpen = ref(false)
function openJudgePanelModal() {
  if (!currentEvent.value) return
  judgePanelModalOpen.value = true
}
async function refreshJudgePanel() {
  if (!selectedEventId.value) return
  try {
    const data = await auth.apiFetch(`/api/events/${selectedEventId.value}/judges`)
    judgePanel.value = Array.isArray(data) ? data : []
  } catch { /* leave stale; the next event switch reloads */ }
}

const readinessItems = computed(() => {
  const ev = currentEvent.value
  const summary = preFlightSummary.value
  if (!ev || !summary) return []
  const panelReady = summary.judgeCount > 0 && summary.judges.length >= summary.judgeCount
  const items = [
    {
      key: 'roster',
      label: 'Roster has competitors',
      done: summary.diverCount > 0,
      hint: 'Add or import competitors',
      onFix: openLateEntry,
      severity: 'critical',
    },
    {
      key: 'dive_lists',
      label: 'Dive lists complete',
      done: summary.diverCount > 0 && summary.incompleteDivers.length === 0,
      hint: summary.incompleteDivers.length
        ? `${summary.incompleteDivers.length} incomplete`
        : 'Review the dive order',
      onFix: openDiveOrderChecklistTarget,
      severity: 'critical',
    },
    {
      key: 'panel',
      label: 'Judge panel seated',
      done: panelReady,
      hint: `${summary.judges.length}/${summary.judgeCount} seats filled`,
      onFix: openJudgePanelModal,
      severity: 'critical',
    },
    {
      key: 'check_in',
      label: 'Check-in confirmed',
      done: !!ev.check_in_done_at,
      hint: 'Mark present, late, or DNS',
      onFix: startCheckInStep,
      severity: 'critical',
    },
    {
      key: 'order',
      label: 'Start order locked',
      done: !!ev.dive_order_randomised_at,
      hint: 'Randomise or use current order',
      onFix: orderWorkflowState.value === 'random' ? confirmDiveOrder : openDiveOrderChecklistTarget,
      severity: 'critical',
    },
    {
      key: 'sign_off',
      label: 'Referee sign-off',
      done: !!ev.dive_order_signed_off_at,
      hint: 'Send request or sign off',
      onFix: signOffDiveOrder,
      severity: 'critical',
    },
  ]
  if (ev.meet_id && canReadScheduleConflicts.value) {
    const { hard, soft } = eventScheduleConflictCounts.value
    items.push({
      key: 'schedule_conflicts',
      label: 'Schedule conflicts clear',
      done: !hard && !soft && !scheduleConflictsError.value,
      hint: scheduleConflictHint.value,
      onFix: openScheduleForEvent,
      severity: hard ? 'critical' : (soft || scheduleConflictsError.value ? 'warning' : 'info'),
      blocking: hard > 0 || !!scheduleConflictsError.value,
    })
  }
  if (lateArrivalReviewCount.value > 0) {
    items.push({
      key: 'late_arrivals',
      label: 'Late submissions reviewed',
      done: false,
      hint: `${lateArrivalReviewCount.value} pending referee review`,
      severity: 'warning',
    })
  }
  if (ev.event_type === 'synchro_pair') {
    items.push({
      key: 'synchro_pairs',
      label: 'Synchro pairs confirmed',
      done: synchroPendingEntryCount.value === 0,
      hint: synchroPendingEntryCount.value
        ? `${synchroPendingEntryCount.value} missing partner`
        : 'Partners confirmed',
      onFix: openDiveOrderChecklistTarget,
      severity: 'critical',
    })
  }
  if (rosterFederationGroups.value.length > 1) {
    const missingGroups = federationGroupsMissingLists.value
    items.push({
      key: 'federation_readiness',
      label: 'Federations ready',
      done: missingGroups.length === 0,
      hint: missingGroups.length
        ? missingGroups
          .slice(0, 2)
          .map((group) => `${group.country_code || group.name}: ${group.missing_list_count}`)
          .join(' · ')
        : `${rosterFederationGroups.value.length} federations complete`,
      onFix: openDiveOrderChecklistTarget,
      severity: missingGroups.length ? 'warning' : 'info',
      blocking: false,
    })
  }
  return items
})

const startBlockers = computed(() =>
  readinessItems.value
    .filter(item => !item.done && item.blocking !== false)
    .map(item => item.hint ? `${item.label}: ${item.hint}` : item.label),
)
const startBlocked = computed(() =>
  currentEvent.value?.status === 'Upcoming' && startBlockers.value.length > 0,
)
const startBlockedReason = computed(() =>
  startBlocked.value
    ? `Not ready to start:\n${startBlockers.value.join('\n')}`
    : 'Flip the event to Live. The order is then locked.',
)

async function startEvent() {
  if (!currentEvent.value) return
  if (startBlocked.value) {
    showError(startBlockedReason.value.replace(/\n/g, ' · '))
    return
  }
  // Open the pre-flight review instead of the bare native
  // confirm. The modal's "Go Live" button calls
  // commitStartEvent() once the operator has reviewed.
  preFlightOpen.value = true
}

async function commitStartEvent() {
  if (!currentEvent.value) return
  if (startBlocked.value) {
    showError(startBlockedReason.value.replace(/\n/g, ' · '))
    return
  }
  preFlightOpen.value = false
  const evName = currentEvent.value.name
  orderBusy.value = true
  try {
    await queueAction({
      method: 'PUT',
      url: `/api/events/${currentEvent.value.id}/status`,
      body: { status: 'Live' },
      actionType: 'event_status_flip',
    })
    patchCurrentEvent({ status: 'Live' })
    showSuccess(`"${evName}" is Live — scoreboards broadcasting.`)
  } catch (err) {
    showError(`Failed to start "${evName}": ${err.message}`)
  } finally {
    orderBusy.value = false
  }
}

async function resetDiveOrderWorkflow() {
  if (!currentEvent.value) return
  if (!await confirmAction({
    title: 'Reset pre-meet workflow?',
    body:  `Walk the four pre-meet steps again for "${currentEvent.value.name}".`,
    consequences: [
      'Check-in, randomise, and referee sign-off stamps will be cleared',
      'The roster + dive order itself stays intact — only the workflow stamps reset',
    ],
    confirmLabel: 'Reset workflow',
    confirmKind:  'warn',
  })) return
  orderBusy.value = true
  try {
    await queueAction({
      method: 'POST',
      url: `/api/events/${currentEvent.value.id}/dive-order/reset`,
      actionType: 'dive_order_reset',
    })
    patchCurrentEvent({
      check_in_done_at:        null,
      dive_order_randomised_at: null,
      dive_order_signed_off_at: null,
      dive_order_signed_off_by: null,
    })
  } catch (err) {
    showError('Reset failed: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// State 1 click handler. Doesn't stamp on click — opens the
// check-in modal so the operator can mark each diver. The
// modal's "Confirm Check-in Complete" footer button (now inside
// CheckInModal) is what stamps check_in_done_at — emitted back
// here and applied via patchCurrentEvent — advancing to state 2.
function startCheckInStep() {
  openCheckIn()
}

// =========================================================
// DRAG-AND-DROP REORDER — HTML5 drag/drop, falls back to the
// existing ▲/▼ arrows for keyboard / accessibility users. On
// drop we compute fresh display_order values for the entire
// round and persist them in a single bulk-reorder call.
// =========================================================
const dragRosterIdx = ref(null)
const dragOverRosterIdx = ref(null)

function onRosterDragStart(originalIdx, ev) {
  // Cancel the drag entirely if the queue is locked. preventDefault
  // here stops the browser from initiating the drag UI.
  if (!canReorderQueue.value) {
    ev.preventDefault?.()
    return
  }
  dragRosterIdx.value = originalIdx
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    try { ev.dataTransfer.setData('text/plain', String(originalIdx)) } catch { /* noop */ }
  }
}
function onRosterDragOver(originalIdx, ev) {
  if (dragRosterIdx.value == null) return
  // Only allow drop on rows in the same round
  const src = roster.value[dragRosterIdx.value]
  const tgt = roster.value[originalIdx]
  if (!src || !tgt || src.round_number !== tgt.round_number) return
  ev.preventDefault()
  dragOverRosterIdx.value = originalIdx
}
function onRosterDragLeave(originalIdx) {
  if (dragOverRosterIdx.value === originalIdx) dragOverRosterIdx.value = null
}
function onRosterDragEnd() {
  dragRosterIdx.value = null
  dragOverRosterIdx.value = null
}
async function onRosterDrop(originalIdx, ev) {
  ev.preventDefault()
  const from = dragRosterIdx.value
  dragRosterIdx.value = null
  dragOverRosterIdx.value = null
  if (from == null || from === originalIdx) return
  const src = roster.value[from]
  const tgt = roster.value[originalIdx]
  if (!src || !tgt || src.round_number !== tgt.round_number) return

  // Move src to tgt's slot in the local array (optimistic).
  const before = roster.value.slice()
  const moved = roster.value.splice(from, 1)[0]
  roster.value.splice(originalIdx, 0, moved)
  // Track currentIndex through the move so the active diver
  // pointer doesn't break.
  if (currentIndex.value === from) currentIndex.value = originalIdx
  else if (from < currentIndex.value && currentIndex.value <= originalIdx) currentIndex.value--
  else if (originalIdx <= currentIndex.value && currentIndex.value < from) currentIndex.value++

  // Recompute display_order for every row in the affected round.
  // We send all rounds' rows in a single bulk-reorder call so
  // the wire format is uniform and the server can be dumb.
  const round = src.round_number
  const rowsInRound = roster.value
    .map((r, i) => ({ row: r, idx: i }))
    .filter(p => p.row.round_number === round)
  const payload = rowsInRound.map((p, position) => ({
    id: p.row.dive_list_id,
    display_order: position,
  }))
  // Mirror locally too so a future re-render doesn't reorder.
  for (let i = 0; i < rowsInRound.length; i++) {
    rowsInRound[i].row.display_order = i
  }
  try {
    await queueAction({
      method: 'PUT',
      url: `/api/events/${currentEvent.value.id}/dive-lists/reorder`,
      body: { rows: payload },
      actionType: 'dive_list_reorder_bulk',
    })
  } catch (err) {
    showError('Failed to save order: ' + err.message)
    roster.value = before
  }
}

// Move a roster entry up or down within its round. Recomputes
// display_order locally first (optimistic) then persists. We
// pick a value halfway between the new neighbours so subsequent
// drags don't have to renumber the whole round.
async function reorderRosterRow(idx, dir) {
  if (!canReorderQueue.value) return
  const cur = roster.value[idx]
  if (!cur) return
  // Find the previous / next row in the SAME round
  const targetIdx = dir === 'up' ? idx - 1 : idx + 1
  const target = roster.value[targetIdx]
  if (!target || target.round_number !== cur.round_number) return

  // Swap their positions in the local array (optimistic)
  roster.value[idx] = target
  roster.value[targetIdx] = cur
  // currentIndex needs to follow the moved active diver
  if (currentIndex.value === idx)        currentIndex.value = targetIdx
  else if (currentIndex.value === targetIdx) currentIndex.value = idx

  // Persist by giving each row an explicit display_order value
  // (use array index — simple, monotonic, lets future moves
  // continue to compare correctly).
  try {
    await Promise.all([
      queueAction({
        method: 'PUT',
        url: `/api/dive-lists/${cur.dive_list_id}/order`,
        body: { display_order: targetIdx },
        actionType: 'dive_list_reorder_one',
      }),
      queueAction({
        method: 'PUT',
        url: `/api/dive-lists/${target.dive_list_id}/order`,
        body: { display_order: idx },
        actionType: 'dive_list_reorder_one',
      }),
    ])
  } catch (err) {
    showError('Failed to save order: ' + err.message)
    // Revert local swap on failure
    roster.value[idx] = cur
    roster.value[targetIdx] = target
  }
}

async function withdrawRosterRow(idx) {
  const row = roster.value[idx]
  if (!row) return
  const willWithdraw = !row.withdrawn_at
  // No confirm() dialog — fires immediately + offers Undo via
  // the snackbar. The reverse op is just calling the same
  // endpoint with the opposite withdrawn flag, so a misclick
  // is one tap away from being recovered without an admin.
  try {
    await queueAction({
      method: 'PUT',
      url: `/api/dive-lists/${row.dive_list_id}/withdraw`,
      body: { withdrawn: willWithdraw },
      actionType: 'dive_list_withdraw',
    })
    row.withdrawn_at = willWithdraw ? new Date().toISOString() : null
    // If the active diver got withdrawn, advance past them.
    if (willWithdraw && currentIndex.value === idx) {
      const next = roster.value.findIndex((r, i) => i > idx && !r.withdrawn_at)
      if (next >= 0) setActive(next)
    }
    refreshRecentAuditSoon()
    loadScheduleConflictsForEvent()
    showUndo({
      message: willWithdraw
        ? `Withdrew ${row.full_name} from round ${row.round_number}`
        : `Reinstated ${row.full_name} in round ${row.round_number}`,
      onUndo: async () => {
        // Undo path goes through the outbox too — same retry +
        // idempotency posture as the forward op.
        await queueAction({
          method: 'PUT',
          url: `/api/dive-lists/${row.dive_list_id}/withdraw`,
          body: { withdrawn: !willWithdraw },
          actionType: 'dive_list_withdraw',
        })
        row.withdrawn_at = !willWithdraw ? new Date().toISOString() : null
        refreshRecentAuditSoon()
        loadScheduleConflictsForEvent()
      },
    })
  } catch (err) {
    showError('Failed: ' + err.message)
  }
}

// =============================================================
// LATE ENTRY — manager adds a diver from the Control Room.
// Form, autocompletes + once-per-session caches live in
// @/components/control/LateEntryModal.vue (always mounted so
// the cached dive directory / diver list survive reopen). The
// view owns the open flag (body-scroll lock reads it) and
// applies the fresh roster the modal emits after a save.
// =============================================================
const lateOpen = ref(false)
function openLateEntry() {
  lateOpen.value = true
}
function onLateEntryAdded(freshRoster) {
  // Same post-add refresh the inline submit used to run.
  roster.value = freshRoster
  refreshRecentAuditSoon()
  loadScheduleConflictsForEvent()
}

// =============================================================
// CHECK-IN PANEL (#2 from the feature roadmap)
// List, Present / Late / DNS chips, and the confirm-complete
// step live in @/components/control/CheckInModal.vue. The view
// owns the open flag (body-scroll lock reads it) and applies
// the emitted check_in_done_at stamp via patchCurrentEvent.
// =============================================================
const checkInOpen = ref(false)

function openCheckIn() {
  if (!currentEvent.value) return
  checkInOpen.value = true
}


// =============================================================
// JUDGE PANEL — names + ids loaded once per event so the tile
// in the centre column can show "J3 — Sarah Chen" instead of a
// faceless number when scores are missing.
// =============================================================
const judgePanel = ref([])         // [{ judge_id, judge_number, full_name }]
const judgeNameByNumber = computed(() => {
  const m = {}
  for (const j of judgePanel.value) m[j.judge_number] = j.full_name
  return m
})

// =============================================================
// STANDINGS PREVIEW — top 5 visible inline so the meet referee
// always knows the running state without opening the modal.
// =============================================================
const standingsPreview = ref([])
// Operator toggle for the standings + projection panel. Persisted
// in localStorage so the controller's preference survives reload.
// The public scoreboard is unaffected — this only hides the panel
// inside the Control Room.
const SHOW_STANDINGS_KEY = 'dr.controlRoom.showStandings'
// Default to COLLAPSED — only the operators who explicitly want
// the Top 5 + catch-up math always in view will have flipped
// the localStorage flag. The catch-up math is also visible on
// the audience-facing scoreboard, so the operator's view doesn't
// HAVE to carry it; collapsed-by-default reduces the right
// column's resting noise level.
const showStandingsProjection = ref(
  (typeof localStorage !== 'undefined'
    ? localStorage.getItem(SHOW_STANDINGS_KEY)
    : null) === '1',
)
function toggleStandingsProjection() {
  showStandingsProjection.value = !showStandingsProjection.value
  try { localStorage.setItem(SHOW_STANDINGS_KEY, showStandingsProjection.value ? '1' : '0') }
  catch { /* private mode etc. — silent fail */ }
}

// Compressed-layout overflow menus — see the LAYOUT COMPRESSION
// pass below for the rationale (offload secondary chrome from
// the always-visible canvas). Each is a simple ref + a small
// outside-click handler that closes when the user clicks
// anywhere off the menu's wrapper.
const headerMenuOpen  = ref(false)   // Hold / Sponsor / Finalise-early / Manual
const adjustMenuOpen  = ref(false)   // Failed Dive / Cap Score / Re-Dive
const autoNextMenuOpen = ref(false)  // Auto-next: Manual / 5s / 10s / …
const kbdHintsOpen    = ref(false)   // ? popover with all shortcuts
// Per-roster-row overflow menu (the ⋯ in the Dive Order
// panel). One menu open at a time, like every other overflow
// in the Control Room. The value is the row's originalIdx,
// or -1 when nothing is open.
const rosterMenuOpenIdx = ref(-1)

// The ⋯ overflow menu only earns its slot when at least one of
// its contextual actions is live. Broadcast was promoted to a
// standalone button (left of the event picker), so on a Completed
// event with nothing else to offer, the menu — and its ⋯ trigger
// — disappear entirely. It returns for Live events that expose
// Hold / Sponsor branding / Finalise-early / Manual score entry.
const headerMenuHasItems = computed(() =>
  (!!currentEvent.value && currentEvent.value.status !== 'Completed' && !isHeld.value)
  || (!!currentEvent.value && !!currentEvent.value.meet_id && !opsBroadcast.value)
  || finaliseEarlyVisible.value
  || !!currentActive.value,
)

function closeOverflowMenus() {
  headerMenuOpen.value = false
  adjustMenuOpen.value = false
  autoNextMenuOpen.value = false
  kbdHintsOpen.value = false
  rosterMenuOpenIdx.value = -1
}
function toggleRosterMenu(originalIdx) {
  const wasOpen = rosterMenuOpenIdx.value === originalIdx
  closeOverflowMenus()
  rosterMenuOpenIdx.value = wasOpen ? -1 : originalIdx
}
// Toggle the named menu and close all the others — only one
// overflow popover open at a time keeps the canvas predictable.
function toggleMenu(which) {
  const map = {
    header:   headerMenuOpen,
    adjust:   adjustMenuOpen,
    autonext: autoNextMenuOpen,
    kbd:      kbdHintsOpen,
  }
  const target = map[which]
  if (!target) return
  const next = !target.value
  closeOverflowMenus()
  target.value = next
}
function onGlobalClick(e) {
  // Close any open overflow menu when the click is outside any
  // element with .dropdown-host. The menu's own toggle button
  // does its own state flip; we just defer to that.
  if (!e.target.closest?.('.dropdown-host')) closeOverflowMenus()
}

async function refreshStandingsPreview() {
  if (!currentEvent.value) return
  try {
    // SWR cached read with 5s TTL — matches the server-side
    // scoreboard cache and tolerates a brief blackout. Real
    // freshness comes from socket-driven invalidation
    // (score_received → invalidate this URL).
    const result = await auth.cachedApiFetch(
      `/api/scoreboard/${currentEvent.value.id}`,
      { cache: { maxAgeMs: SCOREBOARD_LIVE_TTL_MS, onUpdate: (fresh) => {
        if (fresh?.standings) standingsPreview.value = fresh.standings
      } } },
    )
    standingsPreview.value = result.data?.standings || []
  } catch { standingsPreview.value = [] }
}

// Top 5 visible rows — derived so the panel keeps the existing
// rendering shape while the full standings array drives the
// projection logic.
const standingsTop5 = computed(() => standingsPreview.value.slice(0, 5))

// Edit-Dive modal — meet manager swaps a roster row's dive
// mid-event (typo recovery, Statement-of-Dives change, etc.).
// Per WA Article 6.7.4 / 6.8 the operator (acting as the
// athlete's representative or under Referee oversight) can
// submit a change-of-dives form. Wired through the existing
// POST /api/events/:id/roster endpoint, which now audits as
// `roster.dive_edited` (vs. `late_entry_added` for new rows).
const diveDirectory = ref([])
const editDiveOpen   = ref(false)
const editDiveTarget = ref(null)   // { dive_list_id, competitor_id, full_name, round_number, current_code }
const editDiveSearch = ref("")
const editDiveBusy   = ref(false)
const editDiveErr    = ref("")

// ----------------------------------------------------------------
// Body scroll lock — locks the underlying page whenever any modal
// here is open. iOS Safari otherwise lets the operator drag the
// page underneath the modal during a sign-off / preflight /
// late-entry flow and lose their place in the control surface.
//
// One composed computed covers every modal in this view; the
// composable's reference counter handles nested modals (e.g. a
// confirm dialog over the preflight modal). Anchored at the
// bottom of the modal-ref block so every ref is in scope.
//
// Excluded by design: dropdown menus (.dropdown-menu — header
// menu, adjust menu, autonext menu, kbd hints) and inline
// reveals (.reserves-list, .dive-order-body, .help-popover) —
// those don't take over the screen and benefit from letting the
// underlying surface scroll.
// ----------------------------------------------------------------
useBodyScrollLock().lockWhile(computed(() =>
  lbShow.value ||
  judgeRankingOpen.value ||
  sponsorBrandingOpen.value ||
  reflowOpen.value ||
  holdPromptOpen.value ||
  correctOpen.value ||
  roundEndPromptOpen.value ||
  randomiseModalOpen.value ||
  signoffOpen.value ||
  preFlightOpen.value ||
  judgePanelModalOpen.value ||
  lateOpen.value ||
  checkInOpen.value ||
  editDiveOpen.value
))
async function loadDiveDirectory() {
  try {
    const result = await auth.cachedApiFetch("/api/dive-directory", {
      cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS, onUpdate: (fresh) => {
        if (Array.isArray(fresh)) diveDirectory.value = fresh
      } },
    })
    diveDirectory.value = Array.isArray(result.data) ? result.data : []
  } catch {
    diveDirectory.value = []
  }
}
function openEditDive(item) {
  editDiveTarget.value = {
    dive_list_id:    item.dive_list_id,
    competitor_id:   item.competitor_id,
    full_name:       item.full_name,
    round_number:    item.round_number,
    current_code:    item.dive_code ? `${item.dive_code}${item.position || ""}` : null,
    current_dive_id: item.dive_id || null,
  }
  editDiveSearch.value = ""
  editDiveErr.value    = ""
  editDiveOpen.value   = true
}
function closeEditDive() {
  editDiveOpen.value = false
  editDiveTarget.value = null
  editDiveSearch.value = ""
  editDiveErr.value = ""
}
const editDiveResults = computed(() => {
  if (!editDiveTarget.value) return []
  const term = editDiveSearch.value.toLowerCase().trim()
  // Filter by the event's height when set (non-mixed events).
  // Mixed events / no-height events show every dive.
  const evHeight = currentEvent.value?.is_mixed_height
    ? null
    : (currentEvent.value?.height ? parseFloat(currentEvent.value.height) : null)
  return diveDirectory.value
    .filter((d) => {
      if (evHeight != null && Number(d.height) !== evHeight) return false
      if (!term) return true
      const code = `${d.dive_code}${d.position || ""}`.toLowerCase()
      return code.includes(term) || (d.description || "").toLowerCase().includes(term)
    })
    .slice(0, 25)
})
async function submitEditDive(diveId) {
  if (!editDiveTarget.value || !currentEvent.value) return
  editDiveBusy.value = true
  editDiveErr.value  = ""
  try {
    const r = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/roster`,
      {
        method: "POST",
        body: JSON.stringify({
          competitor_id: editDiveTarget.value.competitor_id,
          dive_id:       diveId,
          round_number:  editDiveTarget.value.round_number,
        }),
      },
    )
    showSuccess(
      `Updated ${editDiveTarget.value.full_name}'s round ${editDiveTarget.value.round_number} dive.`,
    )
    closeEditDive()
    // Refresh the event-side state so the change shows in the
    // queue + Up Next + standings immediately.
    await onEventChange()
    void r
  } catch (err) {
    editDiveErr.value = err.message || "Failed to save"
  } finally {
    editDiveBusy.value = false
  }
}

// Reserves panel state (migration 040 + Article 4.1.8 / 4.1.10 / 4.1.12 reserve
// replacement). Loaded from /api/events/:id/reserves on event
// change + after each promote. Operator picks a withdrawn or
// active primary to replace from the per-row dropdown — the
// reserve inherits that primary's display_order so the dive
// sequence stays intact.
const reserves            = ref([])
const reservesWithdrawn   = ref([])
const reservesActive      = ref([])
const reservesOpen        = ref(true)
const reservesPromoting   = ref(null)   // competitor_id mid-flight
const reservesReplaceChoice = ref({})   // competitor_id → replaces_id

async function loadReserves() {
  if (!currentEvent.value) {
    reserves.value = []
    reservesWithdrawn.value = []
    reservesActive.value = []
    return
  }
  try {
    const r = await auth.apiFetch(`/api/events/${currentEvent.value.id}/reserves`)
    reserves.value          = Array.isArray(r.reserves)  ? r.reserves  : []
    reservesWithdrawn.value = Array.isArray(r.withdrawn) ? r.withdrawn : []
    reservesActive.value    = Array.isArray(r.active)    ? r.active    : []
  } catch {
    reserves.value = []
    reservesWithdrawn.value = []
    reservesActive.value = []
  }
}

async function promoteReserve(competitorId) {
  if (!currentEvent.value) return
  reservesPromoting.value = competitorId
  try {
    const replaces = reservesReplaceChoice.value[competitorId] || null
    const result = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/reserves/${competitorId}/promote`,
      {
        method: 'POST',
        body: JSON.stringify(replaces ? { replaces_competitor_id: replaces } : {}),
      },
    )
    if (result.replaced_name) {
      showSuccess(`Promoted reserve to slot #${result.display_order}, replacing ${result.replaced_name}.`)
    } else {
      showSuccess(`Promoted reserve to slot #${result.display_order}.`)
    }
    delete reservesReplaceChoice.value[competitorId]
    // Refresh reserves + the active roster (the dive-order +
    // queue both need to pick up the new display_order).
    await loadReserves()
    await onEventChange()
  } catch (err) {
    showError(`Failed to promote: ${err.message}`)
  } finally {
    reservesPromoting.value = null
  }
}

// Super Final surfaces (dive-offs, synchro reserve pool, tied-
// pair suggestions) live in @/components/control/
// SuperFinalPanels.vue. The template ref lets onEventChange
// trigger its per-event reload at the same point the inline
// loaders used to run.
const superFinalPanels = ref(null)

// "Anna Smith & Bella Jones" for a synchro pair, just the lead's
// full name otherwise. Used everywhere a standings row needs a
// human-readable label so synchro pairs aren't represented by
// only one of their names.
function pairLabel(row) {
  if (!row) return ''
  if (row.partner_name) return `${row.full_name} & ${row.partner_name}`
  return row.full_name || ''
}

// Effective "judges that contribute to the dive total" count for
// the current panel. Drives the per-dive max contribution when
// every judge gives the same score X. For individual events this
// is just the post-trim kept count. For synchro 9 / 11 the
// rescale that calc_event_dive_points applies (3 / kept_in_group)
// reduces every panel size to a 9-equivalent.
function panelMultiplier(numJudges, isSynchro) {
  if (isSynchro) return 9
  const drop = trimCount(numJudges)
  return Math.max(1, (parseInt(numJudges) || 5) - 2 * drop)
}

// Catch-up panel — replaces the old "+N pts; #/dive (~#/judge)"
// blob with a target-by-target table:
//
//   Catch-up — 4 dives left
//   1st (Anna Smith & Bella Jones)    avg 8.5
//   2nd (Carla Doe & Eve Smith)       avg 7.2
//   3rd (Felix Liu)                   avg 6.0
//
// When even all-10s would not catch a target the row reads
// "Not possible — even straight 10s falls short". For the leader
// the table flips to "would need to overtake you" framed at #2's
// avg score.
const projectedLine = computed(() => {
  const active = currentActive.value
  const standings = standingsPreview.value
  if (!active || !standings.length) return null

  // Primary match: the per-event public_id hash. See earlier
  // comment for the matching fallback chain.
  const activePublic =
    (active.event_type === 'team' && active.team_public_id) ||
    active.public_id ||
    null
  let idx = -1
  if (activePublic) {
    idx = standings.findIndex(s => s.public_id === activePublic)
  }
  if (idx === -1) {
    const matchKey = (s) =>
      `${s.full_name || ''}|${s.country_code || ''}|${s.partner_name || ''}`
    const activeKey = matchKey({
      full_name: active.full_name,
      country_code: active.country_code,
      partner_name: active.partner_name,
    })
    idx = standings.findIndex(s => matchKey(s) === activeKey)
  }

  const leader = standings[0]
  if (!leader) return null
  if (idx === -1) {
    return {
      kind: 'pre',
      activeName: pairLabel({ full_name: active.full_name, partner_name: active.partner_name }),
      leaderName: pairLabel(leader),
      leaderTotal: Number(leader.total || 0),
    }
  }

  const me = standings[idx]
  const myTotal = Number(me.total || 0)
  const totalRounds = parseInt(currentEvent.value?.total_rounds) || 0
  const numJudges  = parseInt(currentEvent.value?.number_of_judges) || 5
  const isSynchro  = currentEvent.value?.event_type === 'synchro_pair'
  const ddProxy    = parseFloat(active.dd) || null
  const remaining  = totalRounds
    ? totalRounds - (parseInt(active.round_number) || 1) + 1
    : 0
  const mult = panelMultiplier(numJudges, isSynchro)

  // Average judge score X needed across `remaining` dives, given
  // the points gap and a DD proxy. Returns null when remaining/DD
  // are unavailable — the table row will fall back to a points
  // figure only.
  //
  // Derivation: per-dive contribution if every judge scores X is
  // X × mult × DD. So gap G across R dives at avg DD D solves to
  // X = G / (mult × D × R). 10 is the ceiling — any X > 10 means
  // even straight 10s wouldn't close the gap.
  //
  // The displayed value rounds UP to the next 0.5 — judges score
  // in half-point increments, so rounding to one decimal would
  // suggest unattainable targets like 5.2. The smallest achievable
  // panel-wide average that mathematically guarantees closing the
  // gap is `Math.ceil(x * 2) / 2`. The `possible` flag still
  // checks the raw x against 10 so a raw of 9.6 (rounds to 10.0
  // — straight 10s, achievable) doesn't flip to "not possible".
  function avgJudgeForGap(gap) {
    if (gap <= 0)              return { score: 0,    possible: true  }
    if (remaining <= 0 || !ddProxy) return { score: null, possible: null  }
    const raw = gap / (mult * ddProxy * remaining)
    const rounded = Math.ceil(raw * 2) / 2
    return { score: rounded, possible: raw <= 10 }
  }

  // Self-referential preface for both kinds.
  const myLabel = pairLabel(me)

  if (idx === 0) {
    // Active diver is leading. Build the chase view from #2's
    // perspective — what they'd need to overtake. If there's no
    // #2, surface the unopposed cue.
    const second = standings[1]
    if (!second) {
      return { kind: 'unopposed', activeName: myLabel }
    }
    const gap = myTotal - Number(second.total || 0)
    const { score, possible } = avgJudgeForGap(gap)
    return {
      kind: 'lead',
      activeName: myLabel,
      runnerUp: pairLabel(second),
      gap,
      remaining,
      avgJudge: score,
      possible,
    }
  }

  // Active diver is chasing. Build a target row for every rank
  // strictly above them — capped to 1st / 2nd / 3rd because rows
  // beyond that aren't podium-relevant and the panel gets dense.
  const targets = []
  const targetRanks = [0, 1, 2].filter(r => r < idx)
  for (const r of targetRanks) {
    const opponent = standings[r]
    const gap = Number(opponent.total || 0) - myTotal
    const { score, possible } = avgJudgeForGap(gap)
    targets.push({
      rank: r + 1,
      name: pairLabel(opponent),
      gap,
      avgJudge: score,
      possible,
    })
  }
  return {
    kind: 'chase',
    activeName: myLabel,
    currentRank: idx + 1,
    remaining,
    targets,
  }
})

// =============================================================
// QUEUE SEARCH + JUMP-TO-ROUND
// =============================================================
const queueSearch = ref('')
const queueRoundFilter = ref(null)   // null = all rounds

const filteredRoster = computed(() => {
  const term = queueSearch.value.trim().toLowerCase()
  return roster.value
    .map((r, originalIdx) => ({ ...r, originalIdx }))
    .filter(r => {
      if (queueRoundFilter.value && r.round_number !== queueRoundFilter.value) return false
      if (!term) return true
      const haystack = [
        r.full_name, r.partner_name, r.team_name, r.club_name,
        r.dive_code, `${r.dive_code}${r.position}`,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(term)
    })
})

const availableRounds = computed(() => {
  const set = new Set(roster.value.map(r => r.round_number))
  return [...set].sort((a, b) => a - b)
})

// =============================================================
// UP NEXT (right-panel hero) — the next divers in roster
// order, starting AFTER the currently-active diver. Withdrawn
// rows are excluded so the operator never queues a scratched
// diver into a "next" slot.
//
// Resting view shows the next 3; click "Show N more ↓"
// (rendered INSIDE the list after the 3rd row) to expand to
// the full set. The same anchored-toggle pattern the history
// columns + scoreboard Up Next use, so the button doesn't
// jump down off the operator's eye-line on click.
//
// Drives the panel that replaces the old Diver Queue as the
// primary right-panel surface; the full searchable roster lives
// in a collapsed-by-default "Dive Order" panel underneath.
// =============================================================
const UP_NEXT_DEFAULT_LIMIT = 3
const upNextShowAll = ref(false)
const upNextDives = computed(() => {
  // A finished event has nobody "up next" — the meet is over, so
  // the queue panel hides entirely (it's gated on length below).
  if (currentEvent.value?.status === 'Completed') return []
  if (!roster.value.length) return []
  // Start one past the active row. When no row is active (pre-
  // meet, or just after a randomise), start from the beginning.
  const start = currentIndex.value >= 0 ? currentIndex.value + 1 : 0
  const tail = []
  for (let i = start; i < roster.value.length; i++) {
    if (roster.value[i].withdrawn_at) continue
    tail.push({ ...roster.value[i], originalIdx: i })
    if (!upNextShowAll.value && tail.length >= UP_NEXT_DEFAULT_LIMIT) break
  }
  return tail
})

// Total non-withdrawn dives still ahead — drives the "Show all
// (N)" copy on the toggle so the operator knows how much they're
// expanding into.
const upNextTotal = computed(() => {
  if (currentEvent.value?.status === 'Completed') return 0
  if (!roster.value.length) return 0
  const start = currentIndex.value >= 0 ? currentIndex.value + 1 : 0
  let n = 0
  for (let i = start; i < roster.value.length; i++) {
    if (!roster.value[i].withdrawn_at) n++
  }
  return n
})

// Collapsed-by-default "Dive Order" panel — holds the search +
// round chips + reorderable roster that used to live at the top
// of the right panel. Operators only need it during pre-meet
// setup or for a manual jump; live scoring leans on Up Next.
const diveOrderOpen = ref(false)

// =============================================================
// HISTORY FILTER — by diver, by round
// =============================================================
const historyDiverFilter = ref('')   // full_name, '' = all
const historyRoundFilter = ref(null) // round, null = all

const filteredHistory = computed(() => {
  return historyCards.value.filter(h => {
    if (historyDiverFilter.value && h.name !== historyDiverFilter.value) return false
    if (historyRoundFilter.value && h.round !== historyRoundFilter.value) return false
    return true
  })
})

// Compressed-layout pass: only the most-recent 3 cards show
// at rest; the operator clicks "Show more" to expand. The full
// list is one click away but the resting left column stays a
// short, scannable strip. The audience-facing scoreboard
// uses a slightly larger 5-card preview because spectators
// can't fall back on memory of "what just happened" the way
// the operator can. Reset on filter change so a "View all"
// expansion doesn't carry over to a freshly filtered view.
// historyPreview / historyRest split: the toggle button sits
// AFTER the preview cards, with the rest dropping down BELOW
// the button when expanded. Without this split, clicking the
// button would push it down off the user's eye line as the
// list grew.
const HISTORY_PREVIEW_COUNT = 3
const historyShowAll = ref(false)
const historyPreview = computed(() =>
  filteredHistory.value.slice(0, HISTORY_PREVIEW_COUNT),
)
const historyRest = computed(() =>
  filteredHistory.value.slice(HISTORY_PREVIEW_COUNT),
)
watch([historyDiverFilter, historyRoundFilter], () => {
  historyShowAll.value = false
})

const historyDivers = computed(() => {
  const set = new Set(historyCards.value.map(h => h.name))
  return [...set].sort()
})


// Connection state is exposed by the composable as
// socket.isConnected — no parallel listeners here.

// Live listeners below all go through useSocketEvent so they're
// torn down with the view. The pooled socket survives navigation
// (NotificationCenter holds a ref), so a bare socket.on here
// would leave a dead Control Room instance still receiving
// score_received — and its auto-advance could move a live meet.

useSocketEvent(socket, 'score_received', (data) => {
  // Invalidate the client-side scoreboard cache for this event so
  // the next refreshStandingsPreview() / showLeaderboard() hits
  // fresh data. Server already invalidates its own cache; the
  // client cache otherwise serves up to 5s of stale data after
  // a new score. Fire-and-forget; failure here is harmless.
  if (data?.event_id) {
    idbInvalidate(`/api/scoreboard/${data.event_id}`).catch(() => {})
  }

  if (!currentActive.value) return
  if (data.event_id !== currentActive.value.event_id) return
  if (data.competitor_id !== currentActive.value.competitor_id) return
  if (data.round_number !== currentActive.value.round_number) return

  if (data.judge_id) scoresThisRound.value[data.judge_id] = parseFloat(data.score)

  // Update judge tile
  let tile = data.judge_number
    ? judgeTiles.value.find(t => t.judgeIndex === parseInt(data.judge_number))
    : judgeTiles.value.find(t => t.judgeId === data.judge_id)
  if (!tile) tile = judgeTiles.value.find(t => !t.scored)
  if (tile) {
    tile.judgeId = data.judge_id
    tile.scored = true
    tile.score = parseFloat(data.score).toFixed(1)
  }

  const totalJudges = parseInt(currentEvent.value?.number_of_judges) || 0
  const scoresIn = Object.keys(scoresThisRound.value).length
  const allScoresIn = totalJudges > 0 && scoresIn >= totalJudges

  if (allScoresIn) {
    const scoreValues = Object.values(scoresThisRound.value)
    addHistoryCard({
      diverName: currentActive.value.full_name,
      country_code: currentActive.value.country_code,
      club_name: currentActive.value.club_name,
      club_code: currentActive.value.club_code,
      partner_name: currentActive.value.partner_name,
      partner_country: currentActive.value.partner_country,
      team_name: currentActive.value.team_name,
      team_code: currentActive.value.team_code,
      competitor_id: currentActive.value.competitor_id,
      round_number: currentActive.value.round_number,
      dive_code: currentActive.value.dive_code,
      position: currentActive.value.position,
      dd: currentActive.value.dd,
      description: currentActive.value.description,
      judge_scores: scoreValues,
      total_points: scoreValues.reduce((a, b) => a + b, 0),
    })
    stopShotClock()                                    // dive complete — clock irrelevant
    updateNextButton(true)
    // Round-end detection: this might have been the final dive
    // of the round. detectRoundEnd surfaces a prompt if so —
    // it'll also kick off the auto-advance timer for the round-
    // end announcement (see watcher on roundEndPromptOpen).
    detectRoundEnd(currentActive.value.round_number)
    // Refresh the inline standings preview so the operator
    // sees totals shift as dives complete.
    refreshStandingsPreview()
    // Auto-advance: only kick off the timer if we're NOT at a
    // round-end (the round-end modal owns that flow) and NOT
    // at the final dive (Finalise should always be a manual
    // confirm — auto-firing finalise would be destructive).
    if (!roundEndPromptOpen.value && !nextBtnComplete.value) {
      startAutoAdvance(nextDiver)
    }
  }
})

useSocketEvent(socket, 'live_result_calculated', (data) => {
  addHistoryCard(data)
  resetJudgeTiles()
})

// judge_signal — judge tapped "Signal Referee" on their
// keypad (or tapped again to clear). Match to the active dive
// + judge_number, flip the tile's signaled flag. The tile
// renders a red ring when the flag is on.
useSocketEvent(socket, 'judge_signal', (data) => {
  if (!currentActive.value) return
  if (data.event_id      !== currentActive.value.event_id)      return
  if (data.competitor_id !== currentActive.value.competitor_id) return
  if (Number(data.round_number) !== Number(currentActive.value.round_number)) return
  const tile = judgeTiles.value.find(t => t.judgeIndex === parseInt(data.judge_number))
  if (tile) tile.signaled = !!data.signaled
})

function initJudgeTiles(n) {
  judgeTiles.value = []
  for (let i = 1; i <= n; i++) {
    // signaled flag → red ring on the tile when this judge has
    // tapped "Signal Referee" on their keypad. Cleared on every
    // setActive() / resetJudgeTiles() pass.
    judgeTiles.value.push({ judgeIndex: i, judgeId: null, score: '—', scored: false, signaled: false })
  }
}

function resetJudgeTiles() {
  judgeTiles.value.forEach(t => {
    t.scored = false
    t.judgeId = null
    t.score = '—'
    t.signaled = false
  })
}

function addHistoryCard(data) {
  let scores = []
  if (Array.isArray(data.judge_scores)) {
    scores = data.judge_scores.map(s => parseFloat(s))
  } else if (typeof data.judge_scores === 'string') {
    try { scores = JSON.parse(data.judge_scores).map(s => parseFloat(s)) } catch { scores = [] }
  } else if (typeof data.judge_array === 'string') {
    scores = data.judge_array.split(',').map(s => parseFloat(s))
  }

  const total = scores.length
    ? scores.reduce((a, b) => a + b, 0).toFixed(1)
    : data.total_points != null ? parseFloat(data.total_points).toFixed(1) : '—'

  const name = data.diverName || data.full_name || '—'
  const country = data.country_code || null
  const club_name = data.club_name || null
  const club_code = data.club_code || null
  // Synchro pair fields. Both the live card path (built from
  // currentActive.value when all judges submit) and the post-
  // refresh /history path carry these now, so the rendered
  // card surfaces both names + the partner's country in the
  // affiliation badge fallback.
  const partner_name = data.partner_name || null
  const partner_country = data.partner_country || null
  const team_name = data.team_name || null
  const team_code = data.team_code || null
  const dive_code = data.dive_code || null
  const position = data.position || null
  const dd = data.dd != null ? parseFloat(data.dd) : null
  const desc = data.description || null
  const total_rounds = data.total_rounds || currentEvent.value?.total_rounds || null
  // Capture score row ids if the source provided them — used by
  // the correction modal to PUT /api/scores/:id. Live cards
  // built from socket events don't have ids yet (the upsert
  // happens server-side); the history endpoint includes them.
  const score_ids = Array.isArray(data.score_ids) ? data.score_ids : []
  // Stash event_id + competitor_id so the modal can refetch ids
  // if needed.
  const event_id = data.event_id || currentEvent.value?.id || null
  const competitor_id = data.competitor_id || null

  historyCards.value.unshift({
    name, country,
    partner_name, partner_country,
    club_name, club_code,
    team_name, team_code,
    dive_code, position, dd, desc,
    round: data.round_number, total_rounds, scores, total,
    score_ids, event_id, competitor_id,
  })
}

function setActive(idx) {
  if (idx < 0 || idx >= roster.value.length) return
  // Any manual jump cancels an in-flight auto-advance — the
  // operator chose this diver, don't override them with the
  // timer.
  cancelAutoAdvance()
  currentIndex.value = idx
  currentActive.value = roster.value[idx]
  scoresThisRound.value = {}
  // Run the description through diveDescription so the position
  // word ("Pike", "Tuck", etc.) appends to the action — e.g.
  // "Forward Dive Pike" instead of just "Forward Dive". The
  // operator (and the broadcast feed) sees the full audience-
  // facing label without doing the mental composition.
  activeInfo.value = {
    name: currentActive.value.full_name,
    country: currentActive.value.country_code || null,
    code: `${currentActive.value.dive_code}${currentActive.value.position}`,
    dd: `DD ${currentActive.value.dd}`,
    desc: diveDescription(currentActive.value) || '—',
    team_name: currentActive.value.team_name || null,
    partner_name: currentActive.value.partner_name || null,
    partner_country: currentActive.value.partner_country || null,
    round_number: currentActive.value.round_number,
    // Club details — surfaced in the active-diver block so the
    // operator can verify identity at a glance and the audience
    // (via broadcast mode) sees who's representing whom.
    club_name: currentActive.value.club_name || null,
    club_code: currentActive.value.club_code || null,
  }
  socket.emit('set_active_diver', {
    ...currentActive.value,
    diverName: currentActive.value.full_name,
    country_code: currentActive.value.country_code || null,
    club_name: currentActive.value.club_name || null,
    club_code: currentActive.value.club_code || null,
    diveCode: `${currentActive.value.dive_code}${currentActive.value.position}`,
    // description is the dive_directory action ("Forward Dive",
    // "Back 2½ Somersaults", …); position is the World Aquatics letter
    // (A/B/C/D). Audience views recompose them via
    // diveDescription() — pass null instead of '—' for missing
    // values so the v-if hides the line cleanly when the row is
    // incomplete.
    description: currentActive.value.description || null,
    position:    currentActive.value.position    || null,
    // Profile-link IDs surfaced explicitly: the spectator
    // scoreboard wraps both diverName and partner_name in
    // /profile/<id> RouterLinks. The spread above already
    // carries these from the roster query, but listing them
    // by name documents the contract and survives any future
    // refactor that changes how currentActive is shaped.
    competitor_id: currentActive.value.competitor_id || null,
    partner_id:    currentActive.value.partner_id    || null,
    eventName: currentEvent.value?.name || '—',
  })
  resetJudgeTiles()
  updateNextButton(false)
  // Reset + auto-start the 60-second shot clock for this diver.
  // Operator can pause / extend if needed (warm-up, equipment).
  // activeStatus is a computed that derives off scoresThisRound +
  // shotClockExpired — both reset above, so the status falls
  // back to 'ready' on its own without an explicit assignment.
  startShotClock()
}

function updateNextButton(allScoresIn) {
  const isLast = currentIndex.value >= roster.value.length - 1
  if (!allScoresIn) {
    nextBtnDisabled.value = true
    nextBtnText.value = t('control.next_diver') + ' →'
    nextBtnComplete.value = false
    return
  }
  if (isLast) {
    nextBtnDisabled.value = false
    nextBtnText.value = '✓ Event Complete — ' + t('control.finalise') + ' & ' + t('control.view_results')
    nextBtnComplete.value = true
  } else {
    nextBtnDisabled.value = false
    nextBtnText.value = t('control.next_diver') + ' →'
    nextBtnComplete.value = false
  }
}

function refAction(type) {
  if (!currentActive.value) return
  // A referee action mid-countdown means the dive needs review
  // — kill the timer so the operator can finish what they're
  // doing without racing the auto-advance.
  cancelAutoAdvance()
  const payload = {
    event_id: currentActive.value.event_id,
    competitor_id: currentActive.value.competitor_id,
    round_number: currentActive.value.round_number,
  }
  if (type === 'failed') socket.emit('referee_failed_dive', payload)
  if (type === 'cap') socket.emit('referee_cap_scores', { ...payload, cap_value: 2.0 })
  if (type === 'redive') socket.emit('referee_redive', payload)
  refreshRecentAuditSoon(700)
}

async function nextDiver() {
  // Cancel any in-flight auto-advance — whether the operator
  // clicked Next manually OR the timer fired, the timer needs
  // to be gone before setActive() so it doesn't race a fresh
  // countdown that's about to start for the next diver.
  cancelAutoAdvance()
  // Guard against accidental skip when scores are partial. Once
  // a referee action (cap, redive, failed) has fired, the next
  // button leaves "disabled" state — but the score map can be
  // incomplete. Require a confirm so a fat-fingered space-bar
  // doesn't lose data.
  const totalJudges = parseInt(currentEvent.value?.number_of_judges) || 0
  const scoresIn = Object.keys(scoresThisRound.value).length
  const partial = totalJudges > 0 && scoresIn > 0 && scoresIn < totalJudges
  if (!nextBtnComplete.value && partial) {
    if (!await confirmAction({
      title: 'Skip ahead with partial scores?',
      body: `Only ${scoresIn} of ${totalJudges} judges have submitted for this dive.`,
      consequences: [
        'The dive will close with whatever scores arrived',
        'Missing judges can still amend via score correction afterwards',
      ],
      confirmLabel: 'Move on',
      confirmKind: 'warn',
    })) return
  }
  if (nextBtnComplete.value) {
    finaliseEvent()
  } else {
    setActive(currentIndex.value + 1)
  }
}

// Keyboard shortcuts for the Control Room — meet referees often
// run the queue with one hand on the keyboard. Only fire when
// the focus is somewhere outside an input/textarea so typing
// into a search box doesn't accidentally advance the queue.
function isTypingTarget(el) {
  if (!el) return false
  const tag = (el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function onKeydown(e) {
  if (isTypingTarget(e.target)) return
  if (!currentEvent.value) return
  // Avoid stomping on browser navigation (alt-arrow / cmd-arrow)
  if (e.altKey || e.metaKey || e.ctrlKey) return

  switch (e.key) {
    case 'Escape':
      // Close any open overflow menu / popover before falling
      // through to the default browser handling.
      if (rosterMenuOpenIdx.value >= 0
          || headerMenuOpen.value
          || adjustMenuOpen.value
          || autoNextMenuOpen.value
          || kbdHintsOpen.value) {
        e.preventDefault()
        closeOverflowMenus()
      }
      break
    case '?':                 // mirror the toolbar ? button — show/hide the hotkey overlay
      e.preventDefault()
      toggleMenu('kbd')
      break
    case 'ArrowRight':
    case ' ':                 // space = advance — same muscle memory as a remote
      e.preventDefault()
      nextDiver()
      break
    case 'ArrowLeft':
      if (currentIndex.value > 0) {
        e.preventDefault()
        setActive(currentIndex.value - 1)
      }
      break
    case 'l':
    case 'L':
      e.preventDefault()
      showLeaderboard()
      break
    case 'h':
    case 'H':                 // hold / resume
      e.preventDefault()
      isHeld.value ? resumeMeet() : openHoldPrompt()
      break
    case 'r':
    case 'R':                 // re-dive
      e.preventDefault()
      refAction('redive')
      break
    case 'f':
    case 'F':                 // failed dive
      e.preventDefault()
      refAction('failed')
      break
    case 't':
    case 'T':                 // reset shot clock
      e.preventDefault()
      resetShotClock()
      break
    default:
      // Number keys 1-9 jump to roster position N (within
      // visible filtered roster, so search + jump compose).
      if (/^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1
        const target = filteredRoster.value[n]
        if (target) {
          e.preventDefault()
          setActive(target.originalIdx)
        }
      }
  }
}

async function showLeaderboard() {
  const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
  lbRows.value = data.standings || []
  lbShow.value = true
  socket.emit('announce_score', { standings: data.standings, eventId: currentEvent.value.id })
}

async function finaliseEvent() {
  if (!currentEvent.value) return
  const ev = currentEvent.value
  // Compose competitor count for the consequences text — N
  // unique non-withdrawn divers in the roster.
  const diverIds = new Set()
  for (const r of roster.value) {
    if (r.withdrawn_at) continue
    diverIds.add(r.competitor_id || r.diver_id || r.dive_list_id)
  }
  const n = diverIds.size
  if (!await confirmAction({
    title: 'Finalise event?',
    body:  `"${ev.name}" will flip to Completed and the recap publishes.`,
    consequences: [
      'Public scoreboard switches to recap mode (podium + full standings)',
      'Event lands in the public Results Archive',
      n ? `"Results posted" emails go out to ${n} competitor${n === 1 ? '' : 's'} (if SMTP is configured)` : '"Results posted" emails go out to every competitor (if SMTP is configured)',
      'Reversible by an org admin via Meet Manager → set status back to Live',
    ],
    confirmLabel: 'Finalise & publish',
    confirmKind:  'primary',
  })) return
  try {
    const evId = currentEvent.value.id
    const evName = currentEvent.value.name
    const finaliseResponse = await auth.apiFetch(`/api/events/${evId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Completed' }),
    })
    currentEvent.value.status = 'Completed'
    // finaliseBtnText is computed off currentEvent.status, so
    // flipping the status above also flips the label to
    // "View Results" without an explicit assignment here.
    await showLeaderboard()
    // Phase 4 — if the event ran long, the server returned a
    // reflow proposal. Surface the modal so the operator can
    // confirm which downstream blocks shift. Skipping the modal
    // (or having no candidates) leaves the timeline untouched —
    // the manual scheduler editor stays available either way.
    if (finaliseResponse && finaliseResponse.reflow
        && Array.isArray(finaliseResponse.reflow.candidates)
        && finaliseResponse.reflow.candidates.length) {
      reflowProposal.value = finaliseResponse.reflow
      reflowEventName.value = evName
      reflowOpen.value = true
    }
    // Offer an Undo. Finalising flips status Live → Completed,
    // which is fully reversible by an org admin via the same
    // status endpoint. Common misclick recovery — the operator
    // hits Finalise expecting "Next Diver" or vice versa.
    showUndo({
      message: `Finalised "${evName}" — results published.`,
      timeoutMs: 12000,
      onUndo: async () => {
        // Force-back-to-live route — outbox-queue it too so a
        // network blip during the undo doesn't strand the
        // operator on the wrong status.
        await queueAction({
          method: 'PUT',
          url: `/api/events/${evId}/status`,
          body: { status: 'Live' },
          actionType: 'event_status_flip',
        })
        if (currentEvent.value && currentEvent.value.id === evId) {
          currentEvent.value.status = 'Live'
          // Computed labels reset automatically — no manual
          // finaliseBtnText assignment needed here.
          lbShow.value = false
        }
      },
    })
  } catch (err) {
    showError('Failed to finalise: ' + err.message)
  }
}

async function onEventChange() {
  if (!selectedEventId.value) return
  // Modal/state reset — switching events shouldn't carry over
  // half-typed score corrections, an unconfirmed sign-off
  // dialog, or a stale round-end prompt from the prior event.
  // Each helper is a no-op when the modal isn't open.
  closeCorrection()
  signoffOpen.value = false
  holdPromptOpen.value = false
  roundEndPromptOpen.value = false
  // (Score-correction draft fields now live inside
  // ScoreCorrectionModal and die with its v-if unmount.)

  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return
  meetName.value = currentEvent.value.name
  historyCards.value = []
  lateArrivalReviewCount.value = 0
  recentAuditRows.value = []
  scheduleConflicts.value = []
  initJudgeTiles(currentEvent.value.number_of_judges)
  loadScheduleConflictsForEvent()
  loadRecentAuditRows()

  const [rosterData, histData, judgesData] = await Promise.all([
    auth.apiFetch(`/api/events/${selectedEventId.value}/roster`),
    auth.apiFetch(`/api/events/${selectedEventId.value}/history`),
    auth.apiFetch(`/api/events/${selectedEventId.value}/judges`).catch(() => []),
  ])
  roster.value = rosterData
  judgePanel.value = Array.isArray(judgesData) ? judgesData : []
  // Top-5 standings preview alongside the queue.
  refreshStandingsPreview()
  // Reserves panel — only meaningful on advanced events
  // (semi-final / final), but the endpoint just returns []
  // when none exist so we always call.
  loadReserves()

  // Super Final dive-offs panel + tied-pair suggestions —
  // owned by SuperFinalPanels now; reload() keeps the original
  // per-event-change cadence (no-op on other formats).
  superFinalPanels.value?.reload()

  // The /history endpoint returns dives ascending (round ASC,
  // name ASC); addHistoryCard() unshifts each card, so iterating
  // in natural order leaves the last-iterated (latest round /
  // diver) on TOP — reverse-chronological, matching the live path
  // where each completed dive is unshifted as it lands. (A stray
  // .reverse() here used to cancel the unshift and render the
  // list oldest-first.)
  ;[...histData].forEach(h => {
    addHistoryCard({
      diverName: h.diverName || h.full_name,
      country_code: h.country_code,
      club_name: h.club_name,
      club_code: h.club_code,
      partner_name: h.partner_name,
      partner_country: h.partner_country,
      team_name: h.team_name,
      team_code: h.team_code,
      round_number: h.round_number,
      dive_code: h.dive_code,
      position: h.position,
      dd: h.dd,
      description: h.description,
      judge_scores: h.judge_scores,
      total_points: h.total_points,
      // Pass through ids + ownership so the score-correction
      // modal can target the right rows.
      score_ids: h.score_ids,
      event_id: h.event_id,
      competitor_id: h.competitor_id,
    })
  })

  // Hold state — re-pull on event switch in case a hold was set
  // from another Control Room instance before we connected.
  isHeld.value = false
  holdReason.value = ''
  socket.emit('get_meet_hold', { event_id: selectedEventId.value })

  if (roster.value.length) {
    if (currentEvent.value.status === 'Completed') {
      // Finished event — review mode. We deliberately do NOT call
      // setActive(): that emits set_active_diver to the spectator
      // scoreboard and starts the 60s shot clock, neither of which
      // belongs on a completed meet. Instead point the position
      // counter at the final dive (so the header reads "Round N / N
      // · Diver M / M" rather than misleadingly claiming we're back
      // at diver 1 of round 1) and leave currentActive null — that
      // keeps the shot clock + READY/DIVING status pill hidden and
      // stops the activeStatus watcher from emitting a live diver.
      const last = roster.value[roster.value.length - 1]
      currentIndex.value = roster.value.length - 1
      currentActive.value = null
      activeInfo.value = {
        name: last.full_name,
        country: last.country_code || null,
        code: `${last.dive_code}${last.position}`,
        dd: `DD ${last.dd}`,
        desc: diveDescription(last) || '—',
        team_name: last.team_name || null,
        partner_name: last.partner_name || null,
        partner_country: last.partner_country || null,
        round_number: currentEvent.value.total_rounds || last.round_number,
        club_name: last.club_name || null,
        club_code: last.club_code || null,
      }
      updateNextButton(false)
    } else {
      setActive(0)
    }
  } else {
    activeInfo.value = { name: 'No divers registered', code: '—', dd: 'DD —', desc: 'No competitors have submitted dive lists.' }
  }
  // finaliseBtnShow / finaliseBtnText are now computed off
  // currentEvent.status + nextBtnComplete — no manual refresh
  // needed when the event changes.
}

// rankClass imported from @/lib/format — single source of truth.
const medals = ['🥇', '🥈', '🥉']

onMounted(async () => {
  events.value = await auth.apiFetch('/api/events')
  // Dive directory feeds the Edit-Dive modal's picker.
  loadDiveDirectory()
  // Honour /control?event=<id> so deep-links from Meet Manager
  // (the per-event "Open Control Room" primary button) land on
  // the right event preselected, instead of dumping the
  // operator on the picker. Falls through silently if the id
  // doesn't match any event the caller can see.
  const preselectId = route.query.event
  if (preselectId && events.value.some(e => e.id === preselectId)) {
    selectedEventId.value = preselectId
    await onEventChange()
  }
  window.addEventListener('keydown', onKeydown)
  // Capture-phase mousedown so a click on the Adjust / kbd-? /
  // header-⋯ trigger fires its own toggle BEFORE this listener
  // sees the event and would otherwise close the menu it just
  // opened. The trigger buttons stop propagation explicitly.
  window.addEventListener('mousedown', onGlobalClick, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousedown', onGlobalClick, true)
  cancelAutoAdvance()
})

</script>

<template>
  <div :class="['ctrl-layout', opsBroadcast ? 'ctrl-broadcast' : '']">
    <!-- Offline / sync status. Renders nothing unless the outbox
         has activity or the socket is disconnected. Operator-side
         this surfaces "your judge broadcast is offline" before the
         judges themselves notice. -->
    <OfflineBanner />
    <!-- Late-arrival queue (DEC-04). Rows the deadline-with-review
         gate accepted because actor_local_time was before the
         deadline even though the server saw the request after.
         Each row gets an approve/deny button. Renders nothing
         when the queue is empty. -->
    <LateArrivalReviewTray
      :event-id="currentEvent?.id || null"
      @loaded="onLateArrivalRowsLoaded"
    />
    <!-- Outbox-side conflict queue. Surfaces local entries the
         server returned 409 for (concurrency race; another
         device wrote the same target first). Operator picks
         discard or retry per entry. -->
    <ConflictReviewTray />
    <!-- Manual-fallback entry trigger (P5). When the operator
         needs to type each judge's score (judges showing values
         on phone screens via BigScoreDisplay), tap this to open
         the per-judge form. Only renders when a diver is active;
         no dive context means no target tuple to attribute to. -->
    <div v-if="currentActive" class="manual-entry-trigger">
      <button class="btn btn-ghost btn-sm"
              type="button"
              @click="openManualEntry"
              v-tip="'Open the manual score-entry form (P5 fallback). Use when judges are showing scores on their phones and the digital broadcast isn\'t getting through.'">
        ⌨ Manual score entry
      </button>
    </div>
    <!-- Floating exit out of operator broadcast mode. -->
    <RouterLink
      v-if="opsBroadcast"
      to="/control"
      class="ops-broadcast-exit"
      v-tip="'Exit broadcast mode'"
    >✕</RouterLink>
    <!-- Header — 3-column grid (left / centre / right). Switched
         from flex + absolute-positioned centre to grid because the
         left group (logo + event picker + connection chip) used to
         overflow into the absolutely-positioned centre meet name
         on narrower viewports, hiding the title behind the
         "CONNECTED" pill. With grid the three regions occupy real
         columns and can never overlap. -->
    <div class="ctrl-header">
      <!-- The connection chip moved into the active-diver strip and
           the Broadcast launcher moved to the right-hand button
           cluster, so the header's left side is just the event
           picker + status now. -->
      <!-- Centre: event picker dressed as the page title. Native
           <select> styled to look like a clickable heading — large
           display font, chevron affordance, hover/focus border.
           Reads as both "this is the current event" and "tap to
           switch". Meet name + status pill drop into a subtitle
           row beneath. Secondary actions (Hold / Broadcast /
           Dashboard) live in the ⋯ menu on the right. -->
      <div class="ctrl-header-ctx">
        <div class="event-title-row">
          <div class="event-title-wrap">
            <select class="event-title-select event-select-sm"
                    v-model="selectedEventId"
                    @change="onEventChange"
                    v-tip:bottom="'Switch to a different event'">
              <option value="">— Select Event —</option>
              <optgroup v-for="g in eventGroups" :key="g.meetId || 'none'" :label="g.label">
                <option v-for="ev in g.events" :key="ev.id" :value="ev.id">{{ ev.name }}</option>
              </optgroup>
            </select>
            <span class="event-title-chevron" aria-hidden="true">▾</span>
          </div>
          <!-- Status pill — same colour vocabulary as the dashboard
               pulse strip. Hidden until an event is selected; the
               picker is the prompt when none is. -->
          <StatusPill v-if="currentEvent?.status" :status="currentEvent.status" size="sm" />
          <span v-if="currentEvent?.is_rehearsal"
                class="rehearsal-pill"
                v-tip="'Dry-run event: hidden from public archive, analytics, emails, and records'">
            Rehearsal
          </span>
        </div>
        <!-- Meet subtitle — drop the meet name (and an explicit
             "venue / federation" subtitle pattern) under the event
             title so the page chrome reads page-title → context
             rather than fighting for the centre with the title. -->
        <div v-if="meetName && meetName !== currentEvent?.name" class="event-title-meta">
          {{ meetName }}
        </div>
      </div>
      <div class="ctrl-header-right">
        <!-- Hold-active glance pill: shows ONLY while held. Click
             resumes immediately; the rest of the time Hold is
             reachable via the ⋯ menu so the resting header isn't
             cluttered with a button the operator clicks ~once
             per meet. -->
        <button
          v-if="isHeld"
          class="btn-hold btn-hold-active"
          @click="resumeMeet"
          v-tip:bottom="'Resume the meet (H)'"
        >▶ {{ $t('control.resume') }}</button>
        <!-- Overflow menu — secondary chrome that the operator
             touches infrequently. Clicking the ⋯ toggles a small
             popover; the global mousedown listener closes it on
             outside-click. Each item closes the menu after firing
             so a re-click opens, click-once-action closes. -->
        <div v-if="headerMenuHasItems" class="dropdown-host header-menu-host">
          <button
            class="btn-back btn-icon"
            @click.stop="toggleMenu('header')"
            :aria-expanded="headerMenuOpen"
            v-tip:bottom.fixed="'More actions'"
          >⋯</button>
          <div v-if="headerMenuOpen" class="dropdown-menu header-menu">
            <button
              v-if="currentEvent && currentEvent.status !== 'Completed' && !isHeld"
              class="dropdown-item"
              @click="openHoldPrompt(); headerMenuOpen = false"
            >⏸ {{ $t('control.hold') }}</button>
            <!-- Sponsor branding — only when the current event
                 lives inside a meet (sponsor is meet-scoped). -->
            <button
              v-if="currentEvent && currentEvent.meet_id && !opsBroadcast"
              class="dropdown-item"
              @click="sponsorBrandingOpen = true; headerMenuOpen = false"
              v-tip="'Upload / reorder / rotate sponsor logos for this meet.'"
            >🎨 {{ $t('control.sponsor_branding') }}</button>
            <!-- Finalise event early — only relevant during a
                 Live meet that hasn't reached its last dive. The
                 prominent header "Finalise Event ✓" button only
                 appears at the natural completion moment, but
                 occasionally an operator needs to cut a meet
                 short (postponement, equipment failure, safety).
                 Amber hover treatment so the operator pauses
                 before clicking; finaliseEvent() already wraps
                 the action in a confirm() dialog. -->
            <button
              v-if="finaliseEarlyVisible"
              class="dropdown-item dropdown-item-amber"
              @click="finaliseEvent(); headerMenuOpen = false"
              v-tip="'Finalise the meet now even though dives are still pending. Use sparingly — postponement, equipment failure, etc.'"
            >✓ Finalise event early…</button>
            <button
              v-if="currentActive"
              class="dropdown-item"
              @click="openManualEntry(); headerMenuOpen = false"
            >Manual score entry</button>
          </div>
        </div>
        <button
          v-if="finaliseBtnShow"
          class="btn-finalise"
          v-tip:bottom.fixed="finaliseBtnTitle"
          @click="currentEvent?.status === 'Completed' ? showLeaderboard() : finaliseEvent()"
        >{{ finaliseBtnText }}</button>
        <!-- Judge Ranking Analysis — only relevant for Completed
             events (the matrix is meaningless until every dive is
             in). Available on individual / synchro_pair / team
             alike; the modal's component handles the type
             differences (pairs render lead & partner; teams
             render team name; individual is the simple case). -->
        <button
          v-if="currentEvent?.status === 'Completed'"
          class="btn-finalise btn-judge-ranking"
          v-tip:bottom.fixed="'Show how the standings would change if every judge had scored unanimously like one specific judge'"
          @click="judgeRankingOpen = true"
        >Judge Analysis</button>
        <!-- Broadcast launcher — far-right of the header. Opens the
             broadcast chooser (projector / stream / OBS / venue
             scoreboard bridge). -->
        <button
          v-if="currentEvent && !opsBroadcast"
          class="btn-back btn-broadcast"
          @click="broadcastModal?.open()"
          v-tip:bottom.fixed="'Broadcast this event — projector, stream overlay, OBS, or venue scoreboard'"
        >{{ $t('control.broadcast_menu') }}</button>
      </div>
    </div>

    <!-- Hold banner — visible whenever the meet is on hold. -->
    <div v-if="isHeld" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>

    <!-- Judge panel picker — opened from the readiness checklist
         when the panel isn't yet full. Self-contained: loads its
         own judge list, posts to /api/events/:id/judges, and on
         save emits → refreshJudgePanel() so the readiness check
         updates in place. -->
    <JudgePanelModal
      :open="judgePanelModalOpen"
      :event-id="selectedEventId"
      :panel-size="currentEvent?.number_of_judges || 5"
      :event-name="currentEvent?.name || ''"
      :meet-id="currentEvent?.meet_id || null"
      @close="judgePanelModalOpen = false"
      @saved="refreshJudgePanel"
    />

    <!-- Pre-flight review modal — final visual check before
         flipping the event Live. The four-step pre-meet stepper
         already verified the procedural prerequisites; this
         modal summarises the actual state (roster, panel,
         referee) plus any warnings worth a second look. -->
    <div v-if="preFlightOpen && preFlightSummary" class="lb-backdrop preflight-backdrop"
         @mousedown.self="preFlightOpen = false">
      <div class="preflight-modal" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
        <div class="preflight-head">
          <div id="preflight-title" class="preflight-title">{{ $t('control.preflight.title') }}</div>
          <div class="preflight-subtitle">{{ preFlightSummary.eventName }}</div>
        </div>

        <div class="preflight-grid">
          <div class="preflight-section">
            <div class="preflight-label">{{ $t('control.preflight.section_event') }}</div>
            <div class="preflight-row">
              <span class="preflight-pill">{{ preFlightSummary.eventType }}</span>
              <span v-if="preFlightSummary.height" class="preflight-pill">
                {{ preFlightSummary.height }}
              </span>
              <span v-if="preFlightSummary.ageGroup" class="preflight-pill">{{ preFlightSummary.ageGroup }}</span>
              <span class="preflight-pill">{{ $t('control.preflight.rounds_suffix', { n: preFlightSummary.rounds }) }}</span>
              <span v-if="preFlightSummary.isRehearsal" class="preflight-pill preflight-pill-rehearsal">
                {{ $t('control.preflight.rehearsal_tag') }}
              </span>
            </div>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">{{ $t('control.preflight.section_roster') }}</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.diverCount ? 'ok' : 'warn']">
                {{ preFlightSummary.diverCount ? '✓' : '⚠' }}
              </span>
              {{ preFlightSummary.diverCount === 1
                  ? $t('control.preflight.diver_count_one', { n: preFlightSummary.diverCount })
                  : $t('control.preflight.diver_count_many', { n: preFlightSummary.diverCount }) }}
            </div>
            <ul v-if="preFlightSummary.incompleteDivers.length" class="preflight-detail-list">
              <li v-for="d in preFlightSummary.incompleteDivers" :key="d.id">
                <template v-if="d.missingDive">
                  {{ d.missingDive === 1
                    ? $t('control.preflight.diver_rows_with_missing_one', { name: d.name, rows: d.rows, total: preFlightSummary.rounds, missing: d.missingDive })
                    : $t('control.preflight.diver_rows_with_missing_many', { name: d.name, rows: d.rows, total: preFlightSummary.rounds, missing: d.missingDive }) }}
                </template>
                <template v-else>
                  {{ $t('control.preflight.diver_rows', { name: d.name, rows: d.rows, total: preFlightSummary.rounds }) }}
                </template>
              </li>
              <li v-if="preFlightSummary.incompleteOverflow" class="preflight-overflow">
                {{ $t('control.preflight.incomplete_overflow', { n: preFlightSummary.incompleteOverflow }) }}
              </li>
            </ul>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">{{ $t('control.preflight.section_panel') }}</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.judges.length === preFlightSummary.judgeCount ? 'ok' : 'warn']">
                {{ preFlightSummary.judges.length === preFlightSummary.judgeCount ? '✓' : '⚠' }}
              </span>
              {{ $t('control.preflight.judges_seated', { seated: preFlightSummary.judges.length, total: preFlightSummary.judgeCount }) }}
            </div>
            <div v-if="preFlightSummary.judges.length" class="preflight-judges">
              <span v-for="(j, i) in preFlightSummary.judges" :key="j.id || j.user_id || i" class="preflight-judge-pill">
                {{ $t('control.preflight.judge_label', { n: i + 1, name: (j.full_name || j.name || $t('control.preflight.judge_fallback')).split(' ').slice(-1)[0] }) }}
              </span>
            </div>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">{{ $t('control.preflight.section_referee') }}</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.refereeSignedOff ? 'ok' : 'warn']">
                {{ preFlightSummary.refereeSignedOff ? '✓' : '⚠' }}
              </span>
              {{ preFlightSummary.refereeSignedOff ? $t('control.preflight.ref_signed_off') : $t('control.preflight.ref_not_signed_off') }}
            </div>
          </div>
        </div>

        <div v-if="preFlightSummary.warnings.length" class="preflight-warnings">
          <div class="preflight-warnings-head">{{ $t('control.preflight.warnings_heading') }}</div>
          <ul>
            <li v-for="(w, i) in preFlightSummary.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>

        <div class="preflight-actions">
          <button type="button" class="btn btn-ghost preflight-cancel" @click="preFlightOpen = false">
            {{ $t('control.preflight.btn_not_yet') }}
          </button>
          <button type="button" class="btn btn-primary preflight-go"
                  @click="commitStartEvent"
                  :disabled="orderBusy || startBlocked"
                  v-tip="startBlockedReason">
            {{ orderBusy ? $t('control.preflight.btn_starting') : $t('control.preflight.btn_go_live') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Leaderboard modal -->
    <div v-if="lbShow" class="lb-backdrop">
      <div class="lb-modal">
        <div class="lb-header">
          <div>
            <div class="lb-title">{{ $t('control.modals.final_results_title') }}</div>
            <div class="lb-event">{{ currentEvent?.name || $t('control.modals.fallback_dash') }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="lbShow = false">{{ $t('control.modals.close') }}</button>
        </div>
        <div class="lb-body">
          <p v-if="!lbRows.length" style="color:var(--text-3);text-align:center;padding:2rem;font-size:13px">{{ $t('control.modals.no_scores') }}</p>
          <div
            v-for="(s, i) in lbRows"
            :key="i"
            :class="['lb-row', i === 0 ? 'lb-winner' : '']"
          >
            <div :class="['lb-rank', rankClass(i)]">{{ i + 1 }}</div>
            <div class="lb-medal">{{ medals[i] || '' }}</div>
            <div class="lb-name">{{ s.full_name }}</div>
            <div class="lb-score">{{ parseFloat(s.total).toFixed(1) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Judge Ranking Analysis modal — only mounted when open so
         the component fetches only on demand. Uses the standard
         .lb-backdrop + .lb-modal pattern (see AGENTS.md "Modal CSS
         pattern" gotcha). -->
    <div v-if="judgeRankingOpen" class="lb-backdrop"
         @mousedown.self="judgeRankingOpen = false">
      <div class="lb-modal jra-modal">
        <div class="lb-header">
          <div>
            <div class="lb-title">{{ $t('control.modals.judge_ranking_title') }}</div>
            <div class="lb-event">{{ currentEvent?.name || $t('control.modals.fallback_dash') }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="judgeRankingOpen = false">{{ $t('control.modals.close') }}</button>
        </div>
        <div class="lb-body">
          <JudgeRankingTable v-if="currentEvent?.id" :event-id="currentEvent.id" />
        </div>
      </div>
    </div>

    <!-- Broadcast chooser — extracted to BroadcastModal (owns
         the chooser / OBS / venue-bridge panels and its own
         body-scroll lock). Opened imperatively from the header
         Broadcast button via the template ref. -->
    <BroadcastModal
      ref="broadcastModal"
      :event="currentEvent"
      @close-header-menu="headerMenuOpen = false"
    />

    <!-- Phase 4 — Reflow modal. Mounted once at the Control Room
         root so the operator can finalise an event and confirm
         downstream shifts without leaving the view. Open/proposal
         state lives on `reflowOpen` / `reflowProposal`, populated
         by finaliseEvent() when the server returns a non-null
         `reflow` payload. -->
    <ReflowModal
      :open="reflowOpen"
      :proposal="reflowProposal"
      :event-name="reflowEventName"
      @close="onReflowClose"
      @saved="onReflowSaved"
    />

    <!-- Sponsor branding modal — wraps the SponsorLogosManager
         from Phase 2 in a familiar lb-modal shell so the
         operator can swap logos mid-meet without leaving the
         Control Room. Gated above on currentEvent.meet_id so
         this modal can assume that's set. -->
    <div v-if="sponsorBrandingOpen && currentEvent && currentEvent.meet_id"
         class="lb-backdrop"
         @mousedown.self="sponsorBrandingOpen = false">
      <div class="lb-modal sponsor-branding-modal">
        <div class="lb-header">
          <div>
            <div class="lb-title">{{ $t('control.modals.sponsor_branding_title') }}</div>
            <div class="lb-event">{{ currentEvent.name }}</div>
          </div>
          <button class="btn btn-ghost btn-sm"
                  @click="sponsorBrandingOpen = false">{{ $t('control.modals.close') }}</button>
        </div>
        <div class="lb-body sponsor-branding-body">
          <SponsorLogosManager :meet-id="currentEvent.meet_id" />
        </div>
      </div>
    </div>

    <!-- Body -->
    <div class="ctrl-body">
      <!-- Left: History -->
      <div class="ctrl-panel">
        <div class="panel-head">Completed Dives</div>
        <div v-if="historyCards.length" class="hist-filters">
          <select class="select hist-filter-select" v-model="historyDiverFilter">
            <option value="">All divers</option>
            <option v-for="n in historyDivers" :key="n" :value="n">{{ n }}</option>
          </select>
          <select class="select hist-filter-select" v-model="historyRoundFilter">
            <option :value="null">All rounds</option>
            <option v-for="n in availableRounds" :key="n" :value="n">Round {{ n }}</option>
          </select>
        </div>
        <div class="panel-body">
          <!-- Preview cards (always visible) + toggle button +
               rest cards (visible when expanded) — wrapped in
               a single v-for over either the preview or the
               full list, with the toggle injected after the
               (HISTORY_PREVIEW_COUNT)th card. This keeps the
               toggle anchored at a fixed visual position so a
               click expands the list DOWN-WARD rather than
               pushing the button off the operator's eye-line. -->
          <template v-for="(card, idx) in (historyShowAll ? filteredHistory : historyPreview)"
                    :key="card.score_ids?.[0] || `${card.competitor_id}-${card.round}`">
          <div
            :class="['hist-card', card.score_ids?.length ? 'hist-card-correctable' : '']"
            v-tip="card.score_ids?.length ? 'Click to amend a score' : ''"
            @click="card.score_ids?.length && openCorrection(card)"
          >
            <div class="hist-round">Round {{ card.round }}{{ card.total_rounds ? ` / ${card.total_rounds}` : '' }}</div>
            <!-- Shared identity block: lead + partner stacked at
                 equal weight for synchro, team / club secondary
                 line for non-synchro rows, country / team / club
                 chip pinned top-right, dive total slotted next to
                 it. The composable maps card.{name,partner_name,
                 country,team_code,club_code,team_name,club_name}
                 into the same shape every other surface uses. -->
            <DiverIdentity
              :row="{
                name: card.name,
                partner_name: card.partner_name,
                country_code: card.country,
                team_code: card.team_code,
                team_name: card.team_name,
                club_code: card.club_code,
                club_name: card.club_name,
              }"
              :rank="competitorOrder(card.competitor_id)"
              variant="split"
              class="hist-identity"
            >
              <template #trailing>
                <div class="hist-total">{{ card.total }}</div>
              </template>
            </DiverIdentity>
            <!-- Dive header line: code + DD + description on a
                 single row so the card is one line shorter and
                 the eye picks up "what was the dive" without
                 jumping. Description gets ellipsis on overflow
                 so a long name (e.g. "Inward 3½ Tuck") still
                 keeps the row to one line. -->
            <div class="hist-dive-line">
              <span class="hist-code">{{ card.dive_code ? `${card.dive_code}${card.position || ''}` : '—' }}</span>
              <span v-if="card.dd != null" class="hist-dd">DD {{ card.dd.toFixed(1) }}</span>
              <span v-if="card.desc" class="hist-desc">{{ card.desc }}</span>
            </div>
            <div v-if="card.scores.length" :class="['hist-scores', !isSynchroEvent ? 'hist-scores-box' : '']">
              <!-- Synchro: group scores into Exec A / Exec B / Sync
                   using the same shared helper the Scoreboard view
                   uses. Falls back to flat chips for individual /
                   team events. -->
              <template v-if="isSynchroEvent">
                <div v-for="g in (groupedSynchroScoresForDisplay(card.scores.join(','), currentEvent?.number_of_judges) || [])"
                     :key="g.role"
                     :class="['judge-group', `judge-group-${g.role}`]">
                  <span class="judge-group-label">{{ g.label }}</span>
                  <span v-for="(j, si) in g.scores" :key="si"
                        :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                        v-tip="j.dropped ? 'Dropped by trim rule' : ''">
                    {{ j.value.toFixed(1) }}
                  </span>
                </div>
              </template>
              <template v-else>
                <span v-for="(j, si) in annotatedScores(card.scores.join(','), card.scores.length)" :key="si"
                      :class="['hist-score', j.dropped ? 'j-dropped' : '']"
                      v-tip="j.dropped ? 'Dropped by trim rule' : ''">{{ j.value.toFixed(1) }}</span>
              </template>
            </div>
          </div>
          <!-- Toggle button injected INSIDE the v-for, after the
               last preview card. Stays visually anchored when
               clicked: expanding renders the rest of the list
               BELOW the button rather than shoving the button
               down. Only renders when there are extra cards to
               reveal. Filter changes collapse via the watch. -->
          <button
            v-if="idx === HISTORY_PREVIEW_COUNT - 1
                  && filteredHistory.length > HISTORY_PREVIEW_COUNT"
            class="hist-toggle"
            @click.stop="historyShowAll = !historyShowAll"
          >
            {{ historyShowAll
                ? `Show fewer ↑`
                : `Show ${filteredHistory.length - HISTORY_PREVIEW_COUNT} more ↓` }}
          </button>
          </template>
        </div>
      </div>

      <!-- Centre: Active diver -->
      <div class="ctrl-centre">
        <!-- The Now / Next / On-deck strip used to live here as
             a quick-glance ribbon for the announcer. Removed —
             the right panel's Up Next list (next 5, expandable)
             plus the centre's own active-diver block carry the
             same information without duplicating the same names
             three different ways across two columns. -->
        <div class="active-zone">
          <!-- Compressed header strip — a single muted pre-line
               carrying the round + diver counters, with the
               shot-clock anchored to the right. Replaces the
               three-row stack of "Currently on Board" label +
               ctx pills + auto-next select + status pill +
               shot-clock that used to live here. The status
               pill folds into the diver name row below; the
               auto-next picker moves to a split-button on Next
               Diver where it's adjacent to the action it
               governs. -->
          <div v-if="currentActive || activeInfo.round_number" class="active-meta">
            <span class="active-meta-text">
              <span v-if="activeInfo.round_number">
                Round <strong>{{ activeInfo.round_number }}</strong> / {{ currentEvent?.total_rounds || '?' }}
              </span>
              <span v-if="roster.length" class="active-meta-sep">·</span>
              <span v-if="roster.length">
                Diver <strong>{{ currentIndex + 1 }}</strong> / {{ roster.length }}
              </span>
            </span>
            <!-- Connection chip — relocated here from the header.
                 margin-auto (CSS) right-aligns it in the strip, ahead
                 of the shot clock. -->
            <span class="conn-badge"
                  v-tip:bottom="socket.isConnected.value
                    ? 'Live socket connection healthy — score events are streaming in real time'
                    : 'Re-establishing socket connection — incoming scores are queued until this turns green'">
              <span class="status-dot" :class="{ connected: socket.isConnected.value }"></span>
              <span class="conn-badge-label">{{ socket.isConnected.value ? 'Connected' : 'Connecting' }}</span>
            </span>
            <div v-if="currentActive" :class="['shot-clock', shotClockClass]">
              <button class="shot-clock-face" @click="pauseShotClock"
                      v-tip="shotClockRunning
                        ? '60-second WA post-warning shot clock — click to pause'
                        : (shotClockExpired
                          ? 'Shot clock expired — diver should have begun by now'
                          : '60-second WA post-warning shot clock — click to resume')">
                <span class="shot-clock-num">{{ shotClock }}</span>
                <span class="shot-clock-unit">s</span>
              </button>
              <button class="shot-clock-reset" @click="resetShotClock" v-tip.fixed="'Reset to 30s (T)'">↻</button>
            </div>
          </div>
          <!-- Referee-signal banner — appears the moment any
               judge taps Signal Referee on their keypad. Calls
               out which judges, halts auto-advance, sticks
               around until the judge submits a fresh score (or
               toggles their flag off). -->
          <div v-if="signalingJudges.length" class="referee-signal-banner">
            <div class="referee-signal-icon">🚩</div>
            <div class="referee-signal-body">
              <div class="referee-signal-title">Referee Signal</div>
              <div class="referee-signal-judges">
                <template v-if="signalingJudges.length === 1">
                  Judge {{ signalingJudges[0] }} flagged the referee — auto-advance paused.
                </template>
                <template v-else>
                  Judges {{ signalingJudges.join(', ') }} flagged the referee — auto-advance paused.
                </template>
              </div>
              <div class="referee-signal-hint">
                Resolves when the judge submits a fresh score.
              </div>
            </div>
          </div>

          <div class="active-name">
            <!-- Diver's start-order number ("1.") prefixes the
                 name so the operator sees their canonical
                 position at a glance — same number that shows on
                 the roster queue and the completed-dives cards.
                 The status pill (READY / DIVING / JUDGING) sits
                 inline at the end of the name row rather than in
                 a separate top-bar widget — keeps every piece
                 of "what's happening with this diver right now"
                 on one line. -->
            <span v-if="competitorOrder(currentActive?.competitor_id) != null" class="active-order">{{ competitorOrder(currentActive.competitor_id) }}.</span>
            <template v-if="activeInfo.partner_name">
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
              <span class="active-amp">&amp;</span>
              {{ activeInfo.partner_name }}<span v-if="activeInfo.partner_country" class="active-country">{{ activeInfo.partner_country }}</span>
            </template>
            <template v-else>
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
            </template>
            <span
              v-if="currentActive"
              :class="['status-pill', `status-${activeStatus}`, 'status-pill-inline']"
              v-tip="activeStatus === 'ready'
                ? 'READY — diver is on the board, shot clock running. Auto-advances to DIVING when the clock expires.'
                : activeStatus === 'diving'
                ? 'DIVING — shot clock has expired, the dive is happening. Auto-advances to JUDGING when the first score lands.'
                : 'JUDGING — the panel is scoring. Stays here until the next diver is set.'"
            >
              {{ activeStatus.toUpperCase() }}
            </span>
          </div>
          <div v-if="activeInfo.team_name" class="active-team">{{ activeInfo.team_name }}</div>
          <!-- Club affiliation. Hidden when team_name is set
               (team events surface that instead) so we don't
               show two competing identities. -->
          <div v-if="activeInfo.club_name && !activeInfo.team_name" class="active-club">
            {{ activeInfo.club_name }}<span v-if="activeInfo.club_code" class="active-club-code">{{ activeInfo.club_code }}</span>
          </div>
          <div class="active-badges">
            <div class="active-code">{{ activeInfo.code }}</div>
            <div class="active-dd">{{ activeInfo.dd }}</div>
          </div>
          <div class="active-desc">{{ activeInfo.desc }}</div>

          <div class="judge-block">
            <div style="font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-3);margin-bottom:0.625rem">Judge Scores</div>
            <!-- Synchro: split the live judge tiles into the WA
                 panel groups (Exec A / Exec B / Sync) so the
                 operator sees who's scoring what role at a glance.
                 Each group gets a labelled column; the tiles
                 themselves are unchanged so Score-by-judge wiring
                 (signal flag, scored class, name tooltip) stays
                 identical with the flat layout. -->
            <div v-if="judgeTilesByGroup" class="judge-groups-grid">
              <div v-for="g in judgeTilesByGroup"
                   :key="g.role"
                   :class="['judge-group-col', `judge-group-${g.role}`]">
                <div class="judge-group-col-label">{{ g.label }}</div>
                <div class="judge-group-col-tiles">
                  <div
                    v-for="tile in g.tiles"
                    :key="tile.judgeIndex"
                    :class="[
                      'judge-tile',
                      tile.scored ? 'scored' : '',
                      tile.signaled ? 'signaled' : '',
                    ]"
                    v-tip="tile.signaled
                      ? `${judgeNameByNumber[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
                      : (judgeNameByNumber[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
                  >
                    <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
                    <div class="judge-tile-score">{{ tile.score }}</div>
                    <div v-if="judgeNameByNumber[tile.judgeIndex]" class="judge-tile-name">
                      {{ judgeNameByNumber[tile.judgeIndex].split(' ').slice(-1)[0] }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="judge-grid">
              <div
                v-for="tile in judgeTiles"
                :key="tile.judgeIndex"
                :class="[
                  'judge-tile',
                  tile.scored ? 'scored' : '',
                  tile.signaled ? 'signaled' : '',
                ]"
                v-tip="tile.signaled
                  ? `${judgeNameByNumber[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
                  : (judgeNameByNumber[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
              >
                <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
                <div class="judge-tile-score">{{ tile.score }}</div>
                <!-- Judge name surfaces under the tile so a slow
                     submitter is identifiable at a glance. -->
                <div v-if="judgeNameByNumber[tile.judgeIndex]" class="judge-tile-name">
                  {{ judgeNameByNumber[tile.judgeIndex].split(' ').slice(-1)[0] }}
                </div>
              </div>
            </div>
            <!-- Reserved slot for the computed dive total. Always
                 present so the controls below it never shift; the
                 inner row uses v-show so it stays measurable but
                 invisible until every tile is in. -->
            <div class="active-dive-total-slot">
              <div v-show="liveDiveTotal != null" class="active-dive-total">
                <span class="active-dive-total-label">Dive Total</span>
                <span class="active-dive-total-value">{{ liveDiveTotal != null ? liveDiveTotal.toFixed(1) : '' }}</span>
              </div>
            </div>
          </div>

          <!-- Bottom controls — pinned to the bottom of the centre
               column via margin-top: auto so the layout uses the
               full screen height regardless of how much active-
               diver content is above. The operator's eye learns
               that the action buttons live at the bottom edge.
               Compressed-layout pass: Prev / Next dominate; ref
               actions (Failed / Cap / Re-Dive) collapse into a
               single Adjust ▾ menu since they're occasional;
               auto-next picker rides as a ▾ split-button on
               Next Diver; keyboard hints retreat behind a ?
               icon. Net effect: one primary button + two
               trailing affordances, instead of three rows. -->
          <div class="active-bottom">
            <div class="nav-btns">
              <button class="btn btn-ghost"
                      @click="setActive(currentIndex - 1)"
                      :disabled="currentIndex <= 0"
                      v-tip="currentIndex <= 0
                        ? 'Already at the first diver in the queue'
                        : 'Step back to the previous diver (←)'">← Prev</button>
              <!-- Adjust ▾ — Failed Dive / Cap Score / Re-Dive
                   collapsed into a single dropdown. F/R keyboard
                   shortcuts still work via onKeydown. -->
              <div class="dropdown-host">
                <button
                  class="btn btn-ghost"
                  :disabled="!currentActive"
                  @click.stop="toggleMenu('adjust')"
                  :aria-expanded="adjustMenuOpen"
                  v-tip="!currentActive
                    ? 'Pick an active diver from the queue first'
                    : 'Failed dive, cap score, or re-dive'"
                >Adjust ▾</button>
                <div v-if="adjustMenuOpen" class="dropdown-menu adjust-menu">
                  <button class="dropdown-item dropdown-item-danger"
                          @click="refAction('failed'); adjustMenuOpen = false">
                    {{ $t('control.fail') }} <span class="dropdown-item-hint"><kbd>F</kbd></span>
                  </button>
                  <button class="dropdown-item dropdown-item-amber"
                          @click="refAction('cap'); adjustMenuOpen = false">
                    Cap Score <span class="dropdown-item-aside">max 2.0</span>
                  </button>
                  <button class="dropdown-item dropdown-item-cyan"
                          @click="refAction('redive'); adjustMenuOpen = false">
                    {{ $t('control.redive') }} <span class="dropdown-item-hint"><kbd>R</kbd></span>
                  </button>
                </div>
              </div>
              <!-- Next Diver as a split-button: the wide button
                   advances the queue, the trailing ▾ opens a
                   menu of Auto-next intervals (Manual / 5s / …).
                   Co-locating the picker with the action it
                   governs keeps the operator's eye in one place
                   instead of jumping to a top-bar dropdown. -->
              <div class="split-button dropdown-host">
                <button
                  :class="['btn', 'split-button-main',
                    nextBtnComplete ? 'btn-complete' : 'btn-primary',
                    autoAdvanceCountdown > 0 ? 'btn-counting' : '']"
                  :disabled="nextBtnDisabled"
                  v-tip="nextBtnTitle"
                  @click="nextDiver"
                >
                  {{ nextBtnText }}
                  <span v-if="autoAdvanceCountdown > 0" class="auto-advance-pill">
                    {{ autoAdvanceCountdown }}s
                  </span>
                </button>
                <!-- The ▾ aside is intentionally NOT gated on
                     nextBtnDisabled — the operator should be able
                     to set the Auto-next preference at any point
                     (before the first diver, mid-round, while
                     waiting on scores), even when Next Diver
                     itself can't fire yet. -->
                <button
                  :class="['btn', 'split-button-aside',
                    nextBtnComplete ? 'btn-complete' : 'btn-primary']"
                  @click.stop="toggleMenu('autonext')"
                  :aria-expanded="autoNextMenuOpen"
                  v-tip="`Auto-next: ${autoAdvanceSeconds === 0 ? 'Manual' : autoAdvanceSeconds + 's'}`"
                >▾</button>
                <div v-if="autoNextMenuOpen" class="dropdown-menu autonext-menu">
                  <div class="dropdown-section">Auto-next after the panel completes</div>
                  <button v-for="opt in [
                            { v: 0,  label: 'Manual' },
                            { v: 5,  label: '5 seconds' },
                            { v: 10, label: '10 seconds' },
                            { v: 15, label: '15 seconds' },
                            { v: 20, label: '20 seconds' },
                            { v: 25, label: '25 seconds' },
                            { v: 30, label: '30 seconds' },
                          ]"
                          :key="opt.v"
                          :class="['dropdown-item', autoAdvanceSeconds === opt.v ? 'dropdown-item-active' : '']"
                          @click="autoAdvanceSeconds = opt.v; autoNextMenuOpen = false">
                    <span>{{ opt.label }}</span>
                    <span v-if="autoAdvanceSeconds === opt.v" class="dropdown-item-tick">✓</span>
                  </button>
                </div>
              </div>
              <!-- Keyboard-shortcut popover. Only operators who
                   want a refresher tap the ?; the canvas isn't
                   bombarded with chip text otherwise. The
                   hotkeys themselves stay live regardless. -->
              <div class="dropdown-host kbd-hints-host">
                <button
                  class="btn btn-ghost btn-icon"
                  @click.stop="toggleMenu('kbd')"
                  :aria-expanded="kbdHintsOpen"
                  v-tip.fixed="'Keyboard shortcuts'"
                >?</button>
                <div v-if="kbdHintsOpen" class="dropdown-menu kbd-menu">
                  <div class="dropdown-section">Keyboard shortcuts</div>
                  <div class="kbd-row"><kbd>←</kbd><span>Previous diver</span></div>
                  <div class="kbd-row"><kbd>→</kbd><span class="kbd-row-or">/</span><kbd>Space</kbd><span>Next diver</span></div>
                  <div class="kbd-row"><kbd>1</kbd>–<kbd>9</kbd><span>Jump to roster position</span></div>
                  <div class="kbd-row"><kbd>T</kbd><span>Reset shot clock</span></div>
                  <div class="kbd-row"><kbd>F</kbd><span>Failed dive</span></div>
                  <div class="kbd-row"><kbd>R</kbd><span>Re-dive</span></div>
                  <div class="kbd-row"><kbd>H</kbd><span>Hold / resume meet</span></div>
                  <div class="kbd-row"><kbd>L</kbd><span>Open leaderboard</span></div>
                </div>
              </div>
            </div>
            <!-- Cancel-the-countdown affordance. Sits below the
                 Next Diver row only while the auto-advance timer
                 is running — clicking it stops the timer without
                 advancing, returning the queue to manual control
                 until the operator clicks Next. -->
            <button
              v-if="autoAdvanceCountdown > 0"
              class="btn btn-ghost auto-advance-cancel"
              @click="cancelAutoAdvance"
              v-tip="'Stop the auto-advance timer for this dive'"
            >✕ Cancel auto-advance</button>
          </div>
        </div>
      </div>

      <!-- Right: Dive Order column. Houses the Up Next preview,
           the (collapsed) Top 5 + full Dive Order panels, and
           the workflow stepper + late-entry button. We say
           "Dive Order" everywhere instead of "Queue" / "Roster"
           — three terms for the same concept fragmented the
           operator's mental model. -->
      <div class="ctrl-panel">
        <div v-if="currentEvent" class="workflow-mode-strip" aria-label="Workflow mode">
          <span :class="['workflow-mode-chip', workflowMode === 'setup' ? 'active' : '']">Setup</span>
          <span :class="['workflow-mode-chip', workflowMode === 'meet' ? 'active' : '']">Meet Day</span>
          <span :class="['workflow-mode-chip', workflowMode === 'review' ? 'active' : '']">Review</span>
        </div>
        <!-- Pre-Meet panel — houses the four-step pre-meet
             workflow stepper + the colour-cycling action button
             that drives it (Check In Divers → Randomise → Sign
             Off → Start). The "Dive Order" / "1/48" count chip
             that used to live here was duplicate signal — the
             collapsible Dive Order panel near the bottom of this
             column is the canonical roster view, and the centre
             column already shows "Diver N / Total" in its meta
             strip. The 🔒 Order-locked badge (which only appears
             after the event flips Live and reordering is no
             longer allowed) was moved to the Dive Order accordion
             header below, where the operator would actually try
             to reorder a row.

             Class is `pre-meet-head` (not `dive-order-head`)
             because the lower accordion already owns
             `.dive-order-head`; the duplicate name was shadowing
             its layout rules. -->
        <div class="panel-head pre-meet-head">
          <div class="pre-meet-title">{{ orderWorkflowState === 'live' ? 'Live scoring' : 'Pre-Meet' }}</div>
          <!-- Pre-meet workflow stepper — shows all four steps
               with the current one highlighted and completed
               ones ticked. Renders ABOVE the action button so
               a new operator sees the full flow at a glance
               instead of having to remember that red →
               orange → yellow → green is "step 1 of 4". -->
          <div v-if="currentEvent && roster.length && orderWorkflowState && orderWorkflowState !== 'live'"
               class="wf-stepper"
               v-tip="`Pre-meet step ${WORKFLOW_STEPS.indexOf(orderWorkflowState) + 1} of 4`">
            <div :class="['wf-step', wfStepClass('check-in')]">
              <span class="wf-step-num">{{ wfStepClass('check-in') === 'wf-step-done' ? '✓' : '1' }}</span>
              <span class="wf-step-label">Check-in</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('check-in') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('random')]">
              <span class="wf-step-num">{{ wfStepClass('random') === 'wf-step-done' ? '✓' : '2' }}</span>
              <span class="wf-step-label">Randomise</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('random') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('sign-off')]">
              <span class="wf-step-num">{{ wfStepClass('sign-off') === 'wf-step-done' ? '✓' : '3' }}</span>
              <span class="wf-step-label">Sign Off</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('sign-off') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('start')]">
              <span class="wf-step-num">4</span>
              <span class="wf-step-label">Start</span>
            </div>
          </div>
          <ReadinessChecklist
            v-if="currentEvent && currentEvent.status === 'Upcoming' && readinessItems.length"
            :items="readinessItems"
            :collapse-when-done="false"
          />
          <div v-if="currentEvent?.is_rehearsal" class="rehearsal-note">
            Dry-run mode. Start and complete this event normally; public archive,
            analytics, emails, and records stay untouched.
          </div>
          <!-- Action row: pre-meet workflow button (one button
               cycles through four sequential states before the
               event flips Live — red Check In → orange Randomise
               → yellow Referee Sign Off → green Start), plus the
               Adjust check-in / + Add utility actions. State
               lives on the event row (check_in_done_at,
               dive_order_randomised_at, dive_order_signed_off_at)
               so a page reload picks up where the operator left
               off. The small "↺ Reset" link backtracks to state 1.
               The standalone "Check-in" ghost button is gone —
               clicking the red state-1 button opens the same
               modal. -->
          <div class="pre-meet-actions">
            <template v-if="currentEvent && roster.length && orderWorkflowState && orderWorkflowState !== 'live'">
              <button v-if="orderWorkflowState === 'check-in'"
                      class="btn btn-sm wf-btn wf-btn-red"
                      :disabled="orderBusy"
                      @click="startCheckInStep"
                      v-tip="'Open the check-in modal. Mark each diver present / late / DNS, then confirm to advance.'">
                ✓ Check In Divers
              </button>
              <button v-else-if="orderWorkflowState === 'random'"
                      class="btn btn-sm wf-btn wf-btn-orange"
                      :disabled="orderBusy || !canReorderQueue"
                      @click="randomizeStartOrder"
                      v-tip="'Shuffle the diver start order across every round.'">
                {{ orderBusy ? '🎲 …' : '🎲 Randomise Dive Order' }}
              </button>
              <button v-else-if="orderWorkflowState === 'sign-off'"
                      class="btn btn-sm wf-btn wf-btn-yellow"
                      :disabled="orderBusy"
                      @click="signOffDiveOrder"
                      v-tip="'Referee approves the published dive order.'">
                {{ orderBusy ? '📋 …' : '📋 Referee Sign Off' }}
              </button>
              <button v-else-if="orderWorkflowState === 'start'"
                      class="btn btn-sm wf-btn wf-btn-green"
                      :disabled="orderBusy || startBlocked"
                      @click="startEvent"
                      v-tip="startBlockedReason">
                {{ orderBusy ? '▶ …' : '▶ Start Event' }}
              </button>
              <!-- Skip-randomise affordance: if the operator has
                   already arranged the order manually they can
                   advance straight to sign-off. Hidden outside
                   state 2. -->
              <button v-if="orderWorkflowState === 'random'"
                      class="btn btn-ghost btn-sm wf-skip"
                      :disabled="orderBusy"
                      @click="confirmDiveOrder"
                      v-tip="'Skip randomise — keep the current order and advance to sign-off.'">
                Use current order →
              </button>
              <!-- Reset link: clears every workflow stamp so the
                   operator can walk all four steps again. Hidden in
                   state 1 (nothing to reset). -->
              <button v-if="orderWorkflowState !== 'check-in'"
                      class="btn btn-ghost btn-sm wf-reset"
                      :disabled="orderBusy"
                      @click="resetDiveOrderWorkflow"
                      v-tip="'Clear all workflow stamps and walk the four steps again.'">
                ↺ Reset
              </button>
            </template>
            <span v-else-if="currentEvent && currentEvent.status !== 'Upcoming'"
                  class="wf-live-badge"
                  v-tip="`Event is ${currentEvent.status}`">
              {{ currentEvent.status === 'Live' ? '● Live' : '✓ Done' }}
            </span>
            <!-- Check-in is reachable from inside the workflow's
                 state-1 button. After advance, expose a quiet "Re-
                 open check-in" link so the operator can still adjust
                 attendance mid-meet (someone arrives late, etc.). -->
            <button v-if="currentEvent && roster.length
                          && orderWorkflowState !== 'check-in'
                          && orderWorkflowState !== 'live'"
                    class="btn btn-ghost btn-sm wf-skip" @click="openCheckIn"
                    v-tip="'Reopen the check-in list to adjust attendance.'">
              Adjust check-in
            </button>
            <button v-if="currentEvent" class="btn btn-ghost btn-sm" @click="openLateEntry"
                    v-tip="'Add a late-arriving diver'">+ Add</button>
          </div>
	        </div>

	        <section v-if="currentEvent && !opsBroadcast"
	                 class="inline-audit-panel"
	                 aria-label="Recent event audit">
	          <div class="inline-audit-head">
	            <span class="inline-audit-title">Recent changes</span>
	            <button class="inline-audit-refresh"
	                    type="button"
	                    :disabled="recentAuditLoading"
	                    @click="loadRecentAuditRows"
	                    v-tip="'Refresh recent changes'">
	              ↻
	            </button>
	          </div>
	          <div v-if="recentAuditLoading" class="inline-audit-state">
	            Loading changes…
	          </div>
	          <div v-else-if="recentAuditError" class="inline-audit-state is-error">
	            {{ recentAuditError }}
	          </div>
	          <div v-else-if="!inlineAuditRows.length" class="inline-audit-state">
	            No recent risky changes.
	          </div>
	          <ul v-else class="inline-audit-list">
	            <li v-for="row in inlineAuditRows"
	                :key="`${row.kind}-${row.id}`"
	                :class="['inline-audit-row', `is-${row.kind}`]">
	              <span class="inline-audit-kind">{{ row.kind === 'score' ? 'Score' : 'Audit' }}</span>
	              <span class="inline-audit-copy">
	                <span class="inline-audit-action">{{ auditTitle(row) }}</span>
	                <span class="inline-audit-meta">{{ auditMeta(row) }}</span>
	              </span>
	            </li>
	          </ul>
	        </section>

	        <!-- Up Next — primary right-panel surface during live
	             scoring. Shows the next 3 divers / pairs by default;
             a "Show N more ↓" toggle rendered INSIDE the list
             after row 3 expands to the full set without moving
             the toggle off-screen. Withdrawn rows are skipped
             server-side via the upNextDives computed. Click a
             row to jump-set the active diver, same as a Dive
             Order row click. -->
        <div v-if="upNextDives.length" class="up-next-panel">
          <div class="up-next-panel-head">
            <span class="up-next-panel-label">Up Next</span>
          </div>
          <div class="up-next-list">
            <template v-for="(row, idx) in upNextDives"
                      :key="row.dive_list_id || row.originalIdx">
            <button
              :class="['up-next-row-btn']"
              :disabled="!!row.withdrawn_at"
              @click="setActive(row.originalIdx)"
              v-tip="'Jump to this diver'"
            >
              <!-- Two-column layout: R# label pinned to the
                   LEFT, everything else (names, club, dive code
                   + DD + description) stacked in the right
                   column so the dive header line indents to
                   align with the name + club above it. -->
              <div class="up-next-row-grid">
                <span class="up-next-row-rd">R{{ row.round_number }}</span>
                <div class="up-next-row-stack">
                  <DiverIdentity :row="row"
                                 :rank="row.round_order ?? row.display_order"
                                 class="up-next-identity" />
                  <div v-if="row.dive_code || row.dd != null || row.description"
                       class="up-next-row-bot">
                    <span v-if="row.dive_code" class="up-next-row-code">
                      {{ row.dive_code }}{{ row.position || '' }}
                    </span>
                    <span v-if="row.dd != null" class="up-next-row-dd">DD {{ parseFloat(row.dd).toFixed(1) }}</span>
                    <span v-if="row.description || row.position" class="up-next-row-desc">
                      {{ diveDescription(row) }}
                    </span>
                  </div>
                </div>
              </div>
            </button>
            <!-- Anchored toggle — rendered INSIDE the v-for
                 after the 3rd row so it stays at a fixed
                 visual position when expanded. Extra rows
                 drop down BELOW it. Only renders when there
                 are more upcoming rows than the preview limit
                 (so the button never appears with nothing to
                 reveal). -->
            <button
              v-if="idx === UP_NEXT_DEFAULT_LIMIT - 1
                    && upNextTotal > UP_NEXT_DEFAULT_LIMIT"
              class="up-next-anchor-toggle"
              @click="upNextShowAll = !upNextShowAll"
              v-tip="upNextShowAll
                ? `Show only the next ${UP_NEXT_DEFAULT_LIMIT}`
                : `Show all ${upNextTotal} remaining`"
            >
              {{ upNextShowAll
                  ? `Show fewer ↑`
                  : `Show ${upNextTotal - UP_NEXT_DEFAULT_LIMIT} more ↓` }}
            </button>
            </template>
          </div>
        </div>

        <!-- Reserves panel — surfaces when the meet manager
             advanced from a prelim/semi with reserves. Per
             World Aquatics Article 4.1.8 / 4.1.10 / 4.1.12, a reserve replacing
             a withdrawing primary INHERITS that primary's
             start position so the dive order is preserved.
             The "Replace…" picker (only shown when there's
             at least one active or already-withdrawn primary)
             promotes the reserve into that exact slot;
             clicking just "Promote" slots them at the back
             of the queue. -->
        <div v-if="reserves.length" class="reserves-panel">
          <button class="reserves-head"
                  @click="reservesOpen = !reservesOpen"
                  v-tip="reservesOpen ? 'Collapse' : 'Expand'">
            <span class="reserves-head-label">Reserves</span>
            <span class="reserves-head-count">{{ reserves.length }}</span>
            <span class="reserves-head-chevron">{{ reservesOpen ? '▴' : '▾' }}</span>
          </button>
          <div v-if="reservesOpen" class="reserves-list">
            <div v-for="r in reserves" :key="r.competitor_id" class="reserves-row">
              <div class="reserves-row-head">
                <span class="reserves-row-pos">R{{ r.reserve_position }}</span>
                <span class="reserves-row-name">{{ r.full_name }}</span>
                <span v-if="r.club_code" class="reserves-row-club">{{ r.club_code }}</span>
              </div>
              <div class="reserves-row-actions">
                <select v-model="reservesReplaceChoice[r.competitor_id]" class="select reserves-row-select">
                  <option value="">Slot at back of queue</option>
                  <optgroup v-if="reservesWithdrawn.length" label="Replace withdrawn">
                    <option v-for="w in reservesWithdrawn" :key="w.competitor_id" :value="w.competitor_id">
                      {{ w.full_name }}{{ w.club_code ? ' · ' + w.club_code : '' }}
                    </option>
                  </optgroup>
                  <optgroup v-if="reservesActive.length" label="Replace active (will withdraw them)">
                    <option v-for="a in reservesActive" :key="a.competitor_id" :value="a.competitor_id">
                      {{ a.full_name }}{{ a.club_code ? ' · ' + a.club_code : '' }} (#{{ a.display_order }})
                    </option>
                  </optgroup>
                </select>
                <button type="button"
                        class="btn btn-primary btn-sm"
                        :disabled="reservesPromoting === r.competitor_id"
                        @click="promoteReserve(r.competitor_id)">
                  {{ reservesPromoting === r.competitor_id ? 'Promoting…' : 'Promote' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Super Final surfaces — synchro reserve pool +
             dive-offs panels and their modals, extracted to
             SuperFinalPanels. Self-gating on event format, so
             mounting is unconditional; reload() is driven from
             onEventChange. -->
        <SuperFinalPanels
          ref="superFinalPanels"
          :event="currentEvent"
          @refresh="onEventChange"
        />

        <!-- Standings + projected leader — top 5 inline so the
             meet referee always knows the running state. Mirrors
             the Dive Order pattern below: clickable header with
             a caret + count toggles the body open / closed.
             Stays expanded by default; collapse preference saved
             per browser via toggleStandingsProjection. -->
        <div v-if="standingsTop5.length" class="standings-preview">
          <button class="standings-head"
                  @click="toggleStandingsProjection"
                  :aria-expanded="showStandingsProjection">
            <span class="standings-caret">{{ showStandingsProjection ? '▾' : '▸' }}</span>
            <span class="standings-title">Top 5 right now</span>
            <span class="standings-count">{{ standingsTop5.length }}</span>
          </button>
          <div v-if="showStandingsProjection" class="standings-body">
          <div v-for="(s, i) in standingsTop5" :key="i" class="sp-row">
            <span :class="['sp-rank', i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '']">
              {{ i + 1 }}
            </span>
            <span class="sp-name">
              {{ s.full_name }}
              <template v-if="s.partner_name">
                <span class="sp-amp">&amp;</span>{{ s.partner_name }}
              </template>
            </span>
            <span class="sp-total">{{ parseFloat(s.total).toFixed(1) }}</span>
          </div>
          <!-- Catch-up panel. Replaces the old "+N pts; #/dive
               (~#/judge)" blob with a target-by-target table that
               surfaces the average judge score the active diver
               needs across the remaining dives to reach 1st / 2nd
               / 3rd. Caps at 10 — anything above and the row
               reads "Not possible". For the leader the table
               flips to "what #2 would need to overtake". -->
          <div v-if="projectedLine" :class="['projection-line', `projection-${projectedLine.kind}`]">
            <template v-if="projectedLine.kind === 'chase'">
              <div class="projection-head">
                Catch-up — <strong>{{ projectedLine.remaining }}</strong>
                {{ projectedLine.remaining === 1 ? 'dive' : 'dives' }} left
                · currently {{ projectedLine.currentRank }}
              </div>
              <div v-for="t in projectedLine.targets" :key="t.rank" class="catchup-row">
                <span class="catchup-rank">{{ t.rank }}{{ ['st','nd','rd'][t.rank - 1] || 'th' }}</span>
                <span class="catchup-name">{{ t.name }}</span>
                <span :class="['catchup-target', t.possible === false ? 'catchup-impossible' : '']">
                  <template v-if="t.avgJudge == null">
                    +{{ t.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="t.possible === false">
                    not possible
                  </template>
                  <template v-else-if="t.avgJudge === 0">
                    already there
                  </template>
                  <template v-else>
                    avg {{ t.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="projectedLine.kind === 'lead'">
              <div class="projection-head">
                🏆 <strong>{{ projectedLine.activeName }}</strong> leading
                by <strong>+{{ projectedLine.gap.toFixed(1) }}</strong>
              </div>
              <div class="catchup-row">
                <span class="catchup-rank">2nd</span>
                <span class="catchup-name">{{ projectedLine.runnerUp }}</span>
                <span :class="['catchup-target', projectedLine.possible === false ? 'catchup-impossible' : '']">
                  <template v-if="projectedLine.avgJudge == null">
                    +{{ projectedLine.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="projectedLine.possible === false">
                    can't overtake
                  </template>
                  <template v-else>
                    needs avg {{ projectedLine.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="projectedLine.kind === 'pre'">
              No completed dives yet. {{ projectedLine.leaderName }} leads at
              <strong>{{ projectedLine.leaderTotal.toFixed(1) }}</strong>.
            </template>
            <template v-else-if="projectedLine.kind === 'unopposed'">
              {{ projectedLine.activeName }} unopposed — only diver entered.
            </template>
          </div>
          </div>
        </div>

        <!-- Dive Order — collapsed-by-default panel housing the
             full roster (search, round chips, reorder controls).
             During live scoring the operator only needs Up Next
             above; this panel is for pre-meet setup and the
             occasional manual jump. Header click toggles. -->
        <div v-if="roster.length" class="dive-order-panel" data-dive-order-panel>
          <button class="dive-order-head"
                  @click="diveOrderOpen = !diveOrderOpen"
                  :aria-expanded="diveOrderOpen">
            <span class="dive-order-caret">{{ diveOrderOpen ? '▾' : '▸' }}</span>
            <span class="dive-order-title">Dive Order</span>
            <span class="dive-order-count">{{ roster.length }}</span>
            <!-- Once the event flips out of 'Upcoming' the start
                 order is locked. Lives on this accordion header
                 (rather than the Pre-Meet panel above) because
                 this is where the operator interacts with the
                 order itself — drag-reorder, jump-to-row — so the
                 chip explains why those affordances are dimmed
                 right next to them. -->
            <span v-if="currentEvent && !canReorderQueue"
                  class="queue-lock-badge dive-order-lock-badge"
                  v-tip="`Start order locked — event is ${currentEvent.status}. Withdraw a diver instead if they need to be skipped.`"
                  @click.stop>
              🔒 Order locked
            </span>
          </button>
          <div v-if="diveOrderOpen" class="dive-order-body">
            <div v-if="rosterFederationGroups.length" class="federation-roster-summary"
                 aria-label="Roster by federation">
              <div v-for="group in rosterFederationGroups"
                   :key="group.org_id"
                   :class="['federation-roster-card', group.is_host ? 'is-host' : 'is-participating']">
                <div class="federation-roster-head">
                  <span class="federation-roster-name">
                    {{ group.country_code || group.name }}
                  </span>
                  <span class="federation-roster-scope">
                    {{ group.is_host ? 'Host federation' : 'Participating federation' }}
                  </span>
                </div>
                <div class="federation-roster-meta">
                  <span>{{ group.active_count }} active</span>
                  <span v-if="group.withdrawn_count">{{ group.withdrawn_count }} withdrawn</span>
                  <span :class="['federation-roster-missing', group.missing_list_count ? 'has-missing' : '']">
                    {{ group.missing_list_count ? `${group.missing_list_count} missing list${group.missing_list_count === 1 ? '' : 's'}` : 'Lists complete' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Search + jump-to-round chips -->
            <div class="queue-filters">
              <input
                class="input queue-search"
                type="text"
                v-model="queueSearch"
                placeholder="Search name, dive code…"
              >
              <div class="round-chips">
                <button :class="['round-chip', queueRoundFilter === null ? 'active' : '']"
                        @click="queueRoundFilter = null">All</button>
                <button v-for="n in availableRounds" :key="n"
                        :class="['round-chip', queueRoundFilter === n ? 'active' : '']"
                        @click="queueRoundFilter = n">R{{ n }}</button>
              </div>
            </div>

            <div class="panel-body">
          <!-- filteredRoster is the search-filtered view of the
               full roster, but each item carries originalIdx so
               clicking still maps back to the right slot in
               roster[] — keeps reorder/withdraw logic correct. -->
          <template v-for="(item, listIdx) in filteredRoster" :key="item.dive_list_id || listIdx">
            <!-- Round divider when round_number changes between
                 visible rows. Compare to the previous filtered
                 row, not the unfiltered roster. -->
            <div v-if="listIdx === 0 || filteredRoster[listIdx - 1].round_number !== item.round_number"
                 class="round-divider">
              Round {{ item.round_number }}
            </div>
            <div
              :class="[
                'roster-item',
                item.originalIdx === currentIndex ? 'active' : '',
                item.withdrawn_at ? 'withdrawn' : '',
                dragRosterIdx === item.originalIdx ? 'is-dragging' : '',
                dragOverRosterIdx === item.originalIdx ? 'is-drop-target' : '',
                !canReorderQueue ? 'is-locked' : '',
              ]"
              :draggable="canReorderQueue && !item.withdrawn_at"
              @dragstart="onRosterDragStart(item.originalIdx, $event)"
              @dragover="onRosterDragOver(item.originalIdx, $event)"
              @dragleave="onRosterDragLeave(item.originalIdx)"
              @dragend="onRosterDragEnd"
              @drop="onRosterDrop(item.originalIdx, $event)"
            >
              <div class="roster-row-head">
                <span v-if="canReorderQueue"
                      class="roster-grip"
                      v-tip.fixed="'Drag to reorder within round'">⋮⋮</span>
                <span v-else class="roster-grip roster-grip-locked"
                      v-tip.fixed="'Start order locked — event has started'">🔒</span>
                <button
                  class="roster-jump"
                  :disabled="!!item.withdrawn_at"
                  @click="setActive(item.originalIdx)"
                >
                  <div class="roster-name">
                    <!-- Same round_order-with-display_order-fallback
                         as the Up Next row above. -->
                    <span v-if="(item.round_order ?? item.display_order) != null"
                          class="roster-order">{{ item.round_order ?? item.display_order }}.</span>
                    {{ item.full_name }}<span v-if="item.country_code" class="roster-country">{{ item.country_code }}</span>
                    <template v-if="item.partner_name">
                      <span class="roster-amp">&amp;</span>
                      {{ item.partner_name }}
                    </template>
                    <span v-if="item.withdrawn_at" class="roster-wd-badge">WITHDRAWN</span>
                  </div>
                  <div v-if="item.team_name" class="roster-team">{{ item.team_name }}</div>
                  <div v-if="item.club_name && !item.team_name" class="roster-club">
                    {{ item.club_name }}<span v-if="item.club_code" class="roster-club-code">{{ item.club_code }}</span>
                  </div>
                  <div class="roster-meta">
                    <!-- dive_code / position / dd can be null when
                         the diver hasn't filed their full list yet
                         (LEFT JOIN dive_directory in the roster
                         query). Show a dash instead of "undefined". -->
                    <span>{{ item.dive_code ? `${item.dive_code}${item.position || ''}` : '—' }}</span>
                    <span>DD {{ item.dd != null ? item.dd : '—' }}</span>
                  </div>
                </button>
                <!-- Per-row overflow menu — replaces 4 tiny
                     icon buttons with a single ⋯ trigger that
                     opens a labelled action popover (same
                     pattern as the Meet Manager event-row ⋯
                     menu). Big tap target, self-documenting,
                     scales to whatever actions we add later. -->
                <div class="roster-controls dropdown-host">
                  <button class="roster-overflow"
                          @click.stop="toggleRosterMenu(item.originalIdx)"
                          :aria-expanded="rosterMenuOpenIdx === item.originalIdx"
                          aria-haspopup="menu"
                          v-tip.fixed="'Row actions'">⋯</button>
                  <div v-if="rosterMenuOpenIdx === item.originalIdx"
                       class="roster-menu"
                       role="menu">
                    <button type="button" role="menuitem"
                            class="roster-menu-item"
                            :disabled="!!item.withdrawn_at"
                            @click="openEditDive(item); closeOverflowMenus()">
                      <span class="roster-menu-icon">✎</span>
                      <span class="roster-menu-label">Edit dive</span>
                      <span class="roster-menu-sub">Change-of-dives (Article 6.7.4)</span>
                    </button>
                    <button type="button" role="menuitem"
                            class="roster-menu-item"
                            :disabled="!canReorderQueue || item.originalIdx === 0 || roster[item.originalIdx - 1]?.round_number !== item.round_number"
                            @click="reorderRosterRow(item.originalIdx, 'up'); closeOverflowMenus()">
                      <span class="roster-menu-icon">↑</span>
                      <span class="roster-menu-label">Move up</span>
                      <span class="roster-menu-sub">Within round only</span>
                    </button>
                    <button type="button" role="menuitem"
                            class="roster-menu-item"
                            :disabled="!canReorderQueue || item.originalIdx >= roster.length - 1 || roster[item.originalIdx + 1]?.round_number !== item.round_number"
                            @click="reorderRosterRow(item.originalIdx, 'down'); closeOverflowMenus()">
                      <span class="roster-menu-icon">↓</span>
                      <span class="roster-menu-label">Move down</span>
                      <span class="roster-menu-sub">Within round only</span>
                    </button>
                    <button type="button" role="menuitem"
                            :class="['roster-menu-item', item.withdrawn_at ? 'roster-menu-reinstate' : 'roster-menu-withdraw']"
                            @click="withdrawRosterRow(item.originalIdx); closeOverflowMenus()">
                      <span class="roster-menu-icon">{{ item.withdrawn_at ? '↻' : '✕' }}</span>
                      <span class="roster-menu-label">{{ item.withdrawn_at ? 'Reinstate' : 'Withdraw' }}</span>
                      <span class="roster-menu-sub">{{ item.withdrawn_at ? 'Bring diver back into the queue' : 'Scratch / DNS / DNF' }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Random Dive-Order Draw modal (WA Article 4.1.6) — the
       ceremony flow is extracted to RandomiseDrawModal. The
       parent applies the fresh roster + workflow stamps it
       emits on success. -->
  <RandomiseDrawModal
    v-if="randomiseModalOpen"
    :event="currentEvent"
    :roster="roster"
    @close="randomiseModalOpen = false"
    @randomised="onRandomised"
  />

  <!-- Edit Dive modal — meet manager swaps a roster row's
       dive mid-event. WA Article 6.7.4 / 6.8: changes go via
       the official change-of-dives form, signed by the athlete
       or their representative; the operator acts as the
       representative under Referee oversight. The endpoint
       audits as `roster.dive_edited`. -->
  <div v-if="editDiveOpen" class="lb-backdrop" @click="closeEditDive"></div>
  <div v-if="editDiveOpen" class="lb-modal edit-dive-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Edit Dive</div>
        <div class="lb-event">
          {{ editDiveTarget?.full_name }}
          <span class="edit-dive-round">· Round {{ editDiveTarget?.round_number }}</span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeEditDive">Cancel</button>
    </div>
    <p class="hint" style="margin: 0.75rem 0 1rem">
      Currently:
      <strong v-if="editDiveTarget?.current_code">{{ editDiveTarget.current_code }}</strong>
      <span v-else style="opacity:0.6">(no dive set)</span>.
      Pick a replacement below — the audit log records this as a
      change-of-dives (WA Article 6.7.4).
    </p>
    <input
      class="input"
      type="text"
      v-model="editDiveSearch"
      placeholder="Search code or description (e.g. 109C)…"
      style="margin-bottom: 0.75rem"
      autofocus
    >
    <div v-if="editDiveErr" class="msg msg-error" style="margin-bottom: 0.5rem">{{ editDiveErr }}</div>
    <div class="edit-dive-results">
      <p v-if="!editDiveResults.length" class="hint" style="text-align:center">No dives match.</p>
      <button v-for="d in editDiveResults" :key="d.id"
              type="button"
              class="edit-dive-result"
              :disabled="editDiveBusy"
              @click="submitEditDive(d.id)">
        <span class="edit-dive-code">{{ d.dive_code }}{{ d.position }}</span>
        <span class="edit-dive-meta">{{ d.height }}m · DD {{ d.dd }}</span>
        <span class="edit-dive-desc">{{ d.description }}</span>
      </button>
    </div>
  </div>

  <!-- Hold-reason prompt -->
  <div v-if="holdPromptOpen" class="lb-backdrop" @click="holdPromptOpen = false"></div>
  <div v-if="holdPromptOpen" class="lb-modal hold-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Pause Meet</div>
        <div class="lb-event">Spectators + judges will see a "meet on hold" banner</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="holdPromptOpen = false">Cancel</button>
    </div>
    <div class="lb-body">
      <div class="field">
        <label class="label">Reason (optional, shown publicly)</label>
        <input class="input" type="text" v-model="holdReasonInput"
               placeholder='e.g. "Video review" or "Judges deliberating"'
               @keyup.enter="confirmHold">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="holdPromptOpen = false">Cancel</button>
        <button class="btn btn-primary btn-sm" @click="confirmHold">⏸ Hold meet</button>
      </div>
    </div>
  </div>

  <!-- Score correction modal — extracted to
       ScoreCorrectionModal. Mounted per open so the draft
       fields reset like the inline openCorrection() did;
       mutates the clicked card in place on save. -->
  <ScoreCorrectionModal
    v-if="correctOpen && correctTarget"
    :card="correctTarget"
    :event="currentEvent"
    @close="closeCorrection"
    @saved="refreshRecentAuditSoon()"
  />

  <!-- Check-in modal — extracted to CheckInModal. The confirm
       footer emits the check_in_done_at stamp; the parent
       applies it via patchCurrentEvent. -->
  <CheckInModal
    v-if="checkInOpen && currentEvent"
    :event="currentEvent"
    :workflow-state="orderWorkflowState"
    @close="checkInOpen = false"
    @confirmed="patchCurrentEvent"
  />

  <!-- Referee sign-off modal — flow extracted to SignoffModal.
       Mounted on demand so its referee_signoff_response socket
       listener only lives while a request can be pending. -->
  <SignoffModal
    v-if="signoffOpen"
    :event="currentEvent"
    @close="signoffOpen = false"
    @signed-off="patchCurrentEvent"
  />

  <!-- Late-entry modal — extracted to LateEntryModal. Mounted
       permanently (not v-if) so its lazy-loaded dive-directory /
       org-diver caches keep their once-per-session behaviour. -->
  <LateEntryModal
    :open="lateOpen"
    :event="currentEvent"
    @close="lateOpen = false"
    @added="onLateEntryAdded"
  />

  <!-- Round-end transition prompt -->
  <div v-if="roundEndPromptOpen" class="lb-backdrop" @click="roundEndPromptOpen = false"></div>
  <div v-if="roundEndPromptOpen" class="lb-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Round Complete</div>
        <div class="lb-event">Round {{ roundEndForRound }} of {{ currentEvent?.total_rounds }} finished</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="roundEndPromptOpen = false">Skip</button>
    </div>
    <div class="lb-body">
      <p style="font-family:var(--font-mono);font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:1rem">
        Show the running standings to the audience? Triggers the
        score-reveal overlay on the live scoreboard.
      </p>
      <div v-if="autoAdvanceCountdown > 0"
           style="font-family:var(--font-mono);font-size:12px;color:var(--cyan);margin-bottom:0.75rem">
        Auto-announcing in {{ autoAdvanceCountdown }}s
        <button class="btn btn-ghost btn-sm" style="margin-inline-start:0.5rem" @click="cancelAutoAdvance">✕ Cancel</button>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem">
        <button class="btn btn-ghost btn-sm" @click="roundEndPromptOpen = false; cancelAutoAdvance()">Skip</button>
        <button class="btn btn-primary btn-sm" @click="announceRoundEnd">📣 Announce standings</button>
      </div>
    </div>
  </div>


  <!-- Manual-entry modal (P5). Mounted at template root so the
       overlay stacks above every other ControlView surface. -->
  <ManualScoreEntryForm
    v-if="manualEntryOpen && currentActive"
    :event-id="currentActive.event_id"
    :competitor-id="currentActive.competitor_id"
    :round-number="Number(currentActive.round_number)"
    @close="closeManualEntry"
    @saved="onManualEntrySaved"
  />
</template>

<style scoped src="./ControlView.css"></style>
