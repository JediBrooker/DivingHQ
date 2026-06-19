<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { idbInvalidate } from '@/lib/idbCache'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import StatusPill from '@/components/StatusPill.vue'
import SuperFinalModals from '@/components/manager/SuperFinalModals.vue'
import RosterImportModal from '@/components/manager/RosterImportModal.vue'
import MeetReadinessModal from '@/components/manager/MeetReadinessModal.vue'
import TeamsEnrolmentModal from '@/components/manager/TeamsEnrolmentModal.vue'
import ParticipatingOrgsModal from '@/components/manager/ParticipatingOrgsModal.vue'
import AdvanceStageModal from '@/components/manager/AdvanceStageModal.vue'
import RoundDivesEditor from '@/components/manager/RoundDivesEditor.vue'
import EditMeetModal from '@/components/manager/EditMeetModal.vue'
import { filterStandardTemplates } from '@/lib/standard-templates'
import { RULE_REFERENCES } from '@/lib/ruleReferences'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const { t } = useI18n()
const auth = useAuthStore()

const events = ref([])
const meets = ref([])
const formErr = ref('')
const editErr = ref('')
// Single composable instance, used to lock the body whenever
// any of this view's many modals is open. iOS Safari otherwise
// lets the user drag the page underneath. lockWhile is called
// next to each modal ref's declaration so the locking stays
// colocated with the modal logic; the composable's reference
// counter handles the nested-lock case (e.g. editing an event
// while a confirm dialog is also open).
const scrollLock = useBodyScrollLock()

const showCreateModal = ref(false)     // New Event form lives in a modal
const showCreateMeetModal = ref(false) // New Meet form (was inline)
const showEditModal = ref(false)
scrollLock.lockWhile(computed(() =>
  showCreateModal.value || showCreateMeetModal.value || showEditModal.value
))
// When a create/edit form is open it takes over the content area as
// a full CRM page (toolbar + lists hide) rather than a floating modal.
const formPageOpen = computed(() =>
  showCreateModal.value || showEditModal.value ||
  showCreateMeetModal.value || !!editingMeet.value
)

// Create form
const createName = ref('')
const createGender = ref('Female')
const createHeight = ref('')
const createJudges = ref(5)
const createType = ref('individual')
const createMeetId = ref('')           // optional — bundle this event into a meet

// Migration 039: operator-prescribed round dives. The "Number of
// Rounds" dropdown is gone; total rounds is derived from this
// array's length. Each entry: { dive_id|null, height|null }.
// The full editor (add/remove rows, dive-picker autocomplete,
// per-slot height override) lives in <RoundDivesEditor>; the
// array itself stays here so submit-time code paths and template
// hydration keep working untouched.
const createRoundDives = ref([])
// Derived total rounds. Existing template/code referencing
// `createRounds` keeps working without churn.
const createRounds = computed(() => createRoundDives.value.length)

// Dive directory — loaded once on mount and passed into BOTH
// <RoundDivesEditor> instances (Create + Edit modals) as a prop.
// The editor owns the per-row autocomplete UI; this view just
// hands it the data and forwards "new dive" requests to the
// sub-modal below.
const diveDirectory = ref([])

async function loadDiveDirectory() {
  try {
    const result = await auth.cachedApiFetch('/api/dive-directory', {
      cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS, onUpdate: (fresh) => {
        if (Array.isArray(fresh)) diveDirectory.value = fresh
      } },
    })
    diveDirectory.value = Array.isArray(result.data) ? result.data : []
  } catch {
    diveDirectory.value = []
  }
}

// Template refs into the two editor instances so the
// Create-Dive sub-modal can call `applyDiveAtRow` after a
// successful POST. That keeps the editor responsible for
// formatting the picker label / metadata while the sub-modal
// stays a parent-owned affordance (also reachable from the
// dive-directory page).
const createRoundDivesEditor = ref(null)
const editRoundDivesEditor   = ref(null)

// "Add new dive" sub-modal — POSTs to /api/dive-directory and,
// on success, drops the new dive into the row that opened the
// picker. The editor emits `request-new-dive` ({ rowIdx }); we
// stash which editor asked + which row, open the modal, and on
// submit replay back into the editor via its exposed
// `applyDiveAtRow`.
const showCreateDiveModal = ref(false)
scrollLock.lockWhile(showCreateDiveModal)
const newDiveCtx          = ref(null)   // 'create' | 'edit' — which editor asked
const newDiveRowIdx       = ref(-1)
const newDiveCode = ref('')
const newDiveHeight = ref('1m')
const newDivePosition = ref('B')
const newDiveDd = ref('')
const newDiveDescription = ref('')
const newDiveErr = ref('')
const newDiveBusy = ref(false)

function onRequestNewDive(ctx, { rowIdx }) {
  newDiveCtx.value    = ctx
  newDiveRowIdx.value = rowIdx
  newDiveCode.value = ''
  // Seed height from the event's chosen height when available so
  // the operator doesn't have to re-pick it.
  const evHeight = ctx === 'edit' ? editHeight.value : createHeight.value
  newDiveHeight.value = evHeight || '1m'
  newDivePosition.value = 'B'
  newDiveDd.value = ''
  newDiveDescription.value = ''
  newDiveErr.value = ''
  showCreateDiveModal.value = true
}
function closeCreateDiveModal() {
  showCreateDiveModal.value = false
}

async function submitCreateDive() {
  newDiveErr.value = ''
  if (!newDiveCode.value || !newDiveDd.value) {
    newDiveErr.value = 'Dive code and DD are required'
    return
  }
  newDiveBusy.value = true
  try {
    const heightNumeric = parseFloat(newDiveHeight.value)
    // Adding a dive invalidates the cached catalog so consumers
    // pick up the new row on next load.
    await idbInvalidate('/api/dive-directory')
    const created = await auth.apiFetch('/api/dive-directory', {
      method: 'POST',
      body: JSON.stringify({
        dive_code: newDiveCode.value.trim(),
        height:    heightNumeric,
        position:  newDivePosition.value,
        dd:        parseFloat(newDiveDd.value),
        description: newDiveDescription.value || null,
      }),
    })
    // Append to the local cache so the picker sees it without
    // a full reload.
    diveDirectory.value = [...diveDirectory.value, created]
    // Drop it into the opener row via the editor's exposed
    // `applyDiveAtRow` so label/meta formatting stays in one place.
    const editor = newDiveCtx.value === 'edit'
      ? editRoundDivesEditor.value
      : createRoundDivesEditor.value
    editor?.applyDiveAtRow(newDiveRowIdx.value, created)
    showCreateDiveModal.value = false
  } catch (err) {
    newDiveErr.value = err.message || 'Failed to create dive'
  } finally {
    newDiveBusy.value = false
  }
}

// Migration 031: sign-off policy + multi-board flag.
const createEnforceSignoff = ref(false) // hard gate — push or credential only
const createMixedHeight    = ref(false) // event spans multiple boards
const createIsRehearsal    = ref(false) // dry-run: no public archive / records / emails
// Help-popover toggles
const showSignoffHelp     = ref(false)
const showMixedHeightHelp = ref(false)

// Migration 013 additions: age group, scheduled start, event
// format (final / preliminary), prelim/final link, advance count,
// per-round DD limits.
//
// Age group / division is a single dropdown using <optgroup>
// for visual grouping — every option is reachable in a single
// click. The composite value space:
//
//   ''             → un-bracketed (historical default)
//   'junior:A'     → "Junior Group A"  (16-18, WA Article 13.2.2)
//   'junior:B'     → "Junior Group B"  (14-15, WA Article 13.2.1)
//   'junior:C'     → "Junior Group C"  (12-13, WA Article 13.3.1)
//   'junior:D'     → "Junior Group D"  (11 and under — extends WA
//                                       scheme down per common
//                                       national-federation usage)
//   'age:masters'  → "Masters" (+ free-text suffix)
//   'open'         → "Open"
//   'other'        → free text
//
// The dropdown shows the age range alongside the WA group letter
// ("Group D — 11 and under") so the operator picks once and the
// mapping is visible. Stored format stays "Junior Group X" for
// backward compatibility with existing events.
//
// composeAgeGroup retains support for the legacy 'age:11_under',
// 'age:12_13', 'age:14_15', 'age:16_18' choice values so any
// programmatic caller that hasn't migrated keeps working;
// decomposeAgeGroup auto-maps the same legacy stored strings
// ("11 and under" etc.) into the new junior:* selections so the
// Edit modal shows the right WA Group when an old event is opened.
//
// The sub-inputs (Masters range, Other custom) only render
// when the matching option is picked. Composed into the
// existing events.age_group VARCHAR(40) on submit.
const createAgeChoice  = ref('')
const createAgeMasters = ref('')
const createAgeOther   = ref('')
const createAgeGroup   = computed(() => composeAgeGroup({
  choice:  createAgeChoice.value,
  masters: createAgeMasters.value,
  other:   createAgeOther.value,
}))
function composeAgeGroup({ choice, masters, other }) {
  if (!choice) return ''
  if (choice === 'open')         return 'Open'
  if (choice === 'other')        return (other || '').trim()
  if (choice === 'age:11_under') return '11 and under'
  if (choice === 'age:12_13')    return '12/13'
  if (choice === 'age:14_15')    return '14/15'
  if (choice === 'age:16_18')    return '16-18'
  if (choice === 'age:masters') {
    const m = (masters || '').trim()
    return m ? `Masters ${m}` : 'Masters'
  }
  const junior = choice.match(/^junior:([A-E])$/)
  if (junior) return `Junior Group ${junior[1]}`
  return ''
}
// Reverse-decompose a stored age_group string back into the
// dropdown selection so the Edit modal can hydrate. Best-effort
// — anything unrecognised falls into 'other' with the original
// text preserved.
function decomposeAgeGroup(value) {
  const v = (value || '').trim()
  if (!v)                   return { choice: '',             masters: '', other: '' }
  // Legacy numeric-range stored values map onto their WA Junior
  // Group equivalents so the Edit modal lights up the right
  // dropdown row when an old event is opened. Article 13 anchors
  // A=16-18, B=14-15, C=12-13; D=11-and-under is a national-
  // federation extension that mirrors the WA naming convention
  // (see Diving Australia / USA Diving etc.).
  if (v === '11 and under') return { choice: 'junior:D',     masters: '', other: '' }
  if (v === '12/13')        return { choice: 'junior:C',     masters: '', other: '' }
  if (v === '14/15')        return { choice: 'junior:B',     masters: '', other: '' }
  if (v === '16-18')        return { choice: 'junior:A',     masters: '', other: '' }
  if (v === 'Open')         return { choice: 'open',         masters: '', other: '' }
  const masters = v.match(/^Masters\b\s*(.*)$/i)
  if (masters) return { choice: 'age:masters', masters: masters[1] || '', other: '' }
  const junior = v.match(/^Junior Group\s+([A-E])$/i)
  if (junior) return { choice: `junior:${junior[1].toUpperCase()}`, masters: '', other: '' }
  return { choice: 'other', masters: '', other: v }
}
const createScheduledAt  = ref('')      // datetime-local string, '' = unscheduled
const createEntriesCloseAt = ref('')    // datetime-local string, '' = no deadline
const createFormat       = ref('final') // 'final' | 'preliminary'
const createParentEventId = ref('')     // set on a 'final' to link its prelim
const createAdvanceCount = ref(12)      // World Aquatics standard
const createDdLimitRounds = ref(0)      // 0 = no limit
const createDdLimitValue  = ref('')     // '' = no limit; numeric otherwise

// Round structure (migration 038). Empty array = legacy
// behaviour (use the dd_limit_* pair above). Populated = a list
// of sections, each with its own DD cap + min-distinct-groups
// rule. Mirrors real-world World Aquatics / Diving Australia bulletins —
// e.g. "4 dives @ 7.6 from 4 different groups + 4 dives unlimited
// from 4 different groups" → two sections with rounds=4 each,
// dd_limit=7.6 and null, min_distinct_groups=4 on both.
//
// min_distinct_groups is independent of rounds, so an operator
// can also express "5 dives drawn from 4 different groups" (one
// group is allowed to repeat) or "1 dive from any group" (leave
// min_distinct_groups blank).
const createRoundSections = ref([])
function addRoundSection(preset) {
  const next = preset || {
    label: createRoundSections.value.length === 0 ? 'Voluntary' : 'Optional',
    rounds: 4,
    dd_limit: '',                     // '' = unlimited
    min_distinct_groups: '',          // '' = no group constraint
  }
  createRoundSections.value.push(next)
}
function removeRoundSection(idx) {
  createRoundSections.value.splice(idx, 1)
}
const sectionsRoundsTotal = computed(() =>
  createRoundSections.value.reduce((sum, s) => sum + (parseInt(s.rounds) || 0), 0),
)
function buildRoundRulesPayload() {
  // Empty array → null (legacy mode); non-empty → JSON object
  // shaped per migration 038 / lib/round-rules.js.
  if (!createRoundSections.value.length) return null
  return {
    sections: createRoundSections.value.map(s => ({
      label: s.label || null,
      rounds: parseInt(s.rounds) || 0,
      dd_limit: s.dd_limit === '' || s.dd_limit == null
        ? null
        : Number(parseFloat(s.dd_limit).toFixed(1)),
      min_distinct_groups: s.min_distinct_groups === '' || s.min_distinct_groups == null
        ? null
        : parseInt(s.min_distinct_groups) || null,
    })),
  }
}

// Event templates — saved form configurations the manager can
// apply to a fresh event with one click.
const eventTemplates = ref([])
const saveTemplateOpen = ref(false)
const saveTemplateName = ref('')
const saveTemplateBusy = ref(false)
const templateErr = ref('')

async function loadEventTemplates() {
  try {
    eventTemplates.value = await auth.apiFetch('/api/event-templates')
  } catch {
    eventTemplates.value = []
  }
}

function applyEventTemplate(t) {
  const c = t.config || {}
  // Name is intentionally NOT pulled in — the saved name is
  // usually a season-specific label that the manager wants to
  // re-write for the new event. Everything else fills.
  if (c.gender)            createGender.value = c.gender
  if (c.height !== undefined) createHeight.value = c.height || ''
  if (c.number_of_judges)  createJudges.value = c.number_of_judges
  if (c.total_rounds) {
    // Templates carry total_rounds (legacy); seed N free slots so
    // the operator can pin specific dives or leave the slots blank
    // for diver choice.
    createRoundDives.value = Array.from({ length: c.total_rounds }, () => ({
      dive_id: null, height: null, _label: '',
    }))
  }
  if (c.event_type)        createType.value = c.event_type
  if (c.age_group !== undefined) {
    // age_group is now a computed; decompose the stored string
    // back into its sub-refs so the structured dropdown picks
    // the right option.
    const parts = decomposeAgeGroup(c.age_group)
    createAgeChoice.value  = parts.choice
    createAgeMasters.value = parts.masters
    createAgeOther.value   = parts.other
  }
  if (c.event_format)      createFormat.value = c.event_format
  if (c.advance_count)     createAdvanceCount.value = c.advance_count
  if (c.dd_limit_rounds !== undefined)  createDdLimitRounds.value = c.dd_limit_rounds || 0
  if (c.dd_limit_value !== undefined)   createDdLimitValue.value = c.dd_limit_value ?? ''
  // Round structure (migration 038). When the template carries
  // round_rules, hydrate the editor; otherwise clear so the
  // form falls back to the legacy DD-limit pair.
  if (c.round_rules && Array.isArray(c.round_rules.sections)) {
    createRoundSections.value = c.round_rules.sections.map(s => ({
      label: s.label || '',
      rounds: s.rounds,
      dd_limit: s.dd_limit == null ? '' : String(s.dd_limit),
      min_distinct_groups: s.min_distinct_groups == null ? '' : String(s.min_distinct_groups),
    }))
  } else {
    createRoundSections.value = []
  }
  // Hydrate prescribed round dives if the template specifies any.
  // Most standard templates leave them blank — operator pins per
  // event. Length seeds free slots if total_rounds is set so the
  // editor reflects the round count.
  if (Array.isArray(c.round_dives) && c.round_dives.length) {
    createRoundDives.value = c.round_dives.map((slot) => ({
      dive_id: slot.dive_id || null,
      height:  slot.height ?? null,
      _label:  '',
      _meta:   null,
    }))
  } else if (c.total_rounds) {
    createRoundDives.value = Array.from({ length: c.total_rounds }, () => ({
      dive_id: null, height: null, _label: '', _meta: null,
    }))
  }
}

// Standard / "WA-aligned" templates surfaced in the modal. Filtered
// live by the operator's current Gender + Age Group so the strip
// only shows applicable rule shapes. Collapsed by default — the
// summary line shows the match count and expands on click so the
// strip doesn't dominate the top of the modal.
const suggestedStandardTemplates = computed(() =>
  filterStandardTemplates({
    gender: createGender.value,
    age_group: createAgeGroup.value,
  }),
)
const suggestedTemplatesOpen = ref(false)
function applyStandardTemplate(t) {
  // Reuse the same path as user-saved templates so the form
  // receives a consistent shape regardless of source.
  applyEventTemplate({ name: t.name, config: t.config })
  // After applying, collapse the strip so the operator's eye
  // moves down to the populated form.
  suggestedTemplatesOpen.value = false
}

async function saveAsEventTemplate() {
  templateErr.value = ''
  const name = saveTemplateName.value.trim()
  if (!name) {
    templateErr.value = 'Pick a template name'
    return
  }
  saveTemplateBusy.value = true
  try {
    // Build the config snapshot from the current form state.
    // event-specific fields like meet_id and parent_event_id are
    // intentionally excluded — a template should be re-usable
    // across meets.
    const config = {
      gender: createGender.value,
      height: createHeight.value || null,
      number_of_judges: parseInt(createJudges.value),
      total_rounds: parseInt(createRounds.value),
      event_type: createType.value,
      age_group: createAgeGroup.value || null,
      event_format: createFormat.value,
      advance_count: parseInt(createAdvanceCount.value) || 12,
      dd_limit_rounds: parseInt(createDdLimitRounds.value) || 0,
      dd_limit_value: createDdLimitValue.value
        ? parseFloat(createDdLimitValue.value)
        : null,
      round_rules: buildRoundRulesPayload(),
    }
    const saved = await auth.apiFetch('/api/event-templates', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    })
    // Replace any prior entry by name (server upserts).
    eventTemplates.value = [
      saved,
      ...eventTemplates.value.filter(t => t.name !== saved.name),
    ].sort((a, b) => a.name.localeCompare(b.name))
    saveTemplateOpen.value = false
    saveTemplateName.value = ''
  } catch (err) {
    templateErr.value = err.message
  } finally {
    saveTemplateBusy.value = false
  }
}

async function deleteEventTemplate(t) {
  if (!await confirmAction({
    title: `Delete template "${t.name}"?`,
    body:  'Templates are scoped to your federation. Existing events keyed off this template are not affected.',
    confirmLabel: 'Delete template',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/event-templates/${t.id}`, { method: 'DELETE' })
    eventTemplates.value = eventTemplates.value.filter(x => x.id !== t.id)
    showSuccess(`Deleted template "${t.name}"`)
  } catch (err) {
    showError(`Failed to delete: ${err.message}`)
  }
}

// Stage-progression modal — opens when the operator clicks
// "Advance to next stage →" on a Completed prelim/semifinal row.
// Preview/topN/reserves/dive-order state and the confirm handler
// live in <AdvanceStageModal>; v-if mount re-fetches the preview
// per open. Non-null = open. The scroll lock stays here so it
// sits beside the other modal locks.
const advanceModalEvent = ref(null)
scrollLock.lockWhile(computed(() => !!advanceModalEvent.value))

// True if some other event in the visible list points at `ev` as
// its parent_event_id. Gates the row button — the modal itself
// re-checks via the server preview.
function eventHasNextStage(ev) {
  return events.value.some(other => other.parent_event_id === ev.id)
}

function openAdvanceModal(ev) {
  advanceModalEvent.value = ev
}

// Super Final modals (DWC 2026 Appendix 3) — five dialogs that
// drive the H2H → Semi → Final → Rankings flow. All state and
// handlers live in src/components/manager/SuperFinalModals.vue;
// the template ref below lets the event-row buttons reach into
// the component's exposed openers. The component emits
// `refresh-events` after a successful seed so we reload the
// event list.
//
// Source of truth for the format: docs/2026.03.05-…-Super-
// Final…pdf Appendix 3 (committed alongside this view).
const superFinalModals = ref(null)

// Meet management — separate from event create/edit. A meet is
// a bundle of events; org admins create them here so events
// can be filed under e.g. "2026 National Open".
const meetForm = ref({
  name: '', venue: '', start_date: '', end_date: '',
})
const meetFormErr = ref('')

// Sysadmin-only org filter for the events list. The /api/events
// endpoint returns every org's events when called with a
// sysadmin token; this filter narrows the displayed view
// without re-fetching.
const orgFilter = ref('')

// Free-text search over the events list — matches event name,
// venue name (when present), age group, and the linked meet
// name. Pure client-side; the events array is already in
// memory after the initial /api/events fetch.
const eventSearch = ref('')

// Status filter chips — null = "show all", or one of the event
// status values. Lets an operator focus on whatever lifecycle
// stage they're currently working on (live runs first, post-
// meet recap browsing second, etc.).
const eventStatusFilter = ref(null)
const STATUS_CHIPS = [
  { value: null,        label: 'All' },
  { value: 'Upcoming',  label: 'Upcoming' },
  { value: 'Live',      label: 'Live' },
  { value: 'Completed', label: 'Completed' },
]
function statusChipCount(value) {
  // Count is org-aware so the sysadmin's All-orgs view doesn't
  // misreport when an org filter is active.
  const base = orgFilter.value
    ? events.value.filter(e => e.org_id === orgFilter.value)
    : events.value
  if (value === null) return base.length
  return base.filter(e => e.status === value).length
}

const uniqueOrgs = computed(() => {
  const map = new Map()
  for (const ev of events.value) {
    if (!ev.org_id) continue
    if (!map.has(ev.org_id)) {
      map.set(ev.org_id, {
        id: ev.org_id,
        name: ev.org_name || 'Unknown',
        country_code: ev.country_code || null,
        count: 0,
      })
    }
    map.get(ev.org_id).count++
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})
const uniqueOrgCount = computed(() => uniqueOrgs.value.length)

const filteredManagerEvents = computed(() => {
  let list = events.value
  // 1. Org filter (sysadmin only).
  if (orgFilter.value) {
    list = list.filter(ev => ev.org_id === orgFilter.value)
  }
  // 2. Status chip.
  if (eventStatusFilter.value) {
    list = list.filter(ev => ev.status === eventStatusFilter.value)
  }
  // 3. Free-text search across name + age group + venue + meet
  //    name. Substring match (case-insensitive); the input is
  //    debounced via Vue's reactivity granularity already, no
  //    explicit timer needed for an in-memory list.
  const q = eventSearch.value.trim().toLowerCase()
  if (q) {
    list = list.filter((ev) => {
      const haystack = [
        ev.name,
        ev.age_group,
        ev.venue,
        ev.meet_name,
        ev.org_name,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }
  return list
})

// =============================================================
// Master–detail rail selection. '' = All events (default),
// 'ungrouped' = standalone events (no meet_id), or a meet id.
// The right pane's contextual header + the displayedEvents list
// both key off this.
// =============================================================
const selectedMeetId = ref('')

// Events with no meet attribution — drives the rail's "Ungrouped
// events" count badge.
const ungroupedCount = computed(() =>
  events.value.filter(e => !e.meet_id).length,
)

// The selected meet object (or null for All / Ungrouped views) so
// the right-pane header can read its name / dates / venue.
const selectedMeet = computed(() =>
  meets.value.find(m => m.id === selectedMeetId.value) || null,
)

// filteredManagerEvents (search + status + org) further narrowed
// by the rail selection. The event v-for renders over THIS.
const displayedEvents = computed(() => {
  const list = filteredManagerEvents.value
  if (selectedMeetId.value === '') return list
  if (selectedMeetId.value === 'ungrouped') return list.filter(e => !e.meet_id)
  return list.filter(e => e.meet_id === selectedMeetId.value)
})

// Meets shown in the left rail. A sysadmin loads every federation's
// meets (via /api/meets); the shared org filter narrows the rail to
// one federation so it stays in lock-step with the events list.
// Everyone else only ever has their own org's meets loaded.
const railMeets = computed(() => {
  if (auth.user?.is_system_admin && orgFilter.value) {
    return meets.value.filter(m => m.org_id === orgFilter.value)
  }
  return meets.value
})

// Org-scoped raw count for the rail's "All events" row, mirroring
// the per-meet counts (which are unfiltered by status/search).
const allEventsCount = computed(() =>
  orgFilter.value
    ? events.value.filter(e => e.org_id === orgFilter.value).length
    : events.value.length,
)

// =============================================================
// Accordion layout. The page is a vertical list of collapsible
// sections — "All events", one per meet, then "Ungrouped". Only
// one expands at a time; expanding it reveals that selection's
// event list inline. `expandedMeetId` drives open/closed (null =
// everything collapsed, the default so the page opens as a clean
// meet list); toggleSection also mirrors the key into
// `selectedMeetId` so the existing selectedMeet / displayedEvents
// computeds resolve to the open section.
// =============================================================
const expandedMeetId = ref(null)
function toggleSection(key) {
  if (expandedMeetId.value === key) {
    expandedMeetId.value = null
    return
  }
  expandedMeetId.value = key
  selectedMeetId.value = key
}

// The ordered section list the accordion renders: All events
// first, every rail meet, Ungrouped last. `kind` drives the
// per-section header text + body actions.
const accordionSections = computed(() => {
  const out = [{
    key: '',
    kind: 'all',
    label: auth.user?.is_system_admin ? 'All events' : 'Your events',
    count: allEventsCount.value,
  }]
  for (const m of railMeets.value) {
    out.push({
      key: m.id,
      kind: 'meet',
      label: m.name,
      meet: m,
      count: m.event_count,
      live: m.live_count,
      country: m.country_code,
    })
  }
  out.push({
    key: 'ungrouped',
    kind: 'ungrouped',
    label: 'Ungrouped events',
    count: ungroupedCount.value,
  })
  return out
})

// Open the New Event form, optionally preset to bundle into a
// meet. Called from the rail / detail-header "+ New event" /
// "+ Add event" buttons. Passing '' opens a standalone event.
function openCreateEvent(meetId = '') {
  createMeetId.value = meetId || ''
  showCreateModal.value = true
}

// Human-readable meet date range for the detail header subline.
// Dates arrive as ISO-ish strings (YYYY-MM-DD or full ISO); slice
// to the date portion and format via toLocaleDateString. Returns
// '' when neither bound is present.
function formatMeetDates(meet) {
  if (!meet) return ''
  const fmt = (d) => {
    if (!d) return ''
    const str = String(d)
    // A bare YYYY-MM-DD is pinned to local noon so it doesn't roll
    // back a day in negative-offset zones. A full timestamp (what
    // the API returns) is parsed as-is and converted to the local
    // date by toLocaleDateString — slicing its date portion would
    // show the UTC day, off by one from the local date the user
    // entered.
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(str)
      ? new Date(`${str}T12:00:00`)
      : new Date(str)
    if (Number.isNaN(parsed.getTime())) return ''
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  }
  const start = fmt(meet.start_date)
  const end = fmt(meet.end_date)
  if (start && end) return start === end ? start : `${start} – ${end}`
  return start || end || ''
}

// Candidate parent events for the prelim → semi → final chain.
// A 'semifinal' can only feed from a 'preliminary'; a 'final'
// can feed from either. Cross-org pairing isn't permitted.
const parentCandidates = computed(() => {
  const allowedParentFormats =
    createFormat.value === 'semifinal' ? ['preliminary']
    : createFormat.value === 'final'    ? ['preliminary', 'semifinal']
    : []
  return events.value
    .filter(ev =>
      allowedParentFormats.includes(ev.event_format) &&
      (!auth.user?.is_system_admin
        ? true   // non-sysadmin only sees own org via /api/events
        : ev.org_id === auth.user?.org_id),
    )
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
})

// Default advance counts mirroring World Aquatics individual rules.
// Operators can override per event.
const defaultAdvanceCount = computed(() => {
  // prelim → semi (default 18); prelim → final or semi → final (default 12)
  if (createFormat.value !== 'final' && createFormat.value !== 'semifinal') return 18
  // For a final, look at what the parent is to suggest a default.
  const parent = parentCandidates.value.find(p => p.id === createParentEventId.value)
  if (parent?.event_format === 'preliminary' && createFormat.value === 'semifinal') return 18
  return 12
})

// Edit form
const editId = ref('')
const editName = ref('')
const editGender = ref('Female')
const editHeight = ref('')
const editJudges = ref(5)
const editType = ref('individual')
const editEntriesCloseAt = ref('')   // datetime-local string, '' = no deadline
const editEnforceSignoff = ref(false)
const editMixedHeight    = ref(false)
const editIsRehearsal    = ref(false)
// Structured age group — same shape as the Create form.
const editAgeChoice  = ref('')
const editAgeMasters = ref('')
const editAgeOther   = ref('')
const editAgeGroup   = computed(() => composeAgeGroup({
  choice:  editAgeChoice.value,
  masters: editAgeMasters.value,
  other:   editAgeOther.value,
}))
// AUDIT FIX (Strong-7): the dropdown rework (commit 5a336a7)
// auto-decomposes legacy stored values like "11 and under" / "12/13"
// / "14/15" / "16-18" into their WA Junior Group equivalents
// (junior:D / junior:C / junior:B / junior:A). When the operator
// opens such an event in the Edit modal and saves, composeAgeGroup
// would silently rewrite the column to "Junior Group D" — a quiet
// data migration that could break any downstream report filtering
// on the legacy text. Capture the original column value when the
// modal opens; show a warning if the composed value differs so
// the operator knows the format is about to change AND can opt
// to keep the legacy string instead.
const editAgeOriginal = ref('')   // the events.age_group as stored on open
const editAgeKeepLegacy = ref(false)  // operator opts to preserve legacy string
const editAgeWasLegacy = computed(() =>
  ['11 and under', '12/13', '14/15', '16-18'].includes(editAgeOriginal.value),
)
const editAgeWouldRewrite = computed(() =>
  editAgeWasLegacy.value
  && !editAgeKeepLegacy.value
  && editAgeGroup.value !== editAgeOriginal.value,
)
// Migration 039: prescribed round dives mirrored into the Edit
// modal. Same shape as createRoundDives — each entry is
// { dive_id|null, height|null, _label, _meta }.
const editRoundDives    = ref([])
const editRounds        = computed(() => editRoundDives.value.length)
// Migration 038: round structure (sections). Edit modal previously
// couldn't touch round_rules at all — fixed here.
const editRoundSections = ref([])
function addEditRoundSection() {
  editRoundSections.value.push({
    label: editRoundSections.value.length === 0 ? 'Voluntary' : 'Optional',
    rounds: 4,
    dd_limit: '',
    min_distinct_groups: '',
  })
}
function removeEditRoundSection(idx) {
  editRoundSections.value.splice(idx, 1)
}
const editSectionsRoundsTotal = computed(() =>
  editRoundSections.value.reduce((sum, s) => sum + (parseInt(s.rounds) || 0), 0),
)
function buildEditRoundRulesPayload() {
  if (!editRoundSections.value.length) return null
  return {
    sections: editRoundSections.value.map(s => ({
      label: s.label || null,
      rounds: parseInt(s.rounds) || 0,
      dd_limit: s.dd_limit === '' || s.dd_limit == null
        ? null
        : Number(parseFloat(s.dd_limit).toFixed(1)),
      min_distinct_groups: s.min_distinct_groups === '' || s.min_distinct_groups == null
        ? null
        : parseInt(s.min_distinct_groups) || null,
    })),
  }
}
// Team enrolment modal — open when "Teams" clicked on a team-event
// row. Lists + busy state live in <TeamsEnrolmentModal>; v-if
// mount re-fetches per open. Non-null = open.
const teamsModalEvent = ref(null)

// Participating-orgs modal — open when "Federations" clicked on
// any event row by an org admin. Lists OTHER federations whose
// divers can self-enter the event. All list/invite state lives in
// <ParticipatingOrgsModal>; v-if mount re-fetches per open.
// Non-null = open. The component emits `count-changed` so the
// row's 🌐 chip stays in sync (see bumpParticipatingCount).
const partOrgsModalEvent = ref(null)

// Roster import modal — opened from the per-event "Import
// Roster" button. All CSV / preview / import state and handlers
// live in <RosterImportModal>; v-if mount means every open
// starts from a blank CSV. Non-null = open.
const rosterModalEvent = ref(null)

function openRosterImport(ev) {
  rosterModalEvent.value = ev
}

const HEIGHT_LABELS = {
  // 0m is the poolside / pool-deck progression — sit-dives, kneel-
  // dives, standing falls. Surfaces in the same height select the
  // 1m..10m boards use so a coach can run a beginner session in
  // DivingHQ without faking a 1m event.
  '0m': 'Poolside (0m)',
  '1m': '1m Springboard',
  '3m': '3m Springboard',
  '5m': '5m Platform',
  '7.5m': '7.5m Platform',
  '10m': '10m Platform',
}

const TYPE_LABELS = {
  individual:   'Individual',
  synchro_pair: 'Synchronised Pair',
  team:         'Team (coming soon)',
}

function statusColor(status) {
  if (status === 'Live') return 'var(--green)'
  if (status === 'Completed') return 'var(--text-3)'
  return 'var(--amber)'
}

async function loadEvents() {
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch (err) {
    formErr.value = err.message
  }
}

async function loadMeets() {
  // Sysadmins manage every federation, so they load all meets across
  // orgs; everyone else is scoped to their own org's meets.
  const url = auth.user?.is_system_admin
    ? '/api/meets'
    : auth.user?.org_id
      ? `/api/orgs/${auth.user.org_id}/meets`
      : null
  if (!url) return
  try {
    const body = await auth.apiFetch(url)
    meets.value = Array.isArray(body) ? body : []
  } catch {
    meets.value = []
  }
}

async function createMeet() {
  meetFormErr.value = ''
  if (!meetForm.value.name.trim()) {
    meetFormErr.value = 'Meet name is required'
    return
  }
  try {
    await auth.apiFetch('/api/meets', {
      method: 'POST',
      body: JSON.stringify({
        name:       meetForm.value.name.trim(),
        venue:      meetForm.value.venue.trim() || null,
        start_date: meetForm.value.start_date || null,
        end_date:   meetForm.value.end_date   || null,
      }),
    })
    meetForm.value = { name: '', venue: '', start_date: '', end_date: '' }
    showCreateMeetModal.value = false
    await loadMeets()
  } catch (err) {
    meetFormErr.value = err.message
  }
}

// =============================================================
// Edit Meet — sponsor branding + the meet's core fields. The
// editable form copy / save handler / sponsor-logos manager all
// live in <EditMeetModal>; this view fetches the full meet row
// first (the org meets list lacks description + sponsor fields)
// and only opens the dialog once that succeeds. Non-null = open:
// { id, form }.
// =============================================================
const editingMeet = ref(null)
scrollLock.lockWhile(computed(() => !!editingMeet.value))

// Meet readiness report — fetch/CSV-export state and handlers
// live in <MeetReadinessModal>; v-if mount re-fetches per open.
// Non-null = open. The scroll lock stays here so it sits beside
// the other modal locks.
const readinessMeet = ref(null)
scrollLock.lockWhile(computed(() => !!readinessMeet.value))

async function openEditMeet(meet) {
  // Pull the full meet row so we have the description + sponsor
  // fields that the org meets list doesn't include.
  try {
    const body = await auth.apiFetch(`/api/meets/${meet.id}`)
    const m = body.meet
    editingMeet.value = {
      id: meet.id,
      form: {
        name:             m.name || '',
        venue:            m.venue || '',
        start_date:       m.start_date ? String(m.start_date).slice(0, 10) : '',
        end_date:         m.end_date   ? String(m.end_date).slice(0, 10)   : '',
        description:      m.description || '',
        sponsor_name:     m.sponsor_name || '',
        sponsor_link_url: m.sponsor_link_url || '',
      },
    }
  } catch (err) {
    showError(`Failed to load meet: ${err.message || err}`)
  }
}

async function deleteMeet(meet) {
  if (!await confirmAction({
    title: `Delete meet "${meet.name}"?`,
    body:  `The meet bundle is removed but its ${meet.event_count} event${meet.event_count === 1 ? ' stays' : 's stay'} intact.`,
    consequences: [
      `${meet.event_count} event${meet.event_count === 1 ? '' : 's'} will become standalone (no meet attribution)`,
      'Public meet landing page (/meet/<id>) becomes 404',
      'Existing scores, audit log, and recap PDFs are unaffected',
    ],
    confirmLabel: 'Delete meet',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/meets/${meet.id}`, { method: 'DELETE' })
    await Promise.all([loadMeets(), loadEvents()])
    showSuccess(`Deleted meet "${meet.name}"`)
  } catch (err) {
    showError(`Failed to delete meet: ${err.message}`)
  }
}

function openMeetReadinessReport(meet) {
  readinessMeet.value = meet
}

async function assignEventToMeet(event, meetId) {
  try {
    await auth.apiFetch(`/api/events/${event.id}/meet`, {
      method: 'PUT',
      body: JSON.stringify({ meet_id: meetId || null }),
    })
    event.meet_id = meetId || null
    // Refresh meet event-counts
    await loadMeets()
  } catch (err) {
    showError('Failed: ' + err.message)
  }
}

async function createEvent() {
  formErr.value = ''
  // Synchro panels must have a defined exec/sync grouping.
  if (createType.value === 'synchro_pair' && ![7, 9, 11].includes(parseInt(createJudges.value))) {
    formErr.value = 'Synchronised pair events require 7, 9 or 11 judges'
    return
  }
  if (!createRoundDives.value.length) {
    formErr.value = 'Add at least one dive (or free slot) so the event has rounds'
    return
  }
  try {
    await auth.apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value,
        gender: createGender.value,
        // Mixed-board events leave the height column NULL — the
        // server does the same coercion server-side, but pre-
        // emptively clearing it here means the dive picker that
        // reads form state during validation doesn't see a stale
        // height pinned in.
        height: createMixedHeight.value ? null : (createHeight.value || null),
        number_of_judges: parseInt(createJudges.value),
        // total_rounds is now derived server-side from round_dives
        // length. Send it anyway so legacy code paths (no slots)
        // still work — the server prefers round_dives when both
        // are present.
        total_rounds: createRoundDives.value.length,
        round_dives: createRoundDives.value.map((slot, i) => ({
          round_number: i + 1,
          dive_id: slot.dive_id || null,
          height: slot.height == null || slot.height === ''
            ? null
            : Number(slot.height),
        })),
        event_type: createType.value,
        meet_id: createMeetId.value || null,
        age_group: createAgeGroup.value || null,
        scheduled_at: createScheduledAt.value || null,
        entries_close_at: createEntriesCloseAt.value || null,
        event_format: createFormat.value,
        // Parent link is meaningful for downstream stages —
        // semifinals always feed from a preliminary; finals may
        // feed from either (or none, when standalone).
        parent_event_id: createFormat.value !== 'preliminary' && createParentEventId.value
          ? createParentEventId.value
          : null,
        advance_count: parseInt(createAdvanceCount.value) || 12,
        dd_limit_rounds: parseInt(createDdLimitRounds.value) || 0,
        dd_limit_value: createDdLimitValue.value
          ? parseFloat(createDdLimitValue.value)
          : null,
        round_rules: buildRoundRulesPayload(),
        enforce_referee_signoff: createEnforceSignoff.value,
        is_mixed_height:         createMixedHeight.value,
        is_rehearsal:            createIsRehearsal.value,
      }),
    })
    createName.value = ''
    createGender.value = 'Female'
    createHeight.value = ''
    createJudges.value = 5
    createRoundDives.value = []
    createType.value = 'individual'
    createMeetId.value = ''
    createAgeChoice.value  = ''
    createAgeMasters.value = ''
    createAgeOther.value   = ''
    createScheduledAt.value = ''
    createEntriesCloseAt.value = ''
    createFormat.value = 'final'
    createParentEventId.value = ''
    createAdvanceCount.value = 12
    createDdLimitRounds.value = 0
    createDdLimitValue.value = ''
    createRoundSections.value = []
    createEnforceSignoff.value = false
    createMixedHeight.value = false
    createIsRehearsal.value = false
    showCreateModal.value = false
    await Promise.all([loadEvents(), loadMeets()])
  } catch (err) {
    formErr.value = err.message
  }
}

async function openEdit(ev) {
  editId.value = ev.id
  editName.value = ev.name
  editGender.value = ev.gender
  editHeight.value = ev.height || ''
  editJudges.value = ev.number_of_judges
  editType.value = ev.event_type || 'individual'
  editEnforceSignoff.value = !!ev.enforce_referee_signoff
  editMixedHeight.value    = !!ev.is_mixed_height
  editIsRehearsal.value    = !!ev.is_rehearsal
  // Decompose stored age_group into the structured dropdown.
  // Capture the ORIGINAL stored value so a legacy-format event
  // can show a warning + opt-out before its column gets rewritten
  // (see editAgeWouldRewrite computed above).
  editAgeOriginal.value = ev.age_group || ''
  editAgeKeepLegacy.value = false
  const ageParts = decomposeAgeGroup(ev.age_group)
  editAgeChoice.value  = ageParts.choice
  editAgeMasters.value = ageParts.masters
  editAgeOther.value   = ageParts.other
  // entries_close_at comes back as an ISO string from the server.
  // <input type="datetime-local"> wants 'YYYY-MM-DDTHH:mm' in local
  // time, no zone, no seconds — so format it for display.
  if (ev.entries_close_at) {
    const d = new Date(ev.entries_close_at)
    const pad = (n) => String(n).padStart(2, '0')
    editEntriesCloseAt.value =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  } else {
    editEntriesCloseAt.value = ''
  }
  editErr.value = ''
  // Hydrate round_rules sections from the event row.
  if (ev.round_rules && Array.isArray(ev.round_rules.sections)) {
    editRoundSections.value = ev.round_rules.sections.map((s) => ({
      label: s.label || '',
      rounds: s.rounds,
      dd_limit: s.dd_limit == null ? '' : String(s.dd_limit),
      min_distinct_groups: s.min_distinct_groups == null ? '' : String(s.min_distinct_groups),
    }))
  } else {
    editRoundSections.value = []
  }
  // Hydrate prescribed round_dives. The event row's `total_rounds`
  // is the source of truth for slot count when no rows exist; we
  // fetch the enriched array from the dedicated endpoint so each
  // pre-filled row carries its dive metadata for the picker label.
  editRoundDives.value = []
  try {
    const rd = await auth.apiFetch(`/api/events/${ev.id}/round-dives`)
    if (Array.isArray(rd) && rd.length) {
      editRoundDives.value = rd.map((row) => ({
        dive_id: row.dive_id || null,
        height:  row.height  ?? null,
        _label:  row.dive_id
          ? `${row.dive_code}${row.position || ''} · DD ${row.dd}`
          : '',
        _meta:   row.dive_id ? {
          dive_code: row.dive_code,
          position:  row.position,
          dd:        row.dd,
          height:    Number(row.dive_height ?? row.height ?? 0),
          description: row.description,
        } : null,
      }))
    } else {
      // No prescribed rows yet — synthesise free slots matching
      // the event's stored total_rounds so the editor isn't empty.
      const n = ev.total_rounds || 0
      editRoundDives.value = Array.from({ length: n }, () => ({
        dive_id: null, height: null, _label: '', _meta: null,
      }))
    }
  } catch {
    editRoundDives.value = Array.from({ length: ev.total_rounds || 0 }, () => ({
      dive_id: null, height: null, _label: '', _meta: null,
    }))
  }
  showEditModal.value = true
}

async function saveEdit() {
  editErr.value = ''
  if (editType.value === 'synchro_pair' && ![7, 9, 11].includes(parseInt(editJudges.value))) {
    editErr.value = 'Synchronised pair events require 7, 9 or 11 judges'
    return
  }
  try {
    await auth.apiFetch(`/api/events/${editId.value}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editName.value,
        gender: editGender.value,
        height: editMixedHeight.value ? null : (editHeight.value || null),
        number_of_judges: parseInt(editJudges.value),
        total_rounds: editRoundDives.value.length || null,
        event_type: editType.value,
        // When the original column was a legacy numeric string
        // (e.g. "11 and under") AND the operator chose Keep
        // legacy text in the warning, send the original string
        // verbatim so the save is a true no-op on the column.
        age_group:
          editAgeKeepLegacy.value && editAgeWasLegacy.value
            ? editAgeOriginal.value
            : (editAgeGroup.value || null),
        // Send '' as null so the server clears the deadline; an
        // ISO string sets it. Server treats undefined (absent key)
        // as "leave untouched" — but we always send the field
        // because the user may have just blanked it.
        entries_close_at: editEntriesCloseAt.value || null,
        enforce_referee_signoff: editEnforceSignoff.value,
        is_mixed_height:         editMixedHeight.value,
        is_rehearsal:            editIsRehearsal.value,
        // Migration 038/039: round_rules + round_dives are
        // editable here too. round_dives = [] clears all
        // prescriptions; non-empty replaces them atomically.
        round_rules: buildEditRoundRulesPayload(),
        round_dives: editRoundDives.value.map((slot, i) => ({
          round_number: i + 1,
          dive_id: slot.dive_id || null,
          height: slot.height == null || slot.height === ''
            ? null
            : Number(slot.height),
        })),
      }),
    })
    showEditModal.value = false
    await loadEvents()
  } catch (err) {
    editErr.value = err.message
  }
}

async function deleteEvent(id) {
  const ev = events.value.find(e => e.id === id)
  if (!await confirmAction({
    title: `Delete "${ev?.name || 'this event'}"?`,
    body:  'Removes the event entirely — roster, dive lists, scores, and any record entries derived from it.',
    consequences: [
      'All dives, scores, and the audit log for this event are deleted',
      'Personal bests / club records keyed off this event are recomputed from remaining data',
      'This is not undoable',
    ],
    confirmLabel: 'Delete event',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/events/${id}`, { method: 'DELETE' })
    await loadEvents()
    showSuccess(`Deleted "${ev?.name || 'event'}"`)
  } catch (err) {
    showError(err.message)
  }
}

// ---- Team enrolment ----------------------------------------

function openTeamsModal(ev) {
  teamsModalEvent.value = ev
}

// ---- Participating orgs (international event support) ------
function openPartOrgsModal(ev) {
  partOrgsModalEvent.value = ev
}

// Patch the participating_orgs_count on a single event row in
// `events.value` so the 🌐 International (N) chip stays in sync
// after add/remove without a full loadEvents() refetch.
function bumpParticipatingCount(eventId, newCount) {
  const row = events.value.find(e => e.id === eventId)
  if (row) row.participating_orgs_count = newCount
}

// Visiting org self-withdraws from a foreign-hosted event. Used
// in the per-event overflow menu when the event's host org is
// not the caller's own. Different from removePartOrg above
// (which the HOST uses to evict a federation) — this is the
// guest's exit door.
async function selfWithdrawFromEvent(ev) {
  if (!await confirmAction({
    title: `Withdraw your federation from "${ev.name}"?`,
    body: 'Existing dive list entries from your divers stay intact — only NEW entries are blocked. The host federation will be notified.',
    consequences: [
      'Your divers already entered keep their entries',
      `${ev.org_name || 'The host'} sees a notification that you withdrew`,
      'You can re-join only if the host invites you again',
    ],
    confirmLabel: 'Withdraw',
    confirmKind: 'danger',
  })) return
  try {
    await auth.apiFetch(`/api/events/${ev.id}/participating-orgs/${auth.user.org_id}`, {
      method: 'DELETE',
    })
    showSuccess(`Withdrew from ${ev.name}`)
    // Refresh the events list so the withdrawn event no longer
    // shows up in the manager.
    await loadEvents()
  } catch (err) {
    showError(err.message)
  }
}

// Per-event ⋯ overflow menu — Edit / Audit Log / Import
// Roster / Delete moved here so the row's primary affordance
// (status-aware: Open Control Room / View Results) is the
// dominant button rather than fighting four equal-weight
// siblings. Only one menu is open at a time, identified by
// the event id; null means closed.
const overflowOpenEventId = ref(null)
function toggleOverflow(id) {
  overflowOpenEventId.value = overflowOpenEventId.value === id ? null : id
}
function onOutsideClick(e) {
  if (!e.target.closest?.('.dropdown-host')) overflowOpenEventId.value = null
}

onMounted(async () => {
  await Promise.all([loadEvents(), loadMeets(), loadEventTemplates(), loadDiveDirectory()])
  // Capture-phase mousedown closes the overflow menu when the
  // user clicks anywhere outside its wrapper. Capture phase
  // matters so the row's own ⋯ trigger still fires its toggle
  // before this listener runs.
  window.addEventListener('mousedown', onOutsideClick, true)
})
onUnmounted(() => {
  window.removeEventListener('mousedown', onOutsideClick, true)
})
</script>

<template>
  <div class="main">
    <!-- Create form (modal). The whole card is gated on
         showCreateModal so the inline page can use the full
         width for the events list. -->
    <div v-if="showCreateModal" class="mgr-form-page">
    <div class="mgr-form-card modal-create-event">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap">
        <h2 style="font-size:22px">{{ $t('manager.modals.new_event_title') }}</h2>
        <div style="display:flex;gap:0.5rem">
          <button type="button"
                  class="btn btn-ghost btn-sm"
                  @click="saveTemplateOpen = !saveTemplateOpen">
            {{ saveTemplateOpen ? $t('manager.modals.save_template_cancel') : $t('manager.modals.save_template_btn') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreateModal = false">{{ $t('manager.modals.cancel_x') }}</button>
        </div>
      </div>

      <!-- Template strip — apply a saved configuration with one
           click. Templates are per-org; saving upserts by name. -->
      <div v-if="eventTemplates.length || saveTemplateOpen" class="event-templates">
        <div v-if="eventTemplates.length" class="event-templates-list">
          <div v-for="t in eventTemplates" :key="t.id" class="event-template-row">
            <button type="button" class="event-template-apply" @click="applyEventTemplate(t)">
              <span class="event-template-name">{{ t.name }}</span>
              <span class="event-template-config">
                {{ t.config?.event_type || 'individual' }}{{ t.config?.height ? ' · ' + t.config.height : '' }}{{ t.config?.gender ? ' · ' + t.config.gender : '' }}{{ t.config?.age_group ? ' · ' + t.config.age_group : '' }}
              </span>
            </button>
            <button type="button" class="btn btn-ghost btn-sm event-template-del"
                    @click="deleteEventTemplate(t)" v-tip="'Delete template'">✕</button>
          </div>
        </div>

        <div v-if="saveTemplateOpen" class="event-template-save">
          <input class="input"
                 type="text"
                 v-model="saveTemplateName"
                 placeholder='Template name (e.g. "World Aquatics U16 Womens 3m")'
                 @keyup.enter="saveAsEventTemplate">
          <button type="button" class="btn btn-primary btn-sm"
                  :disabled="saveTemplateBusy"
                  @click="saveAsEventTemplate">
            {{ saveTemplateBusy ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <div v-if="templateErr" class="msg msg-error" style="margin-top:0.5rem">{{ templateErr }}</div>
      </div>

      <!-- World Aquatics / federation-standard templates. Filtered
           live by the operator's current Gender + Age Group, and
           collapsed by default so the strip doesn't dominate the
           top of the modal — click to expand. -->
      <div v-if="suggestedStandardTemplates.length"
           :class="['std-templates', suggestedTemplatesOpen ? 'open' : 'closed']">
        <button type="button" class="std-templates-toggle"
                @click="suggestedTemplatesOpen = !suggestedTemplatesOpen">
          <span class="std-templates-icon">🎯</span>
          <span class="std-templates-summary">
            {{ suggestedStandardTemplates.length }} suggested template{{ suggestedStandardTemplates.length === 1 ? '' : 's' }}
            <span class="std-templates-context">
              for {{ createGender }}{{ createAgeGroup ? ' · ' + createAgeGroup : '' }}
            </span>
          </span>
          <span class="std-templates-chevron" aria-hidden="true">{{ suggestedTemplatesOpen ? '▴' : '▾' }}</span>
        </button>
        <div v-if="suggestedTemplatesOpen" class="std-templates-list">
          <button v-for="t in suggestedStandardTemplates" :key="t.name"
                  type="button"
                  class="std-template"
                  v-tip="t.description"
                  @click="applyStandardTemplate(t)">
            <span class="event-template-name">{{ t.name }}</span>
            <span class="event-template-config">{{ t.description }}</span>
          </button>
        </div>
      </div>

      <form @submit.prevent="createEvent" class="form-stack">
        <!-- Add to meet — surfaced at the very top so the operator
             decides bundling before filling out the detailed
             fields. Preset by the "+ Add event" button when the
             form is opened from a selected meet. -->
        <div class="field">
          <label class="label">Add to meet</label>
          <select class="select" v-model="createMeetId">
            <option value="">Standalone (no meet)</option>
            <option v-for="m in meets" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <p class="hint">
            Bundle this event into a multi-event meet, or leave standalone for a one-off.
          </p>
        </div>
        <div class="field">
          <label class="label">Event Name</label>
          <input class="input" v-model="createName" placeholder="e.g. Womens 10m Platform" required>
        </div>
        <div class="field">
          <label class="label">Event Type</label>
          <select class="select" v-model="createType">
            <option value="individual">Individual</option>
            <option value="synchro_pair">Synchronised Pair</option>
            <option value="team">Team (World Aquatics)</option>
          </select>
          <p v-if="createType === 'synchro_pair'" class="hint">
            Synchro: positions 1–2 (or 1–3) score Diver A's execution, 3–4 (or 4–6) score Diver B's execution, the rest score synchronisation. World Aquatics requires a 9- or 11-judge panel.
          </p>
        </div>
        <div class="field">
          <label class="label">Gender Category</label>
          <select class="select" v-model="createGender">
            <option value="Female">Female</option>
            <option value="Male">Male</option>
            <option value="Mixed">Mixed</option>
          </select>
        </div>

        <!-- Age Group / Division. Structured dropdown — option
             labels show the WA Group letter alongside its age
             range so the operator picks once and the mapping is
             visible (per Article 13.2 / 13.3 / national-federation
             convention for Group D). Plus Masters / Open / Other
             for non-junior events. The composed string lands in
             events.age_group on submit. -->
        <div class="field age-group-field">
          <label class="label">Age Group / Division</label>
          <select class="select age-category" v-model="createAgeChoice">
            <option value="">— Un-bracketed —</option>
            <optgroup label="Age Group (WA Article 13)">
              <option value="junior:D">Group D — 11 and under</option>
              <option value="junior:C">Group C — 12/13</option>
              <option value="junior:B">Group B — 14/15</option>
              <option value="junior:A">Group A — 16-18</option>
              <option value="age:masters">Masters (specify range)</option>
            </optgroup>
            <option value="open">Open</option>
            <option value="other">Other (custom)</option>
          </select>

          <!-- Sub-inputs only appear when Masters / Other is picked. -->
          <input v-if="createAgeChoice === 'age:masters'"
                 class="input" v-model="createAgeMasters"
                 placeholder='Masters range — e.g. "30-34", "M40+", "70+"'
                 style="margin-top:0.5rem">
          <input v-if="createAgeChoice === 'other'" class="input"
                 v-model="createAgeOther"
                 placeholder='e.g. "Para Class S1", "Ex-Pat Open"'
                 style="margin-top:0.5rem">

          <p class="hint" v-if="createAgeGroup" style="margin-top:0.4rem">
            Stored as <strong>{{ createAgeGroup }}</strong>.
          </p>
        </div>

        <div class="field">
          <label class="label">Board / Platform Height</label>
          <select class="select" v-model="createHeight"
                  :disabled="createMixedHeight">
            <option value="">— Select Height —</option>
            <option value="0m">Poolside (0m)</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
          <label class="checkbox-row">
            <input type="checkbox" v-model="createMixedHeight">
            Mixed-board event
            <button type="button" class="help-pill"
                    @click.prevent="showMixedHeightHelp = !showMixedHeightHelp"
                    v-tip="'What is this?'">?</button>
          </label>
          <div v-if="showMixedHeightHelp" class="help-popover">
            Use this for events that span more than one board — e.g. an
            "Open Mixed" exhibition with 1m + 3m + 5m + 10m dives. The
            height field above is ignored and divers can pick any height
            on each of their dives.
          </div>
        </div>
        <div class="field">
          <label class="label">Judge Panel Size</label>
          <select class="select" v-model="createJudges">
            <option v-if="createType !== 'synchro_pair'" value="3">3 Judges</option>
            <option v-if="createType !== 'synchro_pair'" value="5">5 Judges</option>
            <option value="7">7 Judges</option>
            <option value="9">9 Judges</option>
            <option value="11">11 Judges</option>
          </select>
        </div>
        <!-- Round dives (migration 039). Each row is one round in
             the event. Pinning a dive to a row makes it a
             "prescribed" dive — the diver must submit exactly that
             dive in that round. Leaving the dive blank lets the
             diver pick freely. The count of rows == total_rounds.
             The editor (rows, dive-picker, per-slot height) lives
             in <RoundDivesEditor>; new-dive requests bubble back
             up so the shared Create-Dive sub-modal stays here. -->
        <RoundDivesEditor
          ref="createRoundDivesEditor"
          v-model="createRoundDives"
          :height="createHeight"
          :mixed-height="createMixedHeight"
          :dive-directory="diveDirectory"
          @request-new-dive="onRequestNewDive('create', $event)"
        />

        <!-- Round structure (migration 038). Sections of rounds
             with their own DD-sum cap and min-distinct-groups
             rule. Lives directly under the Round dives editor so
             the operator's flow is: pick the rounds, then group
             them. -->
        <div class="field rr-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round structure (optional)</span>
            <span v-if="createRoundSections.length" class="rr-total"
                  :class="{ 'rr-total-mismatch': sectionsRoundsTotal !== parseInt(createRounds) }">
              {{ sectionsRoundsTotal }} / {{ createRounds }} rounds
            </span>
          </label>
          <p class="hint" v-if="!createRoundSections.length" style="margin-bottom:0.5rem">
            For events that need per-section dive rules — e.g.
            "4 dives @ 7.6 from 4 different groups, then 4 dives
            unlimited from 4 groups". Add a section below;
            otherwise the flat DD Limit further down applies.
          </p>

          <div v-for="(s, i) in createRoundSections" :key="i" class="rr-section">
            <div class="rr-section-row">
              <input class="input rr-label" type="text" v-model="s.label" placeholder="Section name (e.g. Voluntary)">
              <button type="button" class="btn btn-ghost btn-sm rr-remove"
                      @click="removeRoundSection(i)" v-tip="'Remove section'">✕</button>
            </div>
            <div class="rr-section-row">
              <label class="rr-cell">
                <span class="rr-cell-label">Rounds</span>
                <input class="input" type="number" min="1" max="12" v-model="s.rounds">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">DD limit (sum)</span>
                <input class="input" type="number" min="0" max="50" step="0.1"
                       v-model="s.dd_limit"
                       placeholder="Unlimited">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">Min different groups</span>
                <input class="input" type="number" min="1" max="6"
                       v-model="s.min_distinct_groups"
                       placeholder="—">
              </label>
            </div>
            <p class="hint" style="margin-top:0.4rem; margin-bottom:0">
              <span v-if="s.min_distinct_groups">
                {{ s.rounds || '?' }} dive{{ parseInt(s.rounds) === 1 ? '' : 's' }} drawn from at least
                <strong>{{ s.min_distinct_groups }}</strong> different group{{ parseInt(s.min_distinct_groups) === 1 ? '' : 's' }}
                (forward / back / reverse / inward / twist / armstand).
              </span>
              <span v-else style="opacity:0.65">
                Leave "Min different groups" blank for no group constraint.
              </span>
            </p>
          </div>

          <div class="rr-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="addRoundSection()">
              + Add section
            </button>
          </div>
          <p class="hint hint-warn"
             v-if="createRoundSections.length && sectionsRoundsTotal !== parseInt(createRounds)">
            Section round counts ({{ sectionsRoundsTotal }}) don't match total_rounds ({{ createRounds }}). Adjust the rounds-per-section above or change Total Rounds.
          </p>
        </div>

        <!-- Scheduled start. Powers the meet schedule view,
             notifications, and (later) calendar export. -->
        <div class="field">
          <label class="label">Scheduled Start (optional)</label>
          <input class="input" type="datetime-local" v-model="createScheduledAt">
          <p class="hint" v-if="createScheduledAt">
            Notifications will fire 1 hour before this time when a competitor's dive list is in.
          </p>
        </div>

        <!-- Entries-close deadline. When set, divers can't submit
             (or change) their dive list past this moment, even
             though the event is still 'Upcoming'. Blank = the
             event accepts entries up until status flips to 'Live'. -->
        <div class="field">
          <label class="label">Entries Close (optional)</label>
          <input class="input" type="datetime-local" v-model="createEntriesCloseAt">
          <p class="hint" v-if="createEntriesCloseAt">
            Divers can submit until this moment. After it passes, their portal hides the event.
          </p>
          <p class="hint" v-else>
            Leave blank to keep entries open until the event goes Live.
          </p>
        </div>

        <!-- Event format — three stages, in order:
             preliminary → semifinal → final. World Aquatics
             individual events use all three; synchro and team
             events typically skip the semi (or are standalone).
             The chain is operator-defined per event. -->
        <div class="field">
          <label class="label">Event Format</label>
          <select class="select" v-model="createFormat" @change="createParentEventId = ''">
            <option value="final">Final (standalone or terminal stage)</option>
            <option value="preliminary">Preliminary (feeds a semi or final)</option>
            <option value="semifinal">Semi-Final (top N from prelim → final)</option>
          </select>
          <p class="hint" v-if="createFormat === 'preliminary'">
            Build the prelim, run it, then create a Semi-Final or Final and use "Advance Top N" on this row to seed the next stage.
          </p>
          <p class="hint" v-else-if="createFormat === 'semifinal'">
            Pick the preliminary it feeds from below. After running the semi, "Advance Top N" pushes the leaders into the final.
          </p>
        </div>

        <!-- Parent picker. For a 'semifinal' the parent must be
             a 'preliminary'; for a 'final' it may be either.
             Listed candidates come from the user's org
             (cross-org linking is rejected). -->
        <div class="field"
             v-if="createFormat !== 'preliminary' && parentCandidates.length">
          <label class="label">
            {{ createFormat === 'semifinal' ? 'Feeds From Preliminary' : 'Feeds From (optional)' }}
          </label>
          <select class="select" v-model="createParentEventId">
            <option value="">
              — {{ createFormat === 'semifinal' ? 'Pick the preliminary' : 'Standalone final (no feeder)' }} —
            </option>
            <option v-for="ev in parentCandidates" :key="ev.id" :value="ev.id">
              {{ ev.name }} <template v-if="ev.event_format !== 'preliminary'">({{ ev.event_format }})</template>
            </option>
          </select>
        </div>

        <!-- Advance count — only relevant on a feeder stage
             (preliminary or semifinal). World Aquatics defaults:
             prelim → semi = 18, semi → final or prelim → final = 12. -->
        <div class="field" v-if="createFormat !== 'final'">
          <label class="label">Advance Top N to Next Stage</label>
          <input class="input" type="number" min="1" max="50" v-model="createAdvanceCount">
          <p class="hint">
            World Aquatics: prelim → semi = 18, semi → final = 12.
            Synchro/team meets often use smaller cuts. {{ RULE_REFERENCES.withdrawalAdvancement }}.
          </p>
        </div>

        <!-- Per-round DD limit. Common in junior events: rounds
             1–N capped to a max DD; later rounds open. Both
             columns nullable; UI clears them in tandem.
             Hidden once the operator switches to the structured
             "Round structure" editor below — that supersedes
             this flat constraint. -->
        <div class="field" v-if="!createRoundSections.length">
          <label class="label">DD Limit (optional)</label>
          <div style="display:flex;gap:0.5rem">
            <input class="input" type="number" min="0" max="12" step="1"
                   v-model="createDdLimitRounds"
                   placeholder="Rounds (0 = no limit)" style="flex:1">
            <input class="input" type="number" min="0" max="5" step="0.1"
                   v-model="createDdLimitValue"
                   placeholder="Max DD (e.g. 1.8)" style="flex:1">
          </div>
          <p class="hint" v-if="parseInt(createDdLimitRounds) > 0 && createDdLimitValue">
            First {{ createDdLimitRounds }} round{{ parseInt(createDdLimitRounds) === 1 ? '' : 's' }} capped to DD ≤ {{ createDdLimitValue }}.
          </p>
        </div>

        <div class="field">
          <label class="checkbox-row">
            <input type="checkbox" v-model="createEnforceSignoff">
            Enforce referee sign-off
            <button type="button" class="help-pill"
                    @click.prevent="showSignoffHelp = !showSignoffHelp"
                    v-tip="'What is this?'">?</button>
          </label>
          <div v-if="showSignoffHelp" class="help-popover">
            <strong>What this does</strong>
            <p>
              Locks the pre-meet workflow's referee sign-off step so the
              actual referee has to approve the dive order — either by
              tapping the push notification on their device, by entering
              their username + password on the meet controller's screen,
              or by typing a 6-digit handoff code on their own device.
            </p>
            <strong>What changes</strong>
            <p>
              The "Manager attests on referee's behalf" tab in the sign-off
              modal disappears, and the underlying API refuses any soft
              attest. The referee's user-id is what gets stamped on the
              event's audit trail.
            </p>
            <strong>When to use it</strong>
            <p>
              Sanctioned meets, anything with formal results that need
              proper attribution. For training / club nights, leave it off
              and the meet controller can sign off after a verbal nod.
            </p>
          </div>
        </div>

        <div class="field">
          <label class="checkbox-row">
            <input type="checkbox" v-model="createIsRehearsal">
            Rehearsal / dry-run event
          </label>
          <p class="hint">
            Uses the real Control Room workflow, but stays out of public archive,
            analytics, emails, and records.
          </p>
        </div>

        <div v-if="formErr" class="msg msg-error">{{ formErr }}</div>
        <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem">{{ $t('manager.modals.new_event_submit') }}</button>
      </form>
    </div>
    </div>
    <!-- /modal-create-event -->

    <!-- Page heading + one-line summary, matching the Judge Analysis
         header: a plain muted sub-paragraph under the title, no box.
         Hidden while a create/edit form page takes over the view. -->
    <header v-show="!formPageOpen" class="mgr-page-head">
      <h1 class="mgr-page-title">{{ $t('manager.title') }}</h1>
      <p class="mgr-page-sub">{{ $t('manager.subtitle') }}</p>
    </header>

    <!-- Accordion — a vertical list of collapsible sections (All
         events, one per meet, Ungrouped). Expanding one reveals that
         selection's event list inline. Hidden while a create/edit
         form page is open. -->
    <div class="mgr-accordion" v-show="!formPageOpen">
      <!-- Top toolbar — page-level create actions, left-aligned and
           standard button size, matching Clubs / Teams / Dive
           Directory (btn btn-primary btn-sm). Both stay visible
           regardless of which section is expanded, so creating a meet
           or a standalone event never requires opening a section
           first. -->
      <div class="mgr-acc-toolbar">
        <button type="button" class="btn btn-primary btn-sm"
                v-tip:bottom.fixed="'Create a meet — a banner that bundles several events together'"
                @click="showCreateMeetModal = true">+ New meet</button>
        <button type="button" class="btn btn-primary btn-sm"
                v-tip:bottom.fixed="'Create a single standalone event (one discipline / height / category)'"
                @click="openCreateEvent('')">+ New event</button>
      </div>

      <!-- Each section = a meet (with "All events" / "Ungrouped"
           book-ends). The header toggles the section; expanding one
           reveals that selection's event list inline and collapses
           the rest. The body is authored once below and rendered
           only for the open section (expandedMeetId === sec.key). -->
      <div v-for="sec in accordionSections" :key="sec.key || 'all'"
           :class="['mgr-acc-section', { open: expandedMeetId === sec.key }]">
        <button type="button" class="mgr-acc-header"
                :aria-expanded="expandedMeetId === sec.key"
                @click="toggleSection(sec.key)">
          <span class="mgr-acc-chevron" aria-hidden="true">▸</span>
          <span class="mgr-acc-label">{{ sec.label }}<template v-if="sec.kind === 'meet' && auth.user?.is_system_admin && sec.country"> · {{ sec.country }}</template></span>
          <span class="mgr-acc-aside">
            <span v-if="sec.kind === 'meet' && sec.live" class="mgr-rail-live">· {{ sec.live }} live</span>
            <span class="mgr-rail-count">{{ sec.count }}</span>
          </span>
        </button>

        <!-- Expanded body: contextual actions + search/chips + the
             event list narrowed to this selection. -->
        <section v-if="expandedMeetId === sec.key" class="mgr-acc-body">
          <header class="mgr-acc-bodyhead">
            <div class="mgr-detail-head-text">
              <!-- A meet -->
              <div v-if="sec.kind === 'meet'" class="mgr-detail-sub">
                <span v-if="formatMeetDates(sec.meet)">{{ formatMeetDates(sec.meet) }}</span>
                <span v-if="sec.meet.venue">· {{ sec.meet.venue }}</span>
                <span>· {{ sec.meet.event_count }} event{{ sec.meet.event_count === 1 ? '' : 's' }}</span>
              </div>
              <!-- Ungrouped -->
              <div v-else-if="sec.kind === 'ungrouped'" class="mgr-detail-sub">
                <span>Standalone events not bundled into a meet.</span>
              </div>
              <!-- All events — sysadmin cross-org subcount + filter -->
              <template v-else>
                <div v-if="auth.user?.is_system_admin && events.length" class="mgr-detail-sub">
                  <span>{{ events.length }} across {{ uniqueOrgCount }} org{{ uniqueOrgCount === 1 ? '' : 's' }}</span>
                </div>
                <div v-if="auth.user?.is_system_admin && uniqueOrgs.length > 1" class="org-filter">
                  <label class="label">Filter by org</label>
                  <select class="select" v-model="orgFilter">
                    <option value="">All organisations ({{ events.length }})</option>
                    <option v-for="o in uniqueOrgs" :key="o.id" :value="o.id">
                      {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }} ({{ o.count }})
                    </option>
                  </select>
                </div>
              </template>
            </div>
            <!-- Meet sections get contextual actions (+ Add event
                 bundles into THIS meet, plus edit/delete). All-events
                 and Ungrouped rely on the toolbar's "+ New event". -->
            <div v-if="sec.kind === 'meet'" class="mgr-detail-actions">
              <button type="button" class="btn btn-primary btn-sm"
                      v-tip:bottom="'Create an event already bundled into this meet'"
                      @click="openCreateEvent(sec.meet.id)">+ Add event</button>
              <button type="button" class="btn btn-ghost btn-sm"
                      v-tip:bottom="'Review every event readiness blocker in this meet'"
                      @click="openMeetReadinessReport(sec.meet)">Readiness</button>
              <button type="button" class="btn btn-ghost btn-sm"
                      v-tip="$t('manager.modals.edit_meet_tip')"
                      @click="openEditMeet(sec.meet)">{{ $t('manager.modals.edit_label') }}</button>
              <button type="button" class="btn btn-ghost btn-sm"
                      @click="deleteMeet(sec.meet)">{{ $t('manager.modals.delete_label') }}</button>
            </div>
          </header>

        <!-- Search + status chips — filter within the current
             selection. Always visible so any view is searchable. -->
        <div class="events-toolbar">
          <input
            class="input events-search"
            type="search"
            v-model="eventSearch"
            placeholder="Search events…"
            aria-label="Search events"
          >
          <div class="events-status-chips">
            <button
              v-for="chip in STATUS_CHIPS"
              :key="chip.label"
              type="button"
              :class="['status-chip', { active: eventStatusFilter === chip.value }]"
              @click="eventStatusFilter = chip.value"
              v-tip:bottom="`Show ${chip.label.toLowerCase()} events`"
            >
              {{ chip.label }}
              <span class="status-chip-count">{{ statusChipCount(chip.value) }}</span>
            </button>
          </div>
        </div>

        <div class="events-list">
          <!-- First-visit empty state (no events at all). -->
          <div v-if="!events.length" class="empty-state-card">
            <div class="empty-state-icon">📅</div>
            <div class="empty-state-title">{{ $t('manager.empty_state_title') }}</div>
            <div class="empty-state-body">
              {{ $t('manager.empty_state_body') }}
            </div>
          </div>
          <!-- Selection has events globally but none match the
               current search/status/org filters. -->
          <div v-else-if="!displayedEvents.length && (eventSearch || eventStatusFilter || orgFilter)" class="empty">
            <span>No events match the current filters.</span>
            <button
              type="button"
              class="link-btn"
              @click="eventSearch = ''; eventStatusFilter = null; orgFilter = ''"
            >Clear filters</button>
          </div>
          <!-- Empty meet / ungrouped view (no filters active). -->
          <div v-else-if="!displayedEvents.length && selectedMeet" class="empty">
            <span>No events in this meet yet.</span>
            <button type="button" class="link-btn" @click="openCreateEvent(selectedMeet.id)">+ Add event</button>
          </div>
          <div v-else-if="!displayedEvents.length && selectedMeetId === 'ungrouped'" class="empty">
            <span>No ungrouped events — every event is filed under a meet.</span>
          </div>
          <div v-else-if="!displayedEvents.length" class="empty">
            <span>No events to show.</span>
          </div>
          <div v-for="ev in displayedEvents" :key="ev.id" class="event-item">
          <div style="flex:1;min-width:0">
            <div class="event-name">
              <StatusPill :status="ev.status" size="sm" />
              <span>{{ ev.name }}</span>
            </div>
            <div class="event-meta">
              <!-- Org badge — visible to sysadmin so they know
                   which federation each event belongs to. -->
              <span v-if="auth.user?.is_system_admin && ev.org_name" class="org-badge">
                {{ ev.org_name }}<span v-if="ev.country_code" class="org-badge-ctry">{{ ev.country_code }}</span>
              </span>
              <span v-if="ev.event_type === 'synchro_pair'" class="event-type-pill">Synchro</span>
              <span v-else-if="ev.event_type === 'team'" class="event-type-pill team">Team</span>
              <span v-if="ev.is_rehearsal"
                    class="event-type-pill rehearsal"
                    v-tip="'Dry-run event: no public archive, analytics, emails, or records'">
                Rehearsal
              </span>
              <!-- 🌐 International chip: visible when one or more
                   other federations are on the participating list.
                   Click jumps straight into the Federations modal. -->
              <button
                v-if="ev.participating_orgs_count > 0"
                type="button"
                class="event-type-pill intl-pill"
                @click.stop="openPartOrgsModal(ev)"
                v-tip="`${ev.participating_orgs_count} federation${ev.participating_orgs_count === 1 ? '' : 's'} invited — click to manage`"
              >🌐 International ({{ ev.participating_orgs_count }})</button>
              <!-- Format badges — distinguish prelim/semi/final
                   at a glance so an operator linking events can
                   find the right pair. -->
              <span v-if="ev.event_format === 'preliminary'" class="event-type-pill prelim">Prelim</span>
              <span v-else-if="ev.event_format === 'semifinal'" class="event-type-pill semi-pill">Semi-Final</span>
              <span v-else-if="ev.parent_event_id" class="event-type-pill final-pill">Final</span>
              <span v-if="ev.age_group" class="event-type-pill age">{{ ev.age_group }}</span>
              <span>{{ ev.gender }}</span><span>·</span>
              <span>{{ ev.number_of_judges }} Judges</span><span>·</span>
              <span>{{ ev.total_rounds }} Rounds</span>
              <template v-if="ev.height">
                <span>·</span><span>{{ HEIGHT_LABELS[ev.height] || ev.height }}</span>
              </template>
              <template v-if="ev.scheduled_at">
                <span>·</span><span>{{ new Date(ev.scheduled_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span>
              </template>
              <template v-if="ev.entries_close_at">
                <span>·</span>
                <span v-tip="`Entries close at ${new Date(ev.entries_close_at).toLocaleString()}`"
                      :style="{ color: new Date(ev.entries_close_at) <= new Date() ? 'var(--text-3)' : 'var(--cyan)' }">
                  {{ new Date(ev.entries_close_at) <= new Date() ? 'entries closed' : 'entries close ' + new Date(ev.entries_close_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
                </span>
              </template>
            </div>
          </div>
          <!-- Actions — restructured into:
                 [optional secondaries] [primary action] [⋯]
               so the operator sees ONE dominant call-to-action
               per event. Primary is status-aware:
                 Upcoming  → "Open Control Room →"  (drive pre-meet workflow)
                 Live      → "🔴 LIVE — Open"        (jump back into the meet)
                 Completed → "View Results"          (ghost; recap is the action)
               Edit / Audit Log / Import Roster / Delete demote
               into the ⋯ overflow menu so they don't compete
               with the primary affordance. -->
          <div class="actions">
            <!-- Status-aware primary action. Each path deep-
                 links into the screen the operator's most
                 likely to want next. -->
            <RouterLink v-if="ev.status === 'Upcoming'"
                        :to="`/control?event=${ev.id}`"
                        class="btn btn-primary btn-sm"
                        v-tip="'Open the Control Room with this event preselected — drive check-in, randomise, sign-off, and start the meet'">
              Open Control Room →
            </RouterLink>
            <RouterLink v-else-if="ev.status === 'Live'"
                        :to="`/control?event=${ev.id}`"
                        class="btn btn-live btn-sm"
                        v-tip="'Live — drop back into the Control Room'">
              🔴 LIVE — Open
            </RouterLink>
            <RouterLink v-else
                        :to="`/scoreboard/${ev.id}`"
                        class="btn btn-ghost btn-sm"
                        v-tip="'View the recap — podium, full standings, dive-by-dive'">
              View Results
            </RouterLink>
            <!-- ⋯ overflow — secondary maintenance actions the
                 operator only touches occasionally. Edit /
                 Audit Log / Import Roster / Delete all live
                 here so the row reads as a single primary
                 action at rest. -->
            <div class="dropdown-host">
              <button class="btn btn-ghost btn-sm btn-icon"
                      :aria-expanded="overflowOpenEventId === ev.id"
                      v-tip="'More actions'"
                      @click.stop="toggleOverflow(ev.id)">⋯</button>
              <div v-if="overflowOpenEventId === ev.id" class="event-overflow-menu">
                <!-- State-relevant actions for this event (seed / advance /
                     teams / view results), moved off the row so the
                     status-aware primary stands alone. Same conditions +
                     handlers as before — one click away in the menu. -->
                <button v-if="ev.event_type === 'team'"
                        class="dropdown-item"
                        @click="openTeamsModal(ev); overflowOpenEventId = null">Teams…</button>
                <button v-if="(ev.event_format === 'preliminary' || ev.event_format === 'semifinal')
                              && eventHasNextStage(ev)
                              && ev.status === 'Completed'"
                        class="dropdown-item"
                        @click="openAdvanceModal(ev); overflowOpenEventId = null"
                        v-tip="'Choose top N + reserves + dive order, preview the ranking, and seed the next stage'">
                  Advance to next stage →
                </button>
                <button v-if="ev.event_format === 'super_final_h2h' && ev.status === 'Upcoming'"
                        class="dropdown-item"
                        @click="superFinalModals?.openH2hModal(ev); overflowOpenEventId = null"
                        v-tip="`Seed the 6 H2H pairs from the Stop-1 ranking. ${RULE_REFERENCES.superFinalH2H}`">
                  🥊 Seed Head-to-Head
                </button>
                <button v-if="ev.event_format === 'super_final_h2h' && ev.status !== 'Upcoming'"
                        class="dropdown-item"
                        @click="superFinalModals?.openH2hResultsModal(ev); overflowOpenEventId = null"
                        v-tip="'See pair-by-pair winners — divers who advance to the Semi Final'">
                  View pair results
                </button>
                <button v-if="ev.event_format === 'super_final_semi' && ev.status === 'Upcoming'"
                        class="dropdown-item"
                        @click="superFinalModals?.openSfSeedModal(ev); overflowOpenEventId = null"
                        v-tip="`Seed the Semi Final from the 6 H2H winners. ${RULE_REFERENCES.superFinalSemi}`">
                  Seed Semi Final
                </button>
                <button v-if="ev.event_format === 'super_final_final' && ev.status === 'Upcoming'"
                        class="dropdown-item"
                        @click="superFinalModals?.openFSeedModal(ev); overflowOpenEventId = null"
                        v-tip="`Seed the Final with the top 2 from each SF group. ${RULE_REFERENCES.superFinalFinal}`">
                  Seed Final
                </button>
                <button v-if="ev.event_format === 'super_final_final' && ev.status === 'Completed'"
                        class="dropdown-item"
                        @click="superFinalModals?.openSuperFinalRankingsModal(ev); overflowOpenEventId = null"
                        v-tip="`Official Super Final rankings. ${RULE_REFERENCES.superFinalRankings}`">
                  View Super Final rankings
                </button>
                <!-- Host-side actions (event belongs to caller's
                     org or sysadmin). Visiting orgs see only the
                     "Withdraw participation" item since they
                     can't edit, delete, or import roster on a
                     foreign-hosted event. -->
                <template v-if="auth.user?.is_system_admin || ev.org_id === auth.user?.org_id">
                  <button class="dropdown-item"
                          @click="openEdit(ev); overflowOpenEventId = null">
                    Edit event
                  </button>
                  <RouterLink :to="`/events/${ev.id}/audit`"
                              class="dropdown-item">
                    Audit log
                  </RouterLink>
                  <button class="dropdown-item"
                          @click="openRosterImport(ev); overflowOpenEventId = null">
                    Import roster…
                  </button>
                  <button class="dropdown-item"
                          @click="openPartOrgsModal(ev); overflowOpenEventId = null"
                          v-tip="'Invite other federations\' divers to enter this event'">
                    Federations…
                  </button>
                  <button class="dropdown-item dropdown-item-danger"
                          @click="deleteEvent(ev.id); overflowOpenEventId = null">
                    Delete event
                  </button>
                </template>
                <template v-else>
                  <!-- Visiting federation overflow — single
                       destructive action: withdraw our
                       participation. The event belongs to a
                       different host so we can't edit or delete
                       it. -->
                  <div class="dropdown-item-static">
                    Hosted by {{ ev.org_name || 'another federation' }}
                  </div>
                  <button class="dropdown-item dropdown-item-danger"
                          @click="selfWithdrawFromEvent(ev); overflowOpenEventId = null"
                          v-tip="'Stop your divers entering this event. Existing entries stay intact.'">
                    Withdraw participation
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>
        </div>
        <!-- /events-list -->
        </section>
        <!-- /mgr-acc-body -->
      </div>
      <!-- /mgr-acc-section -->
    </div>
    <!-- /mgr-accordion -->
  </div>
  <!-- /main -->

  <!-- Edit modal -->
  <div v-if="showEditModal" class="mgr-form-page">
    <div class="mgr-form-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
        <h2 style="font-size:22px">{{ $t('manager.modals.edit_event_title') }}</h2>
        <button class="btn btn-ghost btn-sm" @click="showEditModal = false">{{ $t('manager.modals.cancel') }}</button>
      </div>
      <form @submit.prevent="saveEdit" class="form-stack">
        <div class="field">
          <label class="label">Event Name</label>
          <input class="input" v-model="editName" required>
        </div>
        <div class="field">
          <label class="label">Event Type</label>
          <select class="select" v-model="editType">
            <option value="individual">Individual</option>
            <option value="synchro_pair">Synchronised Pair</option>
            <option value="team">Team (World Aquatics)</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Gender Category</label>
          <select class="select" v-model="editGender">
            <option value="Female">Female</option>
            <option value="Male">Male</option>
            <option value="Mixed">Mixed</option>
          </select>
        </div>

        <!-- Structured Age Group / Division — mirrors the Create
             modal so an operator can change it post-event. -->
        <div class="field">
          <label class="label">Age Group / Division</label>
          <select class="select" v-model="editAgeChoice">
            <option value="">— Un-bracketed —</option>
            <optgroup label="Age Group (WA Article 13)">
              <option value="junior:D">Group D — 11 and under</option>
              <option value="junior:C">Group C — 12/13</option>
              <option value="junior:B">Group B — 14/15</option>
              <option value="junior:A">Group A — 16-18</option>
              <option value="age:masters">Masters (specify range)</option>
            </optgroup>
            <option value="open">Open</option>
            <option value="other">Other (custom)</option>
          </select>

          <input v-if="editAgeChoice === 'age:masters'"
                 class="input" v-model="editAgeMasters"
                 placeholder='Masters range — e.g. "30-34", "M40+", "70+"'
                 style="margin-top:0.5rem">
          <input v-if="editAgeChoice === 'other'" class="input"
                 v-model="editAgeOther"
                 placeholder='e.g. "Para Class S1", "Ex-Pat Open"'
                 style="margin-top:0.5rem">

          <p class="hint" v-if="editAgeGroup && !editAgeWouldRewrite" style="margin-top:0.4rem">
            Stored as <strong>{{ editAgeGroup }}</strong>.
          </p>
          <!-- Legacy-format warning. Surfaces when the event was
               saved with a pre-rework string ("11 and under" etc.)
               and saving now would silently rewrite the column to
               the new canonical "Junior Group X" form. Operator
               can either accept the migration or tick Keep legacy
               text to send the original string back verbatim.
               Hidden once the operator decides — `editAgeWouldRewrite`
               flips false when Keep legacy is checked. -->
          <div v-if="editAgeWouldRewrite" class="msg msg-warning age-legacy-warning"
               style="margin-top:0.5rem">
            <strong>Heads up — this event's age group is stored as
              <code>{{ editAgeOriginal }}</code></strong>.
            Saving as-is will rewrite the column to
            <code>{{ editAgeGroup }}</code> (same age band, new naming
            convention from the WA Article 13 rework). That can
            break any downstream report or saved filter that
            matches the old text.
            <label class="checkbox-row" style="margin-top:0.4rem">
              <input type="checkbox" v-model="editAgeKeepLegacy">
              Keep legacy text — save as <code>{{ editAgeOriginal }}</code>
            </label>
          </div>
          <p class="hint" v-else-if="editAgeKeepLegacy && editAgeWasLegacy"
             style="margin-top:0.4rem">
            Will keep stored as <strong>{{ editAgeOriginal }}</strong>
            (legacy format preserved).
          </p>
        </div>

        <div class="field">
          <label class="label">Board / Platform Height</label>
          <select class="select" v-model="editHeight" :disabled="editMixedHeight">
            <option value="">— Select Height —</option>
            <option value="0m">Poolside (0m)</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
          <label class="checkbox-row">
            <input type="checkbox" v-model="editMixedHeight">
            Mixed-board event
          </label>
        </div>
        <div class="field">
          <label class="label">Judge Panel Size</label>
          <select class="select" v-model="editJudges">
            <option v-if="editType !== 'synchro_pair'" value="3">3 Judges</option>
            <option v-if="editType !== 'synchro_pair'" value="5">5 Judges</option>
            <option value="7">7 Judges</option>
            <option value="9">9 Judges</option>
            <option value="11">11 Judges</option>
          </select>
        </div>
        <div class="field">
          <label class="checkbox-row">
            <input type="checkbox" v-model="editEnforceSignoff">
            Enforce referee sign-off
          </label>
          <p class="hint">
            When on, only the referee can sign off — via push, code,
            or credential entry.
          </p>
        </div>
        <div class="field">
          <label class="checkbox-row">
            <input type="checkbox" v-model="editIsRehearsal">
            Rehearsal / dry-run event
          </label>
          <p class="hint">
            Rehearsal scores do not publish to archive, analytics, emails, or records.
          </p>
        </div>
        <!-- Round dives — same editor as the New Event modal,
             pre-populated from /api/events/:id/round-dives so the
             operator can re-pin or unpin dives, add/remove rounds,
             or override per-slot board heights for mixed events. -->
        <RoundDivesEditor
          ref="editRoundDivesEditor"
          v-model="editRoundDives"
          :height="editHeight"
          :mixed-height="editMixedHeight"
          :dive-directory="diveDirectory"
          @request-new-dive="onRequestNewDive('edit', $event)"
        />

        <!-- Round structure (sections) — was missing from the
             Edit modal entirely; added in migration 039 alongside
             the prescribed-dives editor so an operator can change
             DD limits / min-distinct-groups after the fact. -->
        <div class="field rr-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round structure (optional)</span>
            <span v-if="editRoundSections.length" class="rr-total"
                  :class="{ 'rr-total-mismatch': editSectionsRoundsTotal !== editRoundDives.length }">
              {{ editSectionsRoundsTotal }} / {{ editRoundDives.length }} rounds
            </span>
          </label>
          <p class="hint" v-if="!editRoundSections.length" style="margin-bottom:0.5rem">
            Add a section to split the rounds into per-section DD
            sums or "different groups" rules.
          </p>
          <div v-for="(s, i) in editRoundSections" :key="i" class="rr-section">
            <div class="rr-section-row">
              <input class="input rr-label" type="text" v-model="s.label" placeholder="Section name (e.g. Voluntary)">
              <button type="button" class="btn btn-ghost btn-sm rr-remove"
                      @click="removeEditRoundSection(i)" v-tip="'Remove section'">✕</button>
            </div>
            <div class="rr-section-row">
              <label class="rr-cell">
                <span class="rr-cell-label">Rounds</span>
                <input class="input" type="number" min="1" max="12" v-model="s.rounds">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">DD limit (sum)</span>
                <input class="input" type="number" min="0" max="50" step="0.1"
                       v-model="s.dd_limit" placeholder="Unlimited">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">Min different groups</span>
                <input class="input" type="number" min="1" max="6"
                       v-model="s.min_distinct_groups" placeholder="—">
              </label>
            </div>
          </div>
          <div class="rr-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="addEditRoundSection()">
              + Add section
            </button>
          </div>
          <p class="hint hint-warn"
             v-if="editRoundSections.length && editSectionsRoundsTotal !== editRoundDives.length">
            Section round counts ({{ editSectionsRoundsTotal }}) don't match the
            event's total rounds ({{ editRoundDives.length }}).
          </p>
        </div>

        <!-- Entries-close deadline. Blank to clear, otherwise
             divers can't submit past this moment. -->
        <div class="field">
          <label class="label">Entries Close (optional)</label>
          <input class="input" type="datetime-local" v-model="editEntriesCloseAt">
          <p class="hint" v-if="editEntriesCloseAt">
            Divers can submit until this moment. Clear the field to re-open entries.
          </p>
          <p class="hint" v-else>
            No deadline set — entries close when the event goes Live.
          </p>
        </div>
        <div v-if="editErr" class="msg msg-error">{{ editErr }}</div>
        <button type="submit" class="btn btn-primary-lg">{{ $t('manager.modals.edit_event_submit') }}</button>
      </form>
    </div>
  </div>

  <!-- Create Dive sub-modal — opened from a round-dive picker
       when the operator types a search that doesn't match any
       existing directory entry. Mirrors the create form on
       /dive-directory but inline so the operator never leaves
       event creation. -->
  <div v-if="showCreateDiveModal" class="modal-backdrop"
       @click.self="closeCreateDiveModal" style="z-index:1100">
    <div class="modal modal-create-dive" @click.stop style="max-width:480px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
      <h2 style="font-size:20px">{{ $t('manager.modals.create_dive_title') }}</h2>
      <button class="btn btn-ghost btn-sm" @click="closeCreateDiveModal">{{ $t('manager.modals.cancel_x') }}</button>
    </div>
    <p class="hint" style="margin-bottom:1rem">
      The dive will be added to your federation's custom directory and
      become available to every event. Use the canonical World Aquatics dive
      code (e.g. <code>5132</code>) for cross-federation matching.
    </p>
    <form @submit.prevent="submitCreateDive" class="form-stack">
      <div class="field" style="display:flex;gap:0.5rem">
        <div style="flex:1">
          <label class="label">Dive Code</label>
          <input class="input" v-model="newDiveCode" placeholder="e.g. 5132" maxlength="6" required>
        </div>
        <div style="flex:1">
          <label class="label">Position</label>
          <select class="select" v-model="newDivePosition">
            <option value="A">A — Straight</option>
            <option value="B">B — Pike</option>
            <option value="C">C — Tuck</option>
            <option value="D">D — Free</option>
          </select>
        </div>
      </div>
      <div class="field" style="display:flex;gap:0.5rem">
        <div style="flex:1">
          <label class="label">Height</label>
          <select class="select" v-model="newDiveHeight">
            <option value="0m">0m — Poolside</option>
            <option value="1m">1m</option>
            <option value="3m">3m</option>
            <option value="5m">5m</option>
            <option value="7.5m">7.5m</option>
            <option value="10m">10m</option>
          </select>
        </div>
        <div style="flex:1">
          <label class="label">Degree of Difficulty (DD)</label>
          <input class="input" type="number" min="0.1" max="9.9" step="0.1"
                 v-model="newDiveDd" placeholder="e.g. 2.4" required>
        </div>
      </div>
      <div class="field">
        <label class="label">Description (optional)</label>
        <input class="input" v-model="newDiveDescription"
               placeholder="e.g. Forward 1½ Som with 1 Twist" maxlength="280">
      </div>
      <div v-if="newDiveErr" class="msg msg-error">{{ newDiveErr }}</div>
      <button type="submit" class="btn btn-primary" :disabled="newDiveBusy">
        {{ newDiveBusy ? $t('manager.modals.saving') : $t('manager.modals.create_dive_submit') }}
      </button>
    </form>
    </div>
  </div>

  <!-- New Meet modal — moved out of the inline page so the
       Meet Manager toolbar can offer "+ New Meet" alongside
       "+ New Event" without crowding the main column. -->
  <div v-if="showCreateMeetModal" class="mgr-form-page">
    <div class="mgr-form-card modal-create-meet" style="max-width:560px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:20px">{{ $t('manager.modals.new_meet_title') }}</h2>
        <button class="btn btn-ghost btn-sm" @click="showCreateMeetModal = false">{{ $t('manager.modals.cancel_x') }}</button>
      </div>
      <p class="hint" style="margin-bottom:1rem">
        A meet bundles one or more events under a single name —
        useful for multi-day championships. Leave standalone for
        one-off events.
      </p>
      <form @submit.prevent="createMeet" class="form-stack">
        <div class="field">
          <label class="label">Meet Name</label>
          <input class="input" v-model="meetForm.name" placeholder="e.g. 2026 National Open" required>
        </div>
        <div class="field">
          <label class="label">Venue (optional)</label>
          <input class="input" v-model="meetForm.venue" placeholder="e.g. Sydney Olympic Aquatic Centre">
        </div>
        <div class="field" style="display:flex;gap:0.5rem">
          <div style="flex:1">
            <label class="label">Start Date</label>
            <input class="input" type="date" v-model="meetForm.start_date">
          </div>
          <div style="flex:1">
            <label class="label">End Date</label>
            <input class="input" type="date" v-model="meetForm.end_date">
          </div>
        </div>
        <div v-if="meetFormErr" class="msg msg-error">{{ meetFormErr }}</div>
        <button type="submit" class="btn btn-primary">{{ $t('manager.modals.new_meet_submit') }}</button>
      </form>
    </div>
  </div>

  <!-- Edit Meet modal — name / dates / venue / description /
       sponsor branding incl. the multi-logo manager (migration
       045). Opened from the per-meet Edit button; openEditMeet
       fetches the full row first, then mounts the component with
       the hydrated form. `saved` triggers a meets reload. -->
  <EditMeetModal
    v-if="editingMeet"
    :meet-id="editingMeet.id"
    :initial-form="editingMeet.form"
    @close="editingMeet = null"
    @saved="loadMeets"
  />

  <!-- Advance to next stage modal — opens from the prelim/semi
       row's Completed-state action. Preview + confirm state live
       in the component; v-if mount re-fetches per open. A
       successful advance changes statuses/rosters server-side, so
       `advanced` triggers a full event reload. -->
  <AdvanceStageModal
    v-if="advanceModalEvent"
    :event="advanceModalEvent"
    @close="advanceModalEvent = null"
    @advanced="loadEvents"
  />

  <!-- Super Final modals (DWC 2026 Appendix 3). The five SF
       dialogs live in their own component; this view holds a
       template ref so the event-row buttons can call into them. -->
  <SuperFinalModals ref="superFinalModals" @refresh-events="loadEvents" />

  <!-- Meet readiness report — state + fetch live in the component;
       v-if mount re-fetches per open. -->
  <MeetReadinessModal
    v-if="readinessMeet"
    :meet="readinessMeet"
    @close="readinessMeet = null"
  />

  <!-- Team enrolment modal — lists + busy state live in the
       component; v-if mount re-fetches per open. -->
  <TeamsEnrolmentModal
    v-if="teamsModalEvent"
    :event="teamsModalEvent"
    @close="teamsModalEvent = null"
  />

  <!-- Participating-orgs modal — invite OTHER federations' divers
       to enter this event. List/invite state lives in the
       component; v-if mount re-fetches per open. `count-changed`
       keeps the row's 🌐 chip in sync without a full refetch. -->
  <ParticipatingOrgsModal
    v-if="partOrgsModalEvent"
    :event="partOrgsModalEvent"
    @close="partOrgsModalEvent = null"
    @count-changed="bumpParticipatingCount(partOrgsModalEvent.id, $event)"
  />

  <!-- Roster CSV import modal — state + handlers live in the
       component; v-if mount resets it per open. -->
  <RosterImportModal
    v-if="rosterModalEvent"
    :event="rosterModalEvent"
    @close="rosterModalEvent = null"
  />
</template>

<style scoped src="./ManagerView.css"></style>
