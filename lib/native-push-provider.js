// Apple HTTP/2 + Firebase HTTP v1. Provider credentials never enter app bundles.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
// https://firebase.google.com/docs/cloud-messaging/send/v1-api
const fs = require('node:fs');
const http2 = require('node:http2');
const jwt = require('jsonwebtoken');

function createNativePushProvider({ env = process.env, fetchImpl = fetch } = {}) {
  let appleKey = null, google = null, project = null;
  try {
    if (env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID) {
      appleKey = fs.readFileSync(env.APNS_KEY_PATH, 'utf8');
      const key = require('node:crypto').createPrivateKey(appleKey);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    }
  } catch { appleKey = null; console.error('[native push] APNs credential is unavailable or invalid'); }
  try {
    if (env.FCM_SERVICE_ACCOUNT_PATH) {
      const credentials = JSON.parse(fs.readFileSync(env.FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
      if (!credentials.project_id || !credentials.client_email || !credentials.private_key) throw new Error();
      const key = require('node:crypto').createPrivateKey(credentials.private_key);
      if (key.asymmetricKeyType !== 'rsa') throw new Error();
      project = credentials.project_id;
      const { GoogleAuth } = require('google-auth-library');
      google = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
    }
  } catch { google = null; console.error('[native push] Firebase credential is unavailable or invalid'); }
  let appleJwt, appleJwtAt = 0;
  const configured = { ios: !!appleKey, android: !!google };
  const topic = 'app.divinghq.mobile';
  const environments = (env.APNS_ENVIRONMENTS || 'production').split(',').filter(v => ['production', 'development'].includes(v));
  async function send(device, notification) {
    if (device.platform === 'ios' && !environments.includes(device.environment)) return { accepted: false, reason: 'environment_unconfigured' };
    if (!configured[device.platform]) return { accepted: false, reason: 'provider_unconfigured' };
    // Deliberately private lock-screen payload. Fetch contents under the current
    // session after delivery/tap, so queued pushes cannot disclose a prior user's data.
    const data = { notification_id: notification.id };
    const alert = { title: 'DivingHQ', body: 'You have a new notification. Open DivingHQ to view it.' };
    const ttl = Math.max(0, Math.min(86400, notification.ttl_seconds ?? 3600));
    if (device.platform === 'android') {
      const token = await google.getAccessToken();
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: device.token, notification: alert, data,
          android: { priority: 'HIGH', ttl: `${ttl}s`, notification: { channel_id: 'divinghq_updates', icon: 'ic_stat_divinghq', tag: notification.id } } } }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await res.json().catch(() => ({}));
      const code = result.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
      return { accepted: res.ok, invalid: code === 'UNREGISTERED', reason: res.ok ? null : (code || `fcm_${res.status}`) };
    }
    if (!appleJwt || Date.now() - appleJwtAt > 45 * 60 * 1000) {
      appleJwt = jwt.sign({}, appleKey, { algorithm: 'ES256', issuer: env.APNS_TEAM_ID, keyid: env.APNS_KEY_ID });
      appleJwtAt = Date.now();
    }
    return new Promise((resolve) => {
      const host = device.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
      const session = http2.connect(host);
      let settled = false;
      const done = result => { if (settled) return; settled = true; clearTimeout(timer); session.destroy(); resolve(result); };
      const timer = setTimeout(() => done({ accepted: false, reason: 'apns_timeout' }), 10000);
      session.on('error', () => done({ accepted: false, reason: 'apns_connection' }));
      const req = session.request({ ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${appleJwt}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl) });
      let status, body = '';
      req.on('response', headers => { status = headers[':status']; });
      req.setEncoding('utf8');
      req.on('data', chunk => { if (body.length < 4096) body += chunk; });
      req.on('error', () => done({ accepted: false, reason: 'apns_connection' }));
      req.on('end', () => {
        let reason; try { reason = JSON.parse(body).reason; } catch { /* empty success */ }
        done({ accepted: status === 200, invalid: status === 410 || reason === 'BadDeviceToken', reason: status === 200 ? null : reason || `apns_${status}` });
      });
      req.end(JSON.stringify({ aps: { alert, sound: 'default', 'thread-id': 'divinghq' }, ...data }));
    });
  }
  return { configured, environments, send };
}
module.exports = { createNativePushProvider };
