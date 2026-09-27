// lib/notices.js, the in-app + email sender claims and club approvals
// share. No database: push and email are stubs that record what they got.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const notices = require("../lib/notices");

function recorder() {
  const pushed = [];
  const mailed = [];
  return {
    pushed,
    mailed,
    deps: {
      push: { sendNotification: async (ids, payload) => { pushed.push({ ids, ...payload }); } },
      email: { sendNoticeEmail: async (ids, msg) => { mailed.push({ ids, ...msg }); } },
    },
  };
}

test("each note links to its own page, falling back to the default", async () => {
  const r = recorder();
  await notices.deliver(r.deps, [
    { userIds: ["a", "a", "b"], category: "club_pending", title: "New club waiting", body: "Decide on Clubs.", action_url: "/clubs" },
    { userIds: ["c"], category: "club_decision", title: "Your club is active", body: "Nice." },
  ], { path: "/dashboard" });
  assert.equal(r.pushed.length, 2);
  assert.deepEqual(r.pushed[0].ids, ["a", "b"], "duplicates go once");
  assert.equal(r.pushed[0].action_url, "/clubs");
  assert.equal(r.pushed[1].action_url, "/dashboard");
  assert.deepEqual(r.mailed.map((m) => m.path), ["/clubs", "/dashboard"]);
  // With no email of its own the note mails its title and body.
  assert.equal(r.mailed[1].subject, "Your club is active");
  assert.equal(r.mailed[1].body, "Nice.");
});

test("email: false keeps a note in-app only, and a failed push still mails", async () => {
  const r = recorder();
  await notices.deliver(r.deps, [
    { userIds: ["a"], category: "club_created", title: "Heads-up", body: "x", email: false },
  ]);
  assert.equal(r.pushed.length, 1);
  assert.equal(r.mailed.length, 0);

  const mailed = [];
  await notices.deliver({
    push: { sendNotification: async () => { throw new Error("push down"); } },
    email: { sendNoticeEmail: async (ids, msg) => { mailed.push(msg); } },
  }, [{ userIds: ["a"], category: "club_decision", title: "T", body: "B", email: { subject: "S", body: "Long B" } }]);
  assert.deepEqual(mailed, [{ subject: "S", body: "Long B", path: null }]);
});

test("an empty audience sends nothing and long titles still fit", async () => {
  const r = recorder();
  const long = "X".repeat(200);
  await notices.deliver(r.deps, [
    { userIds: [], category: "club_decision", title: "Nobody", body: "x" },
    { userIds: ["a"], category: "club_decision", title: long, body: "tail" },
  ]);
  assert.equal(r.pushed.length, 1);
  assert.ok(Array.from(r.pushed[0].title).length <= notices.NOTICE_TITLE_MAX);
  assert.equal(r.pushed[0].body, `${long}. tail`);
});
