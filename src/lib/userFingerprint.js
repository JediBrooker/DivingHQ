// Cheap, deterministic per-user fingerprint.
//
// Used to scope client-side keyspaces (idbCache entries, outbox rows)
// per signed-in identity so logout/login on a shared device never
// reads another user's data. The session token lives in an httpOnly
// cookie the client JS can't read, so the user id (already a UUID,
// stable per identity) is the keyspace prefix. Not cryptographic and
// doesn't need to be. Returns 'anon' when signed out, the same prefix
// idbCache uses for public reads.
export function fingerprintFromUser(user) {
  if (!user || !user.id) return 'anon'
  return String(user.id).slice(0, 24)
}
