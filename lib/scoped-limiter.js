// Put a rate limiter in front of one router's routes, and nothing else.
//
// The obvious way to write that is app.use(limiter, router), and it's
// wrong in a way that's easy to miss. With no path, Express mounts both
// functions at "/", so the limiter runs for every request that walks
// past that point in the stack, whether or not this router answers it.
// server.js mounted nine routers like that, which meant a spectator's
// GET /api/scoreboard was counted by two 60/min "search" buckets on its
// way through, GET /api/records by four, and a plain page load that fell
// through to the SPA fallback by the 30/min export bucket four times
// over. A venue full of phones behind one IP ran out in under a minute.
//
// limitRoutes() reads the paths the router declares and only runs the
// limiter for requests aimed at one of them. Anything else passes
// straight through, uncounted. The router still has to be built before
// it's handed over, which every factory in routes/ already is.
//
// opts.overrides maps some of the router's paths (exactly as the router
// declares them) to a limiter of their own, for a router whose routes
// don't cost the same: the archive's cached listing, which every
// scoreboard load hits, shouldn't share a budget with its uncached recap.
// A request is only ever counted once per limitRoutes() call, by the
// first path that matches it, and overrides are checked first.

const express = require("express");

function limitRoutes(limiter, router, { overrides = {} } = {}) {
  const paths = [...new Set(
    (router.stack || []).filter((layer) => layer.route).map((layer) => layer.route.path),
  )];
  // A router with a nested router.use() would hide its paths from us and
  // go unlimited without anyone noticing, so refuse it outright.
  if ((router.stack || []).some((layer) => !layer.route)) {
    throw new Error("limitRoutes: router has middleware layers, list its paths explicitly instead");
  }
  for (const p of Object.keys(overrides)) {
    if (!paths.includes(p)) throw new Error(`limitRoutes: override for ${p}, which the router doesn't declare`);
  }
  // Two patterns can both match one URL (/x/:id and /x/special), and
  // counting it twice would halve somebody's budget. First match wins.
  const counted = Symbol("limitRoutes");
  const once = (lim) => (req, res, next) => {
    if (req[counted]) return next();
    req[counted] = true;
    return lim(req, res, next);
  };
  const gate = express.Router();
  // As the one handler on an all-methods route, the limiter's next()
  // leaves the route and carries on to the router below it.
  for (const [p, own] of Object.entries(overrides)) gate.all(p, once(own));
  const rest = paths.filter((p) => !(p in overrides));
  if (rest.length) gate.all(rest, once(limiter));
  gate.use(router);
  return gate;
}

module.exports = { limitRoutes };
