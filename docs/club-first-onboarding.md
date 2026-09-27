# Club-first onboarding — design

> **Status:** All four phases built (see §14 to §17).
> Author: Christian Brooker (with Claude). Last updated: 2026-09-27.

## 1. Problem

DivingHQ is going to spread bottom-up. A club finds the app, starts
running its own meets on it, other clubs nearby follow, and only then
does the state or national federation decide to join. Today the data
model assumes the opposite order:

- The **organisation** is the tenant, and it's modelled as a national
  federation (`init.sql`, "Country federations live here").
- `users.org_id` and `clubs.org_id` are `NOT NULL`. A club can't exist
  without a federation, and `/api/auth/register` requires an **active**
  org before anyone can sign up at all.
- Only org-level roles (`org_admin`, `meet_manager`) can create or run a
  meet (`requireMeetEditor`, `requireEventManager`,
  `socketCanManageEvent`). A club has no authority of its own.
- Every federation signup waits for a sysadmin (`status = 'pending'`
  until `PUT /api/orgs/:id/status`).

So a club in a country with no federation on DivingHQ can't sign up,
and the one person who can unblock it is the platform owner. That
doesn't scale, and it isn't hands-off.

Countries also aren't flat. Australia has Diving Australia above state
bodies (Diving NSW, Diving Victoria, …) above clubs, and at the national
championships divers represent their **state**. The UK has British
Diving above the home nations.

## 2. Goals

1. A club can sign up and run meets on day one, whether or not anyone
   above it is on DivingHQ.
2. Clubs in the same country can hold meets together with no per-meet
   invitation dance.
3. When a state or national body arrives, it **claims** what's already
   there. No data moves.
4. The platform owner is out of the loop for the normal path. Human
   review is the fallback, not the gate.
5. Existing federations and their data keep working unchanged.

### Non-goals (for now)

- Parallel bodies within one country (USA Diving vs NCAA vs AAU). They
  stay separate accounts. See §11.
- A user belonging to more than one org.
- Moving a club between countries.
- Arbitrary-depth hierarchies. One optional layer (state/region) only.

## 3. Why not "one account per club"

The first idea was to let each club register as its own org and merge
it into the federation later. Rejected, because in a bottom-up world the
merge is the main growth event, not an edge case:

- Moving a club between orgs rewrites roughly ten tables
  (`users`, `user_org_roles`, `coach_diver_links`, `club_admins`,
  `club_affiliations`, `classes`, `class_enrolments`, `guardians`,
  `memberships`, plus the club row). There's no bulk path today; the
  diver transfer in `routes/club-changes.js` handles one user and leaves
  several of those tables behind.
- Separate orgs can only share a meet through `event_participating_orgs`
  invitations, per event, and several paths still assume everyone is in
  the host org: penalty entry charges (`routes/payments.js`), team
  attachment (`routes/teams.js`), member pricing.
- Federation records are scoped by `org_id` (`lib/records.js`), so
  every club-org would grow its own "national" records.

## 4. The model

Keep the org as the tenant. Change what an org starts life as.

```
Australia            organisations row, one per country
 ├─ NSW              regions row (optional layer)
 │   ├─ Ryde DC      clubs row
 │   └─ …
 ├─ VIC
 └─ Some club        clubs row with region_id NULL (countries without states)
```

- **Country account.** One `organisations` row per country. It's created
  automatically, **unclaimed**, the first time a club from that country
  signs up. It becomes a federation when the national body claims it.
- **Region.** An optional grouping of clubs inside a country account
  (Australian states, UK home nations, Canadian provinces). Also
  claimable, by the state body.
- **Club.** Unchanged table, plus an optional `region_id`.

Everyone in a country shares one tenant, so inter-club meets, visiting
judges, club records and the future national records all work with the
code we already have.

### Terminology in the UI

| Internal | Shown to users |
|---|---|
| org, unclaimed | "Australia" (country name), with an "unofficial" marker where it matters |
| org, claimed | the federation's name, e.g. "Diving Australia" |
| region | "State" / "Region" / "Home nation" (per-country label, see §5) |

## 5. Data model

All additive. One migration, plus the usual `init.sql` note (baseline
stays pinned).

```sql
-- organisations: who, if anyone, has claimed this account.
ALTER TABLE organisations
  ADD COLUMN claim_state varchar(12) NOT NULL DEFAULT 'claimed'
    CHECK (claim_state IN ('unclaimed', 'claimed')),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN region_label varchar(20);   -- 'State', 'Province', … NULL = no regions

-- Existing orgs are real federations: they stay 'claimed'.
-- Only orgs created by the club-first signup start 'unclaimed'.
-- One country account per country:
CREATE UNIQUE INDEX organisations_one_per_country
  ON organisations (country_code) WHERE claim_state = 'unclaimed';

CREATE TABLE regions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name         varchar(80) NOT NULL,
  short_code   varchar(8)  NOT NULL,          -- 'NSW' on the scoreboard
  claim_state  varchar(12) NOT NULL DEFAULT 'unclaimed'
                 CHECK (claim_state IN ('unclaimed', 'claimed')),
  claimed_name varchar(120),                  -- 'Diving NSW' once claimed
  claimed_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, short_code)
);

ALTER TABLE clubs
  ADD COLUMN region_id uuid REFERENCES regions(id) ON DELETE SET NULL,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE region_admins (             -- mirrors club_admins (067)
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id  uuid NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_id, user_id)
);

-- Who hosts a meet. Both NULL = the org itself (today's behaviour).
ALTER TABLE meets
  ADD COLUMN host_club_id   uuid REFERENCES clubs(id)   ON DELETE SET NULL,
  ADD COLUMN host_region_id uuid REFERENCES regions(id) ON DELETE SET NULL,
  ADD COLUMN represent_as   varchar(8) NOT NULL DEFAULT 'club'
    CHECK (represent_as IN ('club', 'region', 'country')),
  ADD CONSTRAINT meets_one_host CHECK (host_club_id IS NULL OR host_region_id IS NULL);
```

Regions are seeded per country by a sysadmin script (Australia's eight
states and territories, the UK's four nations, …), not typed in by
clubs, so we don't get "NSW", "N.S.W." and "New South Wales" as three
regions.

Claims and votes (§8):

```sql
CREATE TABLE claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind     varchar(8) NOT NULL CHECK (target_kind IN ('org', 'region')),
  target_id       uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  claimant_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_name       varchar(120) NOT NULL,     -- 'Diving NSW'
  website         varchar(255),
  domain_verified boolean NOT NULL DEFAULT false,
  approver        varchar(12) NOT NULL       -- who decides, fixed at creation
                    CHECK (approver IN ('parent', 'clubs', 'regions', 'sysadmin')),
  status          varchar(12) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'approved', 'rejected', 'escalated', 'withdrawn')),
  closes_at       timestamptz NOT NULL,      -- created_at + claim_timeout_days
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Only one open claim per target at a time.
CREATE UNIQUE INDEX claims_one_open ON claims (target_kind, target_id) WHERE status = 'open';

CREATE TABLE claim_votes (
  claim_id   uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  voter_kind varchar(8) NOT NULL CHECK (voter_kind IN ('club', 'region')),
  voter_id   uuid NOT NULL,                  -- the club or region voting
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote       varchar(8) NOT NULL CHECK (vote IN ('approve', 'object')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claim_id, voter_kind, voter_id)   -- one vote per club, not per admin
);
```

Tunables live in a small `platform_settings` key/value table (or as
extra rows beside `feature_flags`), editable at `/admin/features`:

| Key | Default | Meaning |
|---|---|---|
| `claim_voter_min_age_days` | 30 | A club votes only once it's this old… |
| `claim_voter_min_members` | 5 | …and has this many email-verified members, or has hosted a meet |
| `claim_quorum_min` | 2 | At least this many eligible voters must exist, else sysadmin |
| `claim_majority` | 0.5 | Approvals must exceed this share of eligible voters |
| `claim_timeout_days` | 14 | When an unfinished vote resolves (§8.4) |

## 6. Signup

### 6.1 Club founder (the main path)

`/register`, with the club path shown first:

1. **Country.** A plain country picker, not an org picker.
2. **Region.** Only if the country has regions (`region_label` set).
3. **Club.** Pick an existing club in that country/region, or create one.
4. Name, username, email, password as today.

Server side (`POST /api/auth/register`, extended):

- Resolve the country's org. If none exists, create one:
  `claim_state = 'unclaimed'`, `status = 'active'`, name = country name.
  The unique partial index stops two simultaneous signups creating two.
- Creating a new club makes the registrant its first `club_admins` row
  and sets `clubs.created_by`.
- The club is usable as soon as the email is verified. No sysadmin.
  The sysadmin gets the existing `org_pending`-style notification as a
  heads-up (a new `club_created` kind), with a one-click suspend.

A country that already has a claimed federation behaves as today, with
one exception: creating a new club there is a request the federation's
org_admin approves (existing federations decide who's in), unless the
federation turns on "clubs join automatically".

### 6.2 Divers, judges, coaches

Same form, pick an existing club (or no club). Role requests route per
§7.

### 6.3 A body that wants to claim

`/register-org` becomes "Register your federation or state body". It
asks which country (and optionally which region) the body represents:

- Country/region has **no account yet**: create it claimed-pending,
  exactly today's flow (sysadmin approves). Rare once clubs are active.
- Country/region **exists and is unclaimed**: open a claim (§8)
  instead of creating a second org.
- **Already claimed**: explain, and offer "contact support".

## 7. Who can do what

One pattern at three levels. An admin controls their own level and
everything beneath it, never sideways.

| Action | Club admin | Region admin | Org admin (claimed) | Unclaimed org |
|---|---|---|---|---|
| Create/edit meets hosted by… | own club | own region + its clubs | anything in org | n/a, no org admin exists |
| Run the Control Room for those meets | yes | yes | yes | |
| Approve role requests from… | own club's members | clubs in region | anyone in org | |
| Appoint club admins for… | own club (co-admins) | clubs in region | any club | |
| See member data for… | own club | clubs in region | whole org | |
| Set fees / take payments | own club | own region | org | |

Concretely:

- **`requireMeetEditor` / `requireEventManager` / `socketCanManageEvent`**
  gain a host check: pass if the user is org_admin/meet_manager (today),
  OR a region admin of `meet.host_region_id` (or of the host club's
  region), OR a club admin of `meet.host_club_id`. One helper,
  `canManageMeet(user, meet)`, used by all three so they can't drift.
  Club and region admins can also appoint **meet managers per meet**,
  reusing `event_managers`.
- **Creating a meet** as a club/region admin sets the host columns
  automatically; they can't create an org-hosted meet.
- **Role requests** (`role_requests`) get routed to the nearest admin
  level that exists: club admins → region admins → org admins →
  sysadmin. A granted role is still an org-level `user_org_roles` row
  (so a judge can judge anywhere in the country), which is the right
  scope for judges and divers. When the country is claimed, the
  federation can revoke anything a club granted.
- **`ensureEventOrgGate`** needs no change. Everyone is in the same org.

Regression risk sits here. Every route that checks `org_roles`
directly needs auditing (grep `org_roles.includes`). The plan is to
route them through `canManageMeet` or leave them org-admin-only.

## 8. Claims

### 8.1 Who approves

The approver is fixed when the claim opens, by the first rule that
applies:

| Target | Approver |
|---|---|
| Region, and the org is claimed | the **parent**: org admins |
| Region, org unclaimed, ≥ `claim_quorum_min` eligible clubs in the region | the region's **clubs** vote |
| Org (national), ≥ `claim_quorum_min` claimed regions | the **regions** vote |
| Org (national), no regions, ≥ `claim_quorum_min` eligible clubs | the country's **clubs** vote |
| Anything else | **sysadmin** |

### 8.2 Who counts as an eligible voter

A club votes if **all** of these hold at the moment the claim opens (a
snapshot, so clubs created mid-vote don't count):

- The club is at least `claim_voter_min_age_days` old.
- It has hosted a meet, OR has `claim_voter_min_members` email-verified
  members.
- None of its club admins is the claimant.

Any of the club's admins can cast the club's single vote. A region
votes the same way through its region admins.

### 8.3 Outcomes

- **Approve**: approvals > `claim_majority` × eligible voters, AND
  approvals ≥ `claim_quorum_min`. Resolves immediately.
- **Object**: any single objection from an eligible voter sets
  `status = 'escalated'` and the claim goes to the sysadmin queue with
  the objection reason.
- **Parent/sysadmin approver**: a normal approve/reject.

### 8.4 Timeout

A nightly sweep (the `auto-withdraw.js` pattern) handles
`closes_at < now()`:

- At least one approval and no objections: **approved**.
- No approvals: **escalated** to the sysadmin.

### 8.5 On approval

- Target's `claim_state = 'claimed'`, `claimed_at`, and the display name
  becomes the body's name (`organisations.name` or `regions.claimed_name`).
- Claimant becomes org_admin (national) or a region admin.
- Every club admin in scope gets an email + in-app notice: who now runs
  the org or region, and a link to object after the fact (escalates).
- Audit log: `claim.opened`, `claim.vote`, `claim.approved`,
  `claim.escalated`, `claim.revoked`.
- A sysadmin can revoke a claim at any time (resets to unclaimed, removes
  the granted admin rows).

### 8.6 Trust signals shown to voters

- **Verified domain**: the claimant's email domain matches the domain of
  the `website` they gave. Shown as a badge only. It never auto-approves.
- Claimant's account age and whether they're already a member of a club
  in scope.

## 9. Representation at meets

`meets.represent_as` controls the label beside each diver on the
scoreboard, results, PDFs and team scoring:

| Value | Label | Typical meet |
|---|---|---|
| `club` (default) | club short code, as today | club meets, invitationals |
| `region` | region short code (`NSW`) | national championships |
| `country` | org country code | international meets |

Today the scoreboard joins `users.club_id` **live**
(`routes/scoreboard.js`), so a diver who changes club rewrites history.
That's wrong already, and it's more wrong with regions. Snapshot the
label onto the entry:

```sql
ALTER TABLE competitor_dive_lists
  ADD COLUMN rep_club_id   uuid REFERENCES clubs(id)   ON DELETE SET NULL,
  ADD COLUMN rep_region_id uuid REFERENCES regions(id) ON DELETE SET NULL;
```

Set once when the dive list is first submitted (`lib/dive-list-submit.js`),
read by the scoreboard/results/PDF queries with a fallback to the live
join for historical rows. This is the same idea as records capturing the
diver's org at the time of the dive (`lib/records.js`).

## 10. Records

- `records_club`: unchanged.
- **New** region scope next to `records_federation`, keyed on the
  snapshotted `rep_region_id`.
- National records in an **unclaimed** org are shown with an
  "unofficial" marker until the org is claimed. On claim, the federation
  can accept them or wipe them.

## 11. Open questions

1. **Country ≠ body.** US diving has parallel circuits. Leave them as
   separate accounts until a user needs to be in two, then design
   multi-org membership properly.
2. **Can a club leave its region/country?** Probably yes within a
   country (region change, federation approves once claimed). Cross-
   country: sysadmin only.
3. **Federation rejects an existing club.** It can suspend the club
   (new `clubs.suspended_at`). It can't delete its history.
4. **Privacy on claim.** The claiming body sees member data for every
   club in scope. The signup terms (docs/privacy-policy.md) must say that
   a recognised federation may later administer the country or region.
   Needs a wording change before this ships.
5. **Payments in unclaimed countries.** Affiliation fees go to a
   federation that doesn't exist yet. Club-level payments (classes,
   club entry fees) work via the club's own Connect account. National
   fees simply aren't offered until claimed.
6. **Abuse at club creation.** Rate-limit club creation per IP and per
   email domain, and give the sysadmin a single "suspend club + its
   founder" action.

## 12. Phasing

Each phase ships on its own and is useful without the next.

| Phase | Ships | Unblocks |
|---|---|---|
| **P1: Club-first signup** | `claim_state`, auto-created country accounts, country-first register form, founder becomes club admin, `meets.host_club_id`, `canManageMeet`, role-request routing to club admins | Marketing to clubs anywhere |
| **P2: Regions** | `regions`, `region_admins`, `clubs.region_id`, sysadmin seed script, region-hosted meets | State championships |
| **P3: Claims** | `claims`, `claim_votes`, voting UI, timeout sweep, settings, notifications, revoke | Federations and states arriving, hands-off |
| **P4: Representation** | `represent_as`, entry snapshot, scoreboard/results/PDF labels, region records, "unofficial" marker | National championships on DivingHQ |

Launch prerequisites already shipped (2026-09-27): the Administration
org is hidden from public signup, pending/suspended orgs can't sign in,
the empty-dropdown dead end has a way out, and federation admins can
appoint club admins (`/api/clubs/:id/admins`).

## 13. Testing

- **Integration** (`test/*.integration.test.js`): country auto-create
  and its race (two parallel signups, one org); founder gets club admin;
  `canManageMeet` truth table across all three levels and sideways
  (club A admin vs club B meet); role-request routing; every claim
  outcome in §8.3/§8.4 including self-vote exclusion and the
  mid-vote-club snapshot; revoke.
- **e2e**: club founder signs up in an empty country and runs a meet
  end to end; a second club joins and enters that meet; a state body
  claims and is approved by vote; a nationals meet shows `NSW` labels.
- **Unit**: eligibility and outcome functions pure, no DB, like
  `useScoreTrim`.

## 14. Phase 1 as built

Shipped in migration 087 and the commits after it. Where the build
differs from the plan above, this section wins.

**Signup.** `/register` asks for a country (`lib/countries.json`, shared
with the server), then works out the org: none yet means an unclaimed
country account is created (`resolveCountryOrg` in `routes/auth.js`,
race-safe via the partial unique index), one means that org, several
means the registrant picks. Founding a club in an unclaimed country makes
you its club admin. Sysadmins get a `club_created` notification, not an
approval step.

*Deviation from §6.1:* under a claimed federation nothing changed. A new
club is still created straight away with no approval step, and its
founder does **not** become club admin (the federation appoints admins
from Clubs → Admins). Club approval for federations is left for later.

*Deviation from §6.3:* `/register-org` for a country that already has an
unclaimed account is refused (`409 country_has_clubs`) until claims exist
(phase 3). Until then a sysadmin hands the account over by hand.

**Permissions.** One idea, used everywhere: a *delegate* for an event is
someone with an `event_managers` row, or an admin of the club hosting the
event's meet (`isEventDelegate` in `lib/middleware.js`).
`requireEventManager`, `socketCanManageEvent` and the new
`requireRoleOrEventDelegate` (Control Room, judge panel, conflicts,
manual scores, late arrivals, score correction) all accept delegates.
Meets go through `requireMeetEditorOrClubAdmin` + `isMeetHostAdmin`.
Event create/delete accept the host club's admin. Club admins get this
under a claimed federation too, but only for meets their club hosts.

*Not yet club-scoped* (org roles only): teams, meet and event fees,
international invitations, the audit log, and the 2FA requirement.

**Role requests.** `lib/role-requests.js` decides who reviews: org admins
under a federation; in an unclaimed country the requester's club admins
(diver/judge/referee only, never self-approving an official role); the
sysadmin as fallback. Club admins review on `/club` (My club), where in an
unclaimed country they also manage co-admins (members only, never the
last one).

**Frontend.** `auth.clubAdminOf` / `auth.isClubAdmin` come from the login
and `/api/auth/me` bodies (not the JWT). `useClubScope` narrows the
Manager and Control Room to the user's own club's meets. The scheduler
takes `can_edit` from the server. `/guide` has a Club Admin card.

**Tests.** Integration: signup and the country race, two clubs' admins
against each other, role-request routing and co-admins.
e2e: `test/e2e/club-first-signup.spec.js`.

## 15. Phase 2 as built

Migration 088: `regions`, `region_admins`, `clubs.region_id`,
`meets.host_region_id` (with a one-host check) and
`organisations.region_label`. The `represent_as` column from §5 waits for
phase 4.

**Where regions come from.** There's a built-in catalogue,
`lib/regions.json`, instead of a sysadmin script. It currently holds
Australia (states and territories), Canada (provinces and territories) and
the UK (home nations); adding a country is a JSON edit.
`materializeRegions` copies a country's list into its org:
- **automatically** for an unclaimed country account, the first time
  anyone founds a club there (this also backfills phase-1 accounts);
- **on request** for a claimed federation, via "Set up regions" on the
  Clubs screen (`POST /api/orgs/:id/regions/seed`). A federation may not
  want them.

**Signup.** Once a country has regions, founding a club needs one
(`region_code`, `400 region_required` otherwise). For joining, the
region just narrows the club list. The form reads the org's regions, and
falls back to the catalogue for a country nobody has started yet.

**Putting clubs in regions.** Under a federation, the federation decides
(Region column on the Clubs screen). Where there's no federation, the
club's own admin picks, on My club (`PUT /api/clubs/:id/region`).

**Region admins** are appointed by the federation's org admin or the
sysadmin (a region chip on the Clubs screen opens `RegionAdminsModal`).
State bodies appointing themselves via claims is phase 3. A region admin:
- runs meets hosted by their region or by any club in it: the
  `isEventDelegate` / `isMeetHostAdmin` checks now include the host region
  and the host club's region, so every phase-1 gate follows;
- hosts meets as their region or one of its clubs (`host_region_id`);
- reviews role requests from their clubs' members, next in line after
  the club's own admins (`lib/role-requests.js`);
- manages club admins for their region's clubs where there's no
  federation;
- sees it all on `/region` (My region).

The SPA gets `region_admin_of` next to `club_admin_of`; `useClubScope`,
the router (`allowDelegateAdmin`, `requiresRegionAdmin`) and the nav
treat club and region admins alike.

**Tests.** Integration: catalogue, signup with and without a region, club
moves, federation seeding and appointment, and Ontario's admin against
Ottawa (reachable) and Montreal (not). e2e: a Canadian founder picks a
province at signup.

## 16. Phase 3 as built

Migration 089 adds `claims`, `claim_voters`, `claim_votes` and
`platform_settings`. `lib/claims.js` holds the whole lifecycle. The API is
`routes/claims.js`, and claims open through `POST /api/auth/register-org`.

**Where claims start.** `/register-org` (now country and region pickers,
plus an optional website) opens a claim instead of a new federation when:
- the country has an unclaimed account (a national claim), or
- the body names a region (a region claim). If nobody from the country is
  on DivingHQ yet, the country account is started first so there's a region
  to claim.

The claimant gets an ordinary account in that org. A second claim on the
same target is refused while one is live (verified, and open or
escalated). An unverified claim holds nothing: a newer claim replaces it
(the old claimant is told), and if two verify at once only the first goes
live, the other is withdrawn with a notice (migration 092).

**Voters who are really the claimant.** register-org always makes a new
account, so "none of its admins is the claimant" never matched anyone. A
club or region is also left out of the voter set when one of its admins has
the claimant's email address (lower-cased, +tags dropped, Gmail dots
ignored) or, off webmail and the big ISPs, the same organisation's domain
or a subdomain of it. The same check runs again when a vote is cast, for
admins added after the snapshot. The audit row records how many voters were
left out.

**Who approves** follows §8.1, with one deviation. A national claim goes to
the claimed regions if there are enough of them, **otherwise to the clubs
even when the country has regions**. That keeps more cases off the
sysadmin's desk. Voters are snapshotted when the claim opens; `claim_voters`
is an addition to §5 that makes this possible.

**Activation.** A claim is invisible, and nobody is notified, until the
claimant verifies their email (`activateForUser`, called from verify-email).
The voting window starts then. Claims that stay unverified for 7 days are
withdrawn by the sweep, and the claimant is told (in-app, and by email) and
still sees the withdrawn claim on `/claims`.

**Outcomes** follow §8.3. An objection needs a reason, and the reason goes
to the sysadmin with the escalation. **Deviation from §8.4:** the timeout
never approves. A vote that closes without reaching the §8.3 bar (a
majority and at least `claim_quorum_min` approvals) goes to the sysadmin,
so one approval and two quiet weeks can't hand anyone a country. For
parent-approved region claims, the timeout escalates to the sysadmin.
Sysadmin-approved claims just wait in their queue. Nobody, sysadmin
included, can decide a claim before it's verified (409 `claim_not_live`).

**Claimants who've gone.** Deleting your account withdraws your open and
escalated claims and removes your club and region admin rows in the same
transaction. Every approval path re-reads the claimant first: a deleted one
gets the claim withdrawn, a suspended one sends it to the sysadmin (who
has to lift the suspension, or reject).

**On approval**:
- a national claim renames the org to the body and makes the claimant
  org_admin (with a token bump);
- a region claim sets `regions.claimed_name` and makes the claimant a
  region admin.

Everything that phases 1 and 2 keyed on `claim_state` then switches over
automatically: role requests go to org admins, register-org stops opening
claims on that org, and so on. The sysadmin can revoke an approved claim.
That reverts the target, and a national org gets its country name back.

Revoking also takes back what was handed out under the claim, because the
claimant could grant access to anyone while they ran it:
- a national claim removes **every** `org_admin` and `meet_manager` grant in
  the org (unclaimed means none of either), club and region admin rows
  created since the approval (under a federation, only its admins or
  DivingHQ can make those), and region claims the federation itself
  approved, which are revoked with it. Region claims still waiting on the
  federation go to the sysadmin (escalated if live, approver switched if
  not yet verified);
- a region claim removes the region's admin rows created since the approval,
  plus the claimant's own;
- both remove the `event_managers` seats handed out since the approval by
  anyone who just lost access (and, for a national claim, seats held by
  them). An org admin can seat anyone, themselves included, on any event in
  the org, and `isEventDelegate` honours that seat on its own.

Everyone who lost something has their token bumped and is told. The
response and the `claim.revoked` audit row list every removed grant, so the
sysadmin can re-grant anything that should have stayed.

**Notifications.** Every notice goes out both in-app (`claim_vote`,
`claim_review` and `claim_decided` in the inbox) and by email
(`sendClaimEmail` in `lib/email.js`, English like the other admin emails).
The emails carry what someone needs to act without opening the app:
- the claimant and their website, and whether their email domain matches it;
- the closing date and the rules;
- objection reasons, on escalations to the sysadmin.

The claimant is also told when their claim goes live, when it's decided,
when it goes to DivingHQ and if it's withdrawn or revoked. Outcomes go to
whoever had a vote, plus every club and region admin in the country (a
national claim) or the region's club admins and the federation above it (a
region claim). The wording follows who decided and whether the country has
a federation. In-app titles longer than the 160-character column are cut,
with the full sentence moved into the body.

**Deviation from §8.5:** club admins in scope aren't offered an
after-the-fact "object" link. The approval email tells them to contact
DivingHQ.

**UI**:
- `/claims` for voters, federations, the sysadmin and claimants;
- a dashboard chip for claims waiting on you;
- a "Claim voting rules" section on `/admin/features` for the five
  settings;
- a Club Admin guide step.

**Tests.** Integration covers:
- a club vote passing;
- an objection escalating, then sysadmin approve and revoke;
- a federation deciding a provincial claim;
- the sweep.

e2e covers a federation claiming via `/register-org` and two clubs voting
it in on `/claims`.

## 17. Phase 4 as built

Migration 090 adds `meets.represent_as`, `competitor_dive_lists.rep_club_id` / `rep_region_id` / `rep_country`, the `cdl_snapshot_rep` trigger and `event_rep_code()`. Migration 091 adds `records_region`.

**Default is `country`, not `club`** (deviation from §5). Every existing screen already showed the diver's country chip, so defaulting to club would have silently changed every meet. Organisers opt in per meet: "Divers represent" in the meet's Edit dialog.

**Snapshot by trigger.** Rather than touching the eleven code paths that insert entries, a `BEFORE INSERT` trigger copies the diver's club, region and country onto the row. `event_rep_code(event, user, home_country)` reads the snapshot, falls back to the diver's current club and region for pre-090 rows, and falls back to the country when there's nothing better.

**One slot.** The diver-row queries emit `event_rep_code` as `country_code` / `partner_country`: scoreboard, recap, Control Room roster / history / attendance (and therefore the live active-diver payload, venue boards and judge screens), programme / start list / score sheet / results CSV + PDF, and the venue leaderboard. All chips, and the medal table (which groups by `country_code`), follow without frontend changes, so a nationals set to "state" gets a state medal table. Judges' rows are untouched. Changing the setting clears the scoreboard cache; an already-announced active diver keeps its old label until the next `set_active_diver`.

**Records.** A `region` scope keyed on the entry's region. `GET /api/records` returns `official: false` for national records in an unclaimed country and state records in an unclaimed region.

**Not done:** team events keep their team codes, since a team is its own entity and isn't relabelled by state. Records still have no frontend screen.

**Tests.** Integration covers labels switching across region / club / country, a diver who changes club after entering keeping their entry-time state, the Control Room roster agreeing, and a state record reading unofficial until the region is claimed.

