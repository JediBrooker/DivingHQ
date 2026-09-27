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

module.exports = { deliver, fitNotice, NOTICE_TITLE_MAX };
