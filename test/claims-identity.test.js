// lib/claims.js pieces that don't need a database: telling whether a
// voter is the claimant under another account, and fitting long notice
// titles into notifications.title (varchar 160). The lifecycle itself is
// covered in integration.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const claims = require("../lib/claims");

test("normaliseEmail folds the ways one mailbox gets spelt", () => {
  assert.equal(claims.normaliseEmail("  Boss+Fed@Example.ORG "), "boss@example.org");
  assert.equal(claims.normaliseEmail("b.o.s.s+x@googlemail.com"), "boss@gmail.com");
  assert.equal(claims.normaliseEmail("B.Oss@gmail.com"), "boss@gmail.com");
  // Dots only mean nothing at Gmail.
  assert.equal(claims.normaliseEmail("b.oss@outlook.com"), "b.oss@outlook.com");
  for (const bad of [null, undefined, "", "nobody", "@example.org", "x@", "+tag@example.org"]) {
    assert.equal(claims.normaliseEmail(bad), null, String(bad));
  }
});

test("sharesIdentity: same mailbox anywhere, same domain only off webmail", () => {
  const { sharesIdentity } = claims;
  assert.equal(sharesIdentity("boss@gmail.com", "b.o.s.s+claim@googlemail.com"), true);
  assert.equal(sharesIdentity("boss@gmail.com", "someone.else@gmail.com"), false, "webmail is shared by strangers");
  assert.equal(sharesIdentity("a@yahoo.co.uk", "b@yahoo.co.uk"), false);
  assert.equal(sharesIdentity("a@hotmail.fr", "b@hotmail.fr"), false);
  assert.equal(sharesIdentity("office@diving.org.au", "coach@diving.org.au"), true);
  assert.equal(sharesIdentity("office@nsw.diving.org.au", "coach@diving.org.au"), true, "a subdomain counts");
  assert.equal(sharesIdentity("coach@diving.org.au", "office@nsw.diving.org.au"), true, "either way round");
  assert.equal(sharesIdentity("office@diving.org.au", "coach@notdiving.org.au"), false);
  assert.equal(sharesIdentity("office@diving.org.au", null), false);
});

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
