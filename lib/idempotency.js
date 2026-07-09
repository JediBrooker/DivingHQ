// Idempotency middleware + helpers.
//
// Every meet-time write endpoint (HTTP and socket) optionally
// accepts an `idempotency_key` from the client. The first time a
// key arrives we run the handler normally and cache the response
// in the `idempotency_keys` table (migration 054). Subsequent
// arrivals of the same key short-circuit to the cached response,
// so an outbox-driven retry doesn't double-apply.
//
// See docs/offline-p1-design.md §2 for the full design.
//
// Three exposed surfaces:
//
//   httpMiddleware(action)   Express middleware factory. Attaches
//                            per-route to meet-time write endpoints.
//   socketCheck(…)           Async lookup for socket handlers.
//                            Returns the cached row on hit, null on
//                            miss, or a structured error on conflict.
//   socketStore(…)           Fire-and-forget cache write for socket
//                            handlers AFTER they've completed work.
//
// All three share the same UUID-v4 validation, payload
// canonicalisation, and sha256 hashing so HTTP and socket paths
// agree on identity.
//
// Failure posture: a DB lookup error inside the middleware does
// NOT reject the request. We log + fall through to normal handling.
// Better to double-write under a transient DB blip than to refuse a
// judge's score because the cache layer was flaky. The 72-hour TTL
// on rows means a temporarily-undetected duplicate self-heals.

const crypto = require("crypto");

// RFC 4122 UUID v4: 8-4-4-4-12 hex with the version nibble = 4 and
// the variant nibble in [8,9,a,b]. We're strict so a malformed key
// (truncated, wrong version, mixed-case oddity) fails fast on the
// client side instead of polluting the cache table.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuidV4(s) {
  return typeof s === "string" && UUID_V4_RE.test(s);
}

// Recursive key-sort canonicaliser. JSON.stringify isn't
// deterministic across runtimes when the same object's keys are
// iterated in different order (V8 + JSC agree today, but Node
// version bumps and future JS engines aren't a contract).
// Sorting by key recursively + then stringify produces a
// byte-stable representation suitable for hashing.
function canonicalise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const sorted = {};
  for (const k of Object.keys(value).sort()) {
    sorted[k] = canonicalise(value[k]);
  }
  return sorted;
}

// Returns a Buffer (the pg driver maps Buffer ↔ bytea natively).
function hashPayload(payload) {
  const canonical = JSON.stringify(canonicalise(payload || {}));
  return crypto.createHash("sha256").update(canonical).digest();
}

/**
 * Wire up the idempotency layer with a Postgres pool. Call once
 * per consumer, BEFORE attaching route or socket handlers.
 *
 * Each instance closes over its own pool, so multiple instances
 * (e.g. a test harness next to the app pool) must not share or
 * overwrite each others connection state. That's why there's no
 * module-level pool.
 *
 * @param {{ pool: import('pg').Pool }} opts
 * @returns {object} { httpMiddleware, socketCheck, socketStore, hashPayload, isValidUuidV4 }
 */
function createIdempotency({ pool }) {
  if (!pool) throw new Error("createIdempotency requires { pool }");

  /**
   * Express middleware factory.
   *
   * Usage:
   *   const idem = require('../lib/idempotency')({ pool });
   *   router.post('/api/x', verifyToken, idem.httpMiddleware('action_name'),
   *               async (req, res) => { … });
   *
   * The middleware reads `X-Idempotency-Key` header OR
   * `req.body.idempotency_key`. If neither is present it just calls
   * next() and the handler runs uncached, matching the "online
   * direct call" path for clients that don't use the outbox.
   */
  function httpMiddleware(actionType) {
    return async function idempotencyMiddleware(req, res, next) {
      const key = req.get("X-Idempotency-Key") || req.body?.idempotency_key;
      if (!key) return next();

      if (!req.user?.id) {
        return res.status(401).json({
          error: "Authentication required for idempotent requests",
        });
      }

      if (!isValidUuidV4(key)) {
        return res.status(400).json({
          error: "idempotency_key must be a UUID v4",
        });
      }

      // Strip the key from the body BEFORE hashing so a client that
      // happens to include it in the body doesn't change the hash
      // vs the same payload sent via header.
      const payloadForHash = { ...(req.body || {}) };
      delete payloadForHash.idempotency_key;
      const hash = hashPayload(payloadForHash);

      try {
        const r = await pool.query(
          `SELECT user_id, request_hash, response_status, response_body
           FROM idempotency_keys WHERE idempotency_key = $1`,
          [key],
        );

        if (r.rows.length) {
          const row = r.rows[0];

          // Owner check: a different user MUST NOT be able to
          // replay another user's request, even with the same UUID.
          // A client bug that reuses keys across users would be a
          // privilege-escalation vector without this gate.
          if (row.user_id !== req.user.id) {
            return res.status(403).json({
              error: "idempotency_key belongs to a different user",
            });
          }

          // Payload check: same key + different payload = client bug
          // (or attacker). 422 makes the failure mode explicit; the
          // client outbox should never trip this on its own.
          const cachedHash = Buffer.isBuffer(row.request_hash)
            ? row.request_hash
            : Buffer.from(row.request_hash);
          if (!cachedHash.equals(hash)) {
            return res.status(422).json({
              error: "idempotency_key reused with different payload",
            });
          }

          // Cache hit. Replay the exact response.
          res.set("X-Idempotent", "replay");
          return res.status(row.response_status).json(row.response_body);
        }
      } catch (err) {
        // Fall through to normal handling on DB error. See header.
        console.error("[idempotency] lookup failed:", err.message);
        return next();
      }

      // Cache miss. Wrap res.json so we capture the response on the
      // way back out. We only cache 2xx; failures pass through
      // uncached so the client can retry against natural idempotency
      // (e.g. the scores table's unique constraint).
      const originalJson = res.json.bind(res);
      res.json = function cachedJson(body) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Fire-and-forget. ON CONFLICT DO NOTHING handles the
          // rare race where two concurrent requests with the same
          // key both arrive at this branch.
          pool.query(
            `INSERT INTO idempotency_keys
               (idempotency_key, user_id, action_type, request_hash,
                response_status, response_body)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [key, req.user.id, actionType, hash, res.statusCode, body],
          ).catch((err) =>
            console.error("[idempotency] cache write failed:", err.message),
          );
        }
        return originalJson(body);
      };

      return next();
    };
  }

  /**
   * Socket-handler check. Returns the cached response on hit, null
   * on miss, or `{ error: '…', status: … }` on conflict.
   *
   * Caller pattern:
   *   const hit = await idem.socketCheck(data.idempotency_key,
   *                                      socket.userId,
   *                                      idem.hashPayload(data));
   *   if (hit?.error) { socket.emit('error', hit); return; }
   *   if (hit) { socket.emit('action_result', hit.response_body); return; }
   *   … normal handling …
   *   await idem.socketStore(…);
   *   socket.emit('action_result', …);
   *
   * Returns null when no key was supplied so the caller can fall
   * through to the existing flow without a special case.
   */
  async function socketCheck(key, userId, requestHash) {
    if (!key) return null;
    if (!isValidUuidV4(key)) {
      return { error: "invalid_idempotency_key", status: 400 };
    }
    if (!userId) {
      return { error: "auth_required", status: 401 };
    }

    try {
      const r = await pool.query(
        `SELECT user_id, request_hash, response_status, response_body
         FROM idempotency_keys WHERE idempotency_key = $1`,
        [key],
      );
      if (!r.rows.length) return null;

      const row = r.rows[0];
      if (row.user_id !== userId) {
        return { error: "key_belongs_to_different_user", status: 403 };
      }

      const cachedHash = Buffer.isBuffer(row.request_hash)
        ? row.request_hash
        : Buffer.from(row.request_hash);
      if (!cachedHash.equals(requestHash)) {
        return { error: "key_reused_with_different_payload", status: 422 };
      }

      return {
        response_status: row.response_status,
        response_body: row.response_body,
      };
    } catch (err) {
      console.error("[idempotency] socketCheck failed:", err.message);
      return null;  // fall through, same posture as the HTTP path
    }
  }

  /**
   * Fire-and-forget cache write for socket handlers. Call AFTER the
   * handler has done its work and is about to emit its response, so
   * a replay-after-crash has something to return.
   *
   * Errors are logged, not thrown, since socket emit shouldn't fail
   * just because the cache layer hiccuped.
   */
  function socketStore(key, userId, actionType, requestHash, responseStatus, responseBody) {
    if (!key || !userId) return;
    pool.query(
      `INSERT INTO idempotency_keys
         (idempotency_key, user_id, action_type, request_hash,
          response_status, response_body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, userId, actionType, requestHash, responseStatus, responseBody],
    ).catch((err) =>
      console.error("[idempotency] socketStore failed:", err.message),
    );
  }

  return {
    httpMiddleware,
    socketCheck,
    socketStore,
    hashPayload,
    isValidUuidV4,
  };
}

module.exports = createIdempotency;
module.exports.hashPayload = hashPayload;
module.exports.isValidUuidV4 = isValidUuidV4;
module.exports.canonicalise = canonicalise;
