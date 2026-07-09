// Round-rules validator + helpers.
//
// Models the World Aquatics / Diving Australia "voluntary + optional"
// dive-sheet structure that real youth meets use:
//
//   "4 dives @ 7.6 + 4 dives unlimited" (8 rounds total)
//        └─ sum DD ≤ 7.6 across these 4 rounds, each from a
//           different group
//                              └─ no DD cap, but each from a
//                                 different group
//
// `events.round_rules` is a JSON column (migration 038) shaped:
//
//   {
//     "sections": [
//       { "label": "Voluntary",  "rounds": 4, "dd_limit": 7.6,
//         "min_distinct_groups": 4 },
//       { "label": "Optional",   "rounds": 4, "dd_limit": null,
//         "min_distinct_groups": 4 }
//     ]
//   }
//
// `min_distinct_groups` (1..6, optional): minimum number of World
// Aquatics dive groups (forward / back / reverse / inward / twist /
// armstand) that must appear across the section's dives.
// Independent of `rounds` so an operator can express things like
// "5 dives drawn from 4 different groups" (one group repeats) or
// "5 dives from 5 groups" (all distinct). Null / omitted means no
// group constraint.
//
// NULL round_rules → legacy (dd_limit_rounds + dd_limit_value)
// behaviour, validated separately. Populated → run through
// validateDiveList here.
//
// Functions exported:
//   * groupForDiveCode(code): 'forward' | 'back' | 'reverse'
//                             | 'inward' | 'twist' | 'armstand'
//   * validateRoundRules(rr, totalRounds): sanity-check the rules
//     themselves, returns {valid, error?}
//   * validateDiveList(rr, dives, dives_dd_by_round): check a
//     diver's submitted list, returns {valid, errors[]}.

const GROUPS = {
  "1": "forward",
  "2": "back",
  "3": "reverse",
  "4": "inward",
  "5": "twist",
  "6": "armstand",
};

const GROUP_LABELS = {
  forward:  "Forward",
  back:     "Back",
  reverse:  "Reverse",
  inward:   "Inward",
  twist:    "Twist",
  armstand: "Armstand",
};

// Pull the leading digit off a dive_code and map to a group
// name. Returns null on a code with a non-digit prefix or an
// out-of-range first digit.
function groupForDiveCode(code) {
  if (typeof code !== "string" || !code.length) return null;
  const c = code[0];
  return GROUPS[c] || null;
}

// Sanity-check the rule shape itself, catch the operator
// mis-configuring the event before any diver hit a confusing
// validation error during list submission.
function validateRoundRules(rr, totalRounds) {
  if (rr == null) return { valid: true };
  if (typeof rr !== "object" || !Array.isArray(rr.sections)) {
    return { valid: false, error: "round_rules must be { sections: [...] }" };
  }
  if (!rr.sections.length) {
    return { valid: false, error: "round_rules.sections must not be empty" };
  }
  let total = 0;
  for (let i = 0; i < rr.sections.length; i++) {
    const s = rr.sections[i];
    if (!s || typeof s !== "object") {
      return { valid: false, error: `Section ${i + 1}: not an object` };
    }
    if (!Number.isInteger(s.rounds) || s.rounds < 1) {
      return { valid: false, error: `Section ${i + 1}: rounds must be a positive integer` };
    }
    if (s.dd_limit != null) {
      const dd = Number(s.dd_limit);
      if (!Number.isFinite(dd) || dd <= 0 || dd > 50) {
        return { valid: false, error: `Section ${i + 1}: dd_limit must be a positive number ≤ 50` };
      }
    }
    if (s.label != null && typeof s.label !== "string") {
      return { valid: false, error: `Section ${i + 1}: label must be a string` };
    }
    if (s.min_distinct_groups != null) {
      const m = Number(s.min_distinct_groups);
      if (!Number.isInteger(m) || m < 1 || m > 6) {
        return { valid: false, error: `Section ${i + 1}: min_distinct_groups must be an integer 1–6` };
      }
      if (m > s.rounds) {
        return {
          valid: false,
          error: `Section ${i + 1}: min_distinct_groups (${m}) cannot exceed rounds (${s.rounds})`,
        };
      }
    }
    total += s.rounds;
  }
  if (totalRounds != null && total !== totalRounds) {
    return {
      valid: false,
      error: `Section round counts sum to ${total}, but the event has total_rounds = ${totalRounds}`,
    };
  }
  return { valid: true };
}

// Map round_number → section index. Returns -1 when the round
// falls outside any section (over-the-end roster).
function sectionForRound(rr, roundNumber) {
  let cursor = 0;
  for (let i = 0; i < rr.sections.length; i++) {
    cursor += rr.sections[i].rounds;
    if (roundNumber <= cursor) return i;
  }
  return -1;
}

/**
 * Validate a diver's submitted dive list against the event's
 * round_rules.
 *
 * @param {object|null} rr    the rules object (NULL = no structured
 *                            rules; pass the legacy validator separately)
 * @param {Array}       dives { round_number, dive_id, dd, dive_code }
 *                            per round
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDiveList(rr, dives) {
  if (rr == null) return { valid: true, errors: [] };
  const ruleCheck = validateRoundRules(rr);
  if (!ruleCheck.valid) {
    return { valid: false, errors: [`Event rules misconfigured: ${ruleCheck.error}`] };
  }

  const errors = [];

  // Bucket dives by section index based on round_number.
  const byRound = new Map();
  for (const d of dives) byRound.set(Number(d.round_number), d);

  for (let i = 0; i < rr.sections.length; i++) {
    const section = rr.sections[i];
    const label = section.label || `Section ${i + 1}`;
    // Find rounds that belong to this section.
    let cursorStart = 0;
    for (let k = 0; k < i; k++) cursorStart += rr.sections[k].rounds;
    const sectionDives = [];
    for (let r = 1; r <= section.rounds; r++) {
      const round = cursorStart + r;
      const d = byRound.get(round);
      if (d) sectionDives.push({ ...d, _round: round });
    }
    if (sectionDives.length < section.rounds) {
      errors.push(
        `${label}: ${sectionDives.length} of ${section.rounds} dives submitted`,
      );
      // Continue with the rules we CAN check on the rounds the
      // diver has so far, the operator might be staging a
      // partial save in a future flow.
    }

    // DD-sum constraint.
    if (section.dd_limit != null) {
      let sum = 0;
      for (const d of sectionDives) {
        const dd = Number(d.dd);
        if (Number.isFinite(dd)) sum += dd;
      }
      // 0.001 tolerance: DDs are stored as numeric(3,1) so the sum
      // should be exact, but this is defensive against bigint /
      // string cast quirks, just in case.
      if (sum > section.dd_limit + 0.001) {
        errors.push(
          `${label}: total DD ${sum.toFixed(1)} exceeds the ${section.dd_limit.toFixed(1)} limit`,
        );
      }
    }

    // Distinct-groups constraint. min_distinct_groups = N means
    // the section must collectively use at least N different
    // World Aquatics groups across its dives. N == rounds → "all dives
    // from different groups" (the classic World Aquatics voluntary rule).
    // N < rounds → "spread dives across at least N groups, but
    // some groups may repeat".
    if (section.min_distinct_groups != null && sectionDives.length) {
      const groups = new Set();
      for (const d of sectionDives) {
        const g = groupForDiveCode(d.dive_code);
        if (g) groups.add(g);
      }
      if (groups.size < section.min_distinct_groups) {
        errors.push(
          `${label}: needs ${section.min_distinct_groups} different groups, ${groups.size} used so far`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Convenience wrapper for callers that just want a yes/no.
function isDiveListValid(rr, dives) {
  return validateDiveList(rr, dives).valid;
}

module.exports = {
  GROUPS,
  GROUP_LABELS,
  groupForDiveCode,
  sectionForRound,
  validateRoundRules,
  validateDiveList,
  isDiveListValid,
};
