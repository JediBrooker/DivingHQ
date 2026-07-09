<script setup>
// Session Scheduler: Phases 1, 2 & 3.
//
// Phase 1 (already shipped): vertical timeline (30-min gridlines)
// with one column per board, blocks anchored to their windows by
// absolute positioning. Read-only, no drag, no resize, no insert.
//
// Phase 2 (already shipped): conflict overlay + drawer.
//   * Blocks participating in an active (non-dismissed) conflict
//     pick up a coloured outline (red for hard, amber for soft)
//     and a warning-triangle marker, matching docs/session-scheduler.md §4.1.
//   * Collapsible drawer on the right lists conflicts grouped
//     by severity. Each entry has Jump-to-block, Dismiss
//     (with optional reason), and (when "show dismissed" is on)
//     Un-dismiss. Drawer open-state + show-dismissed toggle
//     persist per-user in localStorage.
//   * Subscribes to the `schedule:conflict_dismissed` socket
//     event and refetches /conflicts on receipt so multi-tab
//     dismissals propagate live.
//
// Phase 3 (this revision): manual edit + duplicate-session.
//   * "Edit mode" toggle in the header. Default OFF, the read-
//     only Phase 2 surface stays the entry experience. With edit
//     mode ON, blocks become draggable (vertical = shift in time,
//     horizontal = re-column to a different board) and resizable
//     (top edge = starts_at, bottom edge = ends_at). 30-min snap
//     by default, 5-min when Shift is held.
//   * Click an empty cell in edit mode → inline "insert" form
//     pre-populated with the clicked board column and the snapped
//     half-hour. Submit → POST /api/sessions/:id/blocks → block
//     appears with its conflict warnings inline.
//   * Hover a block in edit mode → small × button in the corner.
//     Confirms inline ("Delete this block?") then DELETE
//     /api/blocks/:id.
//   * Every successful write surfaces the conflicts the API
//     returned: the block flashes red/amber for a second and the
//     conflict list rolls into the drawer on the next refetch.
//   * "Duplicate to next day" button on each session header
//     (visible only in edit mode). Opens a small modal with a
//     date picker pre-filled to session_date + 1 day; on confirm
//     POSTs /api/sessions/:id/duplicate and the new session
//     appears as a fresh row.
//   * Subscribes to schedule:block_updated, schedule:block_deleted
//     and schedule:session_duplicated so multi-tab edits propagate.
//
// Phase 4 (this revision): subscribes to `schedule:shifted` and
// refetches /sessions on receipt. The live re-flow UI itself
// (the "Reschedule downstream" modal) lives in the Control Room,
// since the operator who marked the event Complete shouldn't have
// to leave that view to confirm shifts. See
// src/components/ReflowModal.vue + the finaliseEvent flow in
// ControlView.vue.

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { useBlockDrag } from '@/composables/useBlockDrag'
// NB: SchedulerView's drawer is a docked side panel, not an
// overlay, so drag-and-drop in the underlying calendar still
// works while it's open. No body-scroll-lock here.

const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()
const socket = useSocket({ spectator: true })

const meetId = computed(() => route.params.meetId)

const loading = ref(false)
const error = ref('')
const sessions = ref([])
const boards = ref([])
const meetEvents = ref([])

const canEditSchedule = computed(() => {
  if (!auth.user) return false
  if (auth.user.is_system_admin) return true
  const roles = auth.user.org_roles || []
  return roles.includes('org_admin') || roles.includes('meet_manager')
})

// Phase 2: conflict state.
const conflicts = ref([])           // raw response from /conflicts
const conflictsLoading = ref(false)
const conflictsError = ref('')
const drawerOpen = ref(false)
const showDismissed = ref(false)
const dismissingId = ref(null)      // composite key of the row currently
                                    // in the "type a reason" inline form
const dismissReason = ref('')
const dismissPending = ref(false)
const dismissError = ref('')
const highlightBlockId = ref(null)  // block to flash when "Jump to block"
                                    // is clicked, cleared after the
                                    // animation lands.

// Visual constants. Pixels per minute defines how tall each block
// renders; the 30-minute gridline cadence and column widths come
// off of it. Tweak these together: the gridline drawer assumes
// MINUTES_PER_GRIDLINE × PIXELS_PER_MINUTE = the row height.
const PIXELS_PER_MINUTE = 1.6
const MINUTES_PER_GRIDLINE = 30
const GRIDLINE_HEIGHT = PIXELS_PER_MINUTE * MINUTES_PER_GRIDLINE

// Phase 3: edit-mode state.
const editMode = ref(false)
const LS_EDIT_MODE = 'scheduler.editMode'
watch(editMode, (v) => writePref(LS_EDIT_MODE, v))
watch(canEditSchedule, (ok) => {
  if (!ok) {
    editMode.value = false
    drawerOpen.value = false
  }
})

// Per-block flash-after-save signal. Holds the block id of the
// row that should briefly pulse red/amber based on whether it
// landed in a hard or soft conflict. Cleared on a timer below.
const editFlashBlockId = ref(null)
const editFlashSeverity = ref(null)
const editSaveError = ref('')

// Inline insert form state. Stores the clicked slot {sessionId,
// startsIso, endsIso, boardIds} until the operator either fills
// in the form (POST) or hits Cancel.
const insertForm = ref(null) // { sessionId, block_type, label, starts_at, ends_at, board_ids }
const insertSaving = ref(false)
const insertError = ref('')

// Hover-confirm delete state. Mirrors the per-conflict dismiss
// inline form pattern: the small × button on each block flips
// pendingDeleteId to that block, the operator confirms inline.
const pendingDeleteId = ref(null)
const deleteSaving = ref(false)

// Duplicate-session modal state.
const duplicateOpen = ref(null) // session object or null
const duplicateDate = ref('')
const duplicateSaving = ref(false)
const duplicateError = ref('')

// LocalStorage keys for the QoL prefs. Mirrors the locale-switcher
// pattern in src/i18n/index.js: a single namespace, one key per
// preference, JSON-encoded so we can extend later without a
// migration. Read once at mount, written on toggle.
const LS_DRAWER_OPEN = 'scheduler.drawerOpen'
const LS_SHOW_DISMISSED = 'scheduler.showDismissed'

function readPref(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}
function writePref(key, value) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore quota */ }
}
watch(drawerOpen, (v) => writePref(LS_DRAWER_OPEN, v))
watch(showDismissed, (v) => writePref(LS_SHOW_DISMISSED, v))

async function load() {
  if (!meetId.value) return
  loading.value = true
  error.value = ''
  try {
    const body = auth.isLoggedIn
      ? await auth.apiFetch(`/api/meets/${meetId.value}/sessions`)
      : await fetchJson(`/api/meets/${meetId.value}/sessions`)
    sessions.value = Array.isArray(body?.sessions) ? body.sessions : []
    boards.value = Array.isArray(body?.boards) ? body.boards : []
    meetEvents.value = Array.isArray(body?.events) ? body.events : []
  } catch (err) {
    error.value = err.message || t('scheduler.load_failed')
  } finally {
    loading.value = false
  }
  // Conflicts are independent of /sessions but always paired with
  // it in the UI, so fire them after we have block ids to map
  // against.
  await loadConflicts()
}

async function loadConflicts() {
  if (!meetId.value) return
  if (!canEditSchedule.value) {
    conflicts.value = []
    conflictsError.value = ''
    conflictsLoading.value = false
    return
  }
  conflictsLoading.value = true
  conflictsError.value = ''
  try {
    const body = await auth.apiFetch(`/api/meets/${meetId.value}/conflicts`)
    conflicts.value = Array.isArray(body?.conflicts) ? body.conflicts : []
  } catch (err) {
    conflictsError.value = err.message || t('scheduler.conflicts.load_failed')
  } finally {
    conflictsLoading.value = false
  }
}

async function fetchJson(url, options = {}) {
  const r = await fetch(url, options)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error || `Server returned ${r.status}`)
  return body
}

watch(() => route.params.meetId, () => load(), { immediate: true })
onMounted(() => {
  drawerOpen.value = readPref(LS_DRAWER_OPEN, false)
  showDismissed.value = readPref(LS_SHOW_DISMISSED, false)
  editMode.value = canEditSchedule.value && readPref(LS_EDIT_MODE, false)
})

// Socket subscription: refetch on schedule:conflict_dismissed for
// any meet we care about. Filtered to our meet to avoid
// gratuitous refetches when a different meet's dismissal
// broadcasts through the shared socket pool.
function onConflictDismissed(payload) {
  if (!payload || !meetId.value) return
  if (payload.meet_id && payload.meet_id !== meetId.value) return
  loadConflicts()
}
// Phase 3: broadcast events from manual edits in other tabs.
// We refetch the whole /sessions payload rather than splicing
// in deltas becuase the absolute-positioning math depends on
// the session window (earliest → latest) and a single moved
// block can shift it.
function onScheduleChanged(payload) {
  if (!payload || !meetId.value) return
  if (payload.meet_id && payload.meet_id !== meetId.value) return
  load()
}
socket.on('schedule:conflict_dismissed', onConflictDismissed)
socket.on('schedule:block_updated', onScheduleChanged)
socket.on('schedule:block_deleted', onScheduleChanged)
socket.on('schedule:session_duplicated', onScheduleChanged)
// Phase 4: live re-flow. The Control Room's reflow modal POSTs
// to /api/blocks/reflow which emits this event; every connected
// timeline (including public-schedule viewers) refetches so the
// new windows appear within a socket round-trip.
socket.on('schedule:shifted', onScheduleChanged)
onUnmounted(() => {
  socket.off('schedule:conflict_dismissed', onConflictDismissed)
  socket.off('schedule:block_updated', onScheduleChanged)
  socket.off('schedule:block_deleted', onScheduleChanged)
  socket.off('schedule:session_duplicated', onScheduleChanged)
  socket.off('schedule:shifted', onScheduleChanged)
})

// The .ics URL is a same-origin path so the browser can hand it
// off to the OS calendar client. We expose it both as a plain
// link (download / open in browser) and as a webcal:// link
// (subscribe in the OS calendar so re-flow updates propagate).
const icsUrl = computed(() => (meetId.value ? `/api/meets/${meetId.value}/schedule.ics` : '#'))
const webcalUrl = computed(() => {
  if (!meetId.value) return '#'
  // Strip the scheme so the OS calendar treats the link as a
  // subscription rather than a one-shot download. window may be
  // undefined during SSR (the SchedulerView isn't SSR'd today,
  // but the guard costs nothing).
  if (typeof window === 'undefined') return '#'
  const { host } = window.location
  return `webcal://${host}/api/meets/${meetId.value}/schedule.ics`
})

// Per-session render scaffolding. We compute the day window
// (earliest block start → latest block end), snap it out to the
// nearest 30-min boundary on each end, and use that as the
// timeline's vertical extent.
function sessionWindow(session) {
  const all = session.blocks || []
  if (!all.length) return null
  let minMs = Infinity
  let maxMs = -Infinity
  for (const b of all) {
    const s = new Date(b.starts_at).getTime()
    const e = new Date(b.ends_at).getTime()
    if (s < minMs) minMs = s
    if (e > maxMs) maxMs = e
  }
  // Snap to MINUTES_PER_GRIDLINE boundaries so the first / last
  // gridline labels land on round times.
  const snap = MINUTES_PER_GRIDLINE * 60 * 1000
  minMs = Math.floor(minMs / snap) * snap
  maxMs = Math.ceil(maxMs / snap) * snap
  return { start: new Date(minMs), end: new Date(maxMs) }
}

function gridlinesForSession(session) {
  const win = sessionWindow(session)
  if (!win) return []
  const out = []
  for (
    let t = win.start.getTime();
    t <= win.end.getTime();
    t += MINUTES_PER_GRIDLINE * 60 * 1000
  ) {
    out.push(new Date(t))
  }
  return out
}

function timelineHeight(session) {
  const win = sessionWindow(session)
  if (!win) return 0
  const minutes = (win.end.getTime() - win.start.getTime()) / 60000
  return minutes * PIXELS_PER_MINUTE
}

// Per-block geometry. board_ids is a uuid[]; we resolve each id
// to a column index and render the block spanning that column.
// Blocks with no board (ceremonies, breaks) get a 'no-column'
// pseudo-column that spans the full width, visually distinct so
// the operator can see they're meet-wide.
function blockStyle(block, session) {
  const win = sessionWindow(session)
  if (!win) return {}
  const offsetMin = (new Date(block.starts_at).getTime() - win.start.getTime()) / 60000
  const durMin = (new Date(block.ends_at).getTime() - new Date(block.starts_at).getTime()) / 60000
  const top = offsetMin * PIXELS_PER_MINUTE
  const height = Math.max(durMin * PIXELS_PER_MINUTE, 18)

  const boardIds = Array.isArray(block.board_ids) ? block.board_ids : []
  if (!boardIds.length) {
    // Full-width band for meet-wide blocks. Logical inset
    // properties so blocks anchor correctly under RTL.
    return {
      top: `${top}px`,
      height: `${height}px`,
      insetInlineStart: '0',
      insetInlineEnd: '0',
    }
  }
  const cols = boards.value
  if (!cols.length) {
    return { top: `${top}px`, height: `${height}px`, insetInlineStart: '0', insetInlineEnd: '0' }
  }
  const indices = boardIds
    .map((id) => cols.findIndex((b) => b.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  if (!indices.length) {
    return { top: `${top}px`, height: `${height}px`, insetInlineStart: '0', insetInlineEnd: '0' }
  }
  const first = indices[0]
  const last = indices[indices.length - 1]
  const colWidthPct = 100 / cols.length
  const leftPct = first * colWidthPct
  const widthPct = (last - first + 1) * colWidthPct
  return {
    top: `${top}px`,
    height: `${height}px`,
    insetInlineStart: `${leftPct}%`,
    width: `${widthPct}%`,
  }
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function formatDate(d) {
  return new Date(d).toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}
function formatRelative(d) {
  if (!d) return ''
  const date = new Date(d)
  return date.toLocaleString([], {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function boardLabel(board) {
  if (board.label) return `${board.height} · ${board.label}`
  return board.height
}

const insertEventOptions = computed(() =>
  meetEvents.value
    .slice()
    .sort((a, b) => {
      const at = a.scheduled_at ? new Date(a.scheduled_at).getTime() : Infinity
      const bt = b.scheduled_at ? new Date(b.scheduled_at).getTime() : Infinity
      return at - bt || String(a.name).localeCompare(String(b.name))
    }),
)

function eventLabel(ev) {
  if (!ev) return ''
  const bits = [ev.name]
  if (ev.height) bits.push(ev.height)
  if (ev.status) bits.push(ev.status)
  return bits.join(' · ')
}

function onInsertEventChange() {
  if (!insertForm.value?.event_id) return
  const ev = meetEvents.value.find((item) => item.id === insertForm.value.event_id)
  if (!ev) return
  if (!insertForm.value.label) insertForm.value.label = ev.name
  const boardId = ev.board_id || boards.value.find((b) => b.height === ev.height)?.id
  if (boardId) insertForm.value.board_ids = [boardId]
}

// block_type → tone class on the card. Maps to a small CSS
// palette below; the design doc's mock uses colour to distinguish
// at-a-glance which kind of block you're looking at.
function blockToneClass(block) {
  return `block-${block.block_type || 'custom'}`
}

// -----------------------------------------------------------------
// Conflict derivations
// -----------------------------------------------------------------

// Active conflicts (not dismissed): what the marker / outline /
// counter use. Dismissed ones land in the drawer's "Dismissed"
// section only when the toggle is on.
const activeConflicts = computed(() =>
  conflicts.value.filter((c) => !c.dismissed),
)
const dismissedConflicts = computed(() =>
  conflicts.value.filter((c) => c.dismissed),
)
const hardConflicts = computed(() =>
  activeConflicts.value.filter((c) => c.severity === 'hard'),
)
const softConflicts = computed(() =>
  activeConflicts.value.filter((c) => c.severity === 'soft'),
)

// Map of blockId → 'hard' | 'soft' for fast lookup at render
// time. Hard wins over soft (a block with both gets the red
// outline, not the amber).
const blockConflictMap = computed(() => {
  const out = new Map()
  for (const c of activeConflicts.value) {
    for (const blockId of [c.block_a.id, c.block_b.id]) {
      const existing = out.get(blockId)
      if (existing === 'hard') continue
      out.set(blockId, c.severity)
    }
  }
  return out
})

function conflictSeverityForBlock(blockId) {
  return blockConflictMap.value.get(blockId) || null
}

function conflictKey(c) {
  return `${c.block_a.id}|${c.block_b.id}|${c.resource_kind}`
}

function isEditing(c) {
  return dismissingId.value === conflictKey(c)
}

function kindLabel(kind) {
  return t(`scheduler.conflicts.kind_${kind}`)
}

function conflictNames(c) {
  return (c.resource_labels || [])
    .filter((s) => s && s.trim())
    .join(', ') || '—'
}

function blockHeading(b) {
  return b.label || b.event_name || t(`scheduler.block_type.${b.block_type}`)
}

// "Jump to block": scroll the matching block card into view, then
// flash a highlight ring. The watch on highlightBlockId clears it
// after a short window so a second click on the same row re-fires
// the animation.
function jumpToBlock(blockId) {
  if (!blockId) return
  nextTick(() => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    highlightBlockId.value = blockId
    setTimeout(() => {
      if (highlightBlockId.value === blockId) highlightBlockId.value = null
    }, 1800)
  })
}

function openDismissForm(c) {
  dismissingId.value = conflictKey(c)
  dismissReason.value = ''
  dismissError.value = ''
}
function cancelDismiss() {
  dismissingId.value = null
  dismissReason.value = ''
  dismissError.value = ''
}

async function confirmDismiss(c) {
  dismissPending.value = true
  dismissError.value = ''
  try {
    await auth.apiFetch('/api/conflicts/dismiss', {
      method: 'POST',
      body: JSON.stringify({
        block_a_id: c.block_a.id,
        block_b_id: c.block_b.id,
        resource_kind: c.resource_kind,
        reason: dismissReason.value.trim() || undefined,
      }),
    })
    cancelDismiss()
    // The socket emit will refetch on every tab; do an immediate
    // refetch here too in case sockets are still reconnecting.
    await loadConflicts()
  } catch (err) {
    dismissError.value = err.message || t('scheduler.conflicts.load_failed')
  } finally {
    dismissPending.value = false
  }
}

async function undismiss(c) {
  if (!c.dismissal?.id) return
  try {
    await auth.apiFetch(`/api/conflicts/dismiss/${c.dismissal.id}`, {
      method: 'DELETE',
    })
    await loadConflicts()
  } catch (err) {
    conflictsError.value = err.message || t('scheduler.conflicts.load_failed')
  }
}

// -----------------------------------------------------------------
// Phase 3: manual edit
// -----------------------------------------------------------------

// Flash the just-edited block red/amber for ~1.4s. Severity comes
// off the conflicts the API returned, hard wins over soft. We
// pick the severity off the inline `conflicts` subset rather than
// re-reading the global map because the global map only updates
// after the next /conflicts poll.
function flashBlock(blockId, returnedConflicts) {
  if (!blockId) return
  let severity = null
  for (const c of (returnedConflicts || [])) {
    if (c.severity === 'hard') { severity = 'hard'; break }
    if (c.severity === 'soft') severity = 'soft'
  }
  editFlashBlockId.value = blockId
  editFlashSeverity.value = severity
  setTimeout(() => {
    if (editFlashBlockId.value === blockId) {
      editFlashBlockId.value = null
      editFlashSeverity.value = null
    }
  }, 1400)
}

// Apply a server-returned block row to the local sessions ref
// without re-fetching the whole payload. Used by drag-save and
// inline-insert so the operator sees their edit land instantly;
// the socket-driven refetch comes second and reconciles anything
// the server might have normalised.
function applyBlockUpdate(block) {
  if (!block) return
  for (const session of sessions.value) {
    if (session.id !== block.session_id) continue
    const idx = (session.blocks || []).findIndex((b) => b.id === block.id)
    if (idx >= 0) {
      session.blocks.splice(idx, 1, block)
    } else {
      session.blocks = (session.blocks || []).concat([block])
      session.blocks.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    }
    return
  }
}

// Column → board_ids resolver. Given a clientX, walk every visible
// timeline body to figure out which column the pointer is over.
// Returns the new board_ids array for the dragged block, or null
// when the pointer is outside any session timeline.
function resolveColumnAtX(clientX, _dxPx, block) {
  if (!boards.value.length) return null
  // The drag may have started on a block in one session timeline
  // and the operator may have dragged horizontally across another.
  // We constrain re-column to the session that owns the block:
  // dragging across sessions isn't supported in Phase 3 (see the
  // design doc §2 "NOT in Phase 3" note in the brief).
  const session = sessions.value.find((s) => s.blocks?.some((b) => b.id === block.id))
  if (!session) return null
  const body = document.querySelector(`[data-session-body="${session.id}"]`)
  if (!body) return null
  const rect = body.getBoundingClientRect()
  if (clientX < rect.left || clientX > rect.right) return null
  const colWidth = rect.width / boards.value.length
  const idx = Math.min(
    boards.value.length - 1,
    Math.max(0, Math.floor((clientX - rect.left) / colWidth)),
  )
  return [boards.value[idx].id]
}

async function commitBlockEdit({ block, patch }) {
  editSaveError.value = ''
  try {
    const body = await auth.apiFetch(`/api/blocks/${block.id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    if (body?.block) applyBlockUpdate(body.block)
    flashBlock(block.id, body?.conflicts)
    // The socket emit triggers a global refetch on every tab; we
    // also poke the conflicts list here so this tab updates the
    // drawer count without waiting for the next socket round-trip.
    await loadConflicts()
  } catch (err) {
    editSaveError.value = err.message || t('scheduler.edit.save_failed')
    // Roll back the optimistic apply by reloading from the server.
    await load()
  }
}

// One drag composable per timeline session, but a single
// composable works for the entire page because the resolver and
// commit callbacks both look up the relevant session via the
// block's id. The factory is invoked once at script init so the
// reactive `dragState` is shared across all blocks.
const dragger = useBlockDrag({
  pixelsPerMinute: PIXELS_PER_MINUTE,
  defaultSnapMinutes: MINUTES_PER_GRIDLINE,
  fineSnapMinutes: 5,
  resolveColumnAtX,
  commit: commitBlockEdit,
})
// Re-expose the reactive ref at the top level of the setup
// scope. Vue's template auto-unwrap only walks top-level refs
// (not nested ones inside an object), so binding `dragState`
// here lets the template reference the unwrapped value via
// `dragState` without `.value`.
const dragState = dragger.dragState

function blockStyleWithPreview(block, session) {
  // When this block is being dragged, render its preview window
  // instead of its persisted one so the operator gets immediate
  // visual feedback. Otherwise fall back to Phase 1 geometry.
  const preview = dragger.dragState.value
  if (preview && preview.blockId === block.id) {
    return blockStyle({
      ...block,
      starts_at: preview.preview.starts_at,
      ends_at: preview.preview.ends_at,
      board_ids: preview.preview.board_ids ?? block.board_ids,
    }, session)
  }
  return blockStyle(block, session)
}

// Click handler on the grid body. In edit mode an empty-cell
// click → open the inline insert form pre-filled with the
// half-hour slot under the cursor and the board column the click
// landed in. We ignore clicks that land inside an existing block
// (the block stops propagation in its mousedown handler) and the
// no-boards case (operator has no columns to fill in yet).
function onGridClick(e, session) {
  if (!editMode.value || !canEditSchedule.value) return
  if (!boards.value.length) return
  // The block's mousedown handler stops propagation, so a click
  // that bubbles to the grid body is definitively on empty space.
  const body = e.currentTarget
  const rect = body.getBoundingClientRect()
  const offsetMin = Math.max(0, (e.clientY - rect.top) / PIXELS_PER_MINUTE)
  // Round DOWN to the start of the clicked half-hour, feels more
  // natural ("click 10:42 → 10:30 block") than round-to-nearest.
  const snappedMin = Math.floor(offsetMin / MINUTES_PER_GRIDLINE) * MINUTES_PER_GRIDLINE
  const win = sessionWindow(session)
  if (!win) return
  const startsMs = win.start.getTime() + snappedMin * 60 * 1000
  const endsMs = startsMs + MINUTES_PER_GRIDLINE * 60 * 1000

  const colWidth = rect.width / boards.value.length
  const colIdx = Math.min(
    boards.value.length - 1,
    Math.max(0, Math.floor((e.clientX - rect.left) / colWidth)),
  )

  insertForm.value = {
    sessionId: session.id,
    block_type: 'custom',
    label: '',
    event_id: null,
    starts_at: new Date(startsMs).toISOString(),
    ends_at: new Date(endsMs).toISOString(),
    board_ids: [boards.value[colIdx].id],
  }
  insertError.value = ''
}

function cancelInsert() {
  insertForm.value = null
  insertError.value = ''
}

async function confirmInsert() {
  if (!insertForm.value) return
  insertSaving.value = true
  insertError.value = ''
  try {
    const body = await auth.apiFetch(`/api/sessions/${insertForm.value.sessionId}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        block_type: insertForm.value.block_type,
        label: insertForm.value.label || null,
        event_id: insertForm.value.block_type === 'event_start'
          ? (insertForm.value.event_id || null)
          : null,
        starts_at: insertForm.value.starts_at,
        ends_at: insertForm.value.ends_at,
        board_ids: insertForm.value.board_ids,
      }),
    })
    if (body?.block) applyBlockUpdate(body.block)
    flashBlock(body?.block?.id, body?.conflicts)
    insertForm.value = null
    await loadConflicts()
  } catch (err) {
    insertError.value = err.message || t('scheduler.edit.save_failed')
  } finally {
    insertSaving.value = false
  }
}

function requestDelete(blockId, e) {
  if (e) {
    e.preventDefault()
    e.stopPropagation()
  }
  pendingDeleteId.value = blockId
}
function cancelDelete() {
  pendingDeleteId.value = null
}
async function confirmDelete(blockId) {
  deleteSaving.value = true
  try {
    await auth.apiFetch(`/api/blocks/${blockId}`, { method: 'DELETE' })
    // Drop the block locally for instant feedback; the socket
    // refetch reconciles a moment later.
    for (const session of sessions.value) {
      const before = session.blocks?.length || 0
      session.blocks = (session.blocks || []).filter((b) => b.id !== blockId)
      if (session.blocks.length !== before) break
    }
    pendingDeleteId.value = null
    await loadConflicts()
  } catch (err) {
    editSaveError.value = err.message || t('scheduler.edit.save_failed')
  } finally {
    deleteSaving.value = false
  }
}

// Duplicate-session modal.
function openDuplicate(session) {
  // Pre-fill the date picker with session_date + 1 day so the
  // common-case "shift everything forward 24h for tomorrow"
  // flow is a single click.
  const baseDay = session.session_date
    ? new Date(session.session_date)
    : new Date()
  baseDay.setUTCDate(baseDay.getUTCDate() + 1)
  duplicateDate.value = baseDay.toISOString().slice(0, 10)
  duplicateError.value = ''
  duplicateOpen.value = session
}
function cancelDuplicate() {
  duplicateOpen.value = null
  duplicateError.value = ''
}
async function confirmDuplicate() {
  if (!duplicateOpen.value) return
  duplicateSaving.value = true
  duplicateError.value = ''
  try {
    const body = await auth.apiFetch(
      `/api/sessions/${duplicateOpen.value.id}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ target_date: duplicateDate.value }),
      },
    )
    duplicateOpen.value = null
    // Splice the new session in; the socket emit will round-trip
    // the same set on every other tab.
    if (body?.session) {
      sessions.value = [...sessions.value, body.session].sort(
        (a, b) => new Date(a.session_date) - new Date(b.session_date),
      )
      // Best-effort scroll to the new session so the operator sees
      // it appear rather than having to scroll the page.
      nextTick(() => {
        const el = document.querySelector(`[data-session-id="${body.session.id}"]`)
        if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    } else {
      // Fallback: full reload if the server didn't return the row.
      await load()
    }
    await loadConflicts()
  } catch (err) {
    duplicateError.value = err.message || t('scheduler.edit.duplicate_failed')
  } finally {
    duplicateSaving.value = false
  }
}
</script>

<template>
  <div class="scheduler-wrap" :class="{ 'has-drawer': drawerOpen }">
    <div class="scheduler-nav">
      <RouterLink :to="`/meet/${meetId}`" class="btn btn-ghost btn-sm">
        {{ $t('scheduler.back_to_meet') }}
      </RouterLink>
      <div class="scheduler-nav-right">
        <button
          v-if="canEditSchedule"
          type="button"
          class="btn btn-ghost btn-sm scheduler-drawer-toggle"
          :class="{ 'has-warnings': activeConflicts.length > 0 }"
          @click="drawerOpen = !drawerOpen"
        >
          <span v-if="activeConflicts.length">
            {{ $t('scheduler.conflicts.open_drawer', { n: activeConflicts.length }) }}
          </span>
          <span v-else>
            {{ $t('scheduler.conflicts.open_drawer_clean') }}
          </span>
        </button>
        <label
          v-if="canEditSchedule"
          class="scheduler-edit-toggle"
          v-tip="editMode ? $t('scheduler.edit.toggle_hint_on') : $t('scheduler.edit.toggle_hint_off')"
        >
          <input type="checkbox" v-model="editMode">
          <span>{{ editMode ? $t('scheduler.edit.toggle_on') : $t('scheduler.edit.toggle_off') }}</span>
        </label>
        <div class="scheduler-ics">
          <a :href="webcalUrl" class="btn btn-ghost btn-sm">
            {{ $t('scheduler.subscribe_ics') }}
          </a>
          <a :href="icsUrl" class="scheduler-ics-download" target="_blank" rel="noopener">
            {{ $t('scheduler.download_ics') }}
          </a>
        </div>
      </div>
    </div>

    <div v-if="editMode && canEditSchedule" class="scheduler-edit-hint">
      {{ $t('scheduler.edit.snap_hint') }}
      <span v-if="editSaveError" class="scheduler-edit-error">— {{ editSaveError }}</span>
    </div>

    <h1 class="scheduler-title">{{ $t('scheduler.title') }}</h1>
    <p class="scheduler-sub">{{ $t('scheduler.subtitle') }}</p>

    <div v-if="loading" class="scheduler-status">{{ $t('common.loading') }}</div>
    <div v-else-if="error" class="scheduler-status scheduler-error">{{ error }}</div>
    <div v-else-if="!sessions.length" class="scheduler-status">
      {{ $t('scheduler.empty') }}
    </div>

    <section
      v-for="session in sessions"
      :key="session.id"
      class="scheduler-session"
      :data-session-id="session.id"
    >
      <div class="scheduler-session-head">
        <div class="scheduler-session-title">{{ session.name }}</div>
        <div class="scheduler-session-meta">
          {{ formatDate(session.session_date) }}
          <span v-if="session.pool"> · {{ session.pool }}</span>
        </div>
        <button
          v-if="editMode && canEditSchedule"
          type="button"
          class="btn btn-ghost btn-sm scheduler-session-duplicate"
          @click="openDuplicate(session)"
        >
          {{ $t('scheduler.edit.duplicate') }}
        </button>
      </div>

      <div v-if="!session.blocks || !session.blocks.length" class="scheduler-status">
        {{ $t('scheduler.no_blocks') }}
      </div>

      <div v-else class="scheduler-timeline-wrap">
        <!-- Time column on the left, with a row label per gridline. -->
        <div class="scheduler-time-col">
          <div class="scheduler-col-head">&nbsp;</div>
          <div
            v-for="g in gridlinesForSession(session)"
            :key="`g-${g.getTime()}`"
            class="scheduler-time-row"
            :style="{ height: `${GRIDLINE_HEIGHT}px` }"
          >
            <span class="scheduler-time-label">{{ formatTime(g) }}</span>
          </div>
        </div>

        <!-- Board columns + absolutely-positioned block layer. -->
        <div class="scheduler-grid">
          <div class="scheduler-grid-head">
            <div
              v-for="b in boards"
              :key="b.id"
              class="scheduler-col-head"
            >
              {{ boardLabel(b) }}
            </div>
            <div v-if="!boards.length" class="scheduler-col-head">
              {{ $t('scheduler.no_boards_column') }}
            </div>
          </div>

          <div
            class="scheduler-grid-body"
            :class="{ 'is-edit-mode': editMode && canEditSchedule }"
            :data-session-body="session.id"
            :style="{ height: `${timelineHeight(session)}px` }"
            @click="onGridClick($event, session)"
          >
            <!-- Gridlines: one absolutely-positioned hairline per
                 30-min boundary so the operator can eyeball any
                 block's start time without checking the left rail. -->
            <div
              v-for="(g, idx) in gridlinesForSession(session)"
              :key="`gline-${g.getTime()}`"
              class="scheduler-gridline"
              :style="{ top: `${idx * GRIDLINE_HEIGHT}px` }"
            ></div>

            <!-- Column dividers: one per board boundary. -->
            <div
              v-for="(b, i) in boards"
              :key="`colsep-${b.id}`"
              v-show="i > 0"
              class="scheduler-colsep"
              :style="{ insetInlineStart: `${(i / boards.length) * 100}%` }"
            ></div>

            <!-- The blocks themselves. -->
            <div
              v-for="block in session.blocks"
              :key="block.id"
              :data-block-id="block.id"
              :class="[
                'scheduler-block',
                blockToneClass(block),
                conflictSeverityForBlock(block.id) === 'hard' ? 'has-conflict-hard' : '',
                conflictSeverityForBlock(block.id) === 'soft' ? 'has-conflict-soft' : '',
                highlightBlockId === block.id ? 'is-highlighted' : '',
                editFlashBlockId === block.id && editFlashSeverity === 'hard' ? 'is-flash-hard' : '',
                editFlashBlockId === block.id && editFlashSeverity === 'soft' ? 'is-flash-soft' : '',
                editFlashBlockId === block.id && !editFlashSeverity ? 'is-flash-ok' : '',
                editMode && canEditSchedule ? 'is-editable' : '',
                dragState && dragState.blockId === block.id ? 'is-dragging' : '',
              ]"
              :style="blockStyleWithPreview(block, session)"
              v-tip="block.notes || ''"
              @mousedown="editMode && canEditSchedule ? dragger.startMove($event, block) : null"
            >
              <!-- Resize handles (top + bottom) are only mounted in
                   edit mode so they don't capture pointer events
                   on the read-only surface. -->
              <div
                v-if="editMode && canEditSchedule"
                class="scheduler-block-handle handle-top"
                @mousedown.stop="dragger.startResizeTop($event, block)"
              ></div>
              <div
                v-if="editMode && canEditSchedule"
                class="scheduler-block-handle handle-bottom"
                @mousedown.stop="dragger.startResizeBottom($event, block)"
              ></div>

              <div class="scheduler-block-time">
                {{ formatTime(block.starts_at) }} – {{ formatTime(block.ends_at) }}
              </div>
              <div class="scheduler-block-label">
                <span
                  v-if="conflictSeverityForBlock(block.id)"
                  class="scheduler-block-warn"
                  v-tip="conflictSeverityForBlock(block.id) === 'hard'
                    ? $t('scheduler.conflicts.marker_tooltip_hard')
                    : $t('scheduler.conflicts.marker_tooltip_soft')"
                >⚠</span>
                {{ block.label || $t(`scheduler.block_type.${block.block_type}`) }}
              </div>
              <div v-if="block.event_name && block.event_name !== block.label" class="scheduler-block-sub">
                {{ block.event_name }}
              </div>

              <!-- Edit-mode delete affordance. Visible on hover via
                   .scheduler-block:hover .scheduler-block-delete in
                   the stylesheet below. -->
              <template v-if="editMode && canEditSchedule">
                <button
                  v-if="pendingDeleteId !== block.id"
                  type="button"
                  class="scheduler-block-delete"
                  :aria-label="$t('scheduler.edit.delete_block')"
                  @click.stop="requestDelete(block.id, $event)"
                  @mousedown.stop
                >✕</button>
                <div
                  v-else
                  class="scheduler-block-delete-confirm"
                  @click.stop
                  @mousedown.stop
                >
                  <span>{{ $t('scheduler.edit.delete_confirm') }}</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="deleteSaving"
                    @click.stop="cancelDelete"
                  >{{ $t('scheduler.edit.delete_no') }}</button>
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="deleteSaving"
                    @click.stop="confirmDelete(block.id)"
                  >{{ $t('scheduler.edit.delete_yes') }}</button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Inline insert form. Mounted at page level rather than per-
         session so it can overlay any timeline. The form's session
         id pins it to the right session. -->
    <div v-if="insertForm" class="scheduler-insert-backdrop" @click.self="cancelInsert">
      <div class="scheduler-insert-card" @click.stop>
        <div class="scheduler-insert-title">{{ $t('scheduler.edit.insert_title') }}</div>
        <label class="scheduler-insert-row">
          <span>{{ $t('scheduler.edit.insert_type_label') }}</span>
          <select v-model="insertForm.block_type" class="input">
            <option value="warmup">{{ $t('scheduler.block_type.warmup') }}</option>
            <option value="event_start">{{ $t('scheduler.block_type.event_start') }}</option>
            <option value="break">{{ $t('scheduler.block_type.break') }}</option>
            <option value="ceremony">{{ $t('scheduler.block_type.ceremony') }}</option>
            <option value="custom">{{ $t('scheduler.block_type.custom') }}</option>
          </select>
        </label>
        <label v-if="insertForm.block_type === 'event_start'" class="scheduler-insert-row">
          <span>{{ $t('scheduler.edit.insert_event_label') }}</span>
          <select v-model="insertForm.event_id" class="input" @change="onInsertEventChange">
            <option :value="null">{{ $t('scheduler.edit.insert_event_none') }}</option>
            <option
              v-for="ev in insertEventOptions"
              :key="ev.id"
              :value="ev.id"
            >
              {{ eventLabel(ev) }}
            </option>
          </select>
        </label>
        <label class="scheduler-insert-row">
          <span>{{ $t('scheduler.edit.insert_label') }}</span>
          <input
            class="input"
            type="text"
            v-model="insertForm.label"
            :placeholder="$t('scheduler.edit.insert_label_placeholder')"
          >
        </label>
        <div class="scheduler-insert-window">
          {{ $t('scheduler.edit.insert_starts') }}
          {{ formatTime(insertForm.starts_at) }}
          —
          {{ $t('scheduler.edit.insert_ends') }}
          {{ formatTime(insertForm.ends_at) }}
        </div>
        <div v-if="insertError" class="msg msg-error">{{ insertError }}</div>
        <div class="scheduler-insert-actions">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="insertSaving" @click="cancelInsert">
            {{ $t('scheduler.edit.insert_cancel') }}
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="insertSaving" @click="confirmInsert">
            {{ $t('scheduler.edit.insert_create') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Duplicate-session modal -->
    <div v-if="duplicateOpen" class="scheduler-insert-backdrop" @click.self="cancelDuplicate">
      <div class="scheduler-insert-card" @click.stop>
        <div class="scheduler-insert-title">{{ $t('scheduler.edit.duplicate_title') }}</div>
        <p class="scheduler-insert-blurb">{{ $t('scheduler.edit.duplicate_blurb') }}</p>
        <label class="scheduler-insert-row">
          <span>{{ $t('scheduler.edit.duplicate_target_label') }}</span>
          <input class="input" type="date" v-model="duplicateDate">
        </label>
        <div v-if="duplicateError" class="msg msg-error">{{ duplicateError }}</div>
        <div class="scheduler-insert-actions">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="duplicateSaving" @click="cancelDuplicate">
            {{ $t('scheduler.edit.duplicate_cancel') }}
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="duplicateSaving" @click="confirmDuplicate">
            {{ $t('scheduler.edit.duplicate_confirm') }}
          </button>
        </div>
      </div>
    </div>

    <!-- =========================================================
         Conflicts drawer: Phase 2.
         Mounted at the page level (not inside .scheduler-session)
         so it stays visible while the operator scrolls between
         sessions on a multi-day meet.
         ========================================================= -->
    <aside v-if="drawerOpen && canEditSchedule" class="scheduler-drawer">
      <div class="scheduler-drawer-head">
        <div class="scheduler-drawer-title">
          {{ $t('scheduler.conflicts.drawer_title') }}
          <span v-if="activeConflicts.length" class="scheduler-drawer-count">
            ({{ activeConflicts.length }})
          </span>
        </div>
        <div class="scheduler-drawer-controls">
          <label class="scheduler-drawer-toggle-label">
            <input type="checkbox" v-model="showDismissed">
            {{ showDismissed ? $t('scheduler.conflicts.hide_dismissed') : $t('scheduler.conflicts.show_dismissed') }}
          </label>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="drawerOpen = false"
            :aria-label="$t('scheduler.conflicts.close_drawer')"
          >✕</button>
        </div>
      </div>

      <div class="scheduler-drawer-body">
        <div v-if="conflictsLoading" class="scheduler-status">
          {{ $t('scheduler.conflicts.loading') }}
        </div>
        <div v-else-if="conflictsError" class="scheduler-status scheduler-error">
          {{ conflictsError }}
        </div>

        <template v-else>
          <!-- Hard conflicts -->
          <div v-if="hardConflicts.length" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-hard">
              {{ $t('scheduler.conflicts.section_hard') }} ({{ hardConflicts.length }})
            </div>
            <div
              v-for="c in hardConflicts"
              :key="conflictKey(c)"
              class="scheduler-conflict-card severity-hard"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_a) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_a.session_name || '' }) }}
                    · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}
                  </div>
                </div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_b) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_b.session_name || '' }) }}
                    · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}
                  </div>
                </div>
              </div>
              <div v-if="!isEditing(c)" class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_b.id)">
                  {{ $t('scheduler.conflicts.jump_to_b') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="openDismissForm(c)">
                  {{ $t('scheduler.conflicts.dismiss') }}
                </button>
              </div>
              <div v-else class="scheduler-conflict-dismiss-form">
                <textarea
                  class="input"
                  rows="2"
                  :placeholder="$t('scheduler.conflicts.dismiss_reason_placeholder')"
                  v-model="dismissReason"
                  :disabled="dismissPending"
                ></textarea>
                <div v-if="dismissError" class="msg msg-error">{{ dismissError }}</div>
                <div class="scheduler-conflict-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="cancelDismiss" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_cancel') }}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" @click="confirmDismiss(c)" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_confirm') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Soft warnings -->
          <div v-if="softConflicts.length" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-soft">
              {{ $t('scheduler.conflicts.section_soft') }} ({{ softConflicts.length }})
            </div>
            <div
              v-for="c in softConflicts"
              :key="conflictKey(c)"
              class="scheduler-conflict-card severity-soft"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_a) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_a.session_name || '' }) }}
                    · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}
                  </div>
                </div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_b) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_b.session_name || '' }) }}
                    · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}
                  </div>
                </div>
              </div>
              <div v-if="!isEditing(c)" class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_b.id)">
                  {{ $t('scheduler.conflicts.jump_to_b') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="openDismissForm(c)">
                  {{ $t('scheduler.conflicts.dismiss') }}
                </button>
              </div>
              <div v-else class="scheduler-conflict-dismiss-form">
                <textarea
                  class="input"
                  rows="2"
                  :placeholder="$t('scheduler.conflicts.dismiss_reason_placeholder')"
                  v-model="dismissReason"
                  :disabled="dismissPending"
                ></textarea>
                <div v-if="dismissError" class="msg msg-error">{{ dismissError }}</div>
                <div class="scheduler-conflict-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="cancelDismiss" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_cancel') }}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" @click="confirmDismiss(c)" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_confirm') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="!hardConflicts.length && !softConflicts.length"
            class="scheduler-status"
          >
            {{ $t('scheduler.conflicts.none_active') }}
          </div>

          <!-- Dismissed (toggle) -->
          <div v-if="showDismissed" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-dismissed">
              {{ $t('scheduler.conflicts.section_dismissed') }} ({{ dismissedConflicts.length }})
            </div>
            <div v-if="!dismissedConflicts.length" class="scheduler-status">
              {{ $t('scheduler.conflicts.none_dismissed') }}
            </div>
            <div
              v-for="c in dismissedConflicts"
              :key="conflictKey(c) + '-dismissed'"
              class="scheduler-conflict-card severity-dismissed"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>{{ blockHeading(c.block_a) }} · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}</div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>{{ blockHeading(c.block_b) }} · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}</div>
              </div>
              <div v-if="c.dismissal" class="scheduler-conflict-dismissed-meta">
                <div>{{ $t('scheduler.conflicts.dismissed_by_at', { when: formatRelative(c.dismissal.at) }) }}</div>
                <div v-if="c.dismissal.reason">
                  {{ $t('scheduler.conflicts.dismissed_reason', { reason: c.dismissal.reason }) }}
                </div>
              </div>
              <div class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="undismiss(c)">
                  {{ $t('scheduler.conflicts.undismiss') }}
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scheduler-wrap {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}

.scheduler-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.scheduler-nav-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.scheduler-ics {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.scheduler-ics-download {
  font-size: 12px;
  color: var(--muted, #888);
  text-decoration: underline;
}

.scheduler-drawer-toggle.has-warnings {
  border-color: var(--red, #c33);
  color: var(--red, #c33);
}

.scheduler-title {
  font-size: 28px;
  margin: 0 0 0.25rem;
}
.scheduler-sub {
  margin: 0 0 1.5rem;
  color: var(--muted, #888);
  font-style: italic;
}

.scheduler-status {
  padding: 1rem;
  border: 1px dashed var(--border, #444);
  border-radius: 6px;
  text-align: center;
  color: var(--muted, #888);
  margin: 1rem 0;
}
.scheduler-error { color: var(--red, #c33); border-color: var(--red, #c33); }

.scheduler-session {
  margin-bottom: 2.5rem;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: var(--panel, #1a1a1a);
  overflow: hidden;
}

.scheduler-session-head {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border, #333);
  background: var(--panel-elev, #222);
}
.scheduler-session-title {
  font-size: 18px;
  font-weight: 600;
}
.scheduler-session-meta {
  font-size: 13px;
  color: var(--muted, #888);
  margin-top: 0.15rem;
}

.scheduler-timeline-wrap {
  display: flex;
  align-items: flex-start;
}

.scheduler-time-col {
  flex: 0 0 64px;
  border-inline-end: 1px solid var(--border, #333);
}
.scheduler-time-row {
  position: relative;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
}
.scheduler-time-label {
  position: absolute;
  top: -8px;
  inset-inline-end: 6px;
  font-size: 11px;
  color: var(--muted, #888);
  background: var(--panel, #1a1a1a);
  padding: 0 4px;
}

.scheduler-grid {
  flex: 1 1 auto;
  position: relative;
}
.scheduler-grid-head {
  display: flex;
}
.scheduler-col-head {
  flex: 1 1 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  padding: 0.5rem 0.25rem;
  color: var(--muted, #ccc);
  border-inline-end: 1px solid var(--border, #333);
  background: var(--panel-elev, #222);
}
.scheduler-col-head:last-child { border-inline-end: none; }

.scheduler-grid-body {
  position: relative;
  background: var(--panel, #1a1a1a);
}

.scheduler-gridline {
  position: absolute;
  inset-inline-start: 0;
  inset-inline-end: 0;
  border-top: 1px dashed var(--border-subtle, rgba(255,255,255,0.07));
  pointer-events: none;
}
.scheduler-colsep {
  position: absolute;
  top: 0;
  bottom: 0;
  border-inline-start: 1px solid var(--border, #333);
  pointer-events: none;
}

.scheduler-block {
  position: absolute;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
  overflow: hidden;
  border-inline-start: 3px solid var(--cyan, #4cb);
  background: rgba(76, 187, 204, 0.15);
  color: var(--fg, #eee);
  box-sizing: border-box;
  transition: outline-color 0.2s, box-shadow 0.2s;
  outline: 2px solid transparent;
  outline-offset: -2px;
}
.scheduler-block-time {
  font-size: 10px;
  color: var(--muted, #ccc);
  margin-bottom: 1px;
}
.scheduler-block-label {
  font-weight: 600;
  line-height: 1.15;
}
.scheduler-block-warn {
  display: inline-block;
  margin-inline-end: 2px;
  color: var(--red, #c33);
  font-weight: 700;
}
.has-conflict-soft .scheduler-block-warn { color: var(--amber, #d90); }
.scheduler-block-sub {
  font-size: 11px;
  color: var(--muted, #aaa);
  margin-top: 2px;
}

/* Block-type palette. Each tone gets its own border + tinted
   background so a glance at the timeline reads as colour-coded
   by category, matching the design-doc mock. */
.block-warmup     { border-inline-start-color: #6ab; background: rgba(106, 170, 187, 0.15); }
.block-event_start{ border-inline-start-color: #d83; background: rgba(216, 136, 51, 0.18); }
.block-break      { border-inline-start-color: #888; background: rgba(136, 136, 136, 0.15); }
.block-ceremony   { border-inline-start-color: #c6a; background: rgba(204, 102, 170, 0.18); }
.block-custom     { border-inline-start-color: #6c6; background: rgba(102, 204, 102, 0.15); }

/* Conflict outlines. Hard wins over soft via specificity order. */
.scheduler-block.has-conflict-soft {
  outline-color: var(--amber, #d90);
}
.scheduler-block.has-conflict-hard {
  outline-color: var(--red, #c33);
  outline-width: 2px;
}
.scheduler-block.is-highlighted {
  box-shadow: 0 0 0 3px var(--cyan, #4cb), 0 0 16px 4px rgba(76, 187, 204, 0.6);
}

/* ----- Drawer ----- */
.scheduler-drawer {
  position: fixed;
  top: 70px;
  inset-inline-end: 12px;
  width: 360px;
  max-width: calc(100vw - 24px);
  /* dvh: stable height on iOS Safari's collapsing toolbar.
     Plus a safe-area-aware bottom inset so the drawer's
     scroll-to-bottom stays reachable on notch iPhones.
     vh fallback first for browsers older than ~Q4-2022. */
  max-height: calc(100vh - 90px - env(safe-area-inset-bottom, 0px));
  max-height: calc(100dvh - 90px - env(safe-area-inset-bottom, 0px));
  background: var(--panel-elev, #222);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 50;
}
.scheduler-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border, #333);
  background: var(--panel, #1a1a1a);
}
.scheduler-drawer-title {
  font-weight: 700;
  font-size: 14px;
}
.scheduler-drawer-count {
  margin-inline-start: 0.25rem;
  color: var(--red, #c33);
  font-weight: 700;
}
.scheduler-drawer-controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.scheduler-drawer-toggle-label {
  font-size: 11px;
  color: var(--muted, #aaa);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  user-select: none;
}
.scheduler-drawer-body {
  overflow-y: auto;
  flex: 1 1 auto;
}
.scheduler-drawer-section {
  border-bottom: 1px solid var(--border, #333);
}
.scheduler-drawer-section-head {
  padding: 0.4rem 0.85rem;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted, #aaa);
  background: var(--panel, #1a1a1a);
}
.section-hard       { color: var(--red, #c33); }
.section-soft       { color: var(--amber, #d90); }
.section-dismissed  { color: var(--muted, #888); }

.scheduler-conflict-card {
  padding: 0.6rem 0.85rem;
  border-inline-start: 3px solid transparent;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
}
.scheduler-conflict-card.severity-hard      { border-inline-start-color: var(--red, #c33); }
.scheduler-conflict-card.severity-soft      { border-inline-start-color: var(--amber, #d90); }
.scheduler-conflict-card.severity-dismissed {
  border-inline-start-color: var(--muted, #555);
  opacity: 0.75;
}
.scheduler-conflict-kind {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted, #888);
  margin-bottom: 2px;
}
.scheduler-conflict-resource {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.scheduler-conflict-blocks {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 12px;
  color: var(--muted, #ccc);
  margin-bottom: 0.5rem;
}
.scheduler-conflict-block-label {
  font-weight: 600;
  color: var(--fg, #eee);
}
.scheduler-conflict-block-sub {
  font-size: 11px;
  color: var(--muted, #888);
}
.scheduler-conflict-arrow {
  color: var(--muted, #666);
  font-size: 12px;
  text-align: center;
}
.scheduler-conflict-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.scheduler-conflict-dismiss-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.3rem;
}
.scheduler-conflict-dismiss-form .input {
  font-size: 12px;
  padding: 0.35rem 0.45rem;
  width: 100%;
  box-sizing: border-box;
}
.scheduler-conflict-dismissed-meta {
  font-size: 11px;
  color: var(--muted, #888);
  margin: 0.25rem 0 0.5rem;
}

@media (max-width: 900px) {
  .scheduler-drawer {
    top: auto;
    bottom: 0;
    inset-inline-start: 0;
    inset-inline-end: 0;
    width: 100%;
    max-width: 100%;
    max-height: 60vh;
    border-radius: 8px 8px 0 0;
  }
}

/* ----- Phase 3: edit mode ----- */
.scheduler-edit-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 12px;
  color: var(--muted, #ccc);
  cursor: pointer;
  user-select: none;
}
.scheduler-edit-hint {
  margin: 0 0 0.75rem;
  padding: 0.4rem 0.6rem;
  font-size: 12px;
  color: var(--muted, #aaa);
  background: var(--panel-elev, #222);
  border: 1px dashed var(--border, #444);
  border-radius: 4px;
}
.scheduler-edit-error {
  color: var(--red, #c33);
  font-weight: 600;
  margin-inline-start: 0.25rem;
}

.scheduler-session-head {
  position: relative;
}
.scheduler-session-duplicate {
  position: absolute;
  top: 0.6rem;
  inset-inline-end: 0.75rem;
}

.scheduler-grid-body.is-edit-mode {
  cursor: crosshair;
}
.scheduler-block.is-editable {
  cursor: grab;
}
.scheduler-block.is-editable.is-dragging {
  cursor: grabbing;
  opacity: 0.85;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
}

.scheduler-block-handle {
  position: absolute;
  inset-inline-start: 0;
  inset-inline-end: 0;
  height: 6px;
  cursor: ns-resize;
  z-index: 2;
  background: transparent;
}
.scheduler-block-handle.handle-top    { top: -3px; }
.scheduler-block-handle.handle-bottom { bottom: -3px; }
.scheduler-block.is-editable .scheduler-block-handle:hover {
  background: rgba(76, 187, 204, 0.5);
}

/* Brief flash after a successful save, distinct from the persistent
   outline applied by .has-conflict-* so the operator can see "I just
   touched this and it landed in a conflict" even when the block was
   already outlined for a different reason. */
@keyframes scheduler-flash-hard {
  0%   { box-shadow: 0 0 0 3px rgba(204, 51, 51, 0.9); }
  100% { box-shadow: 0 0 0 0 rgba(204, 51, 51, 0); }
}
@keyframes scheduler-flash-soft {
  0%   { box-shadow: 0 0 0 3px rgba(221, 153, 0, 0.9); }
  100% { box-shadow: 0 0 0 0 rgba(221, 153, 0, 0); }
}
@keyframes scheduler-flash-ok {
  0%   { box-shadow: 0 0 0 3px rgba(76, 187, 204, 0.9); }
  100% { box-shadow: 0 0 0 0 rgba(76, 187, 204, 0); }
}
.scheduler-block.is-flash-hard { animation: scheduler-flash-hard 1.4s ease-out; }
.scheduler-block.is-flash-soft { animation: scheduler-flash-soft 1.4s ease-out; }
.scheduler-block.is-flash-ok   { animation: scheduler-flash-ok 1.4s ease-out; }

/* Delete affordance, only visible on hover so the read-only view
   in edit-off mode is byte-identical to Phase 2. */
.scheduler-block-delete {
  position: absolute;
  top: 2px;
  inset-inline-end: 2px;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  background: var(--panel-elev, #222);
  border: 1px solid var(--border, #555);
  color: var(--red, #c33);
  border-radius: 50%;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  z-index: 3;
}
.scheduler-block.is-editable:hover .scheduler-block-delete {
  display: inline-flex;
}
.scheduler-block-delete-confirm {
  position: absolute;
  top: 2px;
  inset-inline-end: 2px;
  background: var(--panel-elev, #222);
  border: 1px solid var(--border, #555);
  border-radius: 4px;
  padding: 2px 4px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  z-index: 3;
  cursor: default;
}
.btn.btn-xs {
  font-size: 10px;
  padding: 2px 6px;
  line-height: 1.2;
}

/* Insert + duplicate modal. Shared backdrop because they're never
   open at the same time and the visual treatment matches. */
.scheduler-insert-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.scheduler-insert-card {
  background: var(--panel, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 1.25rem;
  min-width: 320px;
  max-width: 440px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
}
.scheduler-insert-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 0.75rem;
}
.scheduler-insert-blurb {
  font-size: 12px;
  color: var(--muted, #aaa);
  margin: 0 0 0.75rem;
}
.scheduler-insert-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-size: 12px;
}
.scheduler-insert-row > span {
  min-width: 70px;
  color: var(--muted, #aaa);
}
.scheduler-insert-row .input {
  flex: 1 1 auto;
}
.scheduler-insert-window {
  font-size: 12px;
  color: var(--muted, #aaa);
  margin: 0.5rem 0;
}
.scheduler-insert-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
</style>
