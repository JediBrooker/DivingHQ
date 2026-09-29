# divinghq-watch: external uptime and ops alerts

A Cloudflare Worker that checks divinghq.app from outside every 2 minutes
and emails you when something needs a person. It lives off the box on
purpose. A box that's down, out of disk or wedged can't report on
itself, and a backup job that silently stopped running never says a word.

Nothing in here runs until someone deploys it (steps below). The Worker
has no npm dependencies: `src/` is plain ESM that wrangler bundles as is.

| File | What it does |
|---|---|
| `wrangler.toml` | Name, cron, vars, the KV and email bindings |
| `src/index.js` | Entry point. The only file that imports `cloudflare:email` |
| `src/watch.js` | The I/O: probes, KV, sending, retries, `GET /` and `GET /test-alert` |
| `src/evaluate.js` | The rules. One pure function, `evaluate(prevState, observations, now)` |
| `src/mime.js` | Builds the plain-text email by hand (RFC 5322, CRLF, encoded subjects) |
| `src/format.js` | Durations and times for the email text |

Tests: `node --test test/watch-evaluate.test.js test/watch-worker.test.js`
(both run in `npm run test:safe` too).

## What it checks

Each run fetches `$TARGET/api/health` and `$TARGET/api/ops/status`, 10 s
timeout each, then runs these rules:

| Rule | Fires when | Then |
|---|---|---|
| **DOWN** | `/api/health` isn't a 200 with `ok: true` (or times out) on 2 runs in a row | Reminder hourly while down, one "back up after N min" note when it passes again |
| **DB** | `/api/ops/status` says `ok: false` on 2 runs in a row | Same as DOWN |
| **BACKUP** | `backup.last_ok` is false, or `last_success_at` is older than 26 h | At most every 12 h, a "backups OK again" note once a good one lands |
| **OFFSITE** | `backup.offsite` is `failed` | At most every 12 h, a note when it's `ok` again |
| | `backup.offsite` is `not_configured` | Reminder at most weekly |
| **RESTORE** | `restore_check.ok` is false, or `last_run_at` is older than 8 days | At most daily, a note when it passes again |
| **DEPLOY** | `deploy.ok` is false | Once per distinct (`last_at`, `sha`) |
| **ERRORS** | `errors.server_errors` >= 20 and >= 5% of `errors.requests` | At most hourly |
| **STATUS** | `/api/ops/status` unreadable for an hour while health passes | At most daily |

A few behaviours worth knowing:

* **One blip isn't an outage.** DOWN and DB want two failed runs in a
  row (so 2 to 4 minutes), which rides out a `pm2 restart` during a deploy.
* **Unreadable status means "don't know", not "broken".** When
  `/api/ops/status` times out, 404s or returns junk, the DB, backup,
  restore, deploy and error checks hold still: no alerts, no recovery
  notes, nothing reset. The STATUS note is there so the watcher can't go
  quietly blind to backups for weeks.
* **"Never" gets the same grace as "late".** If `backup.json` has never
  recorded a success, the 26 h starts when the watcher first saw that, so
  a fresh install doesn't page before the first nightly run. The same goes
  for the restore check and its 8 days.
* **One email per run.** A database outage trips DOWN and DB together, a
  failed backup usually fails the offsite copy too. Whatever fires in a
  run goes out as one email with all the tags in the subject, e.g.
  `[DivingHQ] DOWN, database down`.
* **A failed send is retried.** If the email binding throws, the alerts
  wait in KV and go out with the next run's email (marked as delayed), for
  up to 6 hours. The failed run also shows as an error in the Worker's cron
  history.
* **KV writes stay low.** State is only written when something that
  matters changes, plus a heartbeat every 30 minutes. A quiet day is about
  50 writes, well under the free plan's 1,000.
* **Recovery notes need proof.** "Backups OK again" waits for a success
  newer than the one on record when the trouble started, and "restore
  check OK again" for a newer run that said `ok: true`. A state file that
  goes missing clears nothing.

Subjects are short so they read on a lock screen: `[DivingHQ] DOWN`,
`[DivingHQ] still DOWN (1 h 2 min)`, `[DivingHQ] back up after 12 min`,
`[DivingHQ] backup failed`, `[DivingHQ] deploy failed (abc1234)`,
`[DivingHQ] 5xx spike: 42 of 310 requests`. Bodies say what's wrong, since
when, and what to look at (the backup runbook in `ops/backups/README.md`,
`pm2 logs dive-recorder`, the deploy output). Times are shown in
`TIME_ZONE` (Sydney) with UTC alongside.

The thresholds live in `LIMITS` at the top of `src/evaluate.js`. If you
change the cron, also change the "every 2 minutes" wording in that file.

## Deploy

You need Node 22 and a Cloudflare login with access to the account that
holds divinghq.app. Any machine works, it doesn't have to be the box.

Before the first deploy, make sure the server side is live: production
must answer `GET https://divinghq.app/api/ops/status` with the JSON above
(otherwise the watcher sends the "status endpoint unreachable" note after
an hour, correctly).

```bash
cd ops/watch

# 1. Sign in (opens a browser). Skip if CLOUDFLARE_API_TOKEN is set.
npx wrangler@4 login

# 2. Create the KV namespace that holds the watcher's state.
npx wrangler@4 kv namespace create WATCH_STATE
#    It prints an id. Paste it into wrangler.toml in place of
#    REPLACE_WITH_KV_NAMESPACE_ID and commit that change (the id isn't
#    a secret, and later deploys need it).

# 3. Deploy.
npx wrangler@4 deploy
```

The email side needs no setup beyond what's there already: Email Routing
is on for the divinghq.app zone and the recipient is a verified
destination address. If `deploy` complains about the `send_email`
binding, check both in the dashboard under Email Service, Email Routing.

### Check it works

```bash
# State after the first cron run (give it 2 minutes). The URL is printed
# by `wrangler deploy`: https://divinghq-watch.<your-subdomain>.workers.dev
curl https://divinghq-watch.<your-subdomain>.workers.dev/

# Live logs, one line per email sent or failure.
npx wrangler@4 tail

# Optional: send yourself a test email.
npx wrangler@4 secret put TEST_KEY          # paste a long random string
curl "https://divinghq-watch.<your-subdomain>.workers.dev/test-alert?key=<that string>"
npx wrangler@4 secret delete TEST_KEY       # when you're done, if you like
```

Without `TEST_KEY` set, `/test-alert` is a 404, and so is a wrong key.
The key rides in the query string, so it ends up in the Worker's request
logs; use a throwaway value.

If the test email lands in spam, add a Gmail filter for
`from:alerts@divinghq.app` with "Never send it to Spam".

## Change the recipient

1. Add the new address in the dashboard under Email Service, Email
   Routing, Destination addresses, and click the link in the
   verification email. Cloudflare refuses to send to unverified addresses.
2. In `wrangler.toml`, change **both** `destination_address` (under
   `[[send_email]]`, the one Cloudflare enforces) and `ALERT_TO` (the To:
   header). A test checks they match.
3. `npx wrangler@4 deploy`.

To watch a different site (a staging box, say), change `TARGET`.

## Pause it

* **For a while** (planned maintenance, a migration): set
  `crons = []` in `wrangler.toml` and `npx wrangler@4 deploy`. Put the
  schedule back and deploy again to resume. Removing the cron in the
  dashboard works too, but the next `wrangler deploy` restores it.
  If the downtime is short you can also just leave it on: you'll get a
  DOWN and a "back up after" email and nothing else.
* **For good**: `npx wrangler@4 delete` removes the Worker, then
  `npx wrangler@4 kv namespace delete --binding WATCH_STATE` removes its
  state.

## Known limits

* It watches from Cloudflare, so a Cloudflare-wide outage takes out the
  site and the watcher (and the email) together. You'd hear about that
  one from the news.
* KV is eventually consistent and cron runs can land in different data
  centres, so very rarely a reminder may go out twice.
* If DOWN alerts arrive while the site works fine from your browser,
  look at Security, Events in the dashboard for blocked requests with the
  user agent `divinghq-watch/1`; a Bot Fight Mode or WAF rule may be
  challenging the Worker. A skip rule for `/api/health` and
  `/api/ops/status` fixes it.
* One recipient. For more, switch the binding to
  `allowed_destination_addresses` and send one message per address.
