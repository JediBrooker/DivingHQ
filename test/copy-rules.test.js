// Copy that has to agree with the code. Guide pages, the README, the
// privacy policy and a few locale strings were written in parallel with
// the rules they describe and went stale when those rules moved. These
// pin the specific sentences that did, so the next change to a rule has
// to update what users read about it too.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const en = JSON.parse(read("src/locales/en.json"));

// lib/role-requests.js: CLUB_GRANTABLE_ROLES is diver, judge, coach.
// Referee reaches every meet in the country, so it goes to DivingHQ.
test("nothing tells a club admin they approve referees", () => {
  const { CLUB_GRANTABLE_ROLES } = require("../lib/role-requests");
  assert.ok(!CLUB_GRANTABLE_ROLES.includes("referee"));
  assert.ok(CLUB_GRANTABLE_ROLES.includes("coach"));
  assert.doesNotMatch(en.home.clubs.step2_desc, /referee/i);
  assert.match(en.home.clubs.step2_desc, /coach/i);
  const stale = [/dive, judge or referee/i, /divers, judges and referees/i, /`diver`, `judge` and `referee`/];
  for (const file of ["src/guide/content/roles-and-permissions.md", "src/guide/content/admin-tasks.md",
    "src/guide/content/faq.md", "README.md"]) {
    for (const re of stale) assert.doesNotMatch(read(file), re, `${file} still says ${re}`);
  }
  assert.doesNotMatch(read("README.md"), /Sign off federation records/);
});

// lib/claims.js sweepOnce: a claim whose window closes without passing()
// goes to the sysadmin. The guide and the settings screen said one
// approval and no objections would pass it.
test("the claim timeout never passes a claim, wherever it's described", () => {
  assert.match(read("lib/platform-settings.js"), /never passes on the clock alone/);
  assert.match(en.admin_settings.claim_timeout_days.description, /never passes on the clock alone/);
  assert.doesNotMatch(en.admin_settings.claim_timeout_days.description, /at least one approval and no objections passes/);
  assert.doesNotMatch(read("src/guide/content/roles-and-permissions.md"), /at least one approval and no objections passes/);
});

// docs/privacy-policy.md is the /privacy page, and its browser-storage
// table is presented as the full list. Two keys from this release were
// missing, and the revoke paragraph said appointments survive a revoke
// (lib/claims.js unwindOrgClaim removes them).
test("the privacy policy lists what the app stores and what a revoke removes", () => {
  const policy = read("docs/privacy-policy.md");
  for (const key of ["divinghq.records.last_book", "dashboard.gettingStarted.*"]) {
    assert.ok(policy.includes(`\`${key}\``), `storage table is missing ${key}`);
  }
  assert.match(read("src/views/RecordsView.vue"), /divinghq\.records\.last_book/);
  assert.match(read("src/components/dashboard/ClubGettingStarted.vue"), /dashboard\.gettingStarted\./);
  assert.doesNotMatch(policy, /appointed while it had access stay in place/);
  assert.match(policy, /referee roles, club and region admins appointed since the approval/);
});

// Since migration 093 every register-org from a listed country opens a
// claim (routes/auth.js), and 096 makes new clubs under a federation wait
// by default. Three passages still described a pending federation that
// lets clubs straight in.
test("docs describe a federation registration as a claim", () => {
  assert.doesNotMatch(read("README.md"), /in a country with no account yet waits in `pending`/);
  assert.doesNotMatch(read("src/guide/content/faq.md"), /DivingHQ reviews a new federation before it goes live/);
  assert.doesNotMatch(read("src/guide/content/quick-start.md"), /join your federation directly/);
});

// Signup writes the chosen club straight into users.club_id (routes/auth.js
// register); only moves made later go through a join request.
test("the guide says signup joins a club directly", () => {
  assert.doesNotMatch(read("src/guide/content/roles-and-permissions.md"), /Nobody lands in a club without asking/);
  assert.doesNotMatch(read("src/guide/content/quick-start.md"), /pick it: its admin approves you/);
});

// The sidebar entry renders t('clubs.title'), "Clubs"; the fallback label
// is never shown. The guide pointed people at "Clubs & teams".
test("the guide names the Clubs sidebar entry as it appears", () => {
  assert.equal(en.clubs.title, "Clubs");
  for (const file of ["src/guide/content/roles-and-permissions.md", "src/guide/content/admin-tasks.md"]) {
    assert.doesNotMatch(read(file), /\*\*Clubs & teams\*\*/, file);
  }
});
