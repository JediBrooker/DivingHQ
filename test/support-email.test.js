// SUPPORT_EMAIL (lib/support.js) and what it's wired into. No DB, no HTTP:
// the mailer's fetch is stubbed and the pool is a fake that answers the one
// or two SELECTs each send-* helper makes.
//
// The integration suite covers the other ends (GET /api/public-config and
// the login messages). This file pins the two things that only show up in
// the outgoing request body: the address validation and the Reply-To.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { supportEmail, supportContact, suspendedAccountMessage, DEFAULT_SUPPORT_EMAIL } = require("../lib/support");

// Set env vars for the length of fn, then put everything back the way it was
// (deleting the ones that weren't set), even if fn throws.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("supportEmail defaults to the hosted inbox", async () => {
  assert.equal(DEFAULT_SUPPORT_EMAIL, "support@divinghq.app");
  await withEnv({ SUPPORT_EMAIL: undefined }, () => {
    assert.equal(supportEmail(), DEFAULT_SUPPORT_EMAIL);
    assert.equal(supportContact(), "DivingHQ support at support@divinghq.app");
  });
});

test("a suspended account is sent to its club admin only where there's no federation", async () => {
  await withEnv({ SUPPORT_EMAIL: undefined }, () => {
    assert.equal(
      suspendedAccountMessage("unclaimed"),
      "Your account has been suspended. Contact your club admin or DivingHQ support at support@divinghq.app.",
    );
    for (const state of ["claimed", null, undefined]) {
      assert.equal(
        suspendedAccountMessage(state),
        "Your account has been suspended. Contact your federation administrator or DivingHQ support at support@divinghq.app.",
      );
    }
  });
});

test("supportEmail takes a real address and trims it", async () => {
  await withEnv({ SUPPORT_EMAIL: "  help@club.example.test " }, () => {
    assert.equal(supportEmail(), "help@club.example.test");
  });
});

test("supportEmail ignores values that aren't a plain address", async () => {
  // Each of these would either read as nonsense in an error message or,
  // worse, smuggle something into a mail header or a mailto: link.
  for (const bad of [
    "",
    "   ",
    "support",
    "support@localhost",
    "two words@example.test",
    "a@b.test, c@d.test",
    "Support <support@example.test>",
    "evil@example.test\r\nBcc: someone@example.test",
    `${"x".repeat(250)}@example.test`,
  ]) {
    await withEnv({ SUPPORT_EMAIL: bad }, () => {
      assert.equal(supportEmail(), DEFAULT_SUPPORT_EMAIL, JSON.stringify(bad));
    });
  }
});

// Build lib/email with a stubbed Cloudflare API and capture every request
// body it sends. The CF_* vars are read when the factory runs, so they have
// to be in place before createEmail() is called.
async function captureMail(run, row = {}) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ success: true }), text: async () => "" };
  };
  try {
    await withEnv({ CF_ACCOUNT_ID: "acct-test", CF_EMAIL_TOKEN: "token-test", EMAIL_FROM: "noreply@example.test" }, async () => {
      const pool = {
        async query(sql) {
          if (/FROM organisations/.test(sql)) return { rows: [{ name: "Test Aquatics" }] };
          return { rows: [{ email: "someone@example.test", full_name: "Some One", ...row }] };
        },
      };
      const email = require("../lib/email")({ pool });
      await run(email);
    });
  } finally {
    global.fetch = realFetch;
  }
  return sent;
}

test("every email goes out with Reply-To set to the support address", async () => {
  const sent = await withEnv({ SUPPORT_EMAIL: undefined }, () => captureMail(async (email) => {
    await email.sendClaimEmail(["00000000-0000-0000-0000-000000000001"], { subject: "A claim", body: "Details" });
    await email.sendPasswordChangedEmail("00000000-0000-0000-0000-000000000001");
  }));
  assert.equal(sent.length, 2);
  for (const m of sent) {
    assert.equal(m.body.reply_to, "support@divinghq.app");
    assert.equal(m.body.from, "noreply@example.test");
    // The REST API spells it reply_to. A camelCase replyTo would be ignored
    // by Cloudflare without an error, so make sure it never sneaks back.
    assert.equal(m.body.replyTo, undefined);
  }
});

test("SUPPORT_EMAIL changes the Reply-To and the suspension notice", async () => {
  const sent = await withEnv({ SUPPORT_EMAIL: "help@club.example.test" }, () => captureMail(async (email) => {
    await email.sendOrgDecisionEmail("00000000-0000-0000-0000-000000000002", "suspended");
  }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.reply_to, "help@club.example.test");
  assert.match(sent[0].body.text, /reply to this email or contact DivingHQ support at help@club\.example\.test/);
});

// The account notices told people to "contact your organisation admin",
// which in a country the clubs started (no federation yet) is nobody. The
// two security ones matter most: whoever gets them may have just lost the
// account, and only DivingHQ can lock it.
test("security and role notices point at support, not an admin who may not exist", async () => {
  const sent = await withEnv({ SUPPORT_EMAIL: "help@club.example.test" }, () => captureMail(async (email) => {
    await email.sendPasswordChangedEmail("00000000-0000-0000-0000-000000000003");
    await email.sendEmailChangedNotice("00000000-0000-0000-0000-000000000003", "old@example.test", "new@example.test");
    await email.sendRoleDecisionEmail("00000000-0000-0000-0000-000000000003", "rejected", "judge");
  }));
  assert.equal(sent.length, 3);
  const [pw, changed, rejected] = sent.map((m) => m.body.text);
  for (const text of [pw, changed, rejected]) assert.doesNotMatch(text, /organisation admin/);
  assert.match(pw, /DivingHQ support at help@club\.example\.test/);
  assert.match(changed, /DivingHQ support at help@club\.example\.test/);
  assert.match(changed, /Reply to this email/);
  // The old address gets this one, and the reset link would go to the new
  // one, so it mustn't tell them to reset the password themselves.
  assert.doesNotMatch(changed, /reset your password/);
  assert.equal(sent[1].body.to, "old@example.test");
  assert.match(rejected, /club or federation admin/);
});

// Only a founder in a country with no federation is a club admin from the
// start. Under a federation, telling them "you're its admin already" sent
// them looking for powers they didn't have.
test("the welcome email only says 'you're its admin' to a club admin", async () => {
  const founder = await captureMail(async (email) => {
    await email.sendWelcomeEmail("00000000-0000-0000-0000-000000000004");
  }, { is_club_admin: true });
  assert.match(founder[0].body.text, /you're its admin already/);

  const member = await captureMail(async (email) => {
    await email.sendWelcomeEmail("00000000-0000-0000-0000-000000000004");
  }, { is_club_admin: false });
  assert.doesNotMatch(member[0].body.text, /admin already/);
  assert.match(member[0].body.text, /\n\nDivingHQ$/);
});

// lib/notices.js mails through sendNoticeEmail, which links to whatever
// page the notice is about. Claim mail keeps its own wording on top.
test("notice emails link to their page, claim emails still point at /claims", async () => {
  const sent = await withEnv({ APP_BASE_URL: "https://hq.example.test" }, () => captureMail(async (email) => {
    await email.sendNoticeEmail(["00000000-0000-0000-0000-000000000005"], {
      subject: "A club is waiting", body: "Decide on Clubs.", path: "/clubs",
    });
    await email.sendClaimEmail(["00000000-0000-0000-0000-000000000005"], { subject: "A claim", body: "Details" });
  }));
  assert.equal(sent.length, 2);
  assert.match(sent[0].body.text, /Decide on Clubs\.\n\nOpen it on DivingHQ: https:\/\/hq\.example\.test\/clubs\n\nDivingHQ$/);
  assert.match(sent[1].body.text, /See the claim on DivingHQ: https:\/\/hq\.example\.test\/claims/);
});

// Under a federation the founder's club waits for approval (migration
// 096), and the welcome email is where they first hear that.
test("the welcome email tells a founder their club is with the federation", async () => {
  const sent = await captureMail(async (email) => {
    await email.sendWelcomeEmail("00000000-0000-0000-0000-000000000006");
  }, { is_club_admin: false, pending_club_name: "Thimphu Divers", org_name: "Bhutan Aquatics" });
  assert.match(sent[0].body.text, /You started Thimphu Divers\. Bhutan Aquatics approves new clubs on DivingHQ/);
  assert.doesNotMatch(sent[0].body.text, /admin already/);
});
