// Shape helpers for the Meet Manager's event forms (Create wizard + Edit).
//
// Both forms edit the same two lists, the round-structure sections
// (migration 038) and the prescribed round dives (migration 039), and each
// used to carry its own copy of the hydrate / blank-slot / payload code.
// The copies had already started to drift (one blank slot was missing
// _meta), so they live here now and both forms plus RoundDivesEditor call
// the same functions. Pure, so test/event-form.test.js covers them without
// a browser.
//
// The payload coercions are deliberately byte-for-byte what the forms sent
// before (parseInt, toFixed(1), `|| null`), the server validates against
// exactly this shape in lib/round-rules.js.

// Section rows as the form edits them: strings for the number inputs, ''
// meaning "no limit".
export function newRoundSection(existingCount) {
  return {
    label: existingCount === 0 ? 'Voluntary' : 'Optional',
    rounds: 4,
    dd_limit: '',                     // '' = unlimited
    min_distinct_groups: '',          // '' = no group constraint
  }
}

export function roundSectionsTotal(sections) {
  return sections.reduce((sum, s) => sum + (parseInt(s.rounds) || 0), 0)
}

// events.round_rules (or a template's) -> editable section rows. Anything
// that isn't { sections: [...] } means "no structure", i.e. [].
export function sectionsFromRoundRules(rr) {
  if (!rr || !Array.isArray(rr.sections)) return []
  return rr.sections.map((s) => ({
    label: s.label || '',
    rounds: s.rounds,
    dd_limit: s.dd_limit == null ? '' : String(s.dd_limit),
    min_distinct_groups: s.min_distinct_groups == null ? '' : String(s.min_distinct_groups),
  }))
}

// Editable section rows -> the round_rules body. An empty list is null so
// the event falls back to the flat dd_limit_* pair.
export function roundRulesFromSections(sections) {
  if (!sections.length) return null
  return {
    sections: sections.map((s) => ({
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

// One free round slot (diver's choice, event height). _label and _meta are
// the picker's display state, RoundDivesEditor fills them when a dive is
// pinned.
export function blankRoundSlot() {
  return { dive_id: null, height: null, _label: '', _meta: null }
}

export function blankRoundSlots(n) {
  return Array.from({ length: n || 0 }, blankRoundSlot)
}

// Round slots -> the round_dives body, one entry per round in order.
export function roundDivesPayload(slots) {
  return slots.map((slot, i) => ({
    round_number: i + 1,
    dive_id: slot.dive_id || null,
    height: slot.height == null || slot.height === ''
      ? null
      : Number(slot.height),
  }))
}
