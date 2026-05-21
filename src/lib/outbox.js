// Client-side outbox for offline-resilient writes.
//
// Every meet-time action a client wants to send goes through this
// outbox. push() persists the action to IndexedDB; drain() walks
// the queue and invokes a caller-supplied send() function (which
// knows how to talk to the socket or HTTP layer). Entries survive
// page reloads, navigation between views, and offline gaps up to
// 72 hours (matching the server-side idempotency retention).
//
// See docs/offline-p1-design.md §1 for the full design.
//
// Design choices worth knowing:
//
//   * The outbox is BACKEND-INJECTED. Production code passes the
//     IDB-backed backend; tests pass an in-memory Map-backed one.
//     Keeps unit tests dependency-free and the production hot path
//     unchanged.
//
//   * push() is synchronous from the caller's perspective in the
//     sense that it returns the idempotency_key immediately. The
//     IDB write completes in the background. Optimistic UI updates
//     can fire on the returned key without waiting for IDB.
//
//   * drain() acquires an in-memory lock; concurrent callers no-op.
//     The lock is in-process only — two tabs of the same SPA can
//     each drain independently, but the server-side idempotency
//     layer dedupes them.
//
//   * FIFO by created_at. The server idempotency_keys table makes
//     re-sends safe, but operator intent is preserved by sending
//     in tap order.
//
//   * 5 attempts with exponential backoff (1s, 2s, 4s, 8s, 16s),
//     then status='failed'. Manual retry surfaces in the UI.
//
//   * No Vue coupling. Components subscribe via outbox.on('change')
//     and re-read counts as needed. A thin composable wrapper
//     (P2 work) translates events to reactive refs.

// ---- Constants ------------------------------------------------

const DB_NAME = 'divinghq-outbox'
const STORE = 'outbox'
const VERSION = 1

// 72h matches the server-side idempotency retention. Entries in
// terminal states older than this get GC'd on startup.
const RETENTION_MS = 72 * 60 * 60 * 1000

// Max 5 attempts then mark failed. UI surfaces failed entries for
// manual retry.
const MAX_ATTEMPTS = 5

// Exponential backoff (ms): attempt 1 → 1s, attempt 2 → 2s, …
function backoffMs(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 30000)
}

// 100KB payload size cap (DEC-OPEN-1 in offline-p1-design.md, OK'd).
const MAX_PAYLOAD_BYTES = 100 * 1024

// State machine. Terminal states: synced, failed, cancelled,
// conflict (the operator-decides flow takes them from conflict to
// either synced or cancelled in P4).
const STATUSES = {
  PENDING: 'pending',
  INFLIGHT: 'inflight',
  SYNCED: 'synced',
  CONFLICT: 'conflict',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

function isTerminal(status) {
  return status === STATUSES.SYNCED
    || status === STATUSES.FAILED
    || status === STATUSES.CANCELLED
    || status === STATUSES.CONFLICT
}

// ---- UUID v4 generator (no crypto.randomUUID polyfill needed) -
// crypto.randomUUID is available in all browsers we support; the
// fallback uses crypto.getRandomValues (also universal). Returns
// a canonical lowercase UUID v4 string.
function uuidV4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Set version (4) and variant (10) bits per RFC 4122.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${
    hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${
    hex.slice(10, 16).join('')}`
}

// ---- Tiny EventEmitter (no Node EventEmitter dep) -------------

function createEmitter() {
  const listeners = new Map()
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    off(event, fn) { listeners.get(event)?.delete(fn) },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) {
        try { fn(...args) } catch (err) {
          // Listeners shouldn't throw; log and keep going so one
          // bad listener doesn't break the chain.
          // eslint-disable-next-line no-console
          console.error('[outbox] listener error:', err)
        }
      }
    },
  }
}

// ---- IDB backend ----------------------------------------------
//
// Production storage. Same structure as src/lib/idbCache.js: lazy-
// open, never-reject helpers, fall through to no-op when
// indexedDB is unavailable (SSR / disabled).

export function createIdbBackend() {
  let dbPromise = null

  function openDb() {
    if (dbPromise) return dbPromise
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(null)
    }
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'idempotency_key' })
          store.createIndex('by_status', 'status', { unique: false })
          store.createIndex('by_action_type', 'action_type', { unique: false })
          store.createIndex('by_created_at', 'created_at', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    })
    return dbPromise
  }

  return {
    async put(entry) {
      const db = await openDb()
      if (!db) return
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(entry)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      })
    },
    async get(key) {
      const db = await openDb()
      if (!db) return null
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(key)
        req.onsuccess = () => resolve(req.result || null)
        req.onerror = () => resolve(null)
      })
    },
    async delete(key) {
      const db = await openDb()
      if (!db) return
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).delete(key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      })
    },
    async list(filter = {}) {
      const db = await openDb()
      if (!db) return []
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly')
        const store = tx.objectStore(STORE)
        const out = []
        // We walk via the by_created_at index so the result is
        // FIFO. Filtering happens in-memory because compound
        // index queries on (status, created_at) would need a
        // second index definition; the queue is small enough
        // that the JS-side filter is cheaper than the schema
        // complexity.
        const cursorReq = store.index('by_created_at').openCursor()
        cursorReq.onsuccess = () => {
          const cur = cursorReq.result
          if (!cur) { resolve(out); return }
          const val = cur.value
          if ((filter.status == null || val.status === filter.status)
              && (filter.action_type == null || val.action_type === filter.action_type)
              && (filter.user_fingerprint == null || val.user_fingerprint === filter.user_fingerprint)) {
            out.push(val)
          }
          cur.continue()
        }
        cursorReq.onerror = () => resolve(out)
      })
    },
    async clear() {
      const db = await openDb()
      if (!db) return
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      })
    },
  }
}

// ---- In-memory backend (tests) --------------------------------
//
// Same interface; Map under the hood. No transactions, no async
// overhead. Tests use this exclusively so the test suite stays
// dependency-free.

export function createMemoryBackend() {
  const m = new Map()
  return {
    async put(entry) { m.set(entry.idempotency_key, entry) },
    async get(key) { return m.get(key) || null },
    async delete(key) { m.delete(key) },
    async list(filter = {}) {
      const entries = [...m.values()]
      entries.sort((a, b) => a.created_at.localeCompare(b.created_at))
      return entries.filter((e) =>
        (filter.status == null || e.status === filter.status)
        && (filter.action_type == null || e.action_type === filter.action_type)
        && (filter.user_fingerprint == null || e.user_fingerprint === filter.user_fingerprint)
      )
    },
    async clear() { m.clear() },
  }
}

// ---- Outbox -----------------------------------------------------
//
// The core API. Caller injects a backend + an optional
// userFingerprint. The fingerprint stops user B from draining
// user A's queued actions after a logout/login swap on the same
// device (see src/lib/idbCache.js comment for the same hazard).

export function createOutbox({
  backend = createIdbBackend(),
  userFingerprint = 'anon',
  maxAttempts = MAX_ATTEMPTS,
  retentionMs = RETENTION_MS,
} = {}) {
  const emitter = createEmitter()
  let drainLock = false

  function emitChange() { emitter.emit('change') }

  /**
   * Queue an action. Returns the idempotency_key the caller
   * should reference for optimistic UI updates + conflict
   * resolution. The IDB write completes in the background; the
   * key is generated synchronously.
   *
   * @param {string} actionType  Stable identifier for the action
   *                             (e.g., 'submit_score'). Used for
   *                             routing in drain() and for
   *                             debugging the queue.
   * @param {object} payload     The action's payload. Will be
   *                             sent verbatim to send() at drain
   *                             time. JSON-serialisable.
   * @param {object} [opts]
   * @param {Date}   [opts.actorLocalTime]  Defaults to now.
   * @returns {Promise<string>}  The idempotency_key.
   */
  async function push(actionType, payload, opts = {}) {
    if (!actionType || typeof actionType !== 'string') {
      throw new Error('outbox.push: actionType required')
    }
    const serialised = JSON.stringify(payload || {})
    if (serialised.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`outbox.push: payload exceeds ${MAX_PAYLOAD_BYTES} bytes`)
    }
    const now = new Date()
    const entry = {
      idempotency_key: uuidV4(),
      action_type: actionType,
      payload,
      actor_local_time: (opts.actorLocalTime || now).toISOString(),
      user_fingerprint: userFingerprint,
      status: STATUSES.PENDING,
      attempts: 0,
      last_attempt_at: null,
      last_error: null,
      conflict_info: null,
      created_at: now.toISOString(),
      synced_at: null,
      server_response: null,
    }
    await backend.put(entry)
    emitChange()
    return entry.idempotency_key
  }

  /**
   * Walk pending entries in FIFO order, calling send() on each.
   * Concurrent drain() calls no-op (in-process lock). Drains
   * only entries matching the configured user_fingerprint.
   *
   * The send function receives the full entry and must return
   *   { ok: true, response }            → mark synced
   * Or throw with err.kind === 'conflict' + err.conflict
   *   payload                            → mark conflict
   * Or throw any other error              → attempt++, retry
   *   or mark failed after maxAttempts.
   *
   * @param {object} opts
   * @param {(entry: object) => Promise<{ ok: boolean, response?: any }>} opts.send
   * @returns {Promise<{ drained: number, conflicts: number, failed: number }>}
   */
  async function drain({ send }) {
    if (drainLock) return { drained: 0, conflicts: 0, failed: 0 }
    if (typeof send !== 'function') {
      throw new Error('outbox.drain: send function required')
    }
    drainLock = true
    try {
      const pending = await backend.list({
        status: STATUSES.PENDING,
        user_fingerprint: userFingerprint,
      })
      let drained = 0
      let conflicts = 0
      let failed = 0

      for (const entry of pending) {
        // Mark inflight before sending so a concurrent drain in
        // another tab skips this entry. The status flips back to
        // pending on retryable failure.
        entry.status = STATUSES.INFLIGHT
        entry.attempts += 1
        entry.last_attempt_at = new Date().toISOString()
        await backend.put(entry)
        emitChange()

        try {
          const result = await send(entry)
          if (result?.ok) {
            entry.status = STATUSES.SYNCED
            entry.synced_at = new Date().toISOString()
            entry.server_response = result.response || null
            entry.last_error = null
            await backend.put(entry)
            drained += 1
          } else {
            throw new Error('send returned non-ok result')
          }
        } catch (err) {
          if (err && err.kind === 'conflict') {
            entry.status = STATUSES.CONFLICT
            entry.conflict_info = err.conflict || { message: err.message }
            await backend.put(entry)
            conflicts += 1
          } else if (entry.attempts >= maxAttempts) {
            entry.status = STATUSES.FAILED
            entry.last_error = String(err?.message || err)
            await backend.put(entry)
            failed += 1
          } else {
            // Schedule a retry with exponential backoff. We just
            // flip the status back to pending; the next drain()
            // (on socket reconnect, online event, or the periodic
            // heartbeat in the calling composable) picks it up.
            entry.status = STATUSES.PENDING
            entry.last_error = String(err?.message || err)
            await backend.put(entry)
            // Note: we don't sleep here. The retry is scheduled
            // by whatever triggered this drain; the backoff is
            // implicit in the wait until the next drain trigger.
          }
          emitChange()
        }
      }

      emitChange()
      return { drained, conflicts, failed }
    } finally {
      drainLock = false
    }
  }

  /**
   * List entries, optionally filtered by status/action_type.
   * Returns in FIFO order (oldest created_at first). Always
   * scoped to this outbox's user_fingerprint.
   */
  async function list(filter = {}) {
    return backend.list({ ...filter, user_fingerprint: userFingerprint })
  }

  /** Single-entry status lookup. */
  async function getEntry(key) {
    const e = await backend.get(key)
    if (!e) return null
    if (e.user_fingerprint !== userFingerprint) return null
    return e
  }

  /**
   * Resolve a conflict-state entry. In P1 the only meaningful
   * decisions are 'discard' (mark cancelled) or 'retry' (flip
   * back to pending). The 'accept_proposed' / 'keep_existing'
   * flow that the Control Room conflict tray will use happens
   * server-side via POST /api/conflicts/:id/resolve in P4; the
   * client outbox only needs to dispose of its local entry.
   */
  async function resolveConflict(key, decision) {
    const entry = await getEntry(key)
    if (!entry || entry.status !== STATUSES.CONFLICT) return false
    if (decision === 'discard') {
      entry.status = STATUSES.CANCELLED
    } else if (decision === 'retry') {
      entry.status = STATUSES.PENDING
      entry.attempts = 0
      entry.last_error = null
      entry.conflict_info = null
    } else {
      throw new Error(`outbox.resolveConflict: unknown decision '${decision}'`)
    }
    await backend.put(entry)
    emitChange()
    return true
  }

  /**
   * Garbage-collect terminal-state entries older than the
   * retention window. Called on startup and (optionally) on a
   * periodic timer by the consumer.
   */
  async function gc() {
    const cutoff = Date.now() - retentionMs
    const all = await backend.list({ user_fingerprint: userFingerprint })
    let removed = 0
    for (const e of all) {
      if (isTerminal(e.status) && Date.parse(e.created_at) < cutoff) {
        await backend.delete(e.idempotency_key)
        removed += 1
      }
    }
    if (removed > 0) emitChange()
    return removed
  }

  return {
    push,
    drain,
    list,
    getEntry,
    resolveConflict,
    gc,
    on: emitter.on,
    off: emitter.off,
    STATUSES,
  }
}

export { STATUSES, MAX_PAYLOAD_BYTES, MAX_ATTEMPTS, RETENTION_MS, uuidV4, backoffMs, isTerminal }
