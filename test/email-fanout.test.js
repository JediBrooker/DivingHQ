// lib/email.js fan-out senders: the ones that mail a list of people
// (event audience, admins). The live and results emails share
// sendEventAudienceEmails, so this pins what each one actually sends,
// one message per row with the exact subject and text, and that a
// failed send is logged under the label ops grep for.
//
// No DB, no HTTP: fetch is stubbed and the pool answers every SELECT
// with the same two people.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PEOPLE = [
  { email: "ann@example.test", full_name: "Ann A" },
  { email: "bob@example.test", full_name: "Bob B" },
];

async function capture(run, { failFor = null } = {}) {
  const sent = [];
  const logged = [];
  const saved = { fetch: global.fetch, error: console.error, env: { ...process.env } };
  Object.assign(process.env, {
    CF_ACCOUNT_ID: "acct-test", CF_EMAIL_TOKEN: "token-test",
    EMAIL_FROM: "noreply@example.test", APP_BASE_URL: "https://hq.example.test",
  });
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.to === failFor) return { ok: false, status: 500, text: async () => "nope" };
    sent.push(body);
    return { ok: true, json: async () => ({}) };
  };
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const pool = {
      async query(sql) {
        if (/SELECT name FROM organisations/.test(sql)) return { rows: [{ name: "Test Aquatics" }] };
        return { rows: PEOPLE };
      },
    };
    await run(require("../lib/email")({ pool }));
  } finally {
    global.fetch = saved.fetch;
    console.error = saved.error;
    process.env = saved.env;
  }
  return { sent, logged };
}

test("event live and results emails go to everyone on the list with their own name", async () => {
  const ev = { id: "ev-1", name: "Nationals 3m" };
  const { sent } = await capture(async (email) => {
    await email.sendEventStartedEmails(ev);
    await email.sendEventResultsEmails(ev);
  });
  assert.deepEqual(sent.map((m) => [m.to, m.subject]), [
    ["ann@example.test", "Nationals 3m is live — good luck!"],
    ["bob@example.test", "Nationals 3m is live — good luck!"],
    ["ann@example.test", "Results posted — Nationals 3m"],
    ["bob@example.test", "Results posted — Nationals 3m"],
  ]);
  assert.equal(
    sent[1].text,
    "Hi Bob B,\n\n\"Nationals 3m\" has just started. Watch the live scoreboard or check in for your turn:\n\nhttps://hq.example.test/scoreboard/ev-1\n\nDivingHQ",
  );
  assert.equal(
    sent[2].text,
    "Hi Ann A,\n\nResults for \"Nationals 3m\" are now available. View the full recap and dive breakdown:\n\nhttps://hq.example.test/scoreboard/ev-1\n\nDivingHQ",
  );
  for (const m of sent) assert.equal(m.from, "noreply@example.test");
});

test("event emails do nothing without an event, and still hand back a promise", async () => {
  const { sent } = await capture(async (email) => {
    const p = email.sendEventStartedEmails(null);
    assert.equal(typeof p.then, "function");
    await p;
  });
  assert.equal(sent.length, 0);
});

test("a failed send is logged under each sender's own label", async () => {
  const ev = { id: "ev-1", name: "Nationals 3m" };
  const { logged } = await capture(async (email) => {
    await email.sendEventStartedEmails(ev);
    await email.sendEventResultsEmails(ev);
    await email.sendNewOrgRequestEmail("New Fed");
    await email.sendOrgDecisionEmail("org-1", "active");
  }, { failFor: "bob@example.test" });
  assert.deepEqual(logged.map((l) => l.slice(0, l.indexOf("]") + 1)), [
    "[Event Live Notify Error]",
    "[Event Results Notify Error]",
    "[Org Request Notify Error]",
    "[Org Decision Notify Error]",
  ]);
});

test("admin fan-outs send the same subject and text to every admin", async () => {
  const { sent } = await capture(async (email) => {
    await email.sendNewOrgRequestEmail("New Fed");
    await email.sendOrgDecisionEmail("org-1", "suspended");
  });
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((m) => m.to), PEOPLE.map((p) => p.email).concat(PEOPLE.map((p) => p.email)));
  assert.equal(sent[0].subject, "New federation awaiting approval: New Fed");
  assert.equal(sent[0].text, sent[1].text);
  assert.equal(sent[2].subject, "Test Aquatics has been suspended");
  assert.equal(sent[2].text, sent[3].text);
});
