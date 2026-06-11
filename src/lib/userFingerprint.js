// Cheap, deterministic per-user fingerprint derived from the JWT.
//
// Used to scope client-side keyspaces (idbCache entries, outbox
// rows) per signed-in identity so logout/login on a shared device
// never reads another user's data. Not cryptographic — slicing
// the JWT's payload segment (the middle dot-separated chunk)
// gives a stable value that changes whenever the identity does,
// without pulling in a crypto dependency. Returns 'anon' when no
// token is present.
export function fingerprintFromToken(token) {
  if (!token) return 'anon'
  const parts = String(token).split('.')
  if (parts.length < 2) return 'anon'
  // 24 chars of the payload is more than enough for collision
  // resistance across realistic numbers of users on one device.
  return parts[1].slice(0, 24)
}

// Per-user fingerprint derived from the signed-in identity instead of
// the JWT. Used since the cookie migration: the token now lives in an
// httpOnly cookie the client JS can't read, so the user id (already a
// UUID, stable per identity) is the keyspace prefix. Returns 'anon'
// when signed out — matching fingerprintFromToken's empty case so the
// two schemes share the public-cache namespace.
export function fingerprintFromUser(user) {
  if (!user || !user.id) return 'anon'
  return String(user.id).slice(0, 24)
}
