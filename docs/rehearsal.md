# Rehearsing a meet on the live site

A checklist for running one real meet end to end on divinghq.app, with real
phones as judges, in a throwaway country that gets deleted afterwards. On
your own, with one phone and a laptop, see
[Rehearsing alone](#rehearsing-alone-one-laptop-and-one-phone). The
kit is `scripts/rehearsal.js`. It writes straight to the production database
from the box, so nobody has to sign up or click through the site to set it
up, and it takes every trace back out when you're done.

## What the kit makes

`node scripts/rehearsal.js seed` creates, in one transaction:

| | |
|---|---|
| Country | Western Sahara (`ESH`) unless you pass `--country`. It's in `lib/countries.json`, has no World Aquatics federation, and no test uses it. Antarctica, Bouvet Island and Heard Island aren't in the catalogue, so they can't be used. |
| Organisation | "DivingHQ Rehearsal", unclaimed (the club-first shape: a club admin runs the meet, nobody holds org admin), no continent so no continental record book can be touched |
| Club | "DivingHQ Rehearsal Club", short code `RHSL` |
| Accounts | `rehearsal-admin` (club admin), `rehearsal-judge1` to `rehearsal-judge5` (or as many as `--judges` asks for: 3, 7, 9 or 11), `rehearsal-referee` (granted in the sysadmin's name, the only way a referee is allowed in an unclaimed country), `rehearsal-diver1` to `rehearsal-diver4` (two women, two men, adults). All email-verified, all on one random password printed once |
| Meet | "DivingHQ Rehearsal Meet", hosted by the club, representing divers by club |
| Event | "Rehearsal Mixed 3m Springboard": individual, 3m, 5 judges (`--judges` again), 3 rounds, referee sign-off enforced. Judges seated J1, J2 and so on in order |
| Dive lists | Valid lists from the core directory, checked by the same code the diver portal uses |

The divers are Zoë Ångström, 陈美玲, Иван Петров and Liam O'Connor, so the
results PDF has to print Chinese and Cyrillic. The two women both dive 105B in
round 1 and the two men both dive 107C, which is how you get a record chip:
the chip only shows when a dive beats a standing record, and in a brand new
club the first dive of anything is a first mark.

The event is **not** flagged as a rehearsal event (`is_rehearsal`), because
that flag turns off the live and results emails and record setting, and those
are the things you want to see working. While it's Live it shows on the
public live list like any other meet.

## Before

- [ ] Pick a time with no live meets. Check the dashboard and
      `https://divinghq.app/scoreboard` for anything Live or starting soon.
- [ ] Make sure the box runs a build that has `scripts/rehearsal.js`
      (deploy the latest `main` with `./deploy.sh` if not).
- [ ] Devices:
  - a laptop for the Control Room
  - a phone for each judge, 5 with the default panel. Browser profiles work
    too, but each judge needs its own browser, profile or device, since the
    windows of one browser (private ones included) share a sign-in. Any
    iPhone from the SE up fits the whole judge pad. On an SE in Safari, or
    the first SE, the panel's tiles under the diver scroll inside the
    header; the keypad, Submit and Signal Referee stay on screen
  - 1 phone for the referee
  - 1 phone for a spectator, not signed in
  - optional: a TV or second laptop for the broadcast view, a phone for a diver
- [ ] Where will you be? Ideally on the kind of venue Wi-Fi a real meet has.
      Put at least one judge on mobile data too.
- [ ] Email works on the box (`CF_ACCOUNT_ID` and `CF_EMAIL_TOKEN` in `.env`),
      otherwise no live or results emails will go out.
- [ ] Push (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `.env`) is only for the
      phone-level notification the referee gets for a sign-off request. Send
      sign-off request, the Approve/Deny banner in the app and the request
      under Waiting for you on their dashboard all work over the app's own
      connection without it, and so does the handoff code.
- [ ] PDF fonts are installed, or the Chinese name prints as `?`:
      `ls /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`
      (README, Self-hosting, PDF fonts).

The production host was verified on 8 October 2026 at Tailscale address
`100.106.112.107` (`jedibrooker`), with DivingHQ in **LXC 120**
(`divinghq`), checkout `/root/DiveRecorder`. LXC 117 belongs to another service.
Confirm `pct list` before operating if the host layout changes; the short host
name may resolve outside the tailnet.

- [ ] Preflight, read only:

  ```bash
  ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js status'"
  ```

  It should end with `Seed in ESH: free to go.`
- [ ] Back up the database. Seed and cleanup write straight to the live one, so
      take a dump inside the container first (and again right before cleanup):

  ```bash
  ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'mkdir -p ~/backups && su postgres -c \"pg_dump -Fc diving_app\" > ~/backups/pre-rehearsal-\$(date -u +%Y%m%dT%H%M%SZ).dump && ls -lh ~/backups | tail -3'"
  ```

  The newest file shouldn't be tiny; `df -h ~` on the box shows the room left,
  and old dumps can go once the rehearsal is cleaned up. A restore is the last
  resort: it rewinds every org on the site to that moment, not just the
  rehearsal.

## Seed

On the box, with your own address so the emails reach you (every account gets
a plus-addressed copy of it, `you+rehearsal-diver1@example.com` and so on):

```bash
ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js seed --email you@example.com'"
```

Or interactively: `ssh root@100.106.112.107`, `pct enter 120`,
`cd ~/DiveRecorder`, `node scripts/rehearsal.js seed --email you@example.com`.

Options: `--country XXX` for another catalogue country; `--judges 3` (or 7, 9,
11) for a different panel, five by default; `--start 2026-10-04T10:00+11:00`
if you seed the night before (the default is the next quarter hour at least 30
minutes out; it only sets what the schedule shows).

The script reads times and dates in the box's own timezone, and the live box
runs on Sydney time (`date` on the box tells you). So `--start` has to carry
the venue's UTC offset: a bare `10:00` would be Sydney's 10:00, not yours.
Mind daylight saving: Sydney is +10:00 until the first Sunday in October and
+11:00 from then. Without `--start`, the meet's date is the box's date, which
is Sydney's today: right for a rehearsal on the east coast of Australia, a day
out wherever it's still yesterday or already tomorrow, so pass `--start`
there. Without `--email` the accounts get `@example.invalid` addresses and no
email arrives anywhere.

It prints the password **once**, then every username with its role, the dive
lists, and the URLs. Write the password where the judges can see it (it's
lowercase with dashes, easy on a phone keyboard). It isn't stored anywhere, so
if you lose it, clean up and seed again.

Seed refuses, and changes nothing, when:

- a rehearsal is already seeded (in any country): run cleanup first. It
  won't re-seed on top, since that would mean resetting the password on phones
  that are already signed in.
- the country already has an organisation of any kind, since real people may
  be in it. Pick another `--country`.
- one of the `rehearsal-*` usernames is taken, or there's no active sysadmin to
  grant the referee role in the name of.

## Rehearsing alone: one laptop and one phone

Five judge phones, a referee and a spectator take a few people. On your own,
seed a three-judge panel and let browsers on the laptop be most of them:

```bash
ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js seed --judges 3 --email you@example.com'"
```

Each role needs its own sign-in, and every window of one browser shares one
(Chrome's incognito windows share one between them too), so it's one browser
each:

| Device | Signed in as | Open |
|---|---|---|
| Your iPhone, in Safari | `rehearsal-judge1` | `/judge`. This is the real-phone check: the keypad, Submit and Signal Referee on an actual iPhone, its screen locking, its mobile data |
| Laptop, Chrome | `rehearsal-admin` | the Control Room URL the seed printed |
| Laptop, a Chrome incognito window | `rehearsal-judge2` | `/judge` |
| Laptop, Safari | `rehearsal-judge3` | `/judge` |
| Laptop, Firefox | `rehearsal-referee`, then signed out | the sign-off in step 3, then `/scoreboard/<event>` as the spectator for the rest |

Not on a Mac? A second Chrome profile, or Edge, does for Safari. Tile the two
laptop judges side by side so you can score both without hunting for windows,
and give the phone its score first: it's the one that matters. Then follow
During as written, with these differences:

- Step 2 is three judges: the phone and two windows.
- Step 3: send the sign-off request from Chrome and answer it in Firefox (the
  banner comes up in the app), or type the handoff code there. Then sign out of
  Firefox and open the scoreboard in it.
- Step 8: with three judges nothing is dropped, every score counts, so
  correcting any of them moves the total.
- The divers are optional as ever. A spare Chrome profile can be
  `rehearsal-diver1` on `/me/meet/<event>`.

What it still can't tell you:

- **Several real phones at once.** One phone tests one radio. Five phones on
  the same Wi-Fi, each locking and waking on its own, five judges submitting
  in the same second over a patchy signal, only happen with five phones.
- **Venue Wi-Fi.** Captive portals, client isolation, a network that drops
  websockets. Your home or office network says nothing about the pool's. Take
  the laptop and phone there if you can.
- **Other phones.** Yours is one size and one browser. The small iPhones are
  covered by the e2e suite in WebKit; an Android phone isn't.

## During

1. **Laptop**: sign in as `rehearsal-admin`, open the Control Room URL the seed
   printed (`/control?event=...`).
2. **Judges**: each phone signs in as `rehearsal-judge1`, `rehearsal-judge2`
   and so on (to `rehearsal-judge5` with the default panel) and opens
   `/judge`. Before the start it says it's waiting and shows only the judge's
   name; leave it there. When the event starts the phone picks it up by itself
   (a few seconds at most, no reload or tap), and the judge number shows next
   to the name with the first diver. Check each phone shows the right one
   then.
3. **Pre-meet steps** in the Control Room:
   - check in all four divers
   - randomise the start order. After the five second draw the dialog shows
     the drawn order with Re-shuffle and Confirm dive order; once confirmed,
     the order stays listed under the Setup checklist for the referee to
     check.
   - referee sign-off. It's enforced, so the operator can't just tick it.
     Either send the request to Rehearsal Referee (an Approve/Deny banner
     comes up in the app on their phone, as a phone notification too if push
     is set up, and the request is under Waiting for you on their dashboard
     with a Sign off button), generate a handoff code that the referee types
     at `/sign-off-codes` on their phone, or let the referee sign in on the
     laptop. Whichever way the referee opens the request, they should see the
     drawn order they're approving. The laptop's dialog closes by itself
     within a few seconds of the referee answering, with no reload, and the
     button moves on to Start Event. The first approval completes the step,
     so to try a second way have the referee Deny the first request (the
     dialog says so and lets you pick another way), or press Cancel request
     in the dialog, then sign off another way. Cancelling takes the request
     off the referee's phone too: check the banner goes. A request nobody
     answers lapses after 5 minutes; the dialog says so and asks you to send
     a new one, and the checklist goes back to sending one. That's worth
     seeing once, but it's a 5 minute wait, so leave one running while you
     do the check-in.
4. **Start the event.** The four "is live" emails should arrive
   (`you+rehearsal-diver1@...` to `diver4`). Judges who allowed notifications
   get "Judging panel is live" as a phone notification. A phone that already
   has `/judge` open moves to the first diver instead and shows no banner in
   the app for it; any other banner on the judge screen appears at the top,
   never over the keypad or Submit.
5. **Run all three rounds.** Start puts the first diver up by itself; judges
   score on their phones, and **Next Diver** in the Control Room moves on
   (at the end of the list it becomes Finalise, then the review screen).
   Scores reach the scoreboard as soon as the panel is in, there's no
   separate announce step; the Standings column's Announce button only
   pushes the standings graphic. In round 1, score whichever woman dives
   105B second higher than the first, same for the men's 107C.
6. **Spectator phone** on `/scoreboard/<event>`: scores should land without a
   refresh, standings reorder, and the second 105B and 107C get a record chip.
   The chip reads "ESH record" (the national book), in grey rather than amber
   because nobody has claimed the country, so the record is unofficial. Tap it
   on the phone (hover on a laptop) for the details: the `RHSL` club record,
   the mark it beat, and "Unofficial". Chips show on the spectator scoreboard
   only, not on the broadcast view. Open or reload the scoreboard mid-dive
   as well: the judges' scores already in for that dive should be there, and
   the dive total once the panel is complete.
7. **Broadcast view** on the TV: `/scoreboard/<event>/broadcast`.
8. Try the awkward bits while you're here: a referee call (failed dive,
   redive, or a cap), a score correction (click the dive in the Control Room's
   History column), a judge who reloads mid dive. For the correction, the
   highest and lowest scores are dropped (with five judges), so a change can
   leave the total where it was: raise one of three tied 6.0s to 7.0 and it
   just becomes the dropped highest. Lower a score by 0.5 instead, one that
   isn't the single highest, keeping it no lower than the lowest, and check
   the dive's total in History moves. With three judges nothing is dropped and
   any correction moves it. A judge who reloads after scoring should come back
   to their score on screen, their tile filled and the keypad shut, the same
   as right after Submit.
9. **Finish the event.** The four results emails should arrive, and every
   judge phone should drop the diver, lock its keypad and say "Event
   finished" within a second or two. One that still shows Submit lit is a
   bug. A score that arrives after the finish should come back as "wasn't
   recorded" with the score shown, not as a failed or queued chip. On a
   connected phone you can't beat the finish to it, so make one: on the last
   dive, once a judge has scored, have them tap Signal Referee (which opens
   their keypad again) and put that phone in airplane mode. Finalise, then
   enter a score on the phone and tap Submit (it queues), and take it out of
   airplane mode.
10. **Results PDF**: `/api/events/<event>/results.pdf`. 陈美玲 should print in
    Chinese and Иван Петров in Cyrillic. `?` or "Ivan Petrov" means the Noto
    fonts aren't on the box.
11. **Records**: `/records`, pick "DivingHQ Rehearsal · ESH" in the country
    picker. The national book opens on Women (the 105B mark); switch to Men
    for the 107C. For the club book use the Club tab and pick DivingHQ
    Rehearsal Club.
12. Optional: a diver phone signed in as `rehearsal-diver1` at
    `/me/meet/<event>`, open from before the start to after the finish. Until
    Zoë has a score of her own it shows no place and "No score yet", not a
    lead or any medal "Already achieved". "N divers until you're up" counts
    down through the order and carries on across a round change: with her
    own dive just scored, it's whoever is left in that round plus whoever is
    ahead of her in the next (3 if she dives last of four). When the event is
    finalised the page says COMPLETED by itself, no reload.

`node scripts/rehearsal.js status` is safe to run at any point; it shows what's
there, how many scores and records, and whether cleanup would refuse.

## What to watch for

- **Latency.** Time from a judge tapping submit to the score showing in the
  Control Room and on the spectator phone. About a second is normal; note
  anything past two or three.
- **Phones going to sleep.** Let a judge's screen lock for a minute mid round,
  then unlock: the judge screen should reconnect and show the current diver.
  Put one phone in airplane mode, score, turn it back on, and check the score
  arrives.
- **Reloads.** Refresh the Control Room laptop mid round, once just after
  Next Diver and once mid-dive with part of the panel in. Either way the
  diver comes back with the judges' tiles that are already in, and Next Diver
  (Finalise on the last dive) arms as soon as the rest of the panel lands.
  Opening the Control Room in a second browser mid-dive should look the same.
  A spectator who opens or reloads the scoreboard mid-dive sees the scores
  already in too.
- **Undo on finalise.** The "Finalised" message has an Undo for 12 seconds.
  It puts the event back to Live with the last diver up again on the judges'
  phones (after a moment on "Event finished") and the scoreboard, never
  round 1 diver 1, and a reload after it keeps the diver, their scores and a
  working Finalise. Divers don't get a second "is live" email. The finalise
  dialog says an org admin can put it back from the Meet Manager; the
  rehearsal has no org admin, and the one who can is `rehearsal-admin`, as the
  event's manager. That way back doesn't put the last diver up on the judges'
  phones the way Undo does, so it's for finalising again, not for scoring on.
- **Small phones.** On every phone the keypad, Submit and Signal Referee
  should be on screen without scrolling, with or without another judge's
  "flagged the referee" in the panel's label row. Only on the smallest (an
  iPhone SE in Safari, the first SE) do the panel's tiles scroll inside the
  header. A key, Submit or Signal Referee below the fold is a bug.
- **Venue Wi-Fi.** Captive portals that expire, client isolation, a network
  that drops websockets. If a phone keeps reconnecting on Wi-Fi but is fine on
  mobile data, it's the network.
- **"Too many attempts" at sign-in.** Every phone on the venue Wi-Fi shares one
  public address, and 20 wrong passwords from it in 15 minutes locks sign-in for
  everyone there for 15 minutes (successful sign-ins don't count). If it happens
  after only a few mistakes, the box may not be seeing real client addresses
  behind the tunnel (`TRUST_PROXY`), which is worth fixing before a real meet.
- **Cloudflare challenges.** A phone that gets a Cloudflare challenge page
  instead of the app means a security setting is catching real users; check
  Security > Events in the Cloudflare dashboard for the zone.
- **Server errors.** On the box: `pm2 logs dive-recorder --lines 200`.
- **Emails in spam.** If the live or results emails don't show up, check spam
  before anything else.

## Cleanup

Take the second dump first (the backup command under Before). Then look, then
do it, then check:

```bash
ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js cleanup --dry-run'"
ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js cleanup'"
ssh root@100.106.112.107 "pct exec 120 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js status'"
```

(Add `--country XXX` if you seeded somewhere else. Without it cleanup takes
out every rehearsal org there is, and only those.)

Cleanup runs in one transaction and prints a count per table. It removes the
organisation, club, accounts, roles, meet, event, dive lists, scores, check-in,
sign-off requests, records and their history, notifications (including ones
sent to people outside the rehearsal about the event, the sysadmin for
instance), push subscriptions, idempotency keys and the audit rows for all of
it. It only touches the rehearsal organisation and the accounts seed made in
it (eleven with five judges): by exact username, since anyone can sign up as
`rehearsal-something`, and only accounts created along with the organisation,
since with three judges someone could sign up as `rehearsal-judge4`. Running
it again when there's nothing left is fine; it says so.

It refuses, and deletes nothing, when:

- **someone else is in the organisation.** Anyone who signed up in Western
  Sahara while the rehearsal was up joined it. The refusal lists them. Decide
  what to do with each (they're a real person), move or delete them by hand,
  then run cleanup again. A rehearsal account deleted through the app also
  shows up here, since deleting renames it, so don't delete them that way.
- **the rehearsal reaches into something real.** A rehearsal account on another
  event's panel or start list, with scores or dive-offs there, or on another
  org's team; another org's event filed under the rehearsal meet; or somebody
  else's open claim on the organisation. Deleting the account would cascade
  that event's scores away, so it stops and lists what it found. Take the
  rehearsal accounts off those events (or decide the claim) by hand first.
- **there's a payment or payout on it.** That's money: refund or reconcile it in
  Stripe and remove the row by hand first. With payments switched off this
  can't happen.

After cleanup, phones that are still signed in get signed out on their next
request. The daily audit snapshot (`AUDIT_SNAPSHOT_DIR`) may already hold copies
of the rehearsal's audit rows; that's the retention copy and stays as it is.
If cleanup warns that records outside the rehearsal were touched (it can't with
the seed as shipped), run `node scripts/rebuild-records.js` and then again
with `--apply`.
