// Standard event templates: World Aquatics & common federation
// patterns shipped as static, code-defined defaults so every org
// gets the same canonical starting points.
//
// Each template has:
//   * name:        surfaces in the modal's template strip.
//   * description: one-line explanation of the rule shape.
//   * applies:     { gender, age_group } both optional. Filters
//                    which templates the modal surfaces given the
//                    operator's current Gender + Age Group choice.
//                    null/undefined match anything.
//   * config:      same shape as the saved-template `config`
//                    blob the manager already supports, so
//                    applyEventTemplate() handles it without
//                    code changes.
//
// Caveats this file is honest about: per-federation Junior
// conditions (DD caps, "voluntary + optional" splits) definately
// change year-to-year and per host federation. The shipped Junior
// templates reflect the World Aquatics structural rules
// (round counts + different-groups requirement). DD limits are
// left blank, operators add them per the bulletin in force.
//
// World Aquatics Senior conditions used as the source of truth:
//   * Men individual:   6 dives, 6 different World Aquatics groups (or
//                        5 + 1 free on springboard).
//   * Women individual: 5 dives, 5 different World Aquatics groups.
//   * Synchro:          first 2 voluntary @ DD 2.0, then 3 (W) or
//                        4 (M) optional.

// Helper: generate the section structure for a "voluntary + optional"
// synchro event. WA rule: first 2 dives at fixed 2.0 DD, remainder
// optional.
function synchroSections(totalRounds) {
  return {
    sections: [
      { label: 'Voluntary', rounds: 2, dd_limit: 4.0,  min_distinct_groups: 2 },
      { label: 'Optional',  rounds: totalRounds - 2, dd_limit: null, min_distinct_groups: totalRounds - 2 },
    ],
  }
}

const TEMPLATES = [
  // ─────────────────────────────────────────────────────────
  // SENIOR / OPEN: INDIVIDUAL EVENTS
  // ─────────────────────────────────────────────────────────
  {
    name: "Men's 1m Springboard — Senior Open",
    description: 'World Aquatics: 6 dives, 5 different groups, no DD limit.',
    applies: { gender: 'Male', age_group: 'Open' },
    config: {
      gender: 'Male', height: '1m',
      number_of_judges: 5, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Men's 3m Springboard — Senior Open",
    description: 'World Aquatics: 6 dives, 5 different groups, no DD limit.',
    applies: { gender: 'Male', age_group: 'Open' },
    config: {
      gender: 'Male', height: '3m',
      number_of_judges: 7, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Men's 10m Platform — Senior Open",
    description: 'World Aquatics: 6 dives, 6 different groups, no DD limit.',
    applies: { gender: 'Male', age_group: 'Open' },
    config: {
      gender: 'Male', height: '10m',
      number_of_judges: 7, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 6 },
        ],
      },
    },
  },
  {
    name: "Women's 1m Springboard — Senior Open",
    description: 'World Aquatics: 5 dives, 5 different groups, no DD limit.',
    applies: { gender: 'Female', age_group: 'Open' },
    config: {
      gender: 'Female', height: '1m',
      number_of_judges: 5, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Women's 3m Springboard — Senior Open",
    description: 'World Aquatics: 5 dives, 5 different groups, no DD limit.',
    applies: { gender: 'Female', age_group: 'Open' },
    config: {
      gender: 'Female', height: '3m',
      number_of_judges: 7, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Women's 10m Platform — Senior Open",
    description: 'World Aquatics: 5 dives, 5 different groups, no DD limit.',
    applies: { gender: 'Female', age_group: 'Open' },
    config: {
      gender: 'Female', height: '10m',
      number_of_judges: 7, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Open',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // SENIOR / OPEN: SYNCHRO EVENTS
  // First 2 dives @ DD 2.0 each (voluntary), remaining optional.
  // ─────────────────────────────────────────────────────────
  {
    name: "Men's 3m Synchro — Senior Open",
    description: '6 dives — 2 voluntary at DD 2.0, then 4 optional.',
    applies: { gender: 'Male', age_group: 'Open' },
    config: {
      gender: 'Male', height: '3m',
      number_of_judges: 11, total_rounds: 6,
      event_type: 'synchro_pair', event_format: 'final',
      age_group: 'Open',
      round_rules: synchroSections(6),
    },
  },
  {
    name: "Men's 10m Synchro — Senior Open",
    description: '6 dives — 2 voluntary at DD 2.0, then 4 optional.',
    applies: { gender: 'Male', age_group: 'Open' },
    config: {
      gender: 'Male', height: '10m',
      number_of_judges: 11, total_rounds: 6,
      event_type: 'synchro_pair', event_format: 'final',
      age_group: 'Open',
      round_rules: synchroSections(6),
    },
  },
  {
    name: "Women's 3m Synchro — Senior Open",
    description: '5 dives — 2 voluntary at DD 2.0, then 3 optional.',
    applies: { gender: 'Female', age_group: 'Open' },
    config: {
      gender: 'Female', height: '3m',
      number_of_judges: 11, total_rounds: 5,
      event_type: 'synchro_pair', event_format: 'final',
      age_group: 'Open',
      round_rules: synchroSections(5),
    },
  },
  {
    name: "Women's 10m Synchro — Senior Open",
    description: '5 dives — 2 voluntary at DD 2.0, then 3 optional.',
    applies: { gender: 'Female', age_group: 'Open' },
    config: {
      gender: 'Female', height: '10m',
      number_of_judges: 11, total_rounds: 5,
      event_type: 'synchro_pair', event_format: 'final',
      age_group: 'Open',
      round_rules: synchroSections(5),
    },
  },

  // ─────────────────────────────────────────────────────────
  // JUNIOR: GROUP A (16–18). Per WA Junior Championships,
  // structurally identical to Senior. Heads up: DD caps come from
  // the host federation's bulletin (Diving Australia, USA Diving,
  // etc.), adjust per current rules.
  // ─────────────────────────────────────────────────────────
  {
    name: "Boys 1m Springboard — Junior Group A (16-18)",
    description: 'WA Junior structure: 6 dives, 5 different groups. Add bulletin DD caps as needed.',
    applies: { gender: 'Male', age_group: 'Junior Group A' },
    config: {
      gender: 'Male', height: '1m',
      number_of_judges: 5, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Boys 3m Springboard — Junior Group A (16-18)",
    description: 'WA Junior structure: 6 dives, 5 different groups. Add bulletin DD caps as needed.',
    applies: { gender: 'Male', age_group: 'Junior Group A' },
    config: {
      gender: 'Male', height: '3m',
      number_of_judges: 7, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Boys 10m Platform — Junior Group A (16-18)",
    description: 'WA Junior structure: 6 dives, 6 different groups.',
    applies: { gender: 'Male', age_group: 'Junior Group A' },
    config: {
      gender: 'Male', height: '10m',
      number_of_judges: 7, total_rounds: 6,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 6, dd_limit: null, min_distinct_groups: 6 },
        ],
      },
    },
  },
  {
    name: "Girls 1m Springboard — Junior Group A (16-18)",
    description: 'WA Junior structure: 5 dives, 5 different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group A' },
    config: {
      gender: 'Female', height: '1m',
      number_of_judges: 5, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Girls 3m Springboard — Junior Group A (16-18)",
    description: 'WA Junior structure: 5 dives, 5 different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group A' },
    config: {
      gender: 'Female', height: '3m',
      number_of_judges: 7, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Girls 10m Platform — Junior Group A (16-18)",
    description: 'WA Junior structure: 5 dives, 5 different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group A' },
    config: {
      gender: 'Female', height: '10m',
      number_of_judges: 7, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group A',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // JUNIOR: GROUP B (14–15). Same structure as Group A, DD caps
  // tighter per host federation. Diving Australia 2024 pattern is
  // reflected in the canonical "4 @ 7.6 + 4 unlimited" youth
  // bulletin, see /events/295029.
  // ─────────────────────────────────────────────────────────
  {
    name: "Boys 1m Springboard — Junior Group B (14-15)",
    description: 'Group B structure: voluntary 4 @ 7.6 + 4 optional from different groups (Diving NSW pattern).',
    applies: { gender: 'Male', age_group: 'Junior Group B' },
    config: {
      gender: 'Male', height: '1m',
      number_of_judges: 5, total_rounds: 8,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group B',
      round_rules: {
        sections: [
          { label: 'Voluntary', rounds: 4, dd_limit: 7.6,  min_distinct_groups: 4 },
          { label: 'Optional',  rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },
  {
    name: "Girls 1m Springboard — Junior Group B (14-15)",
    description: 'Group B structure: voluntary 4 @ 7.6 + 4 optional from different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group B' },
    config: {
      gender: 'Female', height: '1m',
      number_of_judges: 5, total_rounds: 8,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group B',
      round_rules: {
        sections: [
          { label: 'Voluntary', rounds: 4, dd_limit: 7.6,  min_distinct_groups: 4 },
          { label: 'Optional',  rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },
  {
    name: "Boys 3m Springboard — Junior Group B (14-15)",
    description: 'Group B structure: voluntary 4 @ 7.6 + 4 optional from different groups.',
    applies: { gender: 'Male', age_group: 'Junior Group B' },
    config: {
      gender: 'Male', height: '3m',
      number_of_judges: 5, total_rounds: 8,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group B',
      round_rules: {
        sections: [
          { label: 'Voluntary', rounds: 4, dd_limit: 7.6,  min_distinct_groups: 4 },
          { label: 'Optional',  rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },
  {
    name: "Girls 3m Springboard — Junior Group B (14-15)",
    description: 'Group B structure: voluntary 4 @ 7.6 + 4 optional from different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group B' },
    config: {
      gender: 'Female', height: '3m',
      number_of_judges: 5, total_rounds: 8,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group B',
      round_rules: {
        sections: [
          { label: 'Voluntary', rounds: 4, dd_limit: 7.6,  min_distinct_groups: 4 },
          { label: 'Optional',  rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // JUNIOR: GROUP C (12–13). Reduced rounds, lower DD caps.
  // ─────────────────────────────────────────────────────────
  {
    name: "Boys 1m Springboard — Junior Group C (12-13)",
    description: 'Group C structure: 5 dives, 5 different groups. Operator sets DD caps per bulletin.',
    applies: { gender: 'Male', age_group: 'Junior Group C' },
    config: {
      gender: 'Male', height: '1m',
      number_of_judges: 5, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group C',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },
  {
    name: "Girls 1m Springboard — Junior Group C (12-13)",
    description: 'Group C structure: 5 dives, 5 different groups. Operator sets DD caps per bulletin.',
    applies: { gender: 'Female', age_group: 'Junior Group C' },
    config: {
      gender: 'Female', height: '1m',
      number_of_judges: 5, total_rounds: 5,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group C',
      round_rules: {
        sections: [
          { label: 'List', rounds: 5, dd_limit: null, min_distinct_groups: 5 },
        ],
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // JUNIOR: GROUP D (11 and under). Smaller still.
  // ─────────────────────────────────────────────────────────
  {
    name: "Boys 1m Springboard — Junior Group D (11 and under)",
    description: 'Group D entry-level: 4 dives across 4 different groups. Operator sets DD caps per bulletin.',
    applies: { gender: 'Male', age_group: 'Junior Group D' },
    config: {
      gender: 'Male', height: '1m',
      number_of_judges: 5, total_rounds: 4,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group D',
      round_rules: {
        sections: [
          { label: 'List', rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },
  {
    name: "Girls 1m Springboard — Junior Group D (11 and under)",
    description: 'Group D entry-level: 4 dives across 4 different groups.',
    applies: { gender: 'Female', age_group: 'Junior Group D' },
    config: {
      gender: 'Female', height: '1m',
      number_of_judges: 5, total_rounds: 4,
      event_type: 'individual', event_format: 'final',
      age_group: 'Junior Group D',
      round_rules: {
        sections: [
          { label: 'List', rounds: 4, dd_limit: null, min_distinct_groups: 4 },
        ],
      },
    },
  },
]

// Filter helper. Pass the operator's current Gender + Age Group
// selection; the modal narrows the list to templates that apply.
// 'Mixed' gender shows everything; an empty/unset age_group also
// shows everything so the operator sees what's available before
// committing to a category.
export function filterStandardTemplates({ gender, age_group }) {
  return TEMPLATES.filter((t) => {
    const a = t.applies || {}
    if (a.gender && gender && gender !== 'Mixed' && a.gender !== gender) return false
    if (a.age_group && age_group && a.age_group !== age_group) return false
    return true
  })
}

export const STANDARD_TEMPLATES = TEMPLATES
