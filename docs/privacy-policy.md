# DivingHQ Privacy Policy

Last updated: 29 September 2026

This policy explains what DivingHQ collects, why, who can see it, how long it's kept, and how to get it removed. It covers the hosted service at [divinghq.app](https://divinghq.app).

## 1. The short version

DivingHQ is diving competition software for clubs, state and regional bodies, and federations. We collect what's needed to run meets (accounts, dive lists, scores, judging assignments) and we publish ordinary sporting results (names, clubs, rankings, scores) the way every competition does. We don't sell data, we don't run ads, and we don't track you across other websites.

Three things are worth knowing up front:

- **Public results are permanent.** Competition records stay in the public archive, the same way they'd appear in a printed programme. Your *name* stays attached to the dives you actually competed in, because that's the sporting record. Deleting your account removes the *profile* (login, contact details, settings, analytics), not the historical entry.
- **Your club's data can come under a federation later.** A club can start on DivingHQ before its national federation or state body does. If that body later joins and its claim is approved, its administrators can see and manage the accounts of members of clubs in its area. See §6.
- **You can delete your account at any time** from your profile page. We delete personal data straight away and sign out every session. If you create a new account later, you can claim your old competition entries back. See §7.

## 2. Who we are

DivingHQ is operated by **DivingHQ (divinghq.app)**.

- Website: [https://divinghq.app](https://divinghq.app)
- Privacy and support contact: [support@divinghq.app](mailto:support@divinghq.app)

When you use DivingHQ through a club, a state or regional body, a federation or a meet host, that organisation is also responsible for how it uses your data for its own members and events. DivingHQ provides the software and runs the service; the organisation runs its meets and decides who holds which role.

## 3. Data map

A summary of every kind of data DivingHQ stores. Detail follows in §4 and §6.

| Data | Where it comes from | Who can see it | How long we keep it |
|---|---|---|---|
| Account (username, full name, email, password hash, country, club, state or region) | You, at sign-up | You; your club's admins; your region's admins; your federation's admins once there is one (§6) | Until you delete the account |
| Competition details (date of birth, gender, nationality) | An admin in your organisation | You; the admins above; used for age groups and eligibility | Until you delete the account |
| Role requests (the role you asked for and your note) | You | The admins who review them (§6) | Until you delete the account |
| Dive lists, synchro partner pairings | You or your coach | You, your coach and the meet's organisers; everyone once the event goes Live | Permanent (sporting record) |
| Scores, rankings, judging history | Judges and meet officials | Public from the moment an event goes Live | Permanent (sporting record) |
| Claims (the body's name, website, votes and objection reasons) | The body applying, and the clubs or regions voting | The claimant, the voters, the deciding admins, DivingHQ | Kept as the record of who runs an account |
| Two-factor secret and recovery codes (hashed) | You, at 2FA setup | Only used at sign-in | Until you turn 2FA off or delete the account |
| Notifications and push subscriptions | Your browser and the app | Only you | Until you revoke them or delete the account |
| Audit log of privileged actions | The server, on every privileged action | Admins of the organisation concerned | **30 days**, then purged |
| Security logs (IP address, user agent, sign-in attempts) | The server | DivingHQ operations | 30 days |

**Where DivingHQ runs.** The application and its database run on servers operated by DivingHQ. Every request to divinghq.app reaches them through Cloudflare, which handles the encrypted connection and protects the service from abuse (see §6). We keep database backups so we can recover from a failure. They're access-restricted and used for nothing else. Data you delete can remain in a backup until that backup is replaced.

## 4. What we collect in detail

### Account

When you sign up: **username, full name, email address, password** (stored as a bcrypt hash, never readable), **country**, and your **club** and **state or region** if you pick or create one. If you ask for a role (diver, judge, referee), we store the request and any note you add.

Set later:

- **Competition details**: date of birth, gender and nationality, entered by an admin in your organisation and used for age groups, event eligibility and results.
- **Two-factor authentication**: a TOTP secret and bcrypt-hashed recovery codes. You see the codes once at setup; we only keep their hashes.
- **Language preference**: one of the 26 supported languages.
- **Dashboard widgets**: which analytics panels you've pinned.

You can update your name, email, password and 2FA from your profile page.

### Competition data

- **Dive lists**: the dives you (or your coach) entered for each event.
- **Scores**: every judge's score for every dive you performed, and the resulting points.
- **Rankings, results, dive-offs and score corrections** for every meet you took part in.
- **Representation**: what you represented at each meet (your club, state or country, depending on the meet's "Divers represent" setting). It's saved on your entry when you enter, so results don't change if you move club later.
- **Judging assignments**: if you're a judge, which events you sat on and in which panel position.
- **Synchro pairings**: who your partner was for each synchro event.

### Server logs

Like every web service, we record IP addresses, user agents, timestamps and request paths so we can debug, secure and operate the service. Failed sign-ins, rate-limit trips and privileged actions (score corrections, withdrawals, role grants, suspensions) are logged.

### Email

We send service email only: confirming your address, password resets, email changes, role decisions, claim notices, and meet notices for events you're entered in. We don't send marketing email.

### Push notifications

If you turn on push notifications (for example a coach's "your diver is up next" alert), your browser gives us an endpoint URL and a pair of keys. The endpoint belongs to your browser's push service (Google for Chrome and Edge, Mozilla for Firefox, Apple for Safari). Every payload is encrypted, so the push service relays it without seeing the content.

### Payments (not switched on yet)

DivingHQ can take payments (entry fees, memberships, fines) through **Stripe**, but payments are switched off on the hosted service today. When they're switched on, Stripe collects and processes card details directly. We never see or store card numbers; we keep a record of each payment (amount, currency, status and Stripe's reference). We'll update this policy before payments go live.

### Browser storage

DivingHQ keeps a few things in your browser:

| Storage | Name | Purpose |
|---|---|---|
| Cookie (httpOnly) | `dhq_session` | Keeps you signed in. A session cookie, cleared when you close the browser, and unreadable by scripts on the page |
| sessionStorage | `dhq_identity`, `profile.claim.seen` | Who's signed in on this tab, so a refresh on bad venue Wi-Fi doesn't sign you out; whether you've already dismissed the "claim past results" prompt |
| localStorage | `locale`, `dhq-theme`, `dhq-sidebar` | Language, light or dark theme, sidebar collapsed or not |
| localStorage | `sb_sort_by`, `dashboard.activeTab.v1`, `setup.wizard*` | Scoreboard sort order, last dashboard tab, first-run wizard state |
| localStorage | `dr_tour_seen_*`, `scheduler.*`, `dr_control_auto_advance_seconds*` | Which role tours you've already seen, the scheduler's drawer settings, the Control Room's auto-advance delay |
| localStorage | `divinghq.records.last_book`, `dashboard.gettingStarted.*` | The record book you last opened, so the records page reopens it; which parts of a club admin's "Get started" panel you've hidden or opened (stored per account, so the name includes your user ID, and not cleared when you sign out) |
| IndexedDB | `dive-recorder-cache` | Copies of recent pages so the app works offline. Kept per user and cleared when you sign out |
| IndexedDB | `divinghq-outbox` | Scores and other meet-day actions waiting to be sent while offline |
| Service worker cache | `divinghq-shell-*` | The app's own code and assets, so it opens offline once installed |

No third-party cookies, no analytics scripts, no ad pixels.

### What we deliberately don't collect

DivingHQ isn't designed for medical records, government identity numbers, payment card details or biometric data. Please don't type any of that into free-text fields (role-request notes, score-correction reasons, withdrawal reasons, objection reasons). Those fields are stored as written.

## 5. How we use it, and why we're allowed to

We use the data above to:

- run your account: sign-in, password reset, email confirmation, 2FA (**to provide the service you signed up for**);
- run meets: events, dive lists, judging panels, scoring, results and archives (**to provide the service**, for you and for the organisations running the meets);
- publish results and keep the sporting record (**legitimate interest** in accurate, public competition results, the same as any printed programme);
- send the service emails and push notifications described in §4 (**to provide the service**; push only with your **consent**, which you can withdraw in your browser);
- produce PDFs and CSV exports (programmes, start lists, score sheets, results);
- give divers, coaches and judges their analytics dashboards;
- keep an audit trail of privileged actions for disputes and integrity (**legitimate interest**);
- protect the service against abuse, fraud and unauthorised access, and debug and improve it (**legitimate interest**).

We don't sell data, run ads, or share data with anyone for advertising or profiling.

## 6. Who else sees your data

### People in your sport

Access follows the structure of your sport on DivingHQ. Each admin controls their own level and the levels beneath it, never sideways.

- **Club admins** see their own club's members: names, usernames and role requests. They run their club's meets and approve their members' role requests.
- **Region admins** (a state, province or home nation body) see the same for every club in their region, and run the region's meets.
- **Federation admins** see and manage the accounts of everyone in their country's organisation on DivingHQ: names, usernames, email addresses, clubs, regions, roles, competition details, account status and competition entries. They approve role requests, appoint club admins, and can suspend accounts. They can also read the audit log for their organisation.
- **Meet organisers and officials** see what they need to run a meet: entries, dive lists and scores for their events.
- **Coaches** see the profiles and analytics of divers they're linked to as a coach.
- **Guardian link requests** (a parent or guardian asking to pay on a child's behalf) go to whoever approves them: the federation's admins, or, where the clubs run the country, the admins of the child's club (or of its region, or DivingHQ if the club has nobody to ask). They see the parent's name and username and the child's name, club and age. Club and region admins get the child's age, not their date of birth, and never decide a request they're part of.

### Clubs that join before their federation (claims)

A club can start on DivingHQ before its national federation or state body is here. Until one arrives, the country's account is "unclaimed" and each club runs its own meets.

If that federation or state body later joins, it applies to run the country or region on DivingHQ. This is called a **claim**. Here is what happens:

- **The clubs are told.** When a claim opens, the club admins it affects are notified by email and in the app, with the body's name, its website, and whether the applicant's email address is on that website's domain.
- **The clubs decide.** Where enough clubs are eligible, the clubs in that country or region vote (for a national claim, the state bodies already on DivingHQ may vote instead). Any single objection sends the claim to DivingHQ for a decision, together with the reason given. Where there aren't enough eligible voters, DivingHQ reviews the claim itself. A state body's claim in a country whose federation is already on DivingHQ is decided by that federation.
- **What an approved body can see.** Once a claim is approved, the body's administrators become the federation admins (for a country) or region admins (for a state or region) described above. For a country, that means they can see and manage the accounts of members of every club in that country, including names, usernames, email addresses, clubs, roles and competition entries, and they can approve role requests and appoint club admins. For a region, it's the same for the clubs in that region. Club admins keep seeing their own members as before.
- **Nothing is copied or moved.** Your data stays where it is. The body gets access to the account your club is already in, and your club's history (meets, results, records) stays with it.
- **The clubs hear the result.** When a claim is approved, the club admins in its area are told who now runs it.
- **Revocation.** DivingHQ can revoke an approved claim at any time, for example if a body turns out not to be who it said it was. Revoking returns the country or region to unclaimed. It also removes the admin access the claim granted and the access handed out under it: federation admin, meet manager and referee roles, club and region admins appointed since the approval, and event-manager seats those people gave out. A club founder keeps admin of their own club. For a country, state-body claims the federation approved are revoked with it; a state body whose claim DivingHQ or the clubs approved keeps it. Other roles the body approved, such as judge, coach or diver, stay in place. Everyone who loses access is told, and the body's actions stay in the audit log for the normal 30 days.

If you think a claim affecting your club is wrong, reply to the claim email or write to [support@divinghq.app](mailto:support@divinghq.app).

### The public

Spectators see what every meet programme has always shown: divers' names, clubs, states or countries, events, dive lists, scores and rankings. This is public from the moment an event goes Live and stays public in the results archive afterwards. Judges' scores are public too, and so is the analysis of how each judge scored.

### DivingHQ

DivingHQ operations staff see what's needed to keep the service running: logs, errors, and your messages if you contact us. System administrators can see across every organisation to review claims, handle support requests and investigate abuse.

### Service providers

These providers process data for us, only to run the service:

| Provider | What for | What they see |
|---|---|---|
| Cloudflare | Every request to divinghq.app passes through Cloudflare (encrypted connection, abuse protection) | Your IP address, browser details and the pages you request |
| Cloudflare Email Sending | Delivering our service emails | Your name, email address and the email's content |
| Google Fonts | The typefaces the pages use (IBM Plex Sans, DM Mono), loaded from Google's servers | Your IP address and browser details when your browser fetches the fonts |
| Your browser's push service (Google, Mozilla or Apple) | Delivering push notifications you turned on | An encrypted payload it can't read |
| Stripe (only once payments are switched on) | Taking payments | What you enter on Stripe's payment page |

Cloudflare and Google operate worldwide, so this data may be processed outside your country.

**Translation tooling** (used to keep the app's interface in 26 languages) processes only the app's own English interface text, never user data or competition records.

We don't use third-party analytics or marketing tools.

## 7. Deleting your account

You can delete your account from **Profile → Delete account**. We ask for your password first.

If you're the only administrator left in your federation, we ask you to appoint another one first, so the federation isn't left with nobody who can run it. If there's nobody to hand it to, write to us at [support@divinghq.app](mailto:support@divinghq.app): we can take the administrator role off your account, and then you can delete it as usual.

**What we delete, straight away:**

- The login itself: password, email address, 2FA secret and recovery codes.
- Personal details and settings: date of birth, gender, nationality, language, dashboard layout, push subscriptions.
- Anything that links your *account* to other people: roles, coach links, guardian links, role requests, club change or transfer requests still open (they're closed), club and region admin roles, any claim you made that's still being decided (it's withdrawn), and your public profile address (so `/profile/<you>` stops working).
- Every active session, on every device. You're signed out immediately.

**What stays, and why:**

- **Your name on your historical competition entries.** Diving meets are public sporting records, like a printed programme from a national championship decades ago that still lists every diver. Your dive lists, scores, rankings, and the events you competed in or judged keep your name, and your club and country stay on those entries. What changes is that your name is no longer a link: there's no profile, no analytics and no contact details behind it.
- **Audit log entries** of privileged actions you took (for example score corrections you signed off as a referee). Kept for dispute and integrity reasons, then purged on the normal 30-day cycle.

**Coming back later: claim your old results.**

If you create a new account in the future with the same name, we check whether any historical entries in your organisation match. At sign-in we show you past meets that look like yours; you pick the ones that are, and we link them to your new profile. You can also do this from **Profile → Claim past competition entries**. We ask you to confirm rather than matching automatically, because two divers can share a name. Team places, memberships, accreditations and payment records on the old account come across with them.

**If a result needs removing completely** (safeguarding, child protection, a court order, mistaken identity), contact the club or federation that ran the event, and us at [support@divinghq.app](mailto:support@divinghq.app). We'll work with the organisation that ran it.

## 8. Security

- Passwords are stored with bcrypt and are never readable.
- Two-factor authentication with an authenticator app, with one-time recovery codes (also hashed).
- All traffic is encrypted (HTTPS).
- Your session lives in an httpOnly cookie that scripts on the page can't read, and sessions can be ended everywhere at once: changing your password, a change to your roles, a suspension or deleting the account signs out every device.
- Rate limits on sign-in, password reset and bulk actions.
- A strict Content Security Policy: no third-party scripts and no inline JavaScript.
- An audit log of every privileged action.

No service can promise perfect security. Use a strong password, turn on 2FA, and tell us at [support@divinghq.app](mailto:support@divinghq.app) if you think someone has got into your account.

## 9. Children

Diving is a youth sport, and many divers on DivingHQ are children. Children usually join through their club, and their club (or federation) is responsible for getting the consent it needs from parents or guardians.

A child shouldn't create an account without a parent or guardian's involvement. If you think a child has signed up without that, contact us at [support@divinghq.app](mailto:support@divinghq.app) and we'll remove the account.

## 10. Your rights

You can:

- **Access** the data we hold about you: most of it is on your profile, or email us for a copy.
- **Correct** anything that's wrong: most fields are self-service on your profile; email us for the rest.
- **Delete** your account at any time (see §7).
- **Object** to, or ask us to **restrict**, specific processing: contact us.
- **Complain** to your data protection regulator if you're not happy with our answer.

Email [support@divinghq.app](mailto:support@divinghq.app) for any of these. We'll check it's really you before acting, and we'll answer within 30 days.

## 11. Data breaches

If personal data is exposed, we will:

1. Contain it and start investigating within 24 hours of finding out.
2. Tell affected users, and the admins of the affected clubs and organisations, within 72 hours of confirming that personal data was exposed.
3. Tell the relevant regulator within whatever time the law requires (72 hours under GDPR).
4. Publish a summary of what happened once it's fixed.

## 12. Changes to this policy

We may update this policy. If a change is material (a new kind of data, a new provider, or a change to your rights), we'll email account holders before it takes effect. The date at the top shows the latest change.

## 13. Contact

Privacy questions, deletion requests, complaints and safeguarding concerns: write to **DivingHQ (divinghq.app)** at [support@divinghq.app](mailto:support@divinghq.app).
