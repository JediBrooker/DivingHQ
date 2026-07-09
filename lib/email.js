// Email helpers: every send-* function the app dispatches lives
// here. Factory pattern so the test suite can swap the pool or
// disable the mailer without monkey-patching globals.
//
//   const email = require("./lib/email")({ pool });
//   email.sendWelcomeEmail(userId);
//
// All helpers are best-effort: they swallow their own errors and
// log to console so a stuck SMTP host can't take down the request
// path. Callers should never `await` them in critical sections.
//
// `mailer` is null when the Cloudflare Email Sending vars aren't
// set, every helper then no-ops silently. This is the documented
// dev-mode behaviour (registration works without email, you just
// don't get a welcome email or password-reset link).
//
// hashFingerprint() is also exported here because it's used by the
// password-reset flow to prove single-use without a nonce table.
// The function just lives next to the email helpers since that's
// the only place it's called.

const crypto = require("node:crypto");
const { serverT, SUPPORTED } = require("./server-i18n");

module.exports = function createEmail({ pool }) {
  if (!pool) throw new Error("createEmail requires { pool }");

  // Build a translator scoped to a single email send. Callers can
  // pass `{ req }` (preferred, gives full req.user.locale +
  // Accept-Language resolution) OR `{ locale }` (for fanout
  // emails where there's no request, e.g. notification routes
  // running off the user's stored users.locale). When neither is
  // supplied we synthesise an "empty req" so we land on 'en'.
  function tForSend(opts) {
    if (opts && opts.req) return serverT(opts.req);
    if (opts && typeof opts.locale === "string" && SUPPORTED.includes(opts.locale)) {
      return serverT({ user: { locale: opts.locale } });
    }
    return serverT({});      // default English
  }
  const APP_NAME = "DivingHQ";

  // Cloudflare Email Sending REST adapter. Exposes a drop-in
  // `sendMail()` with the same shape the send-* helpers below
  // expect, so every call site is unchanged. Stays null when the
  // CF_* vars are unset, which preserves the documented
  // silent-no-op dev-mode behaviour.
  const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
  const CF_EMAIL_TOKEN = process.env.CF_EMAIL_TOKEN;

  const mailer = (CF_ACCOUNT_ID && CF_EMAIL_TOKEN)
    ? {
        async sendMail({ from, to, subject, text, html }) {
          const body = { from, to, subject, text };
          if (html) body.html = html;
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/email/sending/send`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${CF_EMAIL_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Cloudflare Email Sending failed (${res.status}): ${errText}`);
          }
          return res.json();
        },
      }
    : null;

  const fromAddress = () => process.env.EMAIL_FROM;
  const baseUrl    = () => process.env.APP_BASE_URL || "";

  // Short, deterministic fingerprint of a bcrypt hash. Used as a
  // "single-use" guard for password-reset JWTs: when the user's
  // password column changes, this fingerprint changes too, which
  // invalidates any in-flight reset token without needing a
  // nonce-tracking table.
  function hashFingerprint(bcryptHash) {
    return crypto.createHash("sha256").update(bcryptHash || "").digest("hex").slice(0, 16);
  }

  async function sendRoleDecisionEmail(userId, decision, role) {
    if (!mailer) return;
    try {
      const u = await pool.query("SELECT email, full_name FROM users WHERE id = $1", [userId]);
      const user = u.rows[0];
      if (!user?.email) return;
      const subject = decision === "approved"
        ? `Your ${role} role has been approved`
        : `Your ${role} role request was not approved`;
      const text = decision === "approved"
        ? `Hi ${user.full_name},\n\nYour request for the "${role}" role has been approved. You can now sign in and access the ${role} area.\n\nDivingHQ`
        : `Hi ${user.full_name},\n\nYour request for the "${role}" role was not approved. Please contact your organisation admin if you have questions.\n\nDivingHQ`;
      await mailer.sendMail({ from: fromAddress(), to: user.email, subject, text });
    } catch (err) {
      console.error("[Email Error]", err.message);
    }
  }

  // "We received a password-reset request" email. Includes a
  // 30-min link that hits POST /api/auth/reset-password.
  //
  // FYI `opts` is optional: { req } (preferred) or { locale }. When
  // neither is supplied we fall back to user.locale (when the
  // caller queried it onto the user row) and then to English.
  async function sendPasswordResetEmail(user, token, opts) {
    if (!mailer || !user?.email) return;
    const locale = opts?.locale || user?.locale;
    const t = tForSend(opts?.req ? opts : { locale });
    const link = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await mailer.sendMail({
        from: fromAddress(),
        to: user.email,
        subject: t("emails.password_reset.subject", { app_name: APP_NAME }),
        text: [
          t("emails.password_reset.greeting", { name: user.full_name }),
          "",
          t("emails.password_reset.body", { app_name: APP_NAME }),
          "",
          link,
          "",
          t("emails.password_reset.footer"),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Reset Email Error]", err.message);
    }
  }

  // "Click here to verify your email", sent on every new
  // registration. The link carries a 24-hour JWT scoped to the user;
  // /api/auth/verify-email stamps users.email_verified_at, which
  // gates login (Migration 021).
  //
  // `opts` is optional: { req } (preferred) or { locale }. When
  // neither is supplied we fall back to users.locale and then 'en'.
  async function sendVerifyEmailEmail(userId, token, opts) {
    if (!mailer) return;
    try {
      const u = await pool.query(
        "SELECT email, full_name, locale FROM users WHERE id = $1",
        [userId],
      );
      const user = u.rows[0];
      if (!user?.email) return;
      const locale = opts?.locale || user?.locale;
      const t = tForSend(opts?.req ? opts : { locale });
      const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
      // full_name is sanitised at registration but render via
      // String() defensively in case any caller passes a non-string.
      await mailer.sendMail({
        from: fromAddress(),
        to: user.email,
        subject: t("emails.email_verify.subject", { app_name: APP_NAME }),
        text: [
          t("emails.email_verify.greeting", {
            app_name: APP_NAME,
            name: String(user.full_name || "there"),
          }),
          "",
          t("emails.email_verify.body"),
          "",
          link,
          "",
          t("emails.email_verify.footer", { app_name: APP_NAME }),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Verify Email Error]", err.message);
    }
  }

  // "Confirm your new email address", sent to the NEW address
  // when a signed-in user requests an email change. The link
  // carries a 30-min DB-backed token (Migration 044). The user
  // must click from the NEW inbox; that proves they actually
  // control it before we swap users.email over.
  //
  // We pull full_name from the user row but deliberately don't
  // mention the OLD email, that keeps account-linking signal out
  // of any inbox the new address might be forwarded to.
  async function sendEmailChangeVerify(userId, newEmail, token, opts) {
    if (!mailer || !newEmail || !token) return;
    try {
      const u = await pool.query(
        "SELECT full_name, locale FROM users WHERE id = $1",
        [userId],
      );
      const fullName = u.rows[0]?.full_name || "there";
      const locale = opts?.locale || u.rows[0]?.locale;
      const t = tForSend(opts?.req ? opts : { locale });
      const link = `${baseUrl()}/confirm-email-change?token=${encodeURIComponent(token)}`;
      await mailer.sendMail({
        from: fromAddress(),
        to: newEmail,
        subject: t("emails.email_change.subject", { app_name: APP_NAME }),
        text: [
          t("emails.email_change.greeting", { name: String(fullName) }),
          "",
          t("emails.email_change.body", { app_name: APP_NAME }),
          "",
          link,
          "",
          t("emails.email_change.footer"),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Email Change Verify Error]", err.message);
    }
  }

  // "Your DivingHQ email was changed" hygiene email. Fires
  // to the OLD address after a successful swap so the original
  // owner finds out immediately if a hijacker rotated their
  // email out from under them. Mirrors sendPasswordChangedEmail.
  async function sendEmailChangedNotice(userId, oldEmail, newEmail) {
    if (!mailer || !oldEmail) return;
    try {
      const u = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [userId],
      );
      const fullName = u.rows[0]?.full_name || "there";
      // Mask the new email in the notice: show only the local-part
      // first char + the domain. Enough for "yes that's the address
      // I just confirmed" without making this email a useful
      // account-linking signal in a compromised inbox.
      const masked = (() => {
        const at = String(newEmail).indexOf("@");
        if (at <= 1) return "***";
        const local = String(newEmail).slice(0, at);
        const domain = String(newEmail).slice(at);
        return local[0] + "***" + domain;
      })();
      await mailer.sendMail({
        from: fromAddress(),
        to: oldEmail,
        subject: "Your DivingHQ email address was changed",
        text: `Hi ${String(fullName)},\n\nThis is a confirmation that the email address on your DivingHQ account was just changed to ${masked}. You've also been signed out of every other device for safety.\n\nIf you didn't make this change, contact your organisation admin immediately — your account may be compromised.\n\nDivingHQ`,
      });
    } catch (err) {
      console.error("[Email Changed Notice Error]", err.message);
    }
  }

  // "Your password was just changed" hygiene email. Fires after
  // any successful password change (self-service or via reset).
  async function sendPasswordChangedEmail(userId) {
    if (!mailer) return;
    try {
      const u = await pool.query(
        "SELECT email, full_name FROM users WHERE id = $1",
        [userId],
      );
      const user = u.rows[0];
      if (!user?.email) return;
      await mailer.sendMail({
        from: fromAddress(),
        to: user.email,
        subject: "Your DivingHQ password was changed",
        text: `Hi ${user.full_name},\n\nThis is a confirmation that your password was just changed. If you didn't do this, contact your organisation admin and reset your password immediately.\n\nDivingHQ`,
      });
    } catch (err) {
      console.error("[Hygiene Email Error]", err.message);
    }
  }

  // "Welcome to DivingHQ" email. Fires once on registration.
  async function sendWelcomeEmail(userId) {
    if (!mailer) return;
    try {
      const u = await pool.query(
        `SELECT u.email, u.full_name, o.name AS org_name
         FROM users u JOIN organisations o ON o.id = u.org_id
         WHERE u.id = $1`,
        [userId],
      );
      const user = u.rows[0];
      if (!user?.email) return;
      const base = baseUrl();
      await mailer.sendMail({
        from: fromAddress(),
        to: user.email,
        subject: `Welcome to DivingHQ — ${user.org_name}`,
        text: `Hi ${user.full_name},\n\nThanks for registering with ${user.org_name} on DivingHQ. You can sign in at ${base || "your DivingHQ instance"} with your username and password.\n\nIf you requested a role (diver, judge, etc.), your organisation admin will review and approve it. Until then your account has spectator access — you can already browse meets and watch live broadcasts.\n\nDivingHQ`,
      });
    } catch (err) {
      console.error("[Welcome Email Error]", err.message);
    }
  }

  // "A new role request landed" email to every org_admin in the
  // target org. Helps admins act on requests promptly without
  // polling the User Manager queue.
  async function sendNewRoleRequestEmail(userId, orgId, role, note) {
    if (!mailer) return;
    try {
      const userRes = await pool.query(
        "SELECT full_name FROM users WHERE id = $1",
        [userId],
      );
      const requester = userRes.rows[0];
      if (!requester) return;

      const adminRes = await pool.query(
        `SELECT u.email, u.full_name
         FROM users u
         JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
         WHERE u.org_id = $1 AND r.role = 'org_admin' AND u.email IS NOT NULL`,
        [orgId],
      );
      if (!adminRes.rows.length) return;

      const subject = `New ${role} role request from ${requester.full_name}`;
      const text = `${requester.full_name} requested the "${role}" role.${note ? `\n\nNote: ${note}` : ""}\n\nReview pending requests in the User Manager: ${baseUrl()}/users\n\nDivingHQ`;

      await Promise.all(
        adminRes.rows.map((admin) =>
          mailer.sendMail({ from: fromAddress(), to: admin.email, subject, text }),
        ),
      );
    } catch (err) {
      console.error("[Role Request Notify Error]", err.message);
    }
  }

  // "The meet you registered for just went live" email. Sends to
  // every diver with a dive list in the event (including synchro
  // partners, they're flagged via partner_id on the dive list).
  async function sendEventStartedEmails(event) {
    if (!mailer || !event) return;
    try {
      const audience = await pool.query(
        `SELECT DISTINCT u.email, u.full_name
         FROM competitor_dive_lists cdl
         JOIN users u ON u.id IN (cdl.competitor_id, cdl.partner_id)
         WHERE cdl.event_id = $1 AND u.email IS NOT NULL`,
        [event.id],
      );
      const link = `${baseUrl()}/scoreboard/${event.id}`;
      await Promise.all(
        audience.rows.map((u) =>
          mailer.sendMail({
            from: fromAddress(),
            to: u.email,
            subject: `${event.name} is live — good luck!`,
            text: `Hi ${u.full_name},\n\n"${event.name}" has just started. Watch the live scoreboard or check in for your turn:\n\n${link}\n\nDivingHQ`,
          }),
        ),
      );
    } catch (err) {
      console.error("[Event Live Notify Error]", err.message);
    }
  }

  // "Results are posted" email, fires when a meet flips to
  // Completed. Same audience as the live notification.
  async function sendEventResultsEmails(event) {
    if (!mailer || !event) return;
    try {
      const audience = await pool.query(
        `SELECT DISTINCT u.email, u.full_name
         FROM competitor_dive_lists cdl
         JOIN users u ON u.id IN (cdl.competitor_id, cdl.partner_id)
         WHERE cdl.event_id = $1 AND u.email IS NOT NULL`,
        [event.id],
      );
      const link = `${baseUrl()}/scoreboard/${event.id}`;
      await Promise.all(
        audience.rows.map((u) =>
          mailer.sendMail({
            from: fromAddress(),
            to: u.email,
            subject: `Results posted — ${event.name}`,
            text: `Hi ${u.full_name},\n\nResults for "${event.name}" are now available. View the full recap and dive breakdown:\n\n${link}\n\nDivingHQ`,
          }),
        ),
      );
    } catch (err) {
      console.error("[Event Results Notify Error]", err.message);
    }
  }

  // ---- money notifications ----------------------------------------
  // A payer must never be charged, refunded, or fined silently. Framing
  // copy is localised via the payer's stored locale (server-{xx}.json);
  // the payment DESCRIPTION deliberately matches the English product name
  // the payer already saw on the Stripe Checkout page, worth double-
  // checking if you ever add a new subject_type here.

  // Human description of what a payment was for. English by design (see
  // note above); proper nouns come from the linked rows.
  async function describePayment(p) {
    const one = async (sql, id) => id ? (await pool.query(sql, [id])).rows[0] : null;
    const ev = await one("SELECT name FROM events WHERE id = $1", p.event_id);
    const meet = await one("SELECT name FROM meets WHERE id = $1", p.meet_id);
    switch (p.subject_type) {
      case "event_entry":
        return meet ? `Meet registration — ${meet.name}` : `Entry — ${ev?.name || "event"}`;
      case "membership": {
        const fd = await one("SELECT name FROM fee_definitions WHERE id = $1", p.fee_definition_id);
        return fd?.name || "Membership";
      }
      case "club_affiliation":
      case "club_accreditation": {
        const fd = await one("SELECT name FROM fee_definitions WHERE id = $1", p.fee_definition_id);
        return fd?.name || (p.subject_type === "club_accreditation" ? "Club accreditation" : "Club affiliation");
      }
      case "official_accreditation":
        return `${p.payer_role_type || "official"} accreditation`;
      case "scratch":
        return `Scratch penalty — ${ev?.name || "event"}`;
      case "no_show":
        return `No-show penalty — ${ev?.name || "event"}`;
      case "spectator_ticket":
        return `Spectator ticket — ${meet?.name || "meet"}`;
      case "livestream":
        return `Livestream access — ${meet?.name || "meet"}`;
      case "programme":
        return `Programme — ${meet?.name || "meet"}`;
      case "meet_bundle":
        return `Meet bundle — ${meet?.name || "meet"}`;
      case "fine": {
        const f = await one("SELECT reason FROM fines WHERE id = $1", p.fine_id);
        return f?.reason ? `Fine — ${f.reason}` : "Fine";
      }
      case "donation":
        return "Donation";
      case "class_enrolment": {
        const enr = await one(
          "SELECT c.name FROM class_enrolments e JOIN classes c ON c.id = e.class_id WHERE e.id = $1",
          p.class_enrolment_id,
        );
        return enr?.name ? `Class: ${enr.name}` : "Class enrolment";
      }
      default:
        return p.subject_type;
    }
  }

  const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency || ""}`.trim();

  async function paymentAndPayer(paymentId) {
    const p = (await pool.query("SELECT * FROM payments WHERE id = $1", [paymentId])).rows[0];
    if (!p || !p.payer_user_id) return {}; // club-payer rows have no individual inbox
    const u = (await pool.query(
      "SELECT email, full_name, locale FROM users WHERE id = $1",
      [p.payer_user_id],
    )).rows[0];
    return { p, u };
  }

  // Receipt, sent when the webhook fulfils a payment.
  async function sendPaymentReceiptEmail(paymentId) {
    if (!mailer) return;
    try {
      const { p, u } = await paymentAndPayer(paymentId);
      if (!p || !u?.email) return;
      const t = tForSend({ locale: u.locale });
      const description = await describePayment(p);
      await mailer.sendMail({
        from: fromAddress(),
        to: u.email,
        subject: t("emails.payment_receipt.subject", { app_name: APP_NAME }),
        text: [
          t("emails.common.greeting", { name: u.full_name }),
          "",
          t("emails.payment_receipt.body", { amount: money(p.amount_cents, p.currency), description }),
          "",
          t("emails.payment_receipt.footer", { link: `${baseUrl()}/payment-history` }),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Receipt Email Error]", err.message);
    }
  }

  // Refund notice: full or partial, API- or dashboard- or dispute-initiated.
  async function sendPaymentRefundedEmail(paymentId) {
    if (!mailer) return;
    try {
      const { p, u } = await paymentAndPayer(paymentId);
      if (!p || !u?.email) return;
      const t = tForSend({ locale: u.locale });
      const description = await describePayment(p);
      await mailer.sendMail({
        from: fromAddress(),
        to: u.email,
        subject: t("emails.payment_refunded.subject", { app_name: APP_NAME }),
        text: [
          t("emails.common.greeting", { name: u.full_name }),
          "",
          t("emails.payment_refunded.body", {
            amount: money(p.refunded_amount_cents || p.amount_cents, p.currency),
            description,
          }),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Refund Email Error]", err.message);
    }
  }

  // "A fine has been issued to you", the fined person must hear about a
  // debt the moment it exists, not when they stumble on /charges.
  async function sendFineIssuedEmail(fineId) {
    if (!mailer) return;
    try {
      const f = (await pool.query(
        `SELECT f.amount_cents, f.currency, f.reason, u.email, u.full_name, u.locale
           FROM fines f JOIN users u ON u.id = f.liable_user_id WHERE f.id = $1`,
        [fineId],
      )).rows[0];
      if (!f?.email) return;
      const t = tForSend({ locale: f.locale });
      await mailer.sendMail({
        from: fromAddress(),
        to: f.email,
        subject: t("emails.fine_issued.subject", { app_name: APP_NAME }),
        text: [
          t("emails.common.greeting", { name: f.full_name }),
          "",
          t("emails.fine_issued.body", { amount: money(f.amount_cents, f.currency), reason: f.reason }),
          "",
          t("emails.fine_issued.footer", { link: `${baseUrl()}/charges` }),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Fine Email Error]", err.message);
    }
  }

  // Appeal adjudicated: upheld (fine waived) or dismissed (owed again).
  // Without this the outcome was invisible, dismissed appeals silently
  // reverted to 'owed' and upheld ones silently vanished.
  async function sendAppealDecisionEmail(fineId, decision) {
    if (!mailer) return;
    try {
      const f = (await pool.query(
        `SELECT f.amount_cents, f.currency, u.email, u.full_name, u.locale
           FROM fines f JOIN users u ON u.id = f.liable_user_id WHERE f.id = $1`,
        [fineId],
      )).rows[0];
      if (!f?.email) return;
      const t = tForSend({ locale: f.locale });
      const ns = decision === "upheld" ? "emails.appeal_upheld" : "emails.appeal_dismissed";
      await mailer.sendMail({
        from: fromAddress(),
        to: f.email,
        subject: t(`${ns}.subject`, { app_name: APP_NAME }),
        text: [
          t("emails.common.greeting", { name: f.full_name }),
          "",
          t(`${ns}.body`, { amount: money(f.amount_cents, f.currency), link: `${baseUrl()}/charges` }),
          "",
          APP_NAME,
        ].join("\n"),
      });
    } catch (err) {
      console.error("[Appeal Email Error]", err.message);
    }
  }

  // Free-form alert to the platform operator (disputes, auto-refunds…).
  // English on purpose, the operator runs the platform.
  async function sendOperatorAlertEmail({ subject, text }) {
    if (!mailer) return;
    try {
      const to = process.env.PLATFORM_OPS_EMAIL || fromAddress();
      if (!to) return;
      await mailer.sendMail({ from: fromAddress(), to, subject: `[DivingHQ] ${subject}`, text });
    } catch (err) {
      console.error("[Operator Alert Email Error]", err.message);
    }
  }

  // Alert the platform operator when a payout TRANSFER FAILS. Success
  // needs no email, the Stripe transfer is automatic and the recipient
  // sees it in-app; a failure (e.g. onboarding lapsed, account restricted)
  // is the only thing that wants a human. Recipient is PLATFORM_OPS_EMAIL
  // (falls back to EMAIL_FROM). Fire-and-forget.
  async function sendPayoutFailedEmail({ orgId = null, clubId = null, payouts = [] }) {
    const failed = (payouts || []).filter((p) => p.status === "failed");
    if (!mailer || !failed.length) return;
    try {
      const to = process.env.PLATFORM_OPS_EMAIL || fromAddress();
      if (!to) return;
      const who = orgId
        ? (await pool.query("SELECT name FROM organisations WHERE id = $1", [orgId])).rows[0]
        : (await pool.query("SELECT name FROM clubs WHERE id = $1", [clubId])).rows[0];
      const name = who?.name || (orgId ? "an organisation" : "a club");
      const lines = failed
        .map((p) => `  - ${(p.amount_cents / 100).toFixed(2)} ${p.currency} (payout ${p.id})${p.error ? " — " + p.error : ""}`)
        .join("\n");
      const subject = `[DivingHQ] Payout transfer FAILED — ${name}`;
      const text = `A Stripe transfer failed for ${name} (${orgId ? "federation" : "club"}):\n\n${lines}\n\nThe balance was restored, so they can withdraw again once the issue (usually incomplete onboarding) is resolved. Check the recipient's Connect account in the Stripe dashboard.\n\nDivingHQ`;
      await mailer.sendMail({ from: fromAddress(), to, subject, text });
    } catch (err) {
      console.error("[Payout Failed Notify Error]", err.message);
    }
  }

  return {
    hashFingerprint,
    sendRoleDecisionEmail,
    sendPasswordResetEmail,
    sendVerifyEmailEmail,
    sendPasswordChangedEmail,
    sendEmailChangeVerify,
    sendEmailChangedNotice,
    sendWelcomeEmail,
    sendNewRoleRequestEmail,
    sendEventStartedEmails,
    sendEventResultsEmails,
    sendPayoutFailedEmail,
    sendPaymentReceiptEmail,
    sendPaymentRefundedEmail,
    sendFineIssuedEmail,
    sendAppealDecisionEmail,
    sendOperatorAlertEmail,
  };
};
