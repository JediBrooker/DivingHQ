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
//     hits a constraint or a long lock wait). Errors are logged
//     to stderr for ops follow-up.
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
  try {
    await db.query(
      `INSERT INTO audit_log
         (org_id, actor_id, entity_type, entity_id, entity_name,
          action, metadata, note, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        entry.org_id     || null,
        entry.actor_id   || null,
        entry.entity_type,
        entry.entity_id  || null,
        entry.entity_name || null,
        entry.action,
        entry.metadata != null ? JSON.stringify(entry.metadata) : null,
        entry.note       || null,
        entry.ip_address || null,
        entry.user_agent || null,
      ],
    );
  } catch (err) {
    // Don't throw here, the parent action already succeeded, we
    // just failed to record it. Log loudly so ops actually notices.
    console.error("[audit] recordAudit failed:", err.message, "for", entry.action);
  }
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
