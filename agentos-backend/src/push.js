// push.js — Web Push notifications (browser/PWA), a channel independent of
// Telegram. Uses VAPID keys (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY) — generate
// a pair once with `node -e "console.log(require('web-push').generateVAPIDKeys())"`
// and put both in .env (never commit them). Disabled cleanly (no crash) until
// both are set, same pattern as voice.js/telegram.js.
const webpush = require('web-push');
const { db, uid, now } = require('./db');

function pushEnabled() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

let configured = false;
function ensureConfigured() {
  if (configured || !pushEnabled()) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

async function saveSubscription(tenantId, userId, subscription) {
  const keysJson = JSON.stringify(subscription.keys || {});
  const existing = await db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [subscription.endpoint]);
  if (existing) {
    await db.run('UPDATE push_subscriptions SET user_id = ?, tenant_id = ?, keys_json = ? WHERE endpoint = ?',
      [userId, tenantId, keysJson, subscription.endpoint]);
    return existing.id;
  }
  const id = uid();
  await db.run('INSERT INTO push_subscriptions (id, tenant_id, user_id, endpoint, keys_json, created_at) VALUES (?,?,?,?,?,?)',
    [id, tenantId, userId, subscription.endpoint, keysJson, now()]);
  return id;
}

async function removeSubscription(endpoint) {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

// Best-effort, like Telegram sends in reminders.js — a push failure must
// never break the caller (a reminder tick, an agent reply). A 404/410 from
// the push service means the browser subscription is dead (uninstalled,
// permission revoked, ...) — clean it up so it's not retried forever.
// Returns how many subscriptions actually got a notification, so callers
// (reminders.js) can tell "configured but no subscribed device" apart from
// "configured and delivered" without duplicating the subscription lookup.
async function sendPushToUser(userId, payload) {
  if (!pushEnabled()) return 0;
  ensureConfigured();
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  let delivered = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: JSON.parse(sub.keys_json) };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await removeSubscription(sub.endpoint);
      } else {
        console.error('[push] send failed:', e.message);
      }
    }
  }
  return delivered;
}

module.exports = { pushEnabled, saveSubscription, removeSubscription, sendPushToUser };
