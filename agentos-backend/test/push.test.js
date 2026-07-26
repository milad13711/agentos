// Regression coverage for src/push.js (Web Push subscriptions). Actually
// delivering a push requires talking to a real push service (FCM/Mozilla's),
// which isn't reachable from this sandbox — so this verifies the contract we
// control: enabled/disabled gating, subscription CRUD persisting correctly,
// and that sendPushToUser degrades gracefully (never throws) whether or not
// push is configured, matching voice.js/telegram.js's "disabled means quiet,
// not broken" pattern.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dbPath = path.join(os.tmpdir(), `agentos-test-push-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const { db, uid, now, ready } = require('../src/db');
const push = require('../src/push');

test.before(() => ready);
test.after(() => {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

test('pushEnabled() is false until both VAPID keys are set', () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  assert.equal(push.pushEnabled(), false);
  process.env.VAPID_PUBLIC_KEY = 'pub';
  assert.equal(push.pushEnabled(), false, 'one key alone is not enough');
  process.env.VAPID_PRIVATE_KEY = 'priv';
  assert.equal(push.pushEnabled(), true);
});

test('sendPushToUser() is a silent no-op when push is not configured', async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  const delivered = await push.sendPushToUser('whoever', { title: 'x', body: 'y' });
  assert.equal(delivered, 0);
});

test('saveSubscription() is idempotent per endpoint (re-subscribing the same browser updates, not duplicates)', async () => {
  const tenantId = uid();
  const userId = uid();
  const endpoint = 'https://fake-push-service.test/abc123';

  await push.saveSubscription(tenantId, userId, { endpoint, keys: { p256dh: 'a', auth: 'b' } });
  await push.saveSubscription(tenantId, userId, { endpoint, keys: { p256dh: 'a2', auth: 'b2' } });

  const rows = await db.all('SELECT * FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  assert.equal(rows.length, 1, 'must not create a second row for the same endpoint');
  assert.deepEqual(JSON.parse(rows[0].keys_json), { p256dh: 'a2', auth: 'b2' });
});

test('removeSubscription() deletes by endpoint', async () => {
  const endpoint = 'https://fake-push-service.test/to-remove';
  await push.saveSubscription(uid(), uid(), { endpoint, keys: { p256dh: 'a', auth: 'b' } });
  await push.removeSubscription(endpoint);
  const row = await db.get('SELECT * FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
  assert.equal(row, undefined);
});
