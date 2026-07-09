// Client-side mirror of routes/auth.js validatePassword().
// Keep this as permissive as the server: minimum length plus one
// letter and one digit, no symbol requirement.
export function isValidPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 12
    && /[A-Za-z]/.test(pw)
    && /\d/.test(pw)
}
