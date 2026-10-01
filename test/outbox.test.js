// Unit tests for src/lib/outbox.js.
//
// Pure JS, no IndexedDB. We use the in-memory backend the outbox
// exports for exactly this purpose, so the test suite stays
// dependency-free.
//
// src/ is ESM (sub-package.json); we dynamic-import from a CJS
// test file (same pattern as test/score-trim.test.js).

const { test, before } = require("node:test");
const assert = require("node:assert/strict");

let createOutbox, createMemoryBackend, STATUSES, MAX_PAYLOAD_BYTES, uuidV4, isTerminal;

before(async () => {
  const mod = await import("../src/lib/outbox.js");
  createOutbox = mod.createOutbox;
  createMemoryBackend = mod.createMemoryBackend;
  STATUSES = mod.STATUSES;
  MAX_PAYLOAD_BYTES = mod.MAX_PAYLOAD_BYTES;
  uuidV4 = mod.uuidV4;
  isTerminal = mod.isTerminal;
});

// ---- Helpers --------------------------------------------------

function newOutbox(opts = {}) {
  return createOutbox({
    backend: createMemoryBackend(),
    userFingerprint: 'u1',
    ...opts,
  });
}

// A send() that always succeeds with the entry's payload echoed back.
function okSend(received = []) {
  return async (entry) => {
    received.push(entry);
    return { ok: true, response: { echo: entry.payload } };
  };
}

// A send() that throws a conflict.
function conflictSend() {
  return async () => {
    const err = new Error('conflict from server');
    err.kind = 'conflict';
    err.conflict = { existing: { score: 8.0 }, proposed: { score: 8.5 } };
    throw err;
  };
}

// A send() that throws a transient error N times then succeeds.
function flakySend(failCount) {
  let failures = 0;
  return async (entry) => {
    if (failures < failCount) {
      failures += 1;
      throw new Error(`transient ${failures}/${failCount}`);
    }
    return { ok: true, response: { echo: entry.payload } };
  };
}

// ---- uuidV4 ---------------------------------------------------

test("uuidV4 returns canonical RFC 4122 v4 strings", () => {
  const u = uuidV4();
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("uuidV4 returns unique values across calls", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(uuidV4());
  assert.equal(seen.size, 1000);
});

// ---- push -----------------------------------------------------

test("push() returns a valid UUID v4", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { event_id: 'e1', score: 8.5 });
  assert.match(key, /^[0-9a-f-]{36}$/);
});

test("push() stores entry in pending state with user_fingerprint", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { event_id: 'e1', score: 8.5 });
  const entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.PENDING);
  assert.equal(entry.action_type, 'submit_score');
  assert.equal(entry.user_fingerprint, 'u1');
  assert.equal(entry.attempts, 0);
  assert.deepEqual(entry.payload, { event_id: 'e1', score: 8.5 });
});

test("push() rejects oversized payloads", async () => {
  const o = newOutbox();
  const huge = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
  await assert.rejects(o.push('action', { payload: huge }), /exceeds/);
});

test("push() requires actionType", async () => {
  const o = newOutbox();
  await assert.rejects(o.push('', {}), /actionType required/);
  await assert.rejects(o.push(null, {}), /actionType required/);
});

test("push() emits 'change' event", async () => {
  const o = newOutbox();
  let changed = false;
  o.on('change', () => { changed = true; });
  await o.push('submit_score', {});
  assert.ok(changed);
});

test("push() stamps actor_local_time from opts when provided", async () => {
  const o = newOutbox();
  const t = new Date('2026-05-21T10:00:00Z');
  const key = await o.push('submit_score', {}, { actorLocalTime: t });
  const entry = await o.getEntry(key);
  assert.equal(entry.actor_local_time, t.toISOString());
});

// ---- drain ----------------------------------------------------

test("drain() with no pending entries returns empty result", async () => {
  const o = newOutbox();
  const received = [];
  const result = await o.drain({ send: okSend(received) });
  assert.deepEqual(result, { drained: 0, conflicts: 0, failed: 0, rejected: 0, retryInMs: null });
  assert.equal(received.length, 0);
});

test("drain() marks pending entries as synced on success", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { score: 8.5 });
  const result = await o.drain({ send: okSend() });
  assert.equal(result.drained, 1);
  const entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.SYNCED);
  assert.ok(entry.synced_at);
  assert.equal(entry.attempts, 1);
  assert.deepEqual(entry.server_response, { echo: { score: 8.5 } });
});

test("drain() FIFO order by created_at", async () => {
  const o = newOutbox();
  // Push 3 with slight delays so created_at differs.
  await o.push('a', { n: 1 });
  await new Promise((r) => setTimeout(r, 2));
  await o.push('a', { n: 2 });
  await new Promise((r) => setTimeout(r, 2));
  await o.push('a', { n: 3 });

  const received = [];
  await o.drain({ send: okSend(received) });
  assert.deepEqual(received.map((e) => e.payload.n), [1, 2, 3]);
});

test("drain() marks conflict on conflict error", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { score: 8.5 });
  const result = await o.drain({ send: conflictSend() });
  assert.equal(result.conflicts, 1);
  const entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.CONFLICT);
  assert.deepEqual(entry.conflict_info, { existing: { score: 8.0 }, proposed: { score: 8.5 } });
});

test("drain() retries transient failures up to maxAttempts", async () => {
  const o = newOutbox({ maxAttempts: 3 });
  await o.push('submit_score', { score: 8.5 });

  // Send fails twice then succeeds. Gotcha: we need to drain 3 times
  // because each drain() only processes pending once, and a failure
  // flips status back to pending without retrying in the same call.
  const send = flakySend(2);
  const r1 = await o.drain({ send });
  assert.deepEqual(r1, { drained: 0, conflicts: 0, failed: 0, rejected: 0, retryInMs: 1000 });
  const r2 = await o.drain({ send });
  assert.deepEqual(r2, { drained: 0, conflicts: 0, failed: 0, rejected: 0, retryInMs: 2000 });
  const r3 = await o.drain({ send });
  assert.equal(r3.drained, 1);
});

test("drain() marks failed after maxAttempts is reached", async () => {
  const o = newOutbox({ maxAttempts: 2 });
  const key = await o.push('submit_score', { score: 8.5 });

  const alwaysFail = async () => { throw new Error('boom'); };
  await o.drain({ send: alwaysFail });
  let entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.PENDING);  // first failure → retry
  assert.equal(entry.attempts, 1);

  await o.drain({ send: alwaysFail });
  entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.FAILED);
  assert.equal(entry.attempts, 2);
  assert.equal(entry.last_error, 'boom');
});

test("drain() concurrent calls don't double-send", async () => {
  const o = newOutbox();
  await o.push('submit_score', { n: 1 });
  await o.push('submit_score', { n: 2 });

  const received = [];
  // Slow send so two drains overlap.
  const slowSend = async (entry) => {
    await new Promise((r) => setTimeout(r, 20));
    received.push(entry);
    return { ok: true };
  };
  const [r1, r2] = await Promise.all([
    o.drain({ send: slowSend }),
    o.drain({ send: slowSend }),
  ]);
  // One drain processes both, the other no-ops.
  const totalDrained = r1.drained + r2.drained;
  assert.equal(totalDrained, 2);
  assert.equal(received.length, 2);
});

test("drain() respects user_fingerprint (won't drain other user's entries)", async () => {
  const backend = createMemoryBackend();
  const userA = createOutbox({ backend, userFingerprint: 'A' });
  const userB = createOutbox({ backend, userFingerprint: 'B' });

  await userA.push('submit_score', { who: 'A' });
  await userB.push('submit_score', { who: 'B' });

  const aReceived = [];
  await userA.drain({ send: okSend(aReceived) });
  assert.equal(aReceived.length, 1);
  assert.equal(aReceived[0].payload.who, 'A');

  // B's entry is still pending.
  const bPending = await userB.list({ status: STATUSES.PENDING });
  assert.equal(bPending.length, 1);
  assert.equal(bPending[0].payload.who, 'B');
});

test("drain() throws if send is not a function", async () => {
  const o = newOutbox();
  await o.push('a', {});
  await assert.rejects(o.drain({}), /send function required/);
});

// ---- list / getEntry -----------------------------------------

test("list() filters by status", async () => {
  const o = newOutbox();
  await o.push('a', { n: 1 });
  await o.push('b', { n: 2 });

  const pending = await o.list({ status: STATUSES.PENDING });
  assert.equal(pending.length, 2);

  await o.drain({ send: okSend() });
  const synced = await o.list({ status: STATUSES.SYNCED });
  assert.equal(synced.length, 2);
  const stillPending = await o.list({ status: STATUSES.PENDING });
  assert.equal(stillPending.length, 0);
});

test("list() filters by action_type", async () => {
  const o = newOutbox();
  await o.push('a', {});
  await o.push('b', {});
  await o.push('a', {});

  const aOnly = await o.list({ action_type: 'a' });
  assert.equal(aOnly.length, 2);
});

test("getEntry returns null for wrong user_fingerprint", async () => {
  const backend = createMemoryBackend();
  const userA = createOutbox({ backend, userFingerprint: 'A' });
  const userB = createOutbox({ backend, userFingerprint: 'B' });

  const key = await userA.push('a', {});
  // userB shouldn't see it.
  assert.equal(await userB.getEntry(key), null);
  // userA should.
  assert.ok(await userA.getEntry(key));
});

// ---- resolveConflict ------------------------------------------

test("resolveConflict('discard') marks cancelled", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', {});
  await o.drain({ send: conflictSend() });

  const ok = await o.resolveConflict(key, 'discard');
  assert.ok(ok);
  const entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.CANCELLED);
});

test("resolveConflict('retry') resets to pending + clears attempts", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', {});
  await o.drain({ send: conflictSend() });

  const ok = await o.resolveConflict(key, 'retry');
  assert.ok(ok);
  const entry = await o.getEntry(key);
  assert.equal(entry.status, STATUSES.PENDING);
  assert.equal(entry.attempts, 0);
  assert.equal(entry.conflict_info, null);
});

test("resolveConflict on non-conflict entry returns false", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', {});
  // Still pending, not in conflict state.
  const ok = await o.resolveConflict(key, 'discard');
  assert.equal(ok, false);
});

test("resolveConflict rejects unknown decision", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', {});
  await o.drain({ send: conflictSend() });
  await assert.rejects(o.resolveConflict(key, 'nonsense'), /unknown decision/);
});

// ---- gc -------------------------------------------------------

test("gc() removes terminal-state entries older than retentionMs", async () => {
  const backend = createMemoryBackend();
  const o = createOutbox({ backend, userFingerprint: 'u1', retentionMs: 1000 });

  const keepKey = await o.push('a', {});
  const oldKey = await o.push('b', {});
  await o.drain({ send: okSend() });  // both synced (terminal)

  // Manually age the 'old' entry by mutating the backend.
  const oldEntry = await backend.get(oldKey);
  oldEntry.created_at = new Date(Date.now() - 5000).toISOString();
  await backend.put(oldEntry);

  const removed = await o.gc();
  assert.equal(removed, 1);
  assert.equal(await o.getEntry(oldKey), null);
  assert.ok(await o.getEntry(keepKey));  // recent, kept
});

test("gc() preserves non-terminal entries regardless of age", async () => {
  const backend = createMemoryBackend();
  const o = createOutbox({ backend, userFingerprint: 'u1', retentionMs: 1000 });

  const key = await o.push('a', {});
  // Don't drain; the entry stays pending.
  const e = await backend.get(key);
  e.created_at = new Date(Date.now() - 5000).toISOString();
  await backend.put(e);

  const removed = await o.gc();
  assert.equal(removed, 0);
  assert.ok(await o.getEntry(key));
});

// ---- isTerminal ------------------------------------------------

test("isTerminal recognises every terminal state", () => {
  assert.ok(isTerminal('synced'));
  assert.ok(isTerminal('failed'));
  assert.ok(isTerminal('cancelled'));
  assert.ok(isTerminal('conflict'));
  assert.ok(isTerminal('rejected'));
  assert.ok(!isTerminal('pending'));
  assert.ok(!isTerminal('inflight'));
});

// ---- Offline gaps and dead tabs (A6-02 / A6-03) ------------------

// What useHttpOutbox's senders throw when the request never left the
// device: socket disconnected, fetch network error.
function offlineSend(received = []) {
  return async (entry) => {
    received.push(entry.payload);
    const err = new Error('socket disconnected');
    err.offline = true;
    throw err;
  };
}

test("offline failures don't use up attempts, however many drains run", async () => {
  const o = newOutbox();
  const keys = [];
  // Five queued actions with a drain after each, like the Control Room
  // does on every tap while the venue wifi is down.
  for (let i = 0; i < 5; i++) {
    keys.push(await o.push('socket:set_active_diver', { i }));
    await o.drain({ send: offlineSend() });
  }
  for (const key of keys) {
    const e = await o.getEntry(key);
    assert.equal(e.status, STATUSES.PENDING);
    assert.equal(e.attempts, 0);
  }
});

test("an offline failure stops the drain so later entries can't overtake", async () => {
  const o = newOutbox();
  const first = await o.push('socket:set_active_diver', { diver: 'A' });
  const second = await o.push('socket:set_active_diver', { diver: 'B' });
  const tried = [];
  const r = await o.drain({ send: offlineSend(tried) });
  assert.deepEqual(tried, [{ diver: 'A' }], 'B was never attempted');
  assert.equal(r.drained, 0);
  assert.ok(r.retryInMs > 0, 'the caller is told to try again');
  assert.equal((await o.getEntry(first)).status, STATUSES.PENDING);
  assert.equal((await o.getEntry(second)).status, STATUSES.PENDING);

  // Back online: both go, in tap order.
  const sent = [];
  await o.drain({ send: okSend(sent) });
  assert.deepEqual(sent.map((e) => e.payload.diver), ['A', 'B']);
});

test("a timeout counts an attempt but still holds back the entries behind it", async () => {
  const o = newOutbox();
  const first = await o.push('socket:set_active_diver', { diver: 'A' });
  await o.push('socket:set_active_diver', { diver: 'B' });
  const tried = [];
  await o.drain({
    send: async (entry) => {
      tried.push(entry.payload.diver);
      const err = new Error('timeout');
      err.ambiguous = true;
      throw err;
    },
  });
  assert.deepEqual(tried, ['A']);
  const e = await o.getEntry(first);
  assert.equal(e.status, STATUSES.PENDING);
  assert.equal(e.attempts, 1);
});

test("a server rejection still counts and doesn't block the queue", async () => {
  const o = newOutbox();
  const bad = await o.push('socket:referee_redive', { n: 1 });
  const good = await o.push('socket:meet_hold', { n: 2 });
  await o.drain({
    send: async (entry) => {
      if (entry.payload.n === 1) throw new Error('not authorised');
      return { ok: true };
    },
  });
  assert.equal((await o.getEntry(bad)).attempts, 1);
  assert.equal((await o.getEntry(good)).status, STATUSES.SYNCED);
});

test("retryFailed() puts failed entries back in the queue with fresh attempts", async () => {
  const o = newOutbox({ maxAttempts: 1 });
  const key = await o.push('socket:meet_hold', {});
  await o.drain({ send: async () => { throw new Error('boom'); } });
  assert.equal((await o.getEntry(key)).status, STATUSES.FAILED);
  assert.equal(await o.retryFailed(), 1);
  const e = await o.getEntry(key);
  assert.equal(e.status, STATUSES.PENDING);
  assert.equal(e.attempts, 0);
  const r = await o.drain({ send: okSend() });
  assert.equal(r.drained, 1);
});

test("an entry a dead tab left inflight is sent again by the next outbox", async () => {
  const backend = createMemoryBackend();
  const dead = createOutbox({ backend, userFingerprint: 'u1' });
  const key = await dead.push('submit_score', { score: 8 });
  // The tab reloads while send() is still waiting on its ack.
  dead.drain({ send: () => new Promise(() => {}) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await backend.get(key)).status, STATUSES.INFLIGHT);

  // Age it past the stale threshold, as if the reload took a while.
  const e = await backend.get(key);
  e.last_attempt_at = new Date(Date.now() - 60_000).toISOString();
  await backend.put(e);

  const fresh = createOutbox({ backend, userFingerprint: 'u1' });
  const sent = [];
  const r = await fresh.drain({ send: okSend(sent) });
  assert.equal(r.drained, 1);
  assert.equal(sent[0].idempotency_key, key, 'same key, so the server dedupes');
  assert.equal((await backend.get(key)).status, STATUSES.SYNCED);
});

test("a recently inflight entry is left for its sender, with a hint when to look again", async () => {
  const backend = createMemoryBackend();
  const other = createOutbox({ backend, userFingerprint: 'u1' });
  const key = await other.push('submit_score', { score: 8 });
  other.drain({ send: () => new Promise(() => {}) });
  await new Promise((r) => setTimeout(r, 5));

  const fresh = createOutbox({ backend, userFingerprint: 'u1' });
  const sent = [];
  const r = await fresh.drain({ send: okSend(sent) });
  assert.equal(sent.length, 0);
  assert.equal((await backend.get(key)).status, STATUSES.INFLIGHT);
  assert.ok(r.retryInMs > 0 && r.retryInMs <= 15_000, `retryInMs=${r.retryInMs}`);
});

// ---- Refusals a resend can't change --------------------------------

// What useHttpOutbox's socket sender throws for one of those, a judge's
// score for an event that isn't Live any more.
function finalRefusal(reason = 'event_not_live') {
  const err = new Error(reason);
  err.final = true;
  return err;
}

test("a final refusal closes the entry on the first answer", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { score: 7.5 });
  const r = await o.drain({ send: async () => { throw finalRefusal(); } });
  assert.equal(r.rejected, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.retryInMs, null, 'nothing to come back for');
  const e = await o.getEntry(key);
  assert.equal(e.status, STATUSES.REJECTED);
  assert.equal(e.attempts, 1);
  assert.equal(e.last_error, 'event_not_live');

  // Later drains leave it be, and the banner's Retry can't pick it up.
  const sent = [];
  await o.drain({ send: okSend(sent) });
  assert.equal(await o.retryFailed(), 0);
  await o.drain({ send: okSend(sent) });
  assert.equal(sent.length, 0);
  assert.equal((await o.getEntry(key)).status, STATUSES.REJECTED);
});

test("a final refusal doesn't hold back the entries behind it", async () => {
  const o = newOutbox();
  const late = await o.push('submit_score', { event: 'finished' });
  const next = await o.push('submit_score', { event: 'live' });
  const r = await o.drain({
    send: async (entry) => {
      if (entry.payload.event === 'finished') throw finalRefusal();
      return { ok: true };
    },
  });
  assert.equal(r.rejected, 1);
  assert.equal(r.drained, 1);
  assert.equal((await o.getEntry(late)).status, STATUSES.REJECTED);
  assert.equal((await o.getEntry(next)).status, STATUSES.SYNCED);
});

test("gc() clears old rejected entries like any other finished one", async () => {
  const backend = createMemoryBackend();
  const o = createOutbox({ backend, userFingerprint: 'u1', retentionMs: 1000 });
  const key = await o.push('submit_score', { score: 8 });
  await o.drain({ send: async () => { throw finalRefusal(); } });
  const e = await backend.get(key);
  e.created_at = new Date(Date.now() - 5000).toISOString();
  await backend.put(e);
  assert.equal(await o.gc(), 1);
  assert.equal(await o.getEntry(key), null);
});

// The refusal can come back on any route (the drain is app-wide), so the
// entry carries whether the judge has been told yet, not the screen.
test("acknowledge() marks a rejected entry as told, once", async () => {
  const o = newOutbox();
  const key = await o.push('submit_score', { score: 7.5 });
  assert.equal((await o.getEntry(key)).acknowledged_at, null, 'a new entry starts untold');
  await o.drain({ send: async () => { throw finalRefusal(); } });
  assert.equal((await o.getEntry(key)).acknowledged_at, null, 'refused, but nobody has said so yet');

  let changes = 0;
  o.on('change', () => { changes += 1; });
  assert.equal(await o.acknowledge(key), true);
  const e = await o.getEntry(key);
  assert.ok(Date.parse(e.acknowledged_at) > 0, `acknowledged_at=${e.acknowledged_at}`);
  assert.equal(e.status, STATUSES.REJECTED, 'still closed, only now told');
  assert.equal(changes, 0, 'nothing a count reads has moved');

  assert.equal(await o.acknowledge(key), false, 'the second time is a no-op');
  assert.equal((await o.getEntry(key)).acknowledged_at, e.acknowledged_at);
});

test("acknowledge() leaves anything that wasn't refused for good alone", async () => {
  const o = newOutbox();
  const queued = await o.push('submit_score', { score: 6 });
  assert.equal(await o.acknowledge(queued), false);
  assert.equal((await o.getEntry(queued)).acknowledged_at, null);

  await o.drain({ send: async () => ({ ok: true }) });
  assert.equal((await o.getEntry(queued)).status, STATUSES.SYNCED);
  assert.equal(await o.acknowledge(queued), false);
  assert.equal((await o.getEntry(queued)).acknowledged_at, null);

  assert.equal(await o.acknowledge('no-such-key'), false);
});

test("acknowledge() can't reach another user's entries", async () => {
  const backend = createMemoryBackend();
  const mine = createOutbox({ backend, userFingerprint: 'u1' });
  const theirs = createOutbox({ backend, userFingerprint: 'u2' });
  const key = await mine.push('submit_score', { score: 7 });
  await mine.drain({ send: async () => { throw finalRefusal(); } });
  assert.equal(await theirs.acknowledge(key), false);
  assert.equal((await backend.get(key)).acknowledged_at, null);
});
