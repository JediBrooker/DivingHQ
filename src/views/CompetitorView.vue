<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'
import { diveDescription } from '@/composables/useDiveLabel'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import { validateDiveList } from '@/lib/round-rules'
import EmptyState from '@/components/EmptyState.vue'
import OfflineBanner from '@/components/OfflineBanner.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const events = ref([])
const diveDirectory = ref([])
const selectedEventId = ref('')
const currentEvent = ref(null)
const selectedDives = ref([]) // array of null | dive object
// Migration 039: operator-prescribed round dives. Array indexed
// by round_number-1. Each entry is either:
//   null               — diver picks freely for this round
//   { dive_id, height, slot_height } — slot is constrained.
//                                      slot_height pins the
//                                      diver's free pick to a
//                                      specific board (mixed-
//                                      board events only).
const prescribedDives = ref([])
const showModal = ref(false)
const activeSlot = ref(-1)
const searchInput = ref('')
const activeHeightFilter = ref(null)
const submitErr = ref('')
const loading = ref(false)
const eventLoading = ref(false)
const eventLoadError = ref('')

// Drives the dropdown + the submit-button gate. An event accepts
// dive-list submissions when its lifecycle is still 'Upcoming' AND
// either there's no entries_close_at deadline, or the deadline is
// still in the future. Mirrors the server-side rule in
// loadEventForEntries() — keep them in sync.
function isAcceptingEntries(ev) {
  if (!ev) return false
  if (ev.status && ev.status !== 'Upcoming') return false
  if (ev.entries_close_at && new Date(ev.entries_close_at) <= new Date()) return false
  return true
}

function notAcceptingReason(ev) {
  if (!ev) return ''
  if (ev.status && ev.status !== 'Upcoming') {
    return `"${ev.name}" has already started — entries are closed.`
  }
  if (ev.entries_close_at && new Date(ev.entries_close_at) <= new Date()) {
    return `Entries for "${ev.name}" closed at ${new Date(ev.entries_close_at).toLocaleString()}.`
  }
  return ''
}

// Show open events first, then closed ones (greyed out and
// labelled). Hiding closed events outright would leave divers
// confused about why their event "disappeared", so we keep them
// visible but un-selectable.
const eventOptions = computed(() => {
  const open = events.value.filter(isAcceptingEntries)
  const closed = events.value.filter((e) => !isAcceptingEntries(e))
  return { open, closed }
})

const isCurrentEventOpen = computed(() => isAcceptingEntries(currentEvent.value))

// Migration 041 — post-advance dive-list lock state. The banner
// shown above the dive picker reads `dive_list_locks_at` off the
// event row; `diveListLockExpired` flips the banner from "edit
// or confirm by [time]" to "locked at [time]".
const confirmingList = ref(false)
const confirmStatus  = ref('')   // '' | 'confirmed' | 'failed'
const diveListLockExpired = computed(() => {
  const at = currentEvent.value?.dive_list_locks_at
  if (!at) return false
  return new Date(at) <= new Date()
})

// Super Final F has a stricter lock window than the standard
// 30-min WA Article 6.7.3 default — Appendix 3 §4.1 specifies a
// 15-min break between SF and F with the change-of-dives request
// "made after the SF and at LATEST 5 minutes before the Final".
// On super_final_final events we surface a louder countdown
// banner so the diver knows the deadline is sooner than the
// standard prelim → final flow.
const isSuperFinalFinal = computed(() =>
  currentEvent.value?.event_format === 'super_final_final'
)
// Live countdown to the lock — re-computed once per second so
// the banner ticks down in real time. Returns a friendly string
// like "4 min 12 sec" or null when no lock is set / past.
const liveTickRef = ref(0)
let liveTickHandle = null
function startLiveTick() {
  if (liveTickHandle) return
  liveTickHandle = setInterval(() => { liveTickRef.value++ }, 1000)
}
function stopLiveTick() {
  if (liveTickHandle) { clearInterval(liveTickHandle); liveTickHandle = null }
}
const diveListLockCountdown = computed(() => {
  // Reference liveTickRef so the computed re-runs each tick.
  liveTickRef.value
  const at = currentEvent.value?.dive_list_locks_at
  if (!at) return null
  const ms = new Date(at).getTime() - Date.now()
  if (ms <= 0) return null
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min} min ${sec.toString().padStart(2, '0')} sec` : `${sec} sec`
})
onMounted(() => startLiveTick())
onUnmounted(() => stopLiveTick())

// Migration 040 reserves: the diver's status in the currently-
// selected event (loaded from /api/competitor/list-status when
// the event changes). Drives the "You're Reserve N" banner —
// reserves stay editable while the lock is open so they're
// ready to compete if the meet manager promotes them.
const myListStatus = ref({
  entered: false,
  is_reserve: false,
  reserve_position: null,
  confirmed_at: null,
  dive_list_locks_at: null,
})
async function loadMyListStatus() {
  if (!currentEvent.value) {
    myListStatus.value = { entered: false, is_reserve: false, reserve_position: null, confirmed_at: null, dive_list_locks_at: null }
    return
  }
  try {
    myListStatus.value = await auth.apiFetch(
      `/api/competitor/list-status?event_id=${currentEvent.value.id}`,
    )
  } catch {
    myListStatus.value = { entered: false, is_reserve: false, reserve_position: null, confirmed_at: null, dive_list_locks_at: null }
  }
}

async function confirmInheritedList() {
  if (!currentEvent.value) return
  confirmingList.value = true
  confirmStatus.value  = ''
  try {
    await auth.apiFetch('/api/competitor/confirm-list', {
      method: 'POST',
      body: JSON.stringify({ event_id: currentEvent.value.id }),
    })
    confirmStatus.value = 'confirmed'
  } catch (err) {
    confirmStatus.value = 'failed'
    submitErr.value = err.message || 'Failed to confirm dive list'
  } finally {
    confirmingList.value = false
  }
}

// Synchro support
const orgDivers = ref([])      // potential partners — fellow divers in your org
const partnerId = ref('')       // selected partner's user id, '' = none
const isSynchro = computed(() => currentEvent.value?.event_type === 'synchro_pair')

// Partner autocomplete state. Keeps the rendering simple — no
// dependency, no popper. The dropdown overlays absolutely
// beneath the input and re-uses the same option labels the old
// <select> used.
const partnerSearch = ref('')      // what's currently in the input
const partnerOpen   = ref(false)   // dropdown visible?
const partnerActive = ref(0)       // keyboard-highlighted index in matches

// Filter the org's divers by the search term — case-insensitive
// against the full name + club_code. Empty term returns the
// whole list (capped at 30 to avoid drawing 1000 rows).
const partnerMatches = computed(() => {
  const term = partnerSearch.value.trim().toLowerCase()
  const list = orgDivers.value.filter((d) => {
    if (!term) return true
    const haystack = [d.full_name, d.club_code, d.club_name]
      .filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(term)
  })
  return list.slice(0, 30)
})

// Selected partner's display name — shown in the input when
// closed. Looks up by id so re-selecting from the list shows
// the canonical name even if the user typed only a fragment.
const selectedPartnerLabel = computed(() => {
  if (!partnerId.value) return ''
  const p = orgDivers.value.find((d) => d.id === partnerId.value)
  if (!p) return ''
  return p.club_code ? `${p.full_name} (${p.club_code})` : p.full_name
})

function partnerLabel(d) {
  return d.club_code ? `${d.full_name} (${d.club_code})` : d.full_name
}

function focusPartner() {
  partnerOpen.value = true
  partnerActive.value = 0
  // If a partner is already chosen, clear the input on focus so
  // the user can search again. Re-selecting reverts the label.
  if (partnerId.value && partnerSearch.value === selectedPartnerLabel.value) {
    partnerSearch.value = ''
  }
}

function blurPartner() {
  // Delay close so a click on a list item registers before the
  // dropdown un-mounts.
  setTimeout(() => {
    partnerOpen.value = false
    if (!partnerId.value) {
      // No selection made — reset typed text
      partnerSearch.value = ''
    } else if (!partnerSearch.value.trim()) {
      // Restore the canonical label if the user blanked it
      partnerSearch.value = selectedPartnerLabel.value
    }
  }, 150)
}

function pickPartner(d) {
  partnerId.value = d.id
  partnerSearch.value = partnerLabel(d)
  partnerOpen.value = false
}

function clearPartner() {
  partnerId.value = ''
  partnerSearch.value = ''
  partnerActive.value = 0
}

function partnerKey(e) {
  if (!partnerOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      partnerOpen.value = true
      partnerActive.value = 0
    }
    return
  }
  const n = partnerMatches.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    partnerActive.value = (partnerActive.value + 1) % Math.max(n, 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    partnerActive.value = (partnerActive.value - 1 + n) % Math.max(n, 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const pick = partnerMatches.value[partnerActive.value]
    if (pick) pickPartner(pick)
  } else if (e.key === 'Escape') {
    partnerOpen.value = false
  }
}

// Saved dive list templates. Persists per-diver across meets so
// a 6-dive 3m optionals list doesn't have to be retyped every
// month. Filtered to the active event's height when one is
// loaded so the picker only shows compatible templates.
const templates = ref([])
const saveTemplateName = ref('')
const saveTemplateOpen = ref(false)
const saveTemplateBusy = ref(false)
const templateError = ref('')

const matchingTemplates = computed(() => {
  if (!templates.value.length) return []
  if (!currentEvent.value?.height) return templates.value
  return templates.value.filter(
    t => !t.height || t.height === currentEvent.value.height,
  )
})

async function loadTemplates() {
  try {
    templates.value = await auth.apiFetch('/api/templates')
  } catch {
    templates.value = []
  }
}

function applyTemplate(t) {
  // Resolve each saved {dive_code, position} to its directory
  // entry at the event's height. Unknown dives are skipped with
  // a warning so a template applied at the wrong height still
  // partly populates.
  templateError.value = ''
  const eventHeight = activeEventHeight.value
  const newSelection = Array(selectedDives.value.length).fill(null)
  let missing = 0
  for (const item of (t.dives || [])) {
    const round = item.round_number
    if (!round || round < 1 || round > newSelection.length) continue
    const match = diveDirectory.value.find(d =>
      d.dive_code === item.dive_code &&
      d.position  === item.position &&
      (eventHeight === null || parseFloat(d.height) === eventHeight),
    )
    if (match) newSelection[round - 1] = match
    else missing++
  }
  selectedDives.value = newSelection
  if (missing) {
    templateError.value = `Loaded — ${missing} dive(s) skipped (not in directory at this height).`
  }
}

async function saveAsTemplate() {
  templateError.value = ''
  const name = saveTemplateName.value.trim()
  if (!name) {
    templateError.value = 'Pick a name first'
    return
  }
  saveTemplateBusy.value = true
  try {
    const dives = selectedDives.value
      .map((d, i) => d ? {
        round_number: i + 1,
        dive_code: d.dive_code,
        position:  d.position,
      } : null)
      .filter(Boolean)
    const saved = await auth.apiFetch('/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        name,
        height: currentEvent.value?.height || null,
        dives,
      }),
    })
    // Replace if it already existed (server upserts on name).
    templates.value = [
      saved,
      ...templates.value.filter(t => t.name !== saved.name),
    ]
    saveTemplateName.value = ''
    saveTemplateOpen.value = false
  } catch (err) {
    templateError.value = err.message
  } finally {
    saveTemplateBusy.value = false
  }
}

async function deleteTemplate(t) {
  if (!await confirmAction({
    title: `Delete template "${t.name}"?`,
    body:  'Templates are personal — deleting yours doesn\'t affect anyone else\'s.',
    confirmLabel: 'Delete template',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/templates/${t.id}`, { method: 'DELETE' })
    templates.value = templates.value.filter(x => x.id !== t.id)
    showSuccess(`Deleted template "${t.name}"`)
  } catch (err) {
    showError(`Failed to delete: ${err.message}`)
  }
}

const activeEventHeight = computed(() => {
  if (!currentEvent.value?.height) return null
  return parseFloat(currentEvent.value.height)
})

const allHeights = computed(() =>
  [...new Set(diveDirectory.value.map(d => parseFloat(d.height)))].sort((a, b) => a - b)
)

const totalDD = computed(() =>
  selectedDives.value.reduce((sum, d) => sum + (d ? parseFloat(d.dd) : 0), 0).toFixed(1)
)

// Live round-rules validation. When the event carries a
// round_rules JSON (migration 038), build the dive-list shape
// the server-side validator expects and run the SAME validator
// in the browser so the diver sees per-section violations
// before they hit submit. Server still re-checks on submit so
// the client can't lie its way past the limit.
const roundRulesValidation = computed(() => {
  const rules = currentEvent.value?.round_rules
  if (!rules || !Array.isArray(rules.sections)) return null
  const dives = []
  selectedDives.value.forEach((d, idx) => {
    if (d) {
      dives.push({
        round_number: idx + 1,
        dive_code:    d.dive_code,
        dd:           parseFloat(d.dd),
      })
    }
  })
  return validateDiveList(rules, dives)
})

// Per-section running totals — used by the section header row
// in the dive-list builder so the diver sees "3.4 / 7.6 used"
// in the section as they pick dives.
const roundRulesSections = computed(() => {
  const rules = currentEvent.value?.round_rules
  if (!rules || !Array.isArray(rules.sections)) return null
  let cursor = 0
  return rules.sections.map((s) => {
    const start = cursor
    const end   = cursor + s.rounds
    cursor = end
    let ddUsed = 0
    const groupsUsed = new Set()
    for (let r = start; r < end; r++) {
      const d = selectedDives.value[r]
      if (!d) continue
      const dd = parseFloat(d.dd)
      if (Number.isFinite(dd)) ddUsed += dd
      if (s.min_distinct_groups != null && d.dive_code) {
        groupsUsed.add(d.dive_code[0])
      }
    }
    return {
      ...s,
      start_round: start + 1,
      end_round:   end,
      dd_used:     Number(ddUsed.toFixed(2)),
      dd_remaining: s.dd_limit != null ? Number((s.dd_limit - ddUsed).toFixed(2)) : null,
      groups_used: [...groupsUsed],
    }
  })
})

const searchResults = computed(() => {
  const term = searchInput.value.toLowerCase().trim()
  return diveDirectory.value.filter(d => {
    const combined = (d.dive_code + d.position).toLowerCase()
    const textMatch = !term || combined.includes(term) || d.description.toLowerCase().includes(term)
    const heightMatch = activeHeightFilter.value === null || parseFloat(d.height) === activeHeightFilter.value
    return textMatch && heightMatch
  }).slice(0, 15)
})

async function onEventChange() {
  partnerId.value = ''
  partnerSearch.value = ''
  partnerOpen.value = false
  prescribedDives.value = []
  if (!selectedEventId.value) {
    currentEvent.value = null
    selectedDives.value = []
    return
  }
  // Refresh the events list before computing currentEvent. The
  // events.value array was loaded once on mount; if the operator
  // edits the event's round_rules / total_rounds while this page
  // is open, the cached row is stale. One extra GET per event
  // pick guarantees the diver sees the operator's latest
  // conditions without forcing a page reload.
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch { /* fall back to the cached list */ }
  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return
  selectedDives.value = Array(currentEvent.value.total_rounds || 6).fill(null)

  // Pull operator-prescribed round dives (migration 039). Pre-fill
  // any pinned dive into selectedDives + remember the slot is
  // locked so openModal() refuses to re-open it.
  try {
    const rows = await auth.apiFetch(`/api/events/${currentEvent.value.id}/round-dives`)
    if (Array.isArray(rows) && rows.length) {
      // Resize selectedDives to match the prescribed-row count
      // (the operator may have added/removed slots since last
      // load — server enforces total_rounds = rows.length so we
      // align here too).
      selectedDives.value = Array(rows.length).fill(null)
      const slots = Array(rows.length).fill(null)
      for (const row of rows) {
        const idx = row.round_number - 1
        slots[idx] = {
          dive_id: row.dive_id || null,
          slot_height: row.height ?? null,
        }
        if (row.dive_id) {
          // Pre-fill the locked dive into selectedDives so the
          // diver sees it without an extra fetch.
          selectedDives.value[idx] = {
            id:          row.dive_id,
            dive_code:   row.dive_code,
            position:    row.position,
            dd:          row.dd,
            description: row.description,
            height:      Number(row.dive_height ?? row.height ?? 0),
          }
        }
      }
      prescribedDives.value = slots
    }
  } catch {
    // Silent — fall back to the flat selectedDives. Worst case:
    // the diver picks a dive that the server's submit-list gate
    // rejects, with the same prescribed-violation message they'd
    // see anyway.
  }
  // Reserves status (migration 040) — drives the "You're Reserve
  // N" banner if the diver carried over as a reserve rather than
  // a primary in this stage. Also returns the diver's own
  // existing dive list so we can pre-fill the form (e.g. when
  // they advanced from a prior stage and the inherited list
  // should show in the picker rows).
  await loadMyListStatus()
  if (Array.isArray(myListStatus.value.dives) && myListStatus.value.dives.length) {
    // Resize selectedDives if needed — the diver-list endpoint
    // is the authoritative source when the operator hasn't
    // prescribed a different round count.
    const maxRound = Math.max(...myListStatus.value.dives.map(d => d.round_number))
    if (selectedDives.value.length < maxRound) {
      selectedDives.value = Array(maxRound).fill(null).map(
        (_, i) => selectedDives.value[i] || null,
      )
    }
    // Pre-fill any round that doesn't already have a dive
    // (operator-prescribed slots from the round-dives endpoint
    // win — we only fill the gaps).
    for (const d of myListStatus.value.dives) {
      const idx = d.round_number - 1
      if (!selectedDives.value[idx] && d.dive_id) {
        selectedDives.value[idx] = {
          id:          d.dive_id,
          dive_code:   d.dive_code,
          position:    d.position,
          dd:          d.dd,
          description: d.description,
          height:      Number(d.dive_height ?? 0),
        }
      }
    }
  }
}

// True when round (1-indexed) has an operator-pinned dive_id —
// the slot is locked, the picker can't open, and the row paints
// with a lock indicator.
function isPrescribedRound(roundIdx0) {
  const slot = prescribedDives.value[roundIdx0]
  return !!(slot && slot.dive_id)
}

function openModal(idx) {
  // Locked rows refuse to open the picker — the dive is operator-
  // prescribed and the diver isn't allowed to swap it.
  if (isPrescribedRound(idx)) return
  activeSlot.value = idx
  searchInput.value = ''
  // Slot-height pin (mixed-board events): the operator can pin
  // a specific board for a free slot. Honour that filter so the
  // picker only shows valid dives.
  const slot = prescribedDives.value[idx]
  if (slot && slot.slot_height != null) {
    activeHeightFilter.value = Number(slot.slot_height)
  } else if (activeEventHeight.value !== null) {
    activeHeightFilter.value = activeEventHeight.value
  } else {
    activeHeightFilter.value = null
  }
  showModal.value = true
}

function selectDive(dive) {
  selectedDives.value[activeSlot.value] = dive
  showModal.value = false
}

function setHeightFilter(h) {
  activeHeightFilter.value = h
}

async function submitList() {
  submitErr.value = ''
  const eventId = selectedEventId.value
  const filled = selectedDives.value.filter(Boolean)
  if (!eventId || filled.length < selectedDives.value.length) {
    submitErr.value = `Please select all ${selectedDives.value.length} dives before submitting.`
    return
  }
  if (isSynchro.value && !partnerId.value) {
    submitErr.value = 'Synchronised events require a partner. Pick one above.'
    return
  }
  // Re-evaluate the gate on the client before round-tripping. A
  // tab open across the deadline would otherwise blast through to
  // the server and bounce off the same check. The server still has
  // the authoritative version, but failing fast is friendlier.
  if (!isAcceptingEntries(currentEvent.value)) {
    submitErr.value = notAcceptingReason(currentEvent.value)
    return
  }
  loading.value = true
  try {
    const body = {
      event_id: eventId,
      dives: selectedDives.value.map((d, i) => ({ dive_id: d.id, round_number: i + 1 })),
    }
    if (isSynchro.value) body.partner_id = partnerId.value
    await auth.apiFetch('/api/competitor/submit-list', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    router.push('/dashboard')
  } catch (err) {
    submitErr.value = err.message || 'Submission failed. You may have already submitted for this event.'
  } finally {
    loading.value = false
  }
}

// Pending synchro pairing invitations (migration 051). When
// another diver submits a synchro list naming this diver as
// their partner, a pending_partner_pairings row is created and
// surfaced here as an accept/decline banner. Refreshes on mount
// + after every accept/decline so the banner stays in sync with
// the server.
const pendingPairings = ref([])
const pairingBusy = ref({}) // map<pairing_id, true> while a request is in flight
async function loadPendingPairings() {
  try {
    const rows = await auth.apiFetch('/api/competitor/pending-pairings')
    pendingPairings.value = Array.isArray(rows) ? rows : []
  } catch {
    pendingPairings.value = []
  }
}
async function acceptPairing(p) {
  if (pairingBusy.value[p.id]) return
  pairingBusy.value = { ...pairingBusy.value, [p.id]: true }
  try {
    await auth.apiFetch(`/api/competitor/pairings/${p.id}/accept`, { method: 'POST' })
    showSuccess(t('competitor.pairings.accepted_toast', { requester: p.requester_name }))
    await loadPendingPairings()
    // The accept inserted competitor_dive_lists rows for us too,
    // so a re-load of the current event picks them up.
    if (currentEvent.value) await loadMyListStatus()
  } catch (err) {
    showError(err.message || 'Failed to accept pairing')
  } finally {
    const next = { ...pairingBusy.value }
    delete next[p.id]
    pairingBusy.value = next
  }
}
async function declinePairing(p) {
  if (pairingBusy.value[p.id]) return
  pairingBusy.value = { ...pairingBusy.value, [p.id]: true }
  try {
    await auth.apiFetch(`/api/competitor/pairings/${p.id}/decline`, { method: 'POST' })
    showSuccess(t('competitor.pairings.declined_toast'))
    await loadPendingPairings()
  } catch (err) {
    showError(err.message || 'Failed to decline pairing')
  } finally {
    const next = { ...pairingBusy.value }
    delete next[p.id]
    pairingBusy.value = next
  }
}

// =========================================================
// My club — current club + request-a-change flow.
// The diver can request to move clubs within their org (or, if
// the backend resolves a different to_org_id, an org transfer).
// Current club is sourced pragmatically: if the diver already
// has a pending request its `from_club_name` is the live truth;
// otherwise we show the picker without a "current" label since
// the JWT carries no club info and the clubs list alone can't
// tell us which one is theirs.
// =========================================================
const isDiver = computed(() => auth.user?.org_roles?.includes('diver') ?? false)
const orgClubs = ref([])               // clubs in the diver's org
const clubRequests = ref([])           // this diver's club-change requests
const showClubForm = ref(false)
const clubChoice = ref('')             // selected to_club_id ('' = no club)
const clubNote = ref('')
const clubSubmitting = ref(false)
const clubError = ref('')

// The diver's own pending request, if any.
const myPendingClubRequest = computed(() =>
  clubRequests.value.find(
    r => r.status === 'pending' && r.user_id === auth.user?.id,
  ) || null,
)

// An org transfer awaiting THIS diver's confirmation.
const needsMyConfirm = computed(() => {
  const r = myPendingClubRequest.value
  return !!(r && r.kind === 'org_transfer' && !r.diver_confirmed_at)
})

// Current club name — from the pending request's source, else the
// most recent finalised request's source. Null when unknown.
const currentClubName = computed(() => {
  if (myPendingClubRequest.value) return myPendingClubRequest.value.from_club_name || null
  const mine = clubRequests.value
    .filter(r => r.user_id === auth.user?.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  // After a finalised move the target club is current.
  const finalised = mine.find(r => r.status === 'approved')
  if (finalised) return finalised.to_club_name || null
  return mine[0]?.from_club_name || null
})

const myRequestTargetClub = computed(() => {
  const r = myPendingClubRequest.value
  if (!r) return ''
  if (r.kind === 'org_transfer') {
    const club = r.to_club_name ? ` · ${r.to_club_name}` : ''
    return `${r.to_org_name || '—'}${club}`
  }
  return r.to_club_name || 'No club'
})

async function loadOrgClubs() {
  if (!auth.user?.org_id) { orgClubs.value = []; return }
  try {
    const rows = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/clubs`)
    orgClubs.value = Array.isArray(rows) ? rows : []
  } catch { orgClubs.value = [] }
}

async function loadMyClubRequests() {
  try {
    const rows = await auth.apiFetch('/api/club-change-requests')
    clubRequests.value = Array.isArray(rows) ? rows : []
  } catch { clubRequests.value = [] }
}

async function submitClubChange() {
  clubError.value = ''
  clubSubmitting.value = true
  try {
    await auth.apiFetch('/api/club-change-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_club_id: clubChoice.value || null,
        note: clubNote.value.trim() || null,
      }),
    })
    showClubForm.value = false
    clubChoice.value = ''
    clubNote.value = ''
    await loadMyClubRequests()
    showSuccess('Club change requested')
  } catch (err) {
    clubError.value = err.message || 'Failed to submit request'
  } finally {
    clubSubmitting.value = false
  }
}

async function cancelClubRequest() {
  const r = myPendingClubRequest.value
  if (!r) return
  try {
    await auth.apiFetch(`/api/club-change-requests/${r.id}/cancel`, { method: 'POST' })
    await loadMyClubRequests()
    showSuccess('Request withdrawn')
  } catch (err) {
    showError(err.message || 'Failed to cancel request')
  }
}

async function confirmClubTransfer() {
  const r = myPendingClubRequest.value
  if (!r) return
  try {
    await auth.apiFetch(`/api/club-change-requests/${r.id}/confirm`, { method: 'POST' })
    await loadMyClubRequests()
    showSuccess('Transfer confirmed')
  } catch (err) {
    showError(err.message || 'Failed to confirm transfer')
  }
}

async function loadEntryData() {
  eventLoading.value = true
  eventLoadError.value = ''
  try {
    const [evs, dirResult] = await Promise.all([
      auth.apiFetch('/api/events'),
      auth.cachedApiFetch('/api/dive-directory', {
        cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS, onUpdate: (fresh) => {
          if (Array.isArray(fresh)) diveDirectory.value = fresh
        } },
      }),
      loadTemplates(),
      loadPendingPairings(),
      loadOrgClubs(),
      loadMyClubRequests(),
    ])
    events.value = Array.isArray(evs) ? evs : []
    diveDirectory.value = Array.isArray(dirResult.data) ? dirResult.data : []
  } catch (err) {
    eventLoadError.value = err.message || 'Could not load events for entries.'
    events.value = []
  } finally {
    eventLoading.value = false
  }
}

onMounted(loadEntryData)

// When the event changes and it's synchro, fetch potential
// partners — other divers in the user's org.
watch(currentEvent, async (ev) => {
  if (!ev || ev.event_type !== 'synchro_pair') {
    orgDivers.value = []
    return
  }
  try {
    const body = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/divers`)
    orgDivers.value = (Array.isArray(body) ? body : [])
      .filter(u => u.id !== auth.user.id)
  } catch {
    orgDivers.value = []
  }
})
</script>

<template>
  <!-- Offline / sync banner. Divers editing dive sheets (a
       phase-4 outbox path) see queued state at the top. -->
  <OfflineBanner />
  <div class="page-header">
    <h1 style="font-size:22px;font-weight:600;letter-spacing:-0.015em">{{ $t('competitor.page_label') }}</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <!-- Pending synchro pairing invitations (migration 051).
         Surfaces at the TOP of the page so a diver who just
         logged in immediately sees a partner request before
         they hunt for their own event. Each row carries
         requester + event name + the two action buttons; the
         buttons disable while the request is in flight to
         prevent double-fires. -->
    <div v-if="pendingPairings.length" class="pairings-banner">
      <div class="pairings-banner-head">
        <span class="pairings-banner-icon">🤝</span>
        <span class="pairings-banner-title">
          {{ $t('competitor.pairings.banner_title') }} ({{ pendingPairings.length }})
        </span>
      </div>
      <ul class="pairings-list">
        <li v-for="p in pendingPairings" :key="p.id" class="pairings-row">
          <div class="pairings-row-body">
            {{ $t('competitor.pairings.invite_template', {
              requester: p.requester_name,
              event:     p.event_name,
            }) }}
          </div>
          <div class="pairings-row-actions">
            <button type="button"
                    class="btn btn-primary btn-sm"
                    :disabled="!!pairingBusy[p.id]"
                    @click="acceptPairing(p)">
              {{ $t('competitor.pairings.accept') }}
            </button>
            <button type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="!!pairingBusy[p.id]"
                    @click="declinePairing(p)">
              {{ $t('competitor.pairings.decline') }}
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- My club — current club + request-a-change flow. Divers
         can move clubs within their org; the org admin reviews
         the request. Shown only to users holding the diver role. -->
    <div v-if="isDiver" class="card my-club-card">
      <div class="my-club-head">
        <div>
          <label class="label" style="margin:0">My club</label>
          <div class="my-club-current">
            <template v-if="currentClubName">{{ currentClubName }}</template>
            <template v-else>No club set</template>
          </div>
        </div>
        <button v-if="!myPendingClubRequest && !showClubForm"
                type="button" class="btn btn-ghost btn-sm"
                @click="showClubForm = true">
          Request club change
        </button>
      </div>

      <!-- Pending request status — replaces the form while a
           request is open. -->
      <div v-if="myPendingClubRequest" class="my-club-pending">
        <div class="my-club-pending-head">
          <span class="badge badge-amber">Pending</span>
          <span class="my-club-pending-text">
            Requested move to <strong>{{ myRequestTargetClub }}</strong>
          </span>
        </div>
        <div class="my-club-actions">
          <button v-if="needsMyConfirm" type="button"
                  class="btn btn-primary btn-sm" @click="confirmClubTransfer">
            Confirm transfer
          </button>
          <button type="button" class="btn btn-danger btn-sm" @click="cancelClubRequest">
            Cancel request
          </button>
        </div>
      </div>

      <!-- Inline request form. -->
      <div v-else-if="showClubForm" class="my-club-form">
        <div class="field">
          <label class="label">New club</label>
          <select class="select" v-model="clubChoice">
            <option value="">— No club —</option>
            <option v-for="c in orgClubs" :key="c.id" :value="c.id">
              {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
            </option>
          </select>
        </div>
        <div class="field">
          <label class="label">Note (optional)</label>
          <input class="input" type="text" v-model="clubNote"
                 placeholder="Reason for the change…" maxlength="280">
        </div>
        <div v-if="clubError" class="msg msg-error">{{ clubError }}</div>
        <div class="my-club-actions">
          <button type="button" class="btn btn-ghost btn-sm"
                  @click="showClubForm = false">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm"
                  :disabled="clubSubmitting" @click="submitClubChange">
            {{ clubSubmitting ? 'Submitting…' : 'Submit request' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Empty state — diver landed here but their federation
         doesn't have any events open for entries (or any events
         at all). The form is useless without a pickable event,
         so explain what's missing rather than show an empty
         dropdown. -->
    <div v-if="eventLoading && !events.length" class="empty">Loading events…</div>
    <EmptyState
      v-else-if="eventLoadError"
      icon="!"
      title="Could not load entry events"
      :body="eventLoadError"
      action-label="Retry"
      :on-action="loadEntryData"
    />
    <EmptyState
      v-else-if="!eventOptions.open.length && !eventOptions.closed.length"
      icon="📭"
      title="No events open for entries"
      body="Your federation hasn't opened any events for entries yet. When the meet manager creates an upcoming event, it'll appear here and you'll be able to submit your dive list."
      action-label="Open guide"
      action-to="/guide"
    />

    <div v-else class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">Step 1 — Select Event</label>
      <select class="select" v-model="selectedEventId" @change="onEventChange">
        <option value="">— Choose Active Event —</option>
        <!-- Open events first. Closed events stay listed but
             :disabled so divers can see them but can't pick. -->
        <optgroup v-if="eventOptions.open.length" label="Accepting entries">
          <option v-for="ev in eventOptions.open" :key="ev.id" :value="ev.id">
            {{ ev.name }}{{ ev.event_type === 'synchro_pair' ? ' (Synchro)' : '' }}
            <template v-if="ev.entries_close_at">
              · entries close {{ new Date(ev.entries_close_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
            </template>
          </option>
        </optgroup>
        <optgroup v-if="eventOptions.closed.length" label="Entries closed">
          <option v-for="ev in eventOptions.closed" :key="ev.id" :value="ev.id" disabled>
            {{ ev.name }} — {{ ev.status !== 'Upcoming' ? ev.status.toLowerCase() : 'closed' }}
          </option>
        </optgroup>
      </select>
      <p v-if="currentEvent && !isCurrentEventOpen" class="msg msg-error" style="margin-top:0.75rem">
        {{ notAcceptingReason(currentEvent) }}
      </p>
      <p v-else-if="currentEvent && currentEvent.entries_close_at" class="hint-line" style="margin-top:0.5rem">
        Entries close {{ new Date(currentEvent.entries_close_at).toLocaleString() }}.
      </p>

      <!-- Reserve banner (migration 040, WA Article 4.1.8 / 4.1.10 / 4.1.12). Shown
           when the diver advanced as a reserve rather than a
           primary. Reserves don't compete unless the meet
           manager promotes them, but they stay editable so
           they're ready to dive if a primary withdraws. -->
      <div v-if="currentEvent && myListStatus.is_reserve" class="reserve-banner">
        <div class="reserve-banner-head">
          <span class="reserve-banner-icon">⏳</span>
          <span class="reserve-banner-title">
            You're Reserve {{ myListStatus.reserve_position || '?' }} for "{{ currentEvent.name }}"
          </span>
        </div>
        <p class="reserve-banner-body">
          You don't compete unless the meet manager promotes you (e.g. a primary
          withdraws — <strong>Article 4.1.12</strong>). If promoted into a final,
          you'll dive <strong>first</strong> in the start order — per
          <strong>Article 4.1.8</strong> the lowest-ranked qualifier in the field
          dives first, and as a reserve you're that diver. You can change your
          dive sheet up to 30 minutes before the event begins, so keep your
          list current and you're ready the moment you're promoted.
        </p>
      </div>

      <!-- Post-advance lock banner (migration 041, WA
           Article 6.7.3). Shown when the meet manager has
           stamped a dive_list_locks_at on this event —
           typically a final or semi-final right after the
           prior stage was advanced. Diver carries forward the
           inherited list by default; clicking Confirm
           explicitly stamps confirmed_at so the operator can
           audit who actively responded. Editing rounds via the
           picker below also counts as confirmation.

           Super Final F gets a louder variant: live MM:SS
           countdown + a "WHY this is shorter" hint citing
           Appendix 3 §4.1 (15-min break between SF and F,
           change-of-dives latest 5 minutes before the Final). -->
      <div v-if="currentEvent && currentEvent.dive_list_locks_at"
           :class="['advance-banner',
                    diveListLockExpired ? 'locked' : '',
                    isSuperFinalFinal ? 'super-final-f' : '']">
        <div class="advance-banner-head">
          <span class="advance-banner-icon">
            {{ diveListLockExpired ? '🔒' : (isSuperFinalFinal ? '⚡' : '⏱') }}
          </span>
          <span class="advance-banner-title">
            <template v-if="diveListLockExpired">
              Dive list locked at {{ new Date(currentEvent.dive_list_locks_at).toLocaleString() }}
            </template>
            <template v-else-if="isSuperFinalFinal && diveListLockCountdown">
              <strong>Dive change deadline: {{ diveListLockCountdown }}</strong>
              — locks at {{ new Date(currentEvent.dive_list_locks_at).toLocaleTimeString() }}
            </template>
            <template v-else>
              You've advanced to this event — confirm or edit your list by
              {{ new Date(currentEvent.dive_list_locks_at).toLocaleString() }}
            </template>
          </span>
        </div>
        <p class="advance-banner-body">
          <template v-if="diveListLockExpired">
            The lock window has passed. Contact the meet manager for late changes.
          </template>
          <template v-else-if="isSuperFinalFinal">
            Super Final has a tighter window than the standard event:
            change requests must be in at LATEST 5 minutes before the Final
            (Appendix 3 §4.1 — the 15-min break between Semi Final and Final
            absorbs the standard 30-min change-of-dives buffer). Confirm
            below or edit a round to lock your final list in.
          </template>
          <template v-else>
            Your dives carried forward from the previous stage. If you're happy with
            them as-is, click <strong>Confirm</strong>. Otherwise edit any round below
            and submit — that counts as confirmation. After the deadline the
            inherited list will be used.
          </template>
        </p>
        <div v-if="!diveListLockExpired" style="display:flex;gap:0.5rem;margin-top:0.5rem">
          <button type="button" class="btn btn-primary btn-sm"
                  :disabled="confirmingList"
                  @click="confirmInheritedList">
            {{ confirmingList ? 'Confirming…' : 'Confirm inherited list' }}
          </button>
        </div>
        <p v-if="confirmStatus === 'confirmed'" class="advance-banner-confirmed">
          ✓ Confirmed.
        </p>
      </div>
    </div>

    <!-- Synchro partner picker — autocomplete typeahead. Replaces
         a flat <select> that became unwieldy in orgs with 100+
         divers. Filters as the user types; arrow keys + enter
         navigate the dropdown. -->
    <div v-if="isSynchro" class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">
        {{ $t('competitor.synchro_partner') }}
      </label>
      <div class="partner-typeahead">
        <input
          class="input"
          type="text"
          autocomplete="off"
          :placeholder="orgDivers.length ? 'Search by name…' : 'No other divers in your org yet'"
          :disabled="!orgDivers.length"
          v-model="partnerSearch"
          @focus="focusPartner"
          @blur="blurPartner"
          @keydown="partnerKey"
        >
        <button v-if="partnerId || partnerSearch"
                type="button"
                class="partner-clear"
                @mousedown.prevent="clearPartner"
                v-tip="'Clear'">✕</button>
        <ul v-if="partnerOpen && partnerMatches.length" class="partner-dropdown">
          <li v-for="(d, i) in partnerMatches" :key="d.id"
              :class="['partner-row', i === partnerActive ? 'partner-row-active' : '', d.id === partnerId ? 'partner-row-selected' : '']"
              @mousedown.prevent="pickPartner(d)"
              @mouseenter="partnerActive = i">
            <span class="partner-name">{{ d.full_name }}</span>
            <span v-if="d.club_code" class="partner-club">{{ d.club_code }}</span>
          </li>
        </ul>
        <div v-else-if="partnerOpen && !partnerMatches.length && partnerSearch.trim()"
             class="partner-dropdown partner-empty">
          No divers match "{{ partnerSearch }}".
        </div>
      </div>
      <p v-if="!orgDivers.length" class="hint-line" style="margin-top:0.5rem">
        No other divers found in your organisation yet. Ask your partner to register first.
      </p>
      <p v-else class="hint-line" style="margin-top:0.5rem">
        Both you and your partner perform the same dive list — you only submit it from one account.
      </p>
    </div>

    <div v-if="currentEvent">
      <!-- Templates strip — shows only when at least one saved
           template matches the active event's height. Tapping
           a template fills the dive slots; the diver can then
           tweak before submitting. -->
      <div v-if="matchingTemplates.length || templates.length" class="card template-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;gap:0.5rem;flex-wrap:wrap">
          <label class="label" style="margin:0">Saved templates</label>
          <button class="btn btn-ghost btn-sm" @click="saveTemplateOpen = !saveTemplateOpen">
            {{ saveTemplateOpen ? 'Cancel' : 'Save current as template' }}
          </button>
        </div>

        <div v-if="!matchingTemplates.length" class="hint-line">
          No templates for this height yet. Build a list, then save it.
        </div>
        <div v-else class="template-list">
          <div v-for="t in matchingTemplates" :key="t.id" class="template-row">
            <div class="template-id">
              <span class="template-name">{{ t.name }}</span>
              <span v-if="t.height" class="template-height">{{ t.height }}</span>
              <span class="template-count">{{ (t.dives || []).length }} dive{{ (t.dives || []).length === 1 ? '' : 's' }}</span>
            </div>
            <div class="template-actions">
              <button class="btn btn-ghost btn-sm" @click="applyTemplate(t)">Load</button>
              <button class="btn btn-ghost btn-sm" @click="deleteTemplate(t)" v-tip="'Delete template'">✕</button>
            </div>
          </div>
        </div>

        <div v-if="saveTemplateOpen" class="template-save-form">
          <input
            class="input"
            type="text"
            v-model="saveTemplateName"
            placeholder='Name (e.g. "3m optionals 2026")'
            @keyup.enter="saveAsTemplate"
          >
          <button class="btn btn-primary btn-sm"
                  :disabled="saveTemplateBusy"
                  @click="saveAsTemplate">
            {{ saveTemplateBusy ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <div v-if="templateError" class="msg msg-error" style="margin-top:0.6rem">{{ templateError }}</div>
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
          <h2 style="font-size:18px;font-weight:600">Step 2 — Your Dive List</h2>
          <div class="total-bar" style="padding:0.5rem 1rem;background:transparent;border:none">
            <div>
              <div class="total-value">{{ totalDD }}</div>
              <div class="total-label">{{ $t('competitor.dd_total') }}</div>
            </div>
          </div>
        </div>
        <!-- Round-rules summary strip — only when the event
             carries a structured round_rules object (migration
             038). Shows each section's running totals so the
             diver knows where they stand against the per-section
             DD cap + group-distinctness rule before they finalise. -->
        <div v-if="roundRulesSections" class="rr-summary">
          <div v-for="(s, i) in roundRulesSections" :key="i"
               :class="['rr-summary-row', s.dd_limit != null && s.dd_used > s.dd_limit + 0.001 ? 'rr-over' : '']">
            <div class="rr-summary-head">
              <span class="rr-summary-label">{{ s.label || `Section ${i + 1}` }}</span>
              <span class="rr-summary-rounds">
                {{ s.rounds }} dive{{ s.rounds === 1 ? '' : 's' }}
                <span class="rr-summary-range">(R{{ s.start_round }}–{{ s.end_round }})</span>
              </span>
            </div>
            <div class="rr-summary-meta">
              <span v-if="s.dd_limit != null">
                DD <strong>{{ s.dd_used.toFixed(1) }}</strong> / {{ s.dd_limit.toFixed(1) }}
              </span>
              <span v-else>DD <strong>{{ s.dd_used.toFixed(1) }}</strong> (no cap)</span>
              <span v-if="s.min_distinct_groups != null">
                · groups: <strong>{{ s.groups_used.length }}</strong> / {{ s.min_distinct_groups }} required
              </span>
            </div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:0.5rem">
          <div
            v-for="(dive, idx) in selectedDives"
            :key="idx"
            :class="['dive-row', dive ? 'filled' : '', isPrescribedRound(idx) ? 'locked' : '']"
            @click="openModal(idx)"
          >
            <div :class="['row-num', dive ? 'filled-num' : '']">{{ idx + 1 }}</div>
            <div class="row-info" v-if="dive">
              <div class="row-code">
                {{ dive.dive_code }}<span class="result-pos">{{ dive.position }}</span>
                <span v-if="isPrescribedRound(idx)" class="row-lock-tag" v-tip="'Operator-prescribed dive — can\'t be changed'">🔒 prescribed</span>
              </div>
              <div class="row-desc">{{ diveDescription(dive) }}</div>
            </div>
            <div class="row-info" v-else>
              <div class="row-placeholder">
                <template v-if="prescribedDives[idx]?.slot_height != null">
                  Tap to select a {{ prescribedDives[idx].slot_height }}m dive…
                </template>
                <template v-else>Tap to select dive…</template>
              </div>
            </div>
            <div v-if="dive" class="row-dd">DD {{ dive.dd }}</div>
            <svg v-else width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:var(--text-3)"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          </div>
        </div>

        <!-- Round-rules violation panel. The same validator the
             server runs is mirrored client-side, so the diver
             sees per-section DD-sum + group-repeat violations
             the moment they pick the offending dive — the
             submit button locks until cleared. -->
        <div v-if="roundRulesValidation && !roundRulesValidation.valid && selectedDives.some(d => d)"
             class="rr-violations">
          <div class="rr-violations-head">⚠ Round rules not met</div>
          <ul>
            <li v-for="msg in roundRulesValidation.errors" :key="msg">{{ msg }}</li>
          </ul>
        </div>

        <div v-if="submitErr" class="msg msg-error" style="margin-top:1rem">{{ submitErr }}</div>
        <button class="btn btn-primary-lg" style="margin-top:1.5rem"
                @click="submitList"
                :disabled="loading || !isCurrentEventOpen
                           || (roundRulesValidation && !roundRulesValidation.valid)"
                v-tip="!isCurrentEventOpen
                  ? notAcceptingReason(currentEvent)
                  : (roundRulesValidation && !roundRulesValidation.valid)
                    ? 'Resolve round-rule violations above before submitting'
                    : 'Submit your dive list for this event'">
          {{ loading ? $t('competitor.saving')
             : !isCurrentEventOpen ? 'Entries closed'
             : (roundRulesValidation && !roundRulesValidation.valid) ? $t('competitor.validate_warning')
             : $t('competitor.submit_list') }}
        </button>
      </div>
    </div>
  </div>

  <!-- Search modal -->
  <div v-if="showModal" class="modal-backdrop">
    <div class="modal" style="max-width:560px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;gap:0.75rem">
          <h3 style="font-size:18px;font-weight:600">Find Dive</h3>
          <span v-if="activeEventHeight !== null" class="lock-badge">{{ activeEventHeight }}m board</span>
          <span v-else-if="currentEvent?.is_mixed_height" class="lock-badge mixed-badge">Mixed boards</span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="showModal = false">Cancel</button>
      </div>
      <div class="search-input-wrap" style="margin-bottom:1rem">
        <svg class="search-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" stroke-linecap="round"/></svg>
        <input class="input" type="text" v-model="searchInput" placeholder="Search code or description (e.g. 101C)..." style="padding-inline-start:2.5rem">
      </div>
      <div v-if="activeEventHeight === null" class="height-pills">
        <button
          :class="['pill', activeHeightFilter === null ? 'active' : '']"
          @click="setHeightFilter(null)"
        >All</button>
        <button
          v-for="h in allHeights"
          :key="h"
          :class="['pill', activeHeightFilter === h ? 'active' : '']"
          @click="setHeightFilter(h)"
        >{{ h }}m</button>
      </div>
      <div style="max-height:340px;overflow-y:auto;overflow-x:clip">
        <p v-if="!searchResults.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:1.5rem">No dives found</p>
        <div
          v-for="d in searchResults"
          :key="d.id"
          class="result-item"
          @click="selectDive(d)"
        >
          <div>
            <div class="result-code">{{ d.dive_code }}<span class="result-pos">{{ d.position }}</span></div>
            <div class="result-desc">{{ diveDescription(d) }}</div>
          </div>
          <div class="result-right">
            <div class="result-dd">DD {{ d.dd }}</div>
            <div class="result-height">{{ d.height }}m</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header{display:flex;align-items:center;justify-content:space-between;padding:1.5rem 2rem;border-bottom:1px solid var(--border);max-width:900px;margin:0 auto;}
/* Back-to-dashboard is redundant inside the app shell sidebar. */
.page-header .btn{display:none;}
.main{max-width:900px;margin:0 auto;padding:2rem;display:flex;flex-direction:column;gap:1.5rem;}

/* Post-advance lock banner — surfaces when the meet manager
   has stamped a dive_list_locks_at on this event (migration 041).
   Cyan accent while the window is open; muted when expired. */
.advance-banner {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--cyan);
  background: rgba(0, 224, 255, 0.06);
  border-radius: var(--radius);
}
.advance-banner.locked {
  border-color: var(--border);
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-2);
}
.advance-banner-head {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  letter-spacing: 0.04em;
}
.advance-banner-icon { font-size: 16px; }
.advance-banner-title { color: var(--cyan); }
.advance-banner.locked .advance-banner-title { color: var(--text-2); }
.advance-banner-body {
  margin: 0.5rem 0 0; font-size: 13px; color: var(--text-2);
  line-height: 1.5;
}
.advance-banner-confirmed {
  margin: 0.4rem 0 0; font-size: 12px; color: #34d399;
  font-family: var(--font-mono);
}
/* Super Final F — louder banner because the change window is
   shorter than the standard prelim → final. Amber pulse and
   bold MM:SS countdown so the diver doesn't miss the deadline. */
.advance-banner.super-final-f {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  animation: superFinalLockPulse 2.5s ease-in-out infinite;
}
.advance-banner.super-final-f .advance-banner-title {
  color: #fbbf24;
}
@keyframes superFinalLockPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.0); }
  50%      { box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18); }
}
.advance-banner.super-final-f.locked {
  /* Once the deadline passes the urgency is moot — drop the
     pulse, keep the amber border so the audit trail looks
     consistent with the alert state. */
  animation: none;
  border-color: var(--border);
}

/* Pending synchro pairing invitations (migration 051) — sits at
   the top of the dive-list page so the invitee sees their pending
   pairing requests before they hunt for their event. Violet accent
   so it reads distinct from the cyan (post-advance) and amber
   (reserve) banners. */
.pairings-banner {
  margin: 0 auto 1rem;
  max-width: 900px;
  padding: 0.85rem 1rem;
  border: 1px solid var(--violet, #9b87f5);
  background: rgba(155, 135, 245, 0.08);
  border-radius: var(--radius);
}
.pairings-banner-head {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  letter-spacing: 0.04em;
}
.pairings-banner-icon { font-size: 16px; }
.pairings-banner-title { color: var(--violet, #9b87f5); }
.pairings-list {
  list-style: none; margin: 0.5rem 0 0; padding: 0;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.pairings-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  background: var(--bg-2, rgba(255, 255, 255, 0.02));
  border-radius: var(--radius);
}
.pairings-row-body {
  font-size: 14px; color: var(--text); line-height: 1.4; flex: 1 1 auto;
}
.pairings-row-actions {
  display: flex; gap: 0.5rem; flex: 0 0 auto;
}

/* Reserve banner — amber accent so it reads as a holding
   state distinct from the cyan post-advance lock banner. */
.reserve-banner {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid #ffc857;
  background: rgba(255, 200, 87, 0.08);
  border-radius: var(--radius);
}
.reserve-banner-head {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  letter-spacing: 0.04em;
}
.reserve-banner-icon { font-size: 16px; }
.reserve-banner-title { color: #ffc857; }
.reserve-banner-body {
  margin: 0.5rem 0 0; font-size: 13px; color: var(--text-2);
  line-height: 1.5;
}

/* Round-rules summary strip — one row per section, showing
   running DD totals + group-pick progress against the cap. */
.rr-summary { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.5rem; }
.rr-summary-row {
  display: flex; flex-direction: column; gap: 0.15rem;
  padding: 0.55rem 0.75rem;
  background: var(--bg-3);
  border-inline-start: 3px solid var(--cyan);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}
.rr-summary-row.rr-over {
  border-inline-start-color: var(--red);
  background: rgba(239,68,68,0.08);
  color: var(--red);
}
.rr-summary-head {
  display: flex; justify-content: space-between; align-items: center;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase;
}
.rr-summary-label { color: var(--text); }
.rr-summary-rounds { color: var(--text-3); }
.rr-summary-range {
  margin-inline-start: 0.35rem;
  letter-spacing: 0;
  text-transform: none;
  font-weight: normal;
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.7;
}
.rr-summary-meta { font-size: 11px; }

/* Round-rules violations panel below the dive list — same red
   palette as msg-error so it reads as a hard-block. */
.rr-violations {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: rgba(239,68,68,0.08);
  border: 1px solid rgba(239,68,68,0.4);
  border-radius: var(--radius);
}
.rr-violations-head {
  font-family: var(--font-display);
  font-size: 12px; font-weight: 700; letter-spacing: 0.1em;
  color: var(--red);
  margin-bottom: 0.4rem;
}
.rr-violations ul {
  list-style: disc; margin: 0; padding-inline-start: 1.25rem;
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text); line-height: 1.5;
}

.dive-row{
  display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;
  background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);
  cursor:pointer;transition:border-color 0.15s;
}
.dive-row:hover{border-color:var(--border-2);}
.dive-row.filled{border-color:var(--cyan);background:var(--cyan-dim);}
.dive-row.locked{
  cursor:not-allowed;
  border-style:dashed;
  background:rgba(0, 224, 255, 0.04);
}
.dive-row.locked:hover{border-color:var(--border);}
.row-lock-tag{
  margin-inline-start:0.5rem;
  font-family:var(--font-mono);font-size:10px;font-weight:normal;
  letter-spacing:0.06em; text-transform:uppercase;
  color:var(--cyan); background:rgba(0,224,255,0.12);
  padding:0.1rem 0.45rem; border-radius:999px; vertical-align:middle;
}
.row-num{
  font-family:var(--font-display);font-size:13px;font-weight:700;
  color:var(--text-3);width:28px;flex-shrink:0;text-align:center;
}
.filled-num{color:var(--cyan);}
.row-info{flex:1;}
.row-code{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);}
.row-desc{font-size:11px;color:var(--text-3);margin-top:0.1rem;}
.row-placeholder{font-size:12px;color:var(--text-3);font-style:italic;}
.row-dd{font-family:var(--font-mono);font-size:14px;font-weight:500;color:var(--cyan);flex-shrink:0;}

.total-bar{
  display:flex;align-items:center;justify-content:space-between;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:1rem 1.25rem;
}
.total-label{font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-3);}
.total-value{font-family:var(--font-display);font-size:32px;font-weight:900;color:var(--cyan);}

.search-input-wrap{position:relative;}
.search-icon{position:absolute;inset-inline-start:0.875rem;top:50%;transform:translateY(-50%);color:var(--text-3);}

.height-pills{display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;}
.pill{
  font-family:var(--font-display);font-size:11px;font-weight:700;
  letter-spacing:0.1em;text-transform:uppercase;
  padding:0.35rem 0.875rem;border-radius:20px;border:1px solid var(--border);
  background:var(--bg-3);color:var(--text-3);cursor:pointer;transition:all 0.15s;
}
.pill.active,.pill:hover{background:var(--cyan-dim);border-color:var(--cyan);color:var(--cyan);}

.result-item{
  display:flex;align-items:center;justify-content:space-between;
  padding:0.875rem 1rem;background:var(--bg-3);border:1px solid var(--border);
  border-radius:var(--radius);cursor:pointer;transition:border-color 0.15s;margin-bottom:0.5rem;
}
.result-item:hover{border-color:var(--cyan);}
.result-code{font-family:var(--font-display);font-size:16px;font-weight:700;}
.result-pos{color:var(--cyan);}
.result-desc{font-size:11px;color:var(--text-3);margin-top:0.15rem;}
.result-right{text-align: end;flex-shrink:0;}
.result-dd{font-family:var(--font-mono);font-size:14px;color:var(--cyan);}
.result-height{font-size:10px;color:var(--text-3);margin-top:0.15rem;}

.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }

/* My club card — current club + request-a-change flow. */
.my-club-card { padding: 1rem 1.25rem; }
.my-club-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
}
.my-club-current {
  font-family: var(--font-display); font-size: 16px; font-weight: 700;
  color: var(--text); margin-top: 0.3rem;
}
.my-club-pending {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
  margin-top: 0.85rem; padding: 0.7rem 0.85rem;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius);
}
.my-club-pending-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.my-club-pending-text { font-size: 13px; color: var(--text-2); }
.my-club-pending-text strong { color: var(--text); }
.my-club-form {
  display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.85rem;
}
.my-club-form .field { display: flex; flex-direction: column; gap: 0.35rem; }
.my-club-actions { display: flex; gap: 0.5rem; flex-shrink: 0; flex-wrap: wrap; }
.lock-badge{
  display:inline-flex;align-items:center;gap:0.4rem;
  font-family:var(--font-display);font-size:10px;font-weight:700;
  letter-spacing:0.15em;text-transform:uppercase;
  padding:0.25rem 0.625rem;border-radius:4px;
  background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(6,182,212,0.3);
}
.lock-badge.mixed-badge{
  background:var(--amber-dim);color:var(--amber);border-color:rgba(245,158,11,0.3);
}

/* Saved-template strip */
.template-card { padding: 1rem 1.25rem; }
.template-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.5rem; }
.template-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem; padding: 0.5rem 0.7rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.template-id { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.template-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.template-height {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.35rem;
}
.template-count {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.template-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }

.template-save-form {
  display: flex; gap: 0.5rem; margin-top: 0.5rem;
}
.template-save-form .input { flex: 1; }

/* =========================================================
   Synchro partner typeahead
   ========================================================= */
.partner-typeahead { position: relative; }
.partner-typeahead .input { padding-inline-end: 2.4rem; }
.partner-clear {
  position: absolute; top: 50%; inset-inline-end: 0.5rem;
  transform: translateY(-50%);
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-3); font-size: 14px;
  border-radius: 50%; transition: all 0.1s;
}
.partner-clear:hover { color: var(--red); background: var(--bg-3); }

.partner-dropdown {
  position: absolute; top: calc(100% + 4px); inset-inline-start: 0; inset-inline-end: 0;
  z-index: 50; max-height: 280px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--radius);
  list-style: none; padding: 0.25rem; margin: 0;
  box-shadow: 0 10px 30px rgba(0,0,0,0.45);
}
.partner-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem; padding: 0.5rem 0.7rem;
  border-radius: var(--radius-sm); cursor: pointer;
}
.partner-row + .partner-row { margin-top: 0.1rem; }
.partner-row-active { background: var(--cyan-dim); }
.partner-row-selected .partner-name { color: var(--cyan); }
.partner-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.partner-club {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.partner-empty {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  padding: 0.7rem 0.8rem; font-style: italic;
}

/* =========================================================
   Phone layout (≤600px)
   The diver portal is used predominantly from phones during
   warm-ups. Padding for `.main` is set by the global rule in
   app.css; here we shrink the dive-row chrome, let the
   template-save form wrap, viewport-clip the partner
   typeahead, and bring touch targets above ~36px.
   ========================================================= */
@media (max-width: 600px) {
  /* Dive rows: keep the chip-number on the left, let code+desc
     flex to fill, allow the DD pill to wrap to a new line on the
     tightest screens rather than crushing the description. */
  .dive-row {
    gap: 0.5rem;
    padding: 0.7rem 0.85rem;
    flex-wrap: wrap;
  }
  .row-num { width: 22px; font-size: 12px; }
  .row-info { flex: 1 1 auto; min-width: 0; }
  .row-code { font-size: 15px; }
  .row-desc { font-size: 11px; line-height: 1.35; }
  .row-dd { font-size: 12px; }
  .row-lock-tag {
    margin-inline-start: 0.35rem;
    font-size: 9px;
    padding: 0.08rem 0.35rem;
  }

  /* Banners: less generous padding so they don't dominate the
     viewport above the dive list. */
  .advance-banner,
  .reserve-banner {
    padding: 0.65rem 0.8rem;
    margin-top: 0.75rem;
  }
  .advance-banner-head,
  .reserve-banner-head { font-size: 12px; }
  .advance-banner-body,
  .reserve-banner-body { font-size: 12px; }

  /* Round-rules summary — tighter row padding */
  .rr-summary-row { padding: 0.45rem 0.6rem; }

  /* Template save form: name input + save button stack
     when the row would otherwise overflow. */
  .template-save-form { flex-wrap: wrap; }
  .template-save-form .input,
  .template-save-form .btn,
  .template-save-form .btn-primary {
    flex: 1 1 100%;
    width: 100%;
  }

  /* Template list row: actions stay on the right but can wrap
     under the name+meta when the name is long. */
  .template-row { flex-wrap: wrap; }

  /* Partner typeahead: dropdown was max-height 280 + bottom-relative
     which spilled off-screen on phones. Cap to half viewport with
     scroll, and grow the clear button to a tappable size.

     dvh, not vh: focusing the input triggers the iOS keyboard,
     which collapses the layout viewport. 50vh would lock the
     dropdown to the pre-keyboard size (= half the *large*
     viewport), making it taller than the visible area. 50dvh
     tracks the live viewport so the dropdown stays usable.
     vh fallback first for browsers older than ~Q4-2022. */
  .partner-dropdown {
    max-height: 50vh;
    max-height: 50dvh;
    inset-inline-start: 0;
    inset-inline-end: 0;
  }
  .partner-clear {
    width: 36px;
    height: 36px;
    font-size: 16px;
  }
  .partner-typeahead .input { padding-inline-end: 2.75rem; }

  /* Total-bar: shrink the giant 32px score so the label fits */
  .total-bar { padding: 0.75rem 0.9rem; }
  .total-value { font-size: 26px; }
}
</style>
