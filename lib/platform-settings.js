// Numeric platform knobs the sysadmin tunes at /admin/features
// (migration 089). Today that's the claim-vote rules from
// docs/club-first-onboarding.md §5 and §8.
//
// No cache: these are read when a claim opens, is voted on or swept,
// which is rare, and reading fresh means an edit applies to the next
// claim without a restart. A missing row falls back to the default here,
// and a value outside [min, max] is refused on write rather than clamped
// on read, so what the admin screen shows is what's in force.

const REGISTRY = {
  claim_voter_min_age_days: {
    label: "Club age to vote (days)",
    description: "A club only counts as a voter on a claim once it's been on DivingHQ this long.",
    default: 30, min: 0, max: 365, integer: true,
  },
  claim_voter_min_members: {
    label: "Members to vote",
    description: "...and it has at least this many email-verified members, or has hosted a meet.",
    default: 5, min: 0, max: 500, integer: true,
  },
  claim_quorum_min: {
    label: "Minimum voters",
    description: "Fewer eligible voters than this and the claim goes to the sysadmin instead. Also the fewest approvals that can pass a claim.",
    default: 2, min: 1, max: 50, integer: true,
  },
  claim_majority: {
    label: "Majority needed",
    description: "Approvals have to be more than this share of the eligible voters (0.5 = a simple majority).",
    default: 0.5, min: 0, max: 0.99, integer: false,
  },
  claim_timeout_days: {
    label: "Voting window (days)",
    description: "When it runs out: at least one approval and no objections passes the claim, otherwise it goes to the sysadmin.",
    default: 14, min: 1, max: 90, integer: true,
  },
};

async function getAll(db) {
  const r = await db.query("SELECT key, value FROM platform_settings");
  const stored = Object.fromEntries(r.rows.map((row) => [row.key, Number(row.value)]));
  const out = {};
  for (const [key, def] of Object.entries(REGISTRY)) {
    out[key] = Number.isFinite(stored[key]) ? stored[key] : def.default;
  }
  return out;
}

// For the admin screen: every knob with its label, bounds and value.
async function describeAll(db) {
  const values = await getAll(db);
  return Object.entries(REGISTRY).map(([key, def]) => ({
    key, label: def.label, description: def.description,
    min: def.min, max: def.max, integer: def.integer, default: def.default,
    value: values[key],
  }));
}

// Returns the stored number, or throws with a message fit for a 400.
async function set(db, key, value, userId) {
  const def = REGISTRY[key];
  if (!def) throw Object.assign(new Error("Unknown setting"), { status: 404 });
  const n = Number(value);
  if (!Number.isFinite(n) || n < def.min || n > def.max || (def.integer && !Number.isInteger(n))) {
    throw Object.assign(
      new Error(`${def.label} must be ${def.integer ? "a whole number" : "a number"} from ${def.min} to ${def.max}`),
      { status: 400 },
    );
  }
  await db.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, n, userId || null],
  );
  return n;
}

module.exports = { REGISTRY, getAll, describeAll, set };
