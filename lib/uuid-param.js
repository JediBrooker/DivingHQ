// Path ids are UUIDs, and anything else sent into `WHERE id = $1` makes
// pg throw 22P02, which the route's catch turns into a 500. A mistyped
// link or a crawler then reads as an outage in the 5xx metrics. This
// answers 404 before the handler runs.
//
// Only for routers where every route using those param names really
// takes a UUID: router.param fires for any matching route in the router.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function uuidParams(router, ...names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (isUuid(value)) return next();
      res.status(404).json({ error: "Not found" });
    });
  }
  return router;
}

module.exports = { UUID_RE, isUuid, uuidParams };
