// lib/entry-eligibility.js without a database: the age-group parser,
// the 31 December rule (WA Part Four Article 1.8), the Article 13 groups,
// Masters (Part Eight 4.3.1), gender matching, and what a missing date of
// birth or gender does. The shared validation in lib/account-rules.js
// rides along since signup, the admin drawer and PUT /api/users/me/details
// all lean on it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAgeGroup, checkEntryEligibility, competitionYear, ageOn31December, normaliseGender,
  ineligibleError,
} = require("../lib/entry-eligibility");
const { dateOfBirthError, genderError } = require("../lib/account-rules");

const now = new Date("2026-10-17T12:00:00Z");
const check = (event, diver) => checkEntryEligibility({ event, diver, now });

test("parseAgeGroup: the Meet Manager's forms and the legacy strings", () => {
  assert.deepEqual(parseAgeGroup("Junior Group A"), { min: 16, max: 18, label: "Age Group A (16-18)", ref: "WA Article 13.2.2" });
  assert.equal(parseAgeGroup("junior:B").min, 14);
  assert.equal(parseAgeGroup("junior:B").max, 15);
  assert.deepEqual([parseAgeGroup("Group C").min, parseAgeGroup("Group C").max], [12, 13]);
  assert.deepEqual([parseAgeGroup("Junior Group D").min, parseAgeGroup("Junior Group D").max], [null, 11]);
  // legacy stored values ManagerView still decomposes
  assert.deepEqual([parseAgeGroup("16-18").min, parseAgeGroup("16-18").max], [16, 18]);
  assert.deepEqual([parseAgeGroup("14/15").min, parseAgeGroup("14/15").max], [14, 15]);
  assert.deepEqual([parseAgeGroup("11 and under").min, parseAgeGroup("11 and under").max], [null, 11]);
  assert.deepEqual([parseAgeGroup("U14").min, parseAgeGroup("U14").max], [null, 13]);
  assert.deepEqual([parseAgeGroup("Under 12").min, parseAgeGroup("Under 12").max], [null, 11]);
  assert.deepEqual([parseAgeGroup("18+").min, parseAgeGroup("18+").max], [18, null]);
  // Masters: 25+, five-year groups (Part Eight 4.3.1)
  assert.deepEqual([parseAgeGroup("Masters").min, parseAgeGroup("Masters").max], [25, null]);
  assert.deepEqual([parseAgeGroup("Masters 30-34").min, parseAgeGroup("Masters 30-34").max], [30, 34]);
  assert.deepEqual([parseAgeGroup("Masters 80+").min, parseAgeGroup("Masters 80+").max], [80, null]);
});

test("parseAgeGroup: open and unknown labels mean no age check", () => {
  for (const v of [null, undefined, "", "  ", "Open", "open", "Senior", "Elite", "Group E", "Novice"]) {
    assert.equal(parseAgeGroup(v), null, String(v));
  }
});

test("competitionYear: scheduled_at, then the meet's start date, then today", () => {
  assert.equal(competitionYear({ scheduled_at: "2027-01-03T09:00:00Z" }, now), 2027);
  assert.equal(competitionYear({ scheduled_at: null, meet_start_date: "2025-12-31" }, now), 2025);
  assert.equal(competitionYear({ scheduled_at: new Date("2024-06-01T00:00:00Z") }, now), 2024);
  assert.equal(competitionYear({}, now), 2026);
  assert.equal(competitionYear({ scheduled_at: "garbage" }, now), 2026);
});

test("age is the age on 31 December of the competition year (Article 1.8), not the birthday", () => {
  // Born 20 Dec 2010: 15 for the whole of a 2026 competition even in October.
  assert.equal(ageOn31December("2010-12-20", 2026), 16);
  assert.equal(ageOn31December("2010-01-01", 2026), 16);
  assert.equal(ageOn31December(new Date(2010, 11, 20), 2026), 16);
  assert.equal(ageOn31December(null, 2026), null);
  assert.equal(ageOn31December("", 2026), null);
});

test("Age Group B takes 14 and 15 on 31 December, refuses 13 and 16", () => {
  const ev = { gender: "Mixed", age_group: "Junior Group B", scheduled_at: "2026-11-20T10:00:00Z" };
  assert.equal(check(ev, { gender: "female", date_of_birth: "2012-12-31" }).allowed, true);  // 14
  assert.equal(check(ev, { gender: "female", date_of_birth: "2011-01-01" }).allowed, true);  // 15
  const young = check(ev, { gender: "male", date_of_birth: "2013-01-01" });                   // 13
  assert.equal(young.allowed, false);
  assert.equal(young.code, "too_young");
  assert.match(young.reason, /Age Group B \(14-15\)/);
  assert.match(young.reason, /you are 13 on 31 December 2026/);
  assert.match(young.reason, /13\.2\.1/);
  const old = check(ev, { full_name: "Tom Lee", gender: "male", date_of_birth: "2010-06-30" });  // 16
  assert.equal(old.code, "too_old");
  assert.match(old.reason, /Tom Lee is 16 on 31 December 2026/);
});

test("the competition year moves the bracket: a January event uses that year", () => {
  const diver = { gender: "female", date_of_birth: "2008-03-01" };
  // 18 in 2026, 19 in 2027.
  assert.equal(check({ gender: "Female", age_group: "Junior Group A", scheduled_at: "2026-12-30T10:00:00Z" }, diver).allowed, true);
  assert.equal(check({ gender: "Female", age_group: "Junior Group A", scheduled_at: "2027-01-02T10:00:00Z" }, diver).code, "too_old");
});

test("gender: a women's event takes female only, a men's event male only, mixed anyone", () => {
  const women = { gender: "Female", age_group: "Open" };
  assert.equal(check(women, { gender: "female" }).allowed, true);
  assert.equal(check(women, { gender: "Female" }).allowed, true);
  assert.equal(check(women, { gender: "F" }).allowed, true);
  const man = check(women, { gender: "male" });
  assert.equal(man.allowed, false);
  assert.equal(man.code, "gender");
  assert.match(man.reason, /women's event; your profile says male/);
  assert.equal(check(women, { gender: "other" }).code, "gender");
  assert.equal(check(women, { gender: "prefer_not_to_say" }).code, "gender");
  assert.equal(check({ gender: "Male" }, { gender: "male" }).allowed, true);
  assert.equal(check({ gender: "Male" }, { gender: "female" }).code, "gender");
  for (const g of ["male", "female", "other", null]) {
    assert.equal(check({ gender: "Mixed", age_group: "Open" }, { gender: g }).allowed, true, String(g));
  }
});

test("missing profile fields refuse with where to add them, never silently allow", () => {
  const noGender = check({ gender: "Female" }, { gender: null });
  assert.equal(noGender.allowed, false);
  assert.equal(noGender.code, "missing_gender");
  assert.match(noGender.reason, /your profile has no gender/);
  assert.match(noGender.reason, /Competition details on My Profile/);
  const named = check({ gender: "Male" }, { full_name: "Ana Diaz", gender: "" });
  assert.match(named.reason, /Ana Diaz's profile has no gender/);
  assert.match(named.reason, /on their profile/);

  const noDob = check({ gender: "Mixed", age_group: "Junior Group C" }, { gender: "male", date_of_birth: null });
  assert.equal(noDob.code, "missing_dob");
  assert.match(noDob.reason, /Age Group C \(12-13\)/);
  assert.match(noDob.reason, /no date of birth/);
});

test("open or un-bracketed events skip the age check even with no date of birth", () => {
  assert.equal(check({ gender: "Mixed", age_group: "Open" }, {}).allowed, true);
  assert.equal(check({ gender: "Mixed", age_group: null }, {}).allowed, true);
  assert.equal(check({ gender: "Female", age_group: "Open" }, { gender: "female" }).allowed, true);
  // an age group nobody can parse is no age rule, not a refusal of everyone
  assert.equal(check({ gender: "Mixed", age_group: "Elite" }, { gender: "male" }).allowed, true);
});

test("gender is checked before age, so a wrong-gender entry names the gender", () => {
  const r = check({ gender: "Female", age_group: "Junior Group A", scheduled_at: "2026-05-05T00:00:00Z" },
    { gender: "male", date_of_birth: "1990-01-01" });
  assert.equal(r.code, "gender");
});

test("Masters takes 25 and over, and a five-year group its range", () => {
  const ev = { gender: "Mixed", age_group: "Masters", scheduled_at: "2026-05-05T00:00:00Z" };
  assert.equal(check(ev, { date_of_birth: "2001-12-31" }).allowed, true);   // 25
  const r = check(ev, { date_of_birth: "2002-01-01" });                     // 24
  assert.equal(r.code, "too_young");
  assert.match(r.reason, /Masters Diving Rules Article 4\.3\.1/);
  const group = { ...ev, age_group: "Masters 30-34" };
  assert.equal(check(group, { date_of_birth: "1994-01-01" }).allowed, true);  // 32
  assert.equal(check(group, { date_of_birth: "1991-01-01" }).code, "too_old"); // 35
});

test("normaliseGender folds the spellings the forms and imports write", () => {
  assert.equal(normaliseGender("Male"), "male");
  assert.equal(normaliseGender(" m "), "male");
  assert.equal(normaliseGender("FEMALE"), "female");
  assert.equal(normaliseGender("f"), "female");
  assert.equal(normaliseGender("non-binary"), "other");
  assert.equal(normaliseGender("prefer_not_to_say"), "other");
  assert.equal(normaliseGender(""), null);
  assert.equal(normaliseGender(null), null);
});

test("ineligibleError is the 400 every entry path throws", () => {
  const err = ineligibleError({ allowed: false, code: "gender", reason: "nope" });
  assert.equal(err.status, 400);
  assert.equal(err.code, "ineligible");
  assert.equal(err.eligibility_code, "gender");
  assert.equal(err.message, "nope");
});

test("dateOfBirthError: a real date from 1900 to tomorrow, required on demand", () => {
  assert.equal(dateOfBirthError("1990-06-15"), null);
  assert.equal(dateOfBirthError(""), null);
  assert.equal(dateOfBirthError(null), null);
  assert.match(dateOfBirthError("", { required: true }), /required/);
  assert.match(dateOfBirthError(undefined, { required: true }), /required/);
  for (const bad of ["2020-02-30", "15/06/1990", "1899-12-31", "0000-01-01", "2999-01-01", 19900615, "1990-6-15"]) {
    assert.match(dateOfBirthError(bad) || "", /real date/, String(bad));
  }
});

test("genderError: the four picker values, case-insensitive, required on demand", () => {
  for (const g of ["female", "male", "other", "prefer_not_to_say", "Female", " MALE "]) {
    assert.equal(genderError(g), null, g);
  }
  assert.equal(genderError(""), null);
  assert.match(genderError("", { required: true }), /required/);
  assert.match(genderError("attack helicopter"), /one of/);
  assert.match(genderError(5), /one of/);
});
