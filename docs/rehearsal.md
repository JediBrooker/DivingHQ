# Rehearsing a meet on the live site

A checklist for running one real meet end to end on divinghq.app, with real
phones as judges, in a throwaway country that gets deleted afterwards. The
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
| Accounts | `rehearsal-admin` (club admin), `rehearsal-judge1` to `rehearsal-judge5`, `rehearsal-referee` (granted in the sysadmin's name, the only way a referee is allowed in an unclaimed country), `rehearsal-diver1` to `rehearsal-diver4` (two women, two men, adults). All email-verified, all on one random password printed once |
| Meet | "DivingHQ Rehearsal Meet", hosted by the club, representing divers by club |
| Event | "Rehearsal Mixed 3m Springboard": individual, 3m, 5 judges, 3 rounds, referee sign-off enforced. Judges seated J1 to J5 in order |
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
  - 5 phones for the judges. Browser profiles work too, but each judge needs
    its own profile or device, since private windows in one browser share a
    sign-in
  - 1 phone for the referee
  - 1 phone for a spectator, not signed in
  - optional: a TV or second laptop for the broadcast view, a phone for a diver
- [ ] Where will you be? Ideally on the kind of venue Wi-Fi a real meet has.
      Put at least one judge on mobile data too.
- [ ] Email works on the box (`CF_ACCOUNT_ID` and `CF_EMAIL_TOKEN` in `.env`),
      otherwise no live or results emails will go out.
- [ ] Push works (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `.env`) if you
      want to try the referee's sign-off by push. The handoff code works
      without it.
- [ ] PDF fonts are installed, or the Chinese name prints as `?`:
      `ls /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`
      (README, Self-hosting, PDF fonts).
- [ ] Preflight, read only:

  ```bash
  ssh root@jedibrooker "pct exec 117 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js status'"
  ```

  It should end with `Seed in ESH: free to go.`
- [ ] Back up the database. Seed and cleanup write straight to the live one, so
      take a dump inside the container first (and again right before cleanup):

  ```bash
  ssh root@jedibrooker "pct exec 117 -- bash -lc 'mkdir -p ~/backups && su postgres -c \"pg_dump -Fc diving_app\" > ~/backups/pre-rehearsal-\$(date -u +%Y%m%dT%H%M%SZ).dump && ls -lh ~/backups | tail -3'"
  ```

  The newest file shouldn't be tiny; `df -h ~` on the box shows the room left,
  and old dumps can go once the rehearsal is cleaned up. A restore is the last
  resort: it rewinds every org on the site to that moment, not just the
  rehearsal.

## Seed

On the box, with your own address so the emails reach you (every account gets
a plus-addressed copy of it, `you+rehearsal-diver1@example.com` and so on):

```bash
ssh root@jedibrooker "pct exec 117 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js seed --email you@example.com'"
```

Or interactively: `ssh root@jedibrooker`, `pct enter 117`,
`cd ~/DiveRecorder`, `node scripts/rehearsal.js seed --email you@example.com`.

Options: `--country XXX` for another catalogue country, `--start
2026-10-04T10:00+11:00` if you seed the night before (the default is the next
quarter hour at least 30 minutes out; it only sets what the schedule shows).
`--start` has to carry the venue's UTC offset: the script would read a bare
`10:00` in the box's own timezone (the live box runs on Sydney time; `date`
on the box tells you), not yours. Mind daylight saving: Sydney is +10:00 until the first
Sunday in October and +11:00 from then. Without `--start`, the meet's date is
the box's date, which can be yesterday for you if you seed early in the morning
in Australia. Without `--email` the
accounts get `@example.invalid` addresses and no email arrives anywhere.

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

## During

1. **Laptop**: sign in as `rehearsal-admin`, open the Control Room URL the seed
   printed (`/control?event=...`).
2. **Judges**: each phone signs in as `rehearsal-judge1` to `rehearsal-judge5`
   and opens `/judge`. Before the start it says it's waiting and shows only
   the judge's name; leave it there. When the event starts the phone picks it
   up by itself (a few seconds at most, no reload or tap), and the judge
   number shows next to the name with the first diver. Check each phone shows
   the right one then.
3. **Pre-meet steps** in the Control Room:
   - check in all four divers
   - randomise the start order
   - referee sign-off. It's enforced, so the operator can't just tick it.
     Either send the request to Rehearsal Referee (their phone gets a
     notification with Approve, if push is set up), generate a handoff code
     that the referee types at `/sign-off-codes` on their phone, or let the
     referee sign in on the laptop. Try at least two of these.
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
   The chip reads "ESH record" (the national book) and is marked Unofficial;
   hover or long-press it for the `RHSL` club record and the previous mark.
   Chips show on the spectator scoreboard only, not on the broadcast view.
7. **Broadcast view** on the TV: `/scoreboard/<event>/broadcast`.
8. Try the awkward bits while you're here: a referee call (failed dive or
   redive), a score correction (click the dive in the Control Room's History
   column), a judge who reloads mid dive. Correct one of the middle scores,
   not the highest or lowest: those are dropped, so changing one may not move
   the total at all.
9. **Finish the event.** The four results emails should arrive.
10. **Results PDF**: `/api/events/<event>/results.pdf`. 陈美玲 should print in
    Chinese and Иван Петров in Cyrillic. `?` or "Ivan Petrov" means the Noto
    fonts aren't on the box.
11. **Records**: `/records`, pick "DivingHQ Rehearsal · ESH" in the country
    picker. The national book opens on Women (the 105B mark); switch to Men
    for the 107C. For the club book use the Club tab and pick DivingHQ
    Rehearsal Club.
12. Optional: a diver phone signed in as `rehearsal-diver1` at
    `/me/meet/<event>`.

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
- **Reloads.** Refresh the Control Room laptop mid round. The live state should
  come back.
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
ssh root@jedibrooker "pct exec 117 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js cleanup --dry-run'"
ssh root@jedibrooker "pct exec 117 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js cleanup'"
ssh root@jedibrooker "pct exec 117 -- bash -lc 'cd ~/DiveRecorder && node scripts/rehearsal.js status'"
```

(Add `--country XXX` if you seeded somewhere else. Without it cleanup takes
out every rehearsal org there is, and only those.)

Cleanup runs in one transaction and prints a count per table. It removes the
organisation, club, accounts, roles, meet, event, dive lists, scores, check-in,
sign-off requests, records and their history, notifications (including ones
sent to people outside the rehearsal about the event, the sysadmin for
instance), push subscriptions, idempotency keys and the audit rows for all of
it. It only touches the rehearsal organisation and the eleven accounts seed
made in it, by exact username (anyone can sign up as `rehearsal-something`, so
the prefix alone doesn't count). Running it again when there's nothing left is
fine; it says so.

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
