# divinghq-watch: external uptime and ops alerts

A Cloudflare Worker that checks divinghq.app from outside every 2 minutes
and emails you when something needs a person (or pushes to ntfy, see
[Alerts by ntfy](#alerts-by-ntfy), though that's off on the live Worker).

**Gatus does the quick up/down pushes.** Gatus on the home network (CT
121 on the Proxmox host, `/opt/monitoring/gatus/config.yaml`) checks
`/api/health` and `/api/ops/status` every minute through Cloudflare and
pushes to ntfy after 3 failures, posting from the home IP where ntfy.sh's
quota is fine. So this Worker runs with `DOWN_ALERT_AFTER_MIN = "15"`: a
blip is Gatus's to report, and the Worker only emails about DOWN or the
database once an outage passes 15 minutes. That's also the case Gatus can't
handle, the home line itself being down. Backups, deploys, errors and the
rest are the Worker's alone and email straight away, as before. It lives off the box on
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
| `src/ntfy.js` | The same alerts as an ntfy push, with a priority per rule |
| `src/format.js` | Durations and times for the email text |

Tests: `node --test test/watch-evaluate.test.js test/watch-worker.test.js`
(both run in `npm run test:safe` too).

## What it checks

Each run fetches `$TARGET/api/health` and `$TARGET/api/ops/status`, 10 s
timeout each. A fetch that got lost on the way (a timeout, a network error, or
a 502, 504 or 520-530 that Cloudflare or the tunnel made up) is tried twice
more, 5 s apart, before the run counts it as failed. Then it runs these rules:

| Rule | Fires when | Then |
|---|---|---|
| **DOWN** | `/api/health` isn't a 200 with `ok: true` (or times out) on 2 runs in a row (or for `DOWN_ALERT_AFTER_MIN` minutes when that's set; DB too) | Reminder hourly while down, one "back up after N min" note when it passes again |
| **DB** | `/api/ops/status` says `ok: false` on 2 runs in a row | Same as DOWN |
| **BACKUP** | `backup.last_ok` is false, or `last_success_at` is older than 26 h | At most every 12 h, a "backups OK again" note once a good one lands |
| **OFFSITE** | `backup.offsite` is `failed` | At most every 12 h, a note when it's `ok` again |
| | `backup.offsite` is `not_configured` | Reminder at most weekly |
| **RESTORE** | `restore_check.ok` is false, or `last_run_at` is older than 8 days | At most daily, a note when it passes again |
| **DEPLOY** | `deploy.ok` is false | Once per distinct (`last_at`, `sha`) |
| **ERRORS** | `errors.server_errors` >= 20 and >= 5% of `errors.requests` | At most hourly |
| **STATUS** | `/api/ops/status` unreadable for an hour while health passes | At most daily |
| **FLAKY** | 5 or more runs in the last hour lost requests on the way in (health retried, through or not; status through on a retry) without DOWN going out | At most every 12 h, only on a run where health passes |

A few behaviours worth knowing:

* **One blip isn't an outage.** Each fetch gets three tries, 5 s apart, so
  a request lost on a busy home line doesn't count. On top of that DOWN and
  DB want two failed runs in a row (so 2 to 4 minutes), which rides out a
  `pm2 restart` during a deploy. The email says how many tries the last
  failure took (`HTTP 520 after 3 tries`). An answer from the app itself is
  never retried, bad news included (`/api/health`'s 503 when the database
  is down, a 200 that says `ok: false`): retrying the 503 would triple the
  watcher's own share of the app's 5xx count and set off ERRORS.
* **Retries hide a sagging line from DOWN, so FLAKY watches for it.** A
  connection losing a fifth of its requests would mostly get through on a
  retry and never string two failed runs together, while visitors keep
  seeing errors. FLAKY counts the runs where health lost requests, whether
  a retry got through or all three tries were lost (bad spells last a few
  seconds and often swallow all three), plus status getting through on a
  retry, and sends one low-key note when there are 5 in an hour. Runs
  during a DOWN don't count, and status lost outright while health passes
  is the STATUS rule's, not this one's. `GET /` shows the list under
  `state.flaky.runs`. Only shaky runs change it, so a steady day costs no
  extra KV writes.
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
  50 writes, well under the free plan's 1,000, and even a site flapping
  every run can't pass 720 (one per run).
* **Recovery notes need proof.** "Backups OK again" waits for a success
  newer than the one on record when the trouble started, and "restore
  check OK again" for a newer run that said `ok: true`. A state file that
  goes missing clears nothing.
* **No KV, no run.** If reading the state from KV fails, the run stops
  there (it shows as failed in the cron history) rather than starting from
  a blank state, which would re-send every first-sight alert every 2
  minutes.

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

# 2. Only on a fresh account: create the KV namespace that holds the
#    watcher's state. (Done for divinghq.app; its id is in wrangler.toml.)
npx wrangler@4 kv namespace create WATCH_STATE
#    It prints an id. Paste it into wrangler.toml's [[kv_namespaces]] id
#    and commit that change (the id isn't a secret, and later deploys
#    need it).

# 3. Deploy, then tell it who to email. The address is a secret rather
#    than a var so it isn't in the public repo; it has to be a verified
#    Email Routing destination address on the account.
npx wrangler@4 deploy
npx wrangler@4 secret put ALERT_TO
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

## Alerts by ntfy

Set `NTFY_TOPIC` and every alert goes to ntfy instead, no email at all.
Same wording, minus the email footer, one push per run.

```bash
# Pick a topic nobody will guess: on ntfy.sh, knowing the name is all it
# takes to read (or post to) it.
echo "dhq-watch-$(openssl rand -hex 8)"

# Subscribe to it in the ntfy app on your phone first, then:
npx wrangler@4 secret put NTFY_TOPIC
# Only for a self-hosted server or a reserved topic that wants a token:
npx wrangler@4 secret put NTFY_TOKEN
```

Secrets take effect straight away. `NTFY_SERVER` in `wrangler.toml` is
`https://ntfy.sh`; point it at your own server if you run one (that one
needs a deploy). `GET /` says which channel is live (`"channel": "ntfy"`)
without showing the topic, and `/test-alert` sends a test push.

Priorities, so only an outage really buzzes:

| Priority | Alerts |
|---|---|
| 5 urgent | DOWN, database down |
| 4 high | still-down reminders, backup / offsite / restore check failed, deploy failed, 5xx spike |
| 3 default | back-up notes, overdue backups or restore checks, the test alert |
| 2 low | FLAKY, status endpoint unreachable, offsite copy not configured |

A push ntfy refuses (a 4xx, a timeout) goes out by email instead, as long
as `ALERT_TO` is still set; only when that fails too does it wait in the
outbox for the next run. To go back to email for good,
`npx wrangler@4 secret delete NTFY_TOPIC`.

**ntfy.sh needs a paid plan from a Worker.** Posts count against the
sender's IP, and Workers send from IPs shared with every other Worker, so
the daily quota is usually used up by strangers before the watcher posts
anything (the first deploy got `429 daily message quota reached`). A free
account's token doesn't change that: it still counts against the IP
(tried 9 Oct 2026, same 429). Only a paid plan gives the account its own
quota; then put its access token in `npx wrangler@4 secret put NTFY_TOKEN`.
The other way out is an ntfy server of your own, set in `NTFY_SERVER`, but
not on the box being watched: it would go down along with the site.

## Change the recipient

1. Add the new address in the dashboard under Email Service, Email
   Routing, Destination addresses, and click the link in the
   verification email. Cloudflare refuses to send to unverified addresses.
2. `npx wrangler@4 secret put ALERT_TO` and paste the new address. A
   secret takes effect straight away, no deploy needed.

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
* On the free plan the 1,000 KV writes a day are per account, shared with
  every other Worker on it, and once they're gone writes fail until 00:00
  UTC. The watcher then can't remember what it already sent: an alert that
  fires on first sight (a failed deploy, say) repeats every run, and DOWN
  can't count its second strike. `wrangler tail` shows "couldn't save
  state" when that's happening; the fix is the paid plan or finding the
  other writer.
* **520s with nothing in the app's logs** are the line between Cloudflare
  and the box, not the app. On 30 Sep 2026 a big download filled the home
  connection and requests went missing for an hour; the retries above
  hide single losses, FLAKY reports a run of them, and the tunnel (CT 100)
  was moved from QUIC to HTTP/2 with `TUNNEL_TRANSPORT_PROTOCOL=http2` in a
  systemd drop-in the same night.
* If DOWN alerts arrive while the site works fine from your browser,
  look at Security, Events in the dashboard for blocked requests with the
  user agent `divinghq-watch/1`; a Bot Fight Mode or WAF rule may be
  challenging the Worker. A skip rule for `/api/health` and
  `/api/ops/status` fixes it.
* One recipient. For more, split `ALERT_TO` on commas in `watch.js` and
  send one message per address; each has to be a verified destination.
