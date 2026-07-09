// Round-rules validator + helpers (SPA-side ESM mirror).
//
// Functionally identical to /lib/round-rules.js (CommonJS, used by
// the server). We keep two files instead of one because Vite's @
// alias resolves to /src/ and cross-tree CommonJS imports are
// fragile through Vite's interop. Behaviour MUST stay in sync,
// so any change here needs the same edit in /lib/round-rules.js
// (easy to forget, heads up).
//
// See the server module for the full prose docs on the data shape
// and design rationale.

const GROUPS = {
  '1': 'forward',
  '2': 'back',
  '3': 'reverse',
  '4': 'inward',
  '5': 'twist',
  '6': 'armstand',
}

export const GROUP_LABELS = {
  forward:  'Forward',
  back:     'Back',
  reverse:  'Reverse',
  inward:   'Inward',
  twist:    'Twist',
  armstand: 'Armstand',
}

export function groupForDiveCode(code) {
  if (typeof code !== 'string' || !code.length) return null
  return GROUPS[code[0]] || null
}

export function validateRoundRules(rr, totalRounds) {
  if (rr == null) return { valid: true }
  if (typeof rr !== 'object' || !Array.isArray(rr.sections)) {
    return { valid: false, error: 'round_rules must be { sections: [...] }' }
  }
  if (!rr.sections.length) {
    return { valid: false, error: 'round_rules.sections must not be empty' }
  }
  let total = 0
  for (let i = 0; i < rr.sections.length; i++) {
    const s = rr.sections[i]
    if (!s || typeof s !== 'object') {
      return { valid: false, error: `Section ${i + 1}: not an object` }
    }
    if (!Number.isInteger(s.rounds) || s.rounds < 1) {
      return { valid: false, error: `Section ${i + 1}: rounds must be a positive integer` }
    }
    if (s.dd_limit != null) {
      const dd = Number(s.dd_limit)
      if (!Number.isFinite(dd) || dd <= 0 || dd > 50) {
        return { valid: false, error: `Section ${i + 1}: dd_limit must be a positive number ≤ 50` }
      }
    }
    if (s.label != null && typeof s.label !== 'string') {
      return { valid: false, error: `Section ${i + 1}: label must be a string` }
    }
    if (s.min_distinct_groups != null) {
      const m = Number(s.min_distinct_groups)
      if (!Number.isInteger(m) || m < 1 || m > 6) {
        return { valid: false, error: `Section ${i + 1}: min_distinct_groups must be an integer 1–6` }
      }
      if (m > s.rounds) {
        return {
          valid: false,
          error: `Section ${i + 1}: min_distinct_groups (${m}) cannot exceed rounds (${s.rounds})`,
        }
      }
    }
    total += s.rounds
  }
  if (totalRounds != null && total !== totalRounds) {
    return {
      valid: false,
      error: `Section round counts sum to ${total}, but the event has total_rounds = ${totalRounds}`,
    }
  }
  return { valid: true }
}

export function sectionForRound(rr, roundNumber) {
  let cursor = 0
  for (let i = 0; i < rr.sections.length; i++) {
    cursor += rr.sections[i].rounds
    if (roundNumber <= cursor) return i
  }
  return -1
}

export function validateDiveList(rr, dives) {
  if (rr == null) return { valid: true, errors: [] }
  const ruleCheck = validateRoundRules(rr)
  if (!ruleCheck.valid) {
    return { valid: false, errors: [`Event rules misconfigured: ${ruleCheck.error}`] }
  }

  const errors = []
  const byRound = new Map()
  for (const d of dives) byRound.set(Number(d.round_number), d)

  for (let i = 0; i < rr.sections.length; i++) {
    const section = rr.sections[i]
    const label = section.label || `Section ${i + 1}`
    let cursorStart = 0
    for (let k = 0; k < i; k++) cursorStart += rr.sections[k].rounds
    const sectionDives = []
    for (let r = 1; r <= section.rounds; r++) {
      const round = cursorStart + r
      const d = byRound.get(round)
      if (d) sectionDives.push({ ...d, _round: round })
    }
    if (sectionDives.length < section.rounds) {
      errors.push(
        `${label}: ${sectionDives.length} of ${section.rounds} dives submitted`,
      )
    }

    if (section.dd_limit != null) {
      let sum = 0
      for (const d of sectionDives) {
        const dd = Number(d.dd)
        if (Number.isFinite(dd)) sum += dd
      }
      if (sum > section.dd_limit + 0.001) {
        errors.push(
          `${label}: total DD ${sum.toFixed(1)} exceeds the ${section.dd_limit.toFixed(1)} limit`,
        )
      }
    }

    if (section.min_distinct_groups != null && sectionDives.length) {
      const groups = new Set()
      for (const d of sectionDives) {
        const g = groupForDiveCode(d.dive_code)
        if (g) groups.add(g)
      }
      if (groups.size < section.min_distinct_groups) {
        errors.push(
          `${label}: needs ${section.min_distinct_groups} different groups, ${groups.size} used so far`,
        )
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

export function isDiveListValid(rr, dives) {
  return validateDiveList(rr, dives).valid
}
