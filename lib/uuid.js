// Checking ids that arrive off the wire before they reach a uuid column.
//
// A malformed one (a typo'd link, a stale bookmark, a client bug) made
// Postgres throw 22P02 on the cast, and the accounts and org routes turned
// that into a 500: it showed up in the logs and alerting as a server fault
// and the UI said "Internal server error" instead of not found.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// For router.param("id", requireUuidParam): a path id that can't be a row
// is a 404 before any handler runs.
function requireUuidParam(req, res, next, value) {
  if (isUuid(value)) return next();
  res.status(404).json({ error: "Not found" });
}

module.exports = { UUID_RE, isUuid, requireUuidParam };
