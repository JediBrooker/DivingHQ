// Event progression belongs to one socket, including when the same account
// opens two windows. Transient leases and operation queues share the live-state
// engine's single-process invariant. Tokens never go to event rooms or disk.
const { randomUUID } = require('node:crypto');
const LEASE_MS = 30_000;

function createEventControl({ now = Date.now } = {}) {
  const leases = new Map();
  const queues = new Map();
  function get(eventId) {
    eventId = String(eventId).toLowerCase();
    const lease = leases.get(eventId);
    if (lease?.expiresAt && lease.expiresAt <= now()) {
      leases.delete(eventId);
      return null;
    }
    return lease || null;
  }
  function run(eventId, action) {
    eventId = String(eventId).toLowerCase();
    const previous = queues.get(eventId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    queues.set(eventId, pending);
    pending.finally(() => { if (queues.get(eventId) === pending) queues.delete(eventId); }).catch(() => {});
    return pending;
  }
  function claim(eventId, { socketId, userId, modern = false, takeover = false }) {
    eventId = String(eventId).toLowerCase();
    const previous = get(eventId);
    if (previous && previous.socketId !== socketId && !takeover) return { ok: false, previous };
    if (previous?.socketId === socketId && previous.modern === modern) {
      if (modern) previous.expiresAt = now() + LEASE_MS;
      return { ok: true, lease: previous };
    }
    const lease = { socketId, userId, modern, token: randomUUID(), grantedAt: now(), expiresAt: modern ? now() + LEASE_MS : null };
    leases.set(eventId, lease);
    return { ok: true, lease, previous };
  }
  function owns(eventId, { socketId, userId, token }) {
    eventId = String(eventId).toLowerCase();
    const lease = get(eventId);
    return !!lease && lease.userId === userId && lease.socketId === socketId
      && (lease.modern ? token === lease.token : token == null || token === lease.token);
  }
  function ownsHttp(eventId, { userId, token }) {
    eventId = String(eventId).toLowerCase();
    const lease = get(eventId);
    return !!lease && lease.userId === userId && typeof token === 'string' && token === lease.token;
  }
  function renew(eventId, owner) {
    eventId = String(eventId).toLowerCase();
    if (!owns(eventId, owner)) return false;
    const lease = get(eventId);
    if (lease.modern) lease.expiresAt = now() + LEASE_MS;
    return true;
  }
  function release(eventId, owner) {
    eventId = String(eventId).toLowerCase();
    if (!owns(eventId, owner)) return false;
    leases.delete(eventId);
    return true;
  }
  function disconnect(socketId) {
    return Promise.all([...leases].filter(([, lease]) => lease.socketId === socketId)
      .map(([eventId]) => run(eventId, () => {
        if (get(eventId)?.socketId === socketId) leases.delete(eventId);
      })));
  }
  return { get, run, claim, owns, ownsHttp, renew, release, disconnect, clear: (eventId) => leases.delete(String(eventId).toLowerCase()) };
}
module.exports = { createEventControl, LEASE_MS, eventControl: createEventControl() };
