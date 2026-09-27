// lib/claims.js pieces that don't need a database. Fitting long notice
// titles into notifications.title (varchar 160) for now. The lifecycle
// itself is covered in integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const claims = require("../lib/claims");

test("claim notices: long titles are cut to fit, with the full text kept in the body", async () => {
  const sent = [];
  const push = { sendNotification: async (ids, payload) => { sent.push({ ids, ...payload }); } };
  const long = `${"A".repeat(100)} wants to run ${"B".repeat(80)} (${"C".repeat(90)})`;
  await claims.deliver({ push }, [
    { userIds: ["u1", "u1"], category: "claim_vote", title: long, body: "Your vote decides it." },
    { userIds: ["u2"], category: "claim_decided", title: "Short and sweet", body: "Fine as it is." },
    { userIds: [], category: "claim_decided", title: "Nobody to tell", body: "x" },
  ]);
  assert.equal(sent.length, 2, "an empty audience sends nothing");
  assert.deepEqual(sent[0].ids, ["u1"]);
  assert.ok(Array.from(sent[0].title).length <= 160, `title is ${sent[0].title.length} long`);
  assert.ok(sent[0].title.endsWith("…"));
  assert.equal(sent[0].body, `${long}. Your vote decides it.`);
  assert.equal(sent[1].title, "Short and sweet");
  assert.equal(sent[1].body, "Fine as it is.");
});
