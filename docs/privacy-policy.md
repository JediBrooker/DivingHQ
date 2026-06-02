# DivingHQ Privacy Policy

Last updated: May 19, 2026

> Draft. Replace bracketed placeholders before publishing.
>
> **Before-publish checklist:**
> - `[Legal entity name]` (appears 3 times)
> - `[Physical mailing address]` (appears 2 times)
> - `[privacy@your-domain.example]` (appears 4 times)
> - `[https://your-domain.example]` (appears 2 times)
> - The "Where DivingHQ runs" row in §3 needs your actual hosting setup

This policy explains what DivingHQ collects, why, who can see it, how long it's kept, and how to get it removed.

## 1. The short version

DivingHQ is a diving competition platform. We collect the data needed to run meets — accounts, dive lists, scores, judging assignments — and we publish ordinary sporting results (names, clubs, rankings, scores) the way every other competition does. We don't sell data, we don't run ads, and we don't track you across other websites.

Two things are worth knowing up front:

- **Public results are permanent.** Competition records live in the public archive indefinitely, the same way they'd appear in a printed program. Your *name* stays attached to the dives you actually competed in — that's the sporting record. Deleting your account removes the *profile* (login, contact details, settings, analytics), not the historical entry.
- **You can delete your account at any time** from your profile page. We delete personal data immediately and revoke every session within seconds. If you create a new account later — even years later — you can claim your old competition entries and they show up under your new profile. See §7.

## 2. Who we are

DivingHQ is operated by **[Legal entity name]**.

- Postal address: [Physical mailing address]
- Privacy contact: [privacy@your-domain.example]
- Website: [https://your-domain.example]

If you use DivingHQ through a federation, club, or meet host, that organisation also has responsibility for how your data is used for its events. DivingHQ provides the software; the organisation runs the meet.

## 3. Data map

A summary of every category of data DivingHQ stores. Detail follows in §4.

| Data | Where it comes from | Who can see it | How long we keep it |
|---|---|---|---|
| Account (username, name, email, password hash, organisation, club) | You at sign-up | You + your org admins | Until you delete the account |
| Dive lists, partner pairings | You / your coach | You + your org + spectators once an event goes Live | Permanent (sporting record) |
| Scores, rankings, judging history | Judges, your operator | Public from event Live onwards | Permanent (sporting record) |
| 2FA secret + recovery codes (hashed) | You at 2FA setup | Only used at login | Until you turn 2FA off or delete the account |
| Push subscriptions | Your browser | Internal only | Until you revoke or delete the account |
| Audit log (operator actions) | Server, on every privileged action | Org admins | **30 days**, then purged |
| Security logs (IP, user agent, login attempts) | Server | DivingHQ ops | 30 days |
| Language preference, scoreboard view preferences | Your browser localStorage | Only your browser | Until you clear browser storage |

Where DivingHQ runs: [Your hosting region, e.g. "AWS Sydney (ap-southeast-2)"]. Backups are encrypted and retained for [N] days.

## 4. What we collect in detail

### Account

When you sign up: **username, full name, email, password (stored hashed, never readable), organisation, club**.

Optional, set later:
- **Two-factor authentication** — a TOTP secret + bcrypt-hashed recovery codes. We never store the readable codes; you see them once at setup and they're hashed on save.
- **Language preference** — one of 26 supported locales.
- **Dashboard widgets** — which analytics panels you've pinned.

Self-service updates (name, email, password, 2FA) live on your profile page.

### Competition data

- **Dive lists** — the dives you (or your coach) submitted for each event.
- **Scores** — every judge's score for every dive you performed, plus the trimmed total.
- **Rankings, results, dive-off records, score corrections** — the live state of every meet you appeared in.
- **Judging assignments** — if you're a judge, which events you sat on and which panel position.
- **Synchro pairings** — who your partner was for each synchro event.

### Server logs

Like every web service, we record IP address, user agent, timestamps, and request paths so we can debug, secure, and operate the service. Failed logins, rate-limit trips, and audit-log writes for privileged actions (score corrections, withdrawals, role grants) are all stored.

### Push subscriptions

If you opt in to push notifications (coach "your diver is up next" alerts, meet-day reminders), your browser hands us a push endpoint URL plus a pair of keys. The endpoint URL goes to your browser's push service (Google for Chrome / Edge, Mozilla for Firefox, Apple for Safari). We encrypt every push payload; the push service relays without seeing the content.

### Browser storage

DivingHQ stores a handful of values in your browser:

| Storage | Key | Purpose |
|---|---|---|
| localStorage | `auth_token` | Your signed-in JWT |
| localStorage | `locale` | Language preference (also synced to server when signed in) |
| localStorage | `sb_sort_by`, `sb_view_mode` | Scoreboard view + sort preferences |
| localStorage | `setup.wizardCompleted.v1`, `setup.wizardDismissed.v1` | First-run setup wizard state |
| Service Worker cache | `divinghq-shell-v7` | Offline app shell + cached assets (PWA mode) |
| IndexedDB | Browser push subscription | Owned by your browser; we read the endpoint when you opt in |

No third-party cookies. No analytics scripts. No ad pixels.

### What we deliberately don't collect

DivingHQ isn't designed to collect medical records, government identity numbers, payment card details, or biometric data. Don't type any of that into free-text fields (score-correction reasons, withdrawal reasons, role-request notes, coach-diver link notes) — those fields are stored verbatim.

## 5. How we use it

We use the data above to:

- run accounts: sign-in, password reset, email verification, 2FA;
- run meets: events, dive lists, judging panels, scoring, results, archives;
- send service emails (verify-your-email, password reset, email change) and the push notifications you opted in to;
- generate PDFs and CSV exports (programs, start lists, score sheets);
- give athletes, coaches, and judges their personal analytics dashboards;
- audit privileged actions for forensic / dispute purposes;
- secure the service against abuse, fraud, and unauthorised access;
- debug and improve DivingHQ.

We don't sell data. We don't run ads. We don't share with third parties for behavioural targeting.

## 6. Who else sees your data

**Your organisation** (federation / club / meet host) sees the data they need to run meets: roster, dive lists, scores. Org admins can see audit logs scoped to their org.

**Spectators and the public** see what every meet program has always shown: athletes' names, clubs, countries, events, dive lists, scores, rankings. This is true from the moment an event goes Live and stays true in the public archive afterwards.

**DivingHQ operations staff** see what's needed to keep the service running — logs, errors, support tickets if you contact us.

**Service providers**, where used, only act as our processors. Federations who self-host DivingHQ pick their own providers; for the hosted service, the current list is:

| Provider | Purpose | Region |
|---|---|---|
| [Hosting provider] | App hosting, database, backups | [Region] |
| [Email provider] | Verification + password-reset emails | [Region] |

We don't use third-party analytics or marketing tools.

**Translation tooling** (used to maintain the app's UI in 26 languages) processes only the English UI dictionary — never user data, never competition records.

## 7. Deleting your account

You can delete your account from **Profile → Delete account**. We ask for your password before processing the request.

**What we delete, within seconds**:

- The login itself — password, email, 2FA secret + recovery codes.
- Personal settings — language preference, dashboard widget layout, notification preferences, push subscriptions.
- Anything that links your *account* to other people — coach-diver links, pending role requests, your public profile slug (so `/profile/<you>` 404s).
- Every active session, on every device. You're signed out immediately.

**What stays — and why**:

- **Your name on your historical competition entries.** Diving meets are public sporting records — the same way a printed program from a 1970s nationals still has every name in it. Your dive lists, scores, rankings, and the events you competed in (or judged) keep your name on them. What changes is that your name is no longer a link — there's no profile, no analytics, no contact details behind it.
- **Audit log entries** of privileged actions you took (e.g. score corrections you signed off as a referee). Kept for dispute and integrity reasons, then purged on the normal 30-day rotation.

**Coming back later — claim your old results**:

If you create a new account at any point in the future — months, years — and use the same name, we'll check whether any historical entries in your federation match. At sign-up we'll show you a list of past meets that look like they could be yours; you pick the ones that are, and we re-link them to your new profile. From that point on, your new profile page shows your full competition history, including everything from before the deletion.

You can also trigger the claim flow manually from **Profile → Claim past competition entries** if you skipped it at sign-up.

We require user confirmation rather than auto-matching because two athletes can genuinely share a name; you decide which entries are yours.

**If you need a result fully removed** (safeguarding, child protection, court order, mistaken identity) — contact your federation first, and us at [privacy@your-domain.example]. We'll work with the organisation that ran the event.

## 8. Security

- Passwords stored with bcrypt; never readable.
- 2FA via TOTP with one-time recovery codes (also bcrypt-hashed).
- All traffic over HTTPS.
- Per-session JWT with a version stamp — an admin (or you, via account-delete) can invalidate every active session in one operation.
- Rate limiting on login, password reset, and bulk-write endpoints.
- Strict Content-Security-Policy (no third-party scripts, no inline JavaScript).
- Audit log on every privileged action.

No service can promise absolute security. Keep your password strong, turn 2FA on, and tell us at [privacy@your-domain.example] if you suspect unauthorised access.

## 9. Children and minors

Diving is a youth sport. Children compete on DivingHQ through their federation or club, which is responsible for obtaining the necessary parental consents.

A child shouldn't sign up directly without their parent or guardian's involvement. If you believe a child has signed up directly without consent, contact us at [privacy@your-domain.example] and we'll remove the account.

## 10. Your rights

You can:

- **Access** the data we hold about you — download a copy from your profile (or email us).
- **Correct** anything wrong — most fields are self-service from your profile; email us for the rest.
- **Delete** your account at any time (see §7).
- **Object** to specific processing — contact us.
- **Complain** to a privacy regulator if you're not satisfied with our response.

Email [privacy@your-domain.example] for any of these. We'll verify it's really you before acting and respond within 30 days.

## 11. Data breaches

If your data is exposed, we will:

1. Contain and investigate within 24 hours of detection.
2. Notify affected users + the affected federation's nominated administrator within 72 hours of confirming personal data was exposed.
3. Notify the relevant privacy regulator within whichever timeframe applies (e.g. 72 hours under GDPR).
4. Publish a public post-incident summary at [https://your-domain.example]/security once remediation is complete.

## 12. Changes

We may update this policy. If the change is material — new data category, new third party, change to your rights — we'll notify account holders by email before it takes effect. The "Last updated" date above shows the most recent change.

## 13. Contact

Privacy questions, deletion requests, complaints, child-safeguarding concerns:

**[Legal entity name]**
[Physical mailing address]
[privacy@your-domain.example]
