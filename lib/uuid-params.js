// lib/uuid-params.js: malformed ids answer 404/400, not 500.
//
// Every id in the API is a uuid, and the routes pass path and query ids
// straight into Postgres. A mistyped or truncated link (/scoreboard/abc,
// a crawler guessing) made Postgres throw 22P02 "invalid input syntax for
// type uuid", which the handlers' catch-alls answered with a 500 and a
// logged error.

// The one uuid test is lib/uuid's; this file only adds the Express
// plumbing around it (router params that skip, query filters that 400).
const { UUID_RE, isUuid } = require("./uuid");

// Register a guard on each named path param of `router`. A value that
// can't be a uuid skips the route (next('route')), so the request falls
// through to the app's JSON 404 the way an unknown path does, and a
// later router that owns a literal path in the same spot still gets its
// chance.
function uuidParams(router, ...names) {
  for (const name of names) {
    router.param(name, (_req, _res, next, value) => (isUuid(value) ? next() : next("route")));
  }
  return router;
}

// For optional uuid filters in the query string: answers 400 and returns
// true when one is present but malformed.
function rejectBadUuidQuery(req, res, ...names) {
  for (const name of names) {
    const v = req.query[name];
    if (v === undefined || v === "") continue;
    if (!isUuid(v)) {
      res.status(400).json({ error: `${name} must be a valid id` });
      return true;
    }
  }
  return false;
}

module.exports = { isUuid, uuidParams, rejectBadUuidQuery, UUID_RE };
