// Per-event public_id hash: a 12-char stable handle the Control
// Room uses to match the active diver against a scoreboard row
// without exposing internal UUIDs to spectators.
//
// The hash is computed in Node (not in SQL) so we don't depend
// on the pgcrypto extension being enabled on every deployment.
// Earlier versions used `substr(encode(digest(…), 'hex'), 1, 12)`
// in postgres which threw "function digest(text, unknown) does
// not exist" on databases without pgcrypto, breaking the roster
// and scoreboard queries entirely.
//
// Same algorithm on both sides (roster + scoreboard), sha256 of
// "<kind>:<event_id>:<id>" truncated to 12 hex chars. Per-event
// scope means a spectator can't cross-link a diver across meets.
//
// kind = "comp" for competitors, "team" for team-event teams.

const crypto = require("node:crypto");

function publicId(kind, eventId, id) {
  if (!eventId || !id) return null;
  return crypto
    .createHash("sha256")
    .update(`${kind}:${eventId}:${id}`)
    .digest("hex")
    .slice(0, 12);
}

module.exports = { publicId };
