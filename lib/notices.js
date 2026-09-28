// Notices that go out twice: in-app (lib/push) and by email (lib/email).
//
// Claims started this, club approvals needed the same thing, and a third
// hand-rolled copy of "push it, then mail it, and don't let a failed push
// eat the email" was the point where it had to live somewhere shared.
//
// A note looks like
//
//   { userIds, category, title, body, data, action_url,
//     email: { subject, body } | false }
//
// The in-app text stays short. The email carries whatever someone needs to
// act without opening the app, and links to action_url. Leave `email` out
// to mail the title and body as they are, or set it to false for an
// in-app-only heads-up.
//
// English on purpose, same as every other admin notice here: the in-app
// title is stored as sent, and the inbox only translates the category chip.
//
// insertInApp is the quiet version: a row in the inbox and nothing else.

// notifications.title is varchar(160). Anything longer made the insert
// throw and the in-app notice quietly vanished.
const NOTICE_TITLE_MAX = 160;

// Titles get cut to fit the column. When that happens the whole sentence
// moves to the start of the body, so a long club or region name is still
// there to read.
function fitNotice(title, body) {
  const chars = Array.from(String(title || ""));
  if (chars.length <= NOTICE_TITLE_MAX) return { title, body };
  return {
    title: `${chars.slice(0, NOTICE_TITLE_MAX - 1).join("").trimEnd()}…`,
    body: body ? `${title}. ${body}` : title,
  };
}

// deps: { push, email } where email has sendNoticeEmail(userIds, { subject,
// body, path }). opts.path is the link for notes that don't bring their own
// action_url; opts.tag labels the log line when a push fails.
async function deliver({ push, email } = {}, notes, { path = null, tag = "notices" } = {}) {
  for (const n of notes || []) {
    if (!n) continue;
    const ids = [...new Set(n.userIds || [])];
    if (!ids.length) continue;
    const link = n.action_url || path;
    if (push && typeof push.sendNotification === "function") {
      try {
        const fit = fitNotice(n.title, n.body);
        await push.sendNotification(ids, {
          action_url: link, category: n.category, title: fit.title, body: fit.body, data: n.data,
        });
      } catch (err) {
        console.error(`[${tag}]`, err.message);
      }
    }
    if (n.email === false) continue;
    if (email && typeof email.sendNoticeEmail === "function") {
      const mail = n.email || { subject: n.title, body: n.body };
      try {
        await email.sendNoticeEmail(ids, { ...mail, path: mail.path || link });
      } catch (err) {
        // lib/email swallows its own errors; a test double might not.
        console.error(`[${tag}] email`, err.message);
      }
    }
  }
}

// Straight into the inbox, nothing else: no push, no socket, no email.
// For the low-key notices (a club asking to join a region, how a club
// change went) that three places used to insert by hand, one row per
// recipient. One statement for the whole audience now. The title is cut
// to the column the way those callers always cut it, not with fitNotice,
// so the stored text is what it was. It throws like any query; what "best
// effort" means is up to the caller (on a transaction client it needs a
// savepoint, see routes/club-changes.js).
async function insertInApp(db, userIds, { category, title, body = null, data = {}, action_url = null }) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const r = await db.query(
    `INSERT INTO notifications (user_id, category, title, body, data, action_url, status)
     SELECT u.id, $2, $3, $4, $5::jsonb, $6, 'sent' FROM unnest($1::uuid[]) AS u(id)`,
    [ids, category, String(title).slice(0, NOTICE_TITLE_MAX), body || null,
      JSON.stringify(data || {}), action_url || null],
  );
  return r.rowCount;
}

module.exports = { deliver, insertInApp, fitNotice, NOTICE_TITLE_MAX };
