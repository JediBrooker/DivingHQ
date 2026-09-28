// Audit-log helper for the generic `audit_log` table (migration
// 032). Used by routes/events.js, routes/orgs.js, routes/teams.js,
// routes/control-room.js, etc. to record entity-lifecycle events
// that don't fit the score / role audit shapes.
//
// Design:
//
//   - Best-effort. The helper swallows errors so a write failure
//     against `audit_log` never aborts the parent transaction
//     (e.g. an event delete must succeed even if audit insert
//     hits a constraint or a long lock wait). On a transaction
//     client that takes a savepoint, see recordAudit. Errors are
//     logged to stderr for ops follow-up.
//
//   - Either pool or pgClient acceptable. Routes that already
//     hold a transaction client pass it (so the audit row is
//     committed atomically with the action); routes that don't
//     pass the pool and the audit row writes outside the
//     transaction.
//
//   - actor + IP + user-agent come from the Express req via the
//     auditFromReq() shortcut. Routes without a req (e.g.
//     scheduled jobs) call recordAudit() directly.
//
// Schema reminder (audit_log columns):
//   id, org_id, actor_id, entity_type, entity_id, entity_name,
//   action, metadata jsonb, note, ip_address inet, user_agent text,
//   created_at
//
// Action naming convention: dot-namespaced verb, past tense:
//   'event.created', 'event.deleted', 'event.status_changed',
//   'event.workflow_reset', 'event.late_entry_added',
//   'event.attested_signoff',
//   'roster.withdrew', 'roster.reinstated',
//   'org.created', 'org.status_changed',
//   'club.deleted', 'team.deleted',
//   'event_template.deleted',
//
// New surfaces add new strings, no enum, no migration needed.

const net = require("node:net");

/**
 * Insert one row into audit_log. Best-effort.
 *
 * @param {object|import('pg').PoolClient} db   pool or transaction client
 * @param {object} entry
 * @param {string|null}  entry.org_id
 * @param {string|null}  entry.actor_id
 * @param {string}       entry.entity_type   short identifier ('event', 'org', 'club', …)
 * @param {string|null}  entry.entity_id     uuid of the affected row (nullable post-delete)
 * @param {string|null}  entry.entity_name   denormalised display name
 * @param {string}       entry.action        dot-namespaced verb past tense
 * @param {object|null}  [entry.metadata]    arbitrary jsonb payload
 * @param {string|null}  [entry.note]        free-text reason
 * @param {string|null}  [entry.ip_address]
 * @param {string|null}  [entry.user_agent]
 */
async function recordAudit(db, entry) {
  if (!db || !entry || !entry.entity_type || !entry.action) return;
  const sql = `INSERT INTO audit_log
         (org_id, actor_id, entity_type, entity_id, entity_name,
          action, metadata, note, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`;
  const params = [
    entry.org_id     || null,
    entry.actor_id   || null,
    entry.entity_type,
    entry.entity_id  || null,
    entry.entity_name || null,
    entry.action,
    entry.metadata != null ? JSON.stringify(entry.metadata) : null,
    entry.note       || null,
    auditIp(entry.ip_address),
    entry.user_agent || null,
  ];
  // Don't throw from here, the parent action already succeeded and we
  // just failed to record it. Log loudly so ops actually notices.
  const failed = (err) => console.error("[audit] recordAudit failed:", err.message, "for", entry.action);

  // The pool hands each query its own connection, so a failure there
  // can't touch anybody's transaction.
  if (typeof db.release !== "function") {
    try { await db.query(sql, params); } catch (err) { failed(err); }
    return;
  }

  // A checked-out client is usually mid-BEGIN, and there a failed INSERT
  // aborts the whole transaction. Swallowing the error doesn't undo that:
  // the caller's COMMIT then quietly comes back as ROLLBACK, no exception,
  // and the route answers 2xx for work that was thrown away (an event
  // "created" that doesn't exist). So the insert runs under a savepoint we
  // can roll back to. pg won't tell us whether we're in a transaction, but
  // SAVEPOINT outside one just fails with 25P01 and harms nothing, and
  // then a plain insert is fine.
  let savepoint = false;
  try {
    await db.query("SAVEPOINT record_audit");
    savepoint = true;
  } catch (err) {
    // Anything but "no transaction" (25P02, say: the caller's transaction
    // is already aborted) leaves nothing worth trying.
    if (err.code !== "25P01") { failed(err); return; }
  }
  try {
    await db.query(sql, params);
    if (savepoint) await db.query("RELEASE SAVEPOINT record_audit");
  } catch (err) {
    failed(err);
    if (savepoint) {
      await db.query("ROLLBACK TO SAVEPOINT record_audit").catch(() => {});
      await db.query("RELEASE SAVEPOINT record_audit").catch(() => {});
    }
  }
}

// ip_address is an inet column, and req.ip is only as trustworthy as the
// proxy hop in front of us: without a proxy that rewrites X-Forwarded-For
// the client picks it, and "not-an-ip" fails the cast. Keep the row, drop
// the junk address.
function auditIp(ip) {
  if (typeof ip !== "string") return null;
  const v = ip.trim();
  return net.isIP(v) ? v : null;
}

/**
 * Build the actor / ip / user-agent shape from an Express req
 * so each route call site stays terse:
 *
 *   await recordAudit(client, {
 *     ...auditFromReq(req),
 *     org_id: ev.org_id,
 *     entity_type: 'event',
 *     entity_id: ev.id,
 *     entity_name: ev.name,
 *     action: 'event.deleted',
 *   })
 */
function auditFromReq(req) {
  if (!req) return { actor_id: null, ip_address: null, user_agent: null };
  return {
    actor_id:   req.user?.id || null,
    ip_address: req.ip || (req.connection && req.connection.remoteAddress) || null,
    user_agent: (req.get && req.get("user-agent")) || null,
  };
}

module.exports = { recordAudit, auditFromReq };
