// Client-side mirror of routes/auth.js validatePassword().
// Keep this permissive in the same way as the server: minimum
// length plus one letter and one digit, with no symbol requirement.
export function isValidPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 12
    && /[A-Za-z]/.test(pw)
    && /\d/.test(pw)
}
