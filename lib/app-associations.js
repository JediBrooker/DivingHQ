// Public signing identities only. Keep API and infrastructure URLs out of OS
// app-link routing; authenticated screens still pass the SPA and server gates.
const APP_PATHS = ['/', '/login', '/register', '/register-org', '/forgot-password', '/reset-password', '/verify-email', '/confirm-email-change', '/dashboard', '/manager', '/control', '/judge', '/coach', '/coach/*', '/competitor', '/profile', '/profile/*', '/judge-profile', '/judge-profile/*', '/judges', '/scoreboard', '/scoreboard/*', '/meet/*', '/records', '/records/*', '/judge-analysis', '/results-archive', '/broadcast/*', '/inbox', '/notifications', '/settings', '/settings/*', '/me/*', '/events/*', '/users', '/club', '/clubs', '/region', '/claims', '/teams', '/teams/*', '/assign-judges', '/audit', '/admin/*', '/dive-directory', '/sign-off-codes', '/compare', '/setup', '/payments', '/payments/return', '/payment-history', '/membership', '/guardians', '/accreditation', '/charges', '/fines', '/classes', '/donate', '/guide', '/guide/*', '/privacy', '/terms'];
const appleAssociation = {
  applinks: { apps: [], details: [{ appID: '6MY34D5RKG.app.divinghq.mobile', paths: APP_PATHS }] },
};
const androidAssociation = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: 'app.divinghq.mobile', sha256_cert_fingerprints: [
    '31:91:94:E5:72:A2:43:76:8D:C3:27:73:21:0A:55:8D:B8:C7:E3:FE:7B:1D:80:61:62:4C:0E:46:35:56:ED:2F',
  ] },
}];
function installAppAssociations(app) {
  for (const [route, data] of [
    ['/.well-known/apple-app-site-association', appleAssociation],
    ['/.well-known/assetlinks.json', androidAssociation],
  ]) app.get(route, (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json(data));
}
module.exports = { installAppAssociations, appleAssociation, androidAssociation, APP_PATHS };
