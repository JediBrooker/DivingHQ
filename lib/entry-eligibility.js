// Who may be entered in an event: the event's gender and age group
// against the diver's profile.
//
// Every path that puts a diver on an event's roster asks this one
// function (lib/dive-list-submit.js for the diver's own and the coach's
// submit, routes/control-room.js for the late-entry add and the CSV
// import), and the pickers that offer divers or events ask it too
// (GET /api/events for the Dive Sheets list, GET /api/orgs/:id/divers for
// the late-entry picker, GET /api/coach/dive-lists/:event_id), so what a
// screen hides is exactly what the server would refuse. Before this a
// male senior could be entered in a Women's 10m Platform and score 200.
//
// World Aquatics Competition Regulations, in force February 2026
// (docs/2026-02-18_World-Aquatics_CR-Final.pdf), PART FOUR Diving Rules:
//
//   Article 1.8     age "is determined by the age of the Athlete on 31
//                   December in the year of the start date of the relevant
//                   competition", so the age check never looks at the
//                   diver's birthday itself, only the birth year against
//                   the competition year.
//   Article 13.2.1  Age Group B: fourteen or fifteen on that date.
//   Article 13.2.2  Age Group A: sixteen, seventeen or eighteen.
//   Article 13.3.1  Age Group C: twelve or thirteen (federation events).
//   Article 13.3    federations may adopt their own groups; Group D
//                   (11 and under) is the common national extension and
//                   the Meet Manager offers it.
//
// PART EIGHT Masters Diving Rules, Article 4.3.1: masters are 25 or older,
// in five-year groups from 25-29 upwards. Article 4.1 of that Part applies
// the Part Four rules, so the 31 December rule holds there too.
//
// events.age_group is free text (varchar 40). The Meet Manager writes
// "Open", "Junior Group A".."D", "Masters" or "Masters 30-34", and older
// rows carry "16-18", "14/15", "12/13", "11 and under" or anything an
// operator typed. parseAgeGroup turns the forms it recognises into a
// bracket; anything else means no age check, since refusing everyone
// over a label nobody can parse is worse than the old behaviour.
//
// The competition year is the event's scheduled_at, else its meet's start
// date, else today. The checks run in UTC like lib/direct-use-age.js.

const PROFILE_GENDERS = ["female", "male", "other", "prefer_not_to_say"];

const WA_AGE_RULE_REF = "WA Article 1.8 (age on 31 December of the competition year)";

// users.gender is free text: the forms write the lowercase values above,
// the admin drawer and older imports may have "Male" / "F". Anything that
// is a word but not male or female is "other"; empty is null (unknown).
function normaliseGender(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (v === "male" || v === "m" || v === "man" || v === "men" || v === "boy") return "male";
  if (v === "female" || v === "f" || v === "woman" || v === "women" || v === "girl") return "female";
  return "other";
}

// The event_gender enum is 'Male' | 'Female' | 'Mixed'.
function eventGenderNeeds(eventGender) {
  const g = String(eventGender || "").trim().toLowerCase();
  if (g === "male") return "male";
  if (g === "female") return "female";
  return null; // Mixed, or unset: any gender
}

// The WA junior groups (Article 13) plus the national Group D.
const JUNIOR_GROUPS = {
  A: { min: 16, max: 18, label: "Age Group A (16-18)", ref: "WA Article 13.2.2" },
  B: { min: 14, max: 15, label: "Age Group B (14-15)", ref: "WA Article 13.2.1" },
  C: { min: 12, max: 13, label: "Age Group C (12-13)", ref: "WA Article 13.3.1" },
  D: { min: null, max: 11, label: "Age Group D (11 and under)", ref: "WA Article 13.3 (federation age groups)" },
};
const MASTERS_MIN_AGE = 25;
const MASTERS_REF = "WA Masters Diving Rules Article 4.3.1";

// A bracket is { min, max, label, ref } with null for an open end, or
// null when the string carries no age rule we recognise.
function parseAgeGroup(ageGroup) {
  const raw = String(ageGroup == null ? "" : ageGroup).trim();
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === "open" || v === "senior" || v === "seniors") return null;

  let m = v.match(/^(?:junior group|junior:|group)\s*([a-e])$/);
  if (m) return JUNIOR_GROUPS[m[1].toUpperCase()] || null;

  m = v.match(/^masters?(?:\s+(.*))?$/);
  if (m) {
    const rest = (m[1] || "").trim();
    if (!rest) return { min: MASTERS_MIN_AGE, max: null, label: "Masters (25 and over)", ref: MASTERS_REF };
    const range = rest.match(/^(\d{1,3})\s*[-–/]\s*(\d{1,3})$/);
    if (range) {
      const lo = Number(range[1]), hi = Number(range[2]);
      if (lo <= hi) return { min: lo, max: hi, label: `Masters ${lo}-${hi}`, ref: MASTERS_REF };
    }
    const plus = rest.match(/^(\d{1,3})\s*\+$/);
    if (plus) return { min: Number(plus[1]), max: null, label: `Masters ${plus[1]}+`, ref: MASTERS_REF };
    return { min: MASTERS_MIN_AGE, max: null, label: "Masters (25 and over)", ref: MASTERS_REF };
  }

  // "16-18", "14/15", "12 - 13"
  m = v.match(/^(\d{1,3})\s*[-–/]\s*(\d{1,3})$/);
  if (m) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo > hi) return null;
    return { min: lo, max: hi, label: `${lo}-${hi}`, ref: WA_AGE_RULE_REF };
  }
  // "11 and under", "11 & under", "11 or under"
  m = v.match(/^(\d{1,3})\s*(?:and|&|or)\s*(?:under|younger|below)$/);
  if (m) return { min: null, max: Number(m[1]), label: `${m[1]} and under`, ref: WA_AGE_RULE_REF };
  // "U14", "U-14", "Under 14": younger than 14
  m = v.match(/^(?:u|u-|under\s*)(\d{1,3})$/);
  if (m) {
    const n = Number(m[1]);
    return { min: null, max: n - 1, label: `Under ${n}`, ref: WA_AGE_RULE_REF };
  }
  // "18+", "18 and over", "18 and older"
  m = v.match(/^(\d{1,3})\s*(?:\+|(?:and|&|or)\s*(?:over|older|above))$/);
  if (m) return { min: Number(m[1]), max: null, label: `${m[1]} and over`, ref: WA_AGE_RULE_REF };

  return null;
}

// YYYY-MM-DD, or a Date (pg hands DATE columns back as a Date at local
// midnight unless the query casts them, so take both).
function birthYear(dob) {
  if (dob instanceof Date) return Number.isNaN(dob.getTime()) ? null : dob.getFullYear();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob || ""));
  return m ? Number(m[1]) : null;
}

// The year whose 31 December the age is taken on (Article 1.8).
function competitionYear(event, now = new Date()) {
  for (const v of [event?.scheduled_at, event?.meet_start_date]) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isNaN(d.getTime())) return d.getUTCFullYear();
  }
  return now.getUTCFullYear();
}

function ageOn31December(dob, year) {
  const by = birthYear(dob);
  return by == null ? null : year - by;
}

function genderWord(g) {
  return g === "male" ? "men's" : "women's";
}

// Who the message is about: the diver themselves on Dive Sheets ("your
// profile"), a named diver when a coach or the Control Room enters them.
function subject(diver) {
  const name = diver?.full_name && String(diver.full_name).trim();
  return name
    ? { their: `${name}'s`, theyAre: `${name} is`, fix: "Add it under Competition details on their profile." }
    : { their: "your", theyAre: "you are", fix: "Add it under Competition details on My Profile." };
}

// Result: { allowed: true, code: null, reason: null }
//      or { allowed: false, code, reason } with code one of
//      'missing_gender' | 'gender' | 'missing_dob' | 'too_young' | 'too_old'.
function checkEntryEligibility({ event, diver, now = new Date() }) {
  const s = subject(diver);
  const needs = eventGenderNeeds(event?.gender);
  if (needs) {
    const has = normaliseGender(diver?.gender);
    if (!has) {
      return {
        allowed: false,
        code: "missing_gender",
        reason: `This is a ${genderWord(needs)} event and ${s.their} profile has no gender. ${s.fix}`,
      };
    }
    if (has !== needs) {
      return {
        allowed: false,
        code: "gender",
        reason: `This is a ${genderWord(needs)} event; ${s.their} profile says ${has}.`,
      };
    }
  }

  const bracket = parseAgeGroup(event?.age_group);
  if (bracket) {
    const year = competitionYear(event, now);
    const age = ageOn31December(diver?.date_of_birth, year);
    if (age == null) {
      return {
        allowed: false,
        code: "missing_dob",
        reason: `This event is for ${bracket.label} and ${s.their} profile has no date of birth. ${s.fix}`,
      };
    }
    const outside = (bracket.min != null && age < bracket.min) ? "too_young"
      : (bracket.max != null && age > bracket.max) ? "too_old" : null;
    if (outside) {
      return {
        allowed: false,
        code: outside,
        reason: `This event is for ${bracket.label}; ${s.theyAre} ${age} on 31 December ${year} `
          + `(${bracket.ref}; ${WA_AGE_RULE_REF}).`,
      };
    }
  }
  return { allowed: true, code: null, reason: null };
}

// The 400 every entry path answers with. `code: 'ineligible'` for the
// SPA, the finer code alongside.
function ineligibleError(result) {
  const err = new Error(result.reason);
  err.status = 400;
  err.code = "ineligible";
  err.eligibility_code = result.code;
  return err;
}

// The profile fields the check reads, for a set of users. DATE comes back
// as text so the year is the one that was typed, not a timezone's.
async function loadEntryProfiles(db, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const r = await db.query(
    `SELECT id, full_name, gender, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth
       FROM users WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  for (const row of r.rows) out.set(row.id, row);
  return out;
}

// Check one or more divers against an event, throwing the 400 for the
// first who can't enter. `event` needs gender, age_group, scheduled_at
// (and meet_start_date when the caller has it). `selfId` is the caller
// when they're entering themselves, so their own refusal reads "your
// profile" while a partner's or a coached diver's is named.
async function assertEligible(db, event, userIds, { now, selfId = null } = {}) {
  const profiles = await loadEntryProfiles(db, userIds);
  for (const id of userIds || []) {
    if (!id) continue;
    const profile = profiles.get(id) || { id };
    const diver = id === selfId ? { ...profile, full_name: null } : profile;
    const result = checkEntryEligibility({ event, diver, now });
    if (!result.allowed) throw ineligibleError(result);
  }
}

// The SELECT fragment for an event row the check can read.
const EVENT_ELIGIBILITY_COLUMNS = "e.gender, e.age_group, e.scheduled_at, m.start_date AS meet_start_date";

module.exports = {
  PROFILE_GENDERS,
  normaliseGender,
  parseAgeGroup,
  competitionYear,
  ageOn31December,
  checkEntryEligibility,
  ineligibleError,
  loadEntryProfiles,
  assertEligible,
  EVENT_ELIGIBILITY_COLUMNS,
};
