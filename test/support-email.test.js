// SUPPORT_EMAIL (lib/support.js) and what it's wired into. No DB, no HTTP:
// the mailer's fetch is stubbed and the pool is a fake that answers the one
// or two SELECTs each send-* helper makes.
//
// The integration suite covers the other ends (GET /api/public-config and
// the login messages). This file pins the two things that only show up in
// the outgoing request body: the address validation and the Reply-To.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { supportEmail, supportContact, DEFAULT_SUPPORT_EMAIL } = require("../lib/support");

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
async function captureMail(run) {
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
          return { rows: [{ email: "someone@example.test", full_name: "Some One" }] };
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
