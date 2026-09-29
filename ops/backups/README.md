# Database backups

Nightly backups of the DivingHQ database, an encrypted copy off the box on
Cloudflare R2, a weekly check that the newest backup really restores, and a
status endpoint that tells the outside monitor how all of that is going.

Everything here runs on the app's box, as root, from cron. Nothing needs the
app to be up.

| What | When (UTC) | Script | Leaves behind |
|---|---|---|---|
| Backup | nightly 16:30 | `scripts/ops/backup-db.sh` | `/var/backups/divinghq/divinghq-<stamp>.dump`, the newest 14 kept; `divinghq/<stamp>.dump.enc` in R2; `/var/lib/divinghq/backup.json` |
| Restore check | Sundays 17:30 | `scripts/ops/restore-check.sh` | `/var/lib/divinghq/restore-check.json` |
| Deploy | whenever you run it | `deploy.sh` | `/var/lib/divinghq/deploy.json` |

16:30 UTC is 02:30 in Sydney in winter and 03:30 in summer. Both scripts log
to `/var/log/divinghq-backup.log`.

Don't deploy while the nightly dump is running (`pgrep -a pg_dump` shows
it). `pg_dump` holds a share lock on every table until it finishes. A
migration that alters a table waits behind that lock, and every app query
on the table then queues behind the migration, so the site stalls until
the dump is done.

## How it works

**backup-db.sh** takes a custom-format `pg_dump` of the app's database. It
finds the database the way the app does (`DATABASE_URL`, else the `DB_*`
settings in the app's `.env`), so it isn't tied to this box. The dump is
written under a temporary name and only becomes a backup once
`pg_restore --list` can read it back and finds `schema_meta` in it. Then:

* The newest 14 dumps are kept (`BACKUP_KEEP_LOCAL`) and older ones deleted.
  Only files named like `divinghq-20261001T163000Z.dump` are ever touched.
* If the four `R2_*` settings are in `.env`, the dump is encrypted with the
  passphrase in `/root/.divinghq-backup-passphrase`
  (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`), decrypted again to prove
  the passphrase opens it, and uploaded to R2 with curl's built-in SigV4
  signing. The ETag R2 answers with is checked against the file's MD5. If the
  passphrase file is missing or empty, nothing is uploaded and the off-site
  status is `failed`: a plain dump never leaves the box.
* How long R2 keeps the copies is a lifecycle rule on the bucket (below), not
  the script's business.
* `backup.json` records the attempt, the last success, the size and the
  off-site outcome. The script exits non-zero if the local dump or the
  off-site copy failed.

Secrets stay out of `ps` and out of the log: the database password travels
as `PGPASSWORD`, the R2 key reaches curl on stdin.

**restore-check.sh** takes the newest local dump, restores it into a scratch
database (`divinghq_restore_check`, dropped and recreated each run) in one
transaction that stops at the first error, then compares it with the live
database: `schema_meta.version` must match, and the row counts of `users`,
`organisations`, `meets`, `events` and `scores` must be close (within 25
rows, or between half and double). The scratch database is dropped again
whatever happened, and `restore-check.json` gets `{ last_run_at, ok }`. It
refuses to run if the scratch name is the live database's name, or doesn't
contain `restore_check`. While it runs, the scratch copy takes about as much
disk as the live database does, so keep that much free.

**deploy.sh** writes `deploy.json` once its `git pull` has landed: `ok: true`
and the commit when it gets to the end, `ok: false` and the commit it was
trying when a later step fails. `--dry` writes nothing.

### Settings

All optional. Put them in the app's `.env` or the environment; a variable
already set in the environment wins over `.env`.

| Setting | Default | |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/divinghq` | local dumps |
| `BACKUP_KEEP_LOCAL` | `14` | how many local dumps to keep |
| `OPS_STATE_DIR` | `/var/lib/divinghq` | the three state files. The app reads it too, so set it in `.env` if you change it, and keep it outside the repo (deploy.sh refuses a dirty tree) |
| `BACKUP_PASSPHRASE_FILE` | `/root/.divinghq-backup-passphrase` | first line is the passphrase |
| `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | unset | all four, or none. Three of four is reported as a failure |
| `RESTORE_CHECK_DB` | `divinghq_restore_check` | the scratch database; must contain `restore_check` |
| `RESTORE_CHECK_MIN_PCT` / `_MAX_PCT` / `_SLACK_ROWS` | `50` / `200` / `25` | how close "close" is |

## Install on the box (once)

Run these as root on the box. They assume the app lives in `/root/DiveRecorder`;
if it doesn't, change the path here and `DIVINGHQ_DIR` in the cron file.

1. **Check the tools and the clock.** `pg_dump` must be at least the server's
   major version (Debian's `postgresql-client` from the same install is), and
   the cron times assume the box runs on UTC.

   ```bash
   pg_dump --version && psql --version && openssl version
   curl --help all | grep -q aws-sigv4 && echo "curl can sign for R2"
   date +%Z                                # should print UTC
   systemctl is-active cron || apt install -y cron
   ```

   If `date +%Z` isn't UTC, either move the box to UTC or change the two hour
   fields in the cron file you install in step 6.

2. **Directories.**

   ```bash
   install -d -m 0700 -o root -g root /var/backups/divinghq
   install -d -m 0755 -o root -g root /var/lib/divinghq
   ```

3. **The backup passphrase.** This encrypts the off-site copies.

   ```bash
   ( umask 077; openssl rand -base64 48 > /root/.divinghq-backup-passphrase )
   cat /root/.divinghq-backup-passphrase
   ```

   **Copy that line into your password manager now**, as "DivingHQ backup
   passphrase" with today's date. It's the only key to the copies in R2: if
   the box dies and the passphrase goes with it, every off-site backup is
   unreadable, and nobody (Cloudflare included) can get it back. Don't put it
   in `.env` or the repo.

4. **Let the app's database role create databases**, which the weekly restore
   check needs for its scratch copy (and the restore runbook uses too).

   ```bash
   grep '^DB_USER=' /root/DiveRecorder/.env        # the app's role, say DB_USER=divinghq
   runuser -u postgres -- psql -c 'ALTER ROLE divinghq CREATEDB'   # use that name
   ```

5. **Run both once by hand** and read what they say.

   ```bash
   /root/DiveRecorder/scripts/ops/backup-db.sh
   /root/DiveRecorder/scripts/ops/restore-check.sh
   cat /var/lib/divinghq/backup.json /var/lib/divinghq/restore-check.json
   curl -s http://127.0.0.1:3000/api/ops/status
   ```

   Until R2 is set up (next section) the backup says
   `offsite not_configured`, which is fine for now.

6. **Install the cron job and the log rotation.**

   ```bash
   cd /root/DiveRecorder
   install -m 0644 -o root -g root ops/cron/divinghq-backup /etc/cron.d/divinghq-backup
   install -m 0644 -o root -g root ops/cron/divinghq-backup.logrotate /etc/logrotate.d/divinghq-backup
   install -m 0640 -o root -g adm /dev/null /var/log/divinghq-backup.log
   logrotate --debug /etc/logrotate.d/divinghq-backup     # dry run, should list the log
   ```

   cron picks up `/etc/cron.d` changes by itself. The next morning,
   `tail /var/log/divinghq-backup.log` should end with a `done:` line. When
   the files in `ops/cron/` change in the repo, run the two `install` lines
   again.

## Off-site copies on Cloudflare R2

This part is done by the account owner in the Cloudflare dashboard, then in
the box's `.env`. Nothing in the repo creates or changes anything in
Cloudflare.

1. **Turn on R2.** Dashboard, **R2 object storage**. R2 has to be purchased
   (added to the account) before it will issue API tokens; the free allowance
   is likely to cover this, the status page's `backup.size_bytes` times 35 is
   roughly what the bucket will hold.

2. **Create a private bucket**, for example `divinghq-backups`, with automatic
   location and the Standard storage class. Leave it private: no public
   `r2.dev` access, no custom domain.

3. **Add a lifecycle rule** so old copies go away by themselves. In the
   bucket, **Settings**, **Object lifecycle rules**, **Add rule**: prefix
   `divinghq/`, delete objects 35 days after upload. (The privacy policy says
   off-site backups are kept for about five weeks. If you choose another
   period, update `docs/privacy-policy.md` to match.) See Cloudflare's
   [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
   page for the current screens.

   Optional but worth it: a **bucket lock rule** on the same prefix for, say,
   30 days. Then even someone who takes over the box and its R2 key can't
   delete or overwrite the recent copies.

4. **Create an R2 API token for the box.** R2 overview, **API Tokens**,
   **Manage**, **Create Account API token**. Permission **Object Read &
   Write**, applied to **that bucket only**, no expiry (or a long one with a
   reminder to rotate it). Create it and copy the **Access Key ID** and
   **Secret Access Key**; the secret is shown once. Your **Account ID** is on
   the R2 overview page (it's also the first part of the bucket's S3 API URL).

5. **Put the four values in the box's `.env`** yourself (not in chat, not in
   the repo):

   ```bash
   R2_ACCOUNT_ID=<account id>
   R2_BUCKET=divinghq-backups
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   ```

   and keep the file private: `chmod 600 /root/DiveRecorder/.env`. The app
   doesn't read these, so no restart is needed.

6. **Try it:** run `/root/DiveRecorder/scripts/ops/backup-db.sh`. It should
   end with `offsite ok`, and the bucket should show
   `divinghq/divinghq-<stamp>.dump.enc`.

To change the passphrase later, write a new one to the file and save it in
the password manager next to the old one. New uploads use the new one; keep
the old one until its last copy has expired (35 days).

## Restore runbook

Tested: `test/ops-backup.integration.test.js` runs these download, decrypt and
restore commands against a copy of the test database, so if they change,
change them there too.

Throughout, `STAMP` is the backup you're restoring, for example
`20261001T163000Z`.

1. **Pick a backup.** The local ones are in `/var/backups/divinghq/` (newest
   last in `ls`). If the box is gone or the local copies are no good, use R2.

2. **Download it from R2** (skip for a local dump). Easiest: in the dashboard,
   open the bucket, **Objects**, `divinghq/`, the `.dump.enc` you want,
   **Download**, then copy it to the box. Or on the box, with curl (the key
   goes in a private file, so it stays out of `ps` and your shell history):

   ```bash
   mkdir -p -m 0700 /root/restore && cd /root/restore
   ( umask 077; cat > r2.curl )      # type:  user = "ACCESS_KEY_ID:SECRET_ACCESS_KEY"   then Ctrl-D
   curl --fail --silent --show-error --config r2.curl --aws-sigv4 "aws:amz:auto:s3" \
     -o divinghq-STAMP.dump.enc \
     "https://ACCOUNT_ID.r2.cloudflarestorage.com/divinghq-backups/divinghq/divinghq-STAMP.dump.enc"
   ```

   To see what's there:
   `curl --fail -s --config r2.curl --aws-sigv4 "aws:amz:auto:s3" "https://ACCOUNT_ID.r2.cloudflarestorage.com/divinghq-backups?list-type=2&prefix=divinghq/" | grep -o '<Key>[^<]*</Key>'`.
   Delete `r2.curl` when you're done.

3. **Decrypt it** (only the `.enc` ones). On a new box, first put the
   passphrase back from the password manager:
   `( umask 077; cat > /root/.divinghq-backup-passphrase )`, paste, Enter,
   Ctrl-D.

   ```bash
   cd /root/restore
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in divinghq-STAMP.dump.enc -out divinghq-STAMP.dump \
     -pass file:/root/.divinghq-backup-passphrase
   ```

   `bad decrypt` means the wrong passphrase (an older one, if it was rotated).

4. **Check it reads:** `pg_restore --list divinghq-STAMP.dump | head`.

5. **Restore into a new database**, as the app's own role, so everything in it
   ends up owned by that role. This is exactly what the weekly restore check
   does. Do it in a throwaway shell: the `source` line exports the whole
   `.env` into it, and a later `pm2 restart --update-env` from that same shell
   would hand the app those stale values.

   ```bash
   cd /root/DiveRecorder
   bash
   source scripts/ops/common.sh && ops_load_env .env && ops_resolve_db
   echo "restoring as $PGUSER"
   createdb diving_app_restored
   pg_restore --no-owner --no-privileges --single-transaction --exit-on-error \
     -d diving_app_restored /root/restore/divinghq-STAMP.dump
   psql -X -d diving_app_restored -c 'SELECT version FROM schema_meta'
   psql -X -d diving_app_restored -c 'SELECT count(*) FROM users'
   exit
   ```

   (The `source` line points `psql`, `createdb` and `pg_restore` at the app's
   server with the app's credentials from `.env`, the same way the scripts do.)

6. **Switch the app over**, back in your normal shell. Nothing is dropped, so
   this is easy to undo.

   ```bash
   pm2 stop dive-recorder
   # in /root/DiveRecorder/.env:  DB_DATABASE=diving_app_restored
   npm run migrate          # brings an older backup up to the running code's schema
   pm2 restart dive-recorder --update-env
   curl -s http://127.0.0.1:3000/api/health
   ```

   Anything written after the backup was taken is gone; tell the people
   affected. Once you're sure, drop the old database
   (`runuser -u postgres -- dropdb <old name>`). The nightly backup follows
   `.env`, so it backs up the restored database from now on.

**On a brand new box:** set the app up as in the README's "Production deploy"
section, but instead of loading `init.sql`, create the app's role with
`CREATEDB` and restore with steps 2 to 5 straight into the database name in
`.env`. Then `npm run migrate`, start it under PM2, and repeat "Install on the
box" above, putting the passphrase back from the password manager rather than
making a new one.

## GET /api/ops/status

Public, `Cache-Control: no-store`, always a 200 (with `ok: false` when the
database doesn't answer). It never includes names, hosts, paths or error text.
The three blocks come from the state files, and a missing or unreadable file
gives nulls. The shape is shared with the outside monitor; `src/types.js`
(`OpsStatus`) documents it for the code.

```json
{
  "ok": true,
  "schema_version": 104,
  "time": "2026-10-02T09:00:00.000Z",
  "backup": { "last_attempt_at": "2026-10-01T16:30:00.000Z", "last_success_at": "2026-10-01T16:30:00.000Z",
              "last_ok": true, "offsite": "ok", "size_bytes": 69738696 },
  "restore_check": { "last_run_at": "2026-09-27T17:30:03.000Z", "ok": true },
  "deploy": { "last_at": "2026-10-01T23:12:40.000Z", "ok": true, "sha": "5323566" },
  "errors": { "window_minutes": 15, "server_errors": 0, "requests": 412 }
}
```

(`sha` is always 7 characters.) `errors` counts the 5xx and all responses this
process sent in the last 15 minutes, from zero after a restart.

What a monitor reading this needs to know:

* `backup.last_ok` is the local dump only. A night where the dump worked but
  the R2 upload didn't has `last_ok: true` and `offsite: "failed"` (and the
  script exits non-zero), so alert on `offsite` as well.
* `backup.last_success_at` moves with every good local dump, off-site or
  not.
* Maintenance mode answers writes with a 503, and those count in
  `server_errors` like any other 5xx.

## When something's wrong

* **`permission denied for table ...` from pg_dump.** The app's role doesn't
  own every table (something was created as `postgres`). Let it read
  everything: `runuser -u postgres -- psql -c 'GRANT pg_read_all_data TO divinghq'`
  (with the app's role name).
* **Restore check: "can't create databases".** Step 4 of the install.
* **Restore check: schema version differs.** A deploy migrated the live
  database after the dump was taken. Run `backup-db.sh`, then
  `restore-check.sh` again.
* **Restore check: a table count is "too far apart".** Compare the two numbers
  in the log. A restored table far smaller than live means the backup is
  missing data; far larger means the live table lost rows since the backup,
  which is worth a look on its own.
* **`offsite failed`.** The log says which part: the passphrase file, a missing
  `R2_*` setting, the upload itself (a `403` is usually the token's bucket
  scope), or an ETag mismatch.
* **"another backup or restore check still holds ..."** Two runs overlapped;
  the second waits up to half an hour (an hour for the restore check) and then
  gives up. Look for a stuck `pg_dump` with `ps`.
