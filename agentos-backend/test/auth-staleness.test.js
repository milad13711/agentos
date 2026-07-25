// Regression test for the "known issue" logged in CLAUDE.md: a role change
// (or disable/remove) used to only take effect once the caller's existing
// token naturally expired (up to 12h), because role/isSuperAdmin/status were
// trusted from the signed token instead of the live DB row. requireAuth() /
// requireSuperAdmin() in server.js now re-read status+role+is_super_admin
// from the DB on every request, so a change applies to the very next request
// made with an already-issued token. This test drives that through the real
// HTTP server (no mocks) on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const dbPath = path.join(os.tmpdir(), `agentos-test-auth-staleness-${process.pid}-${Date.now()}.sqlite`);
process.env.AGENTOS_DB_PATH = dbPath;
process.env.AGENTOS_TOKEN_SECRET = 'test-secret';

const server = require('../src/server');
const { db, ready } = require('../src/db');

let baseUrl;
test.before(async () => {
  await ready;
  await new Promise((resolve) => {
    server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  server.close();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a role change applies immediately to a token issued before the change', async () => {
  const owner = await request('POST', '/api/auth/register', {
    body: { tenantName: 'Staleness Co', name: 'Owner', email: `owner-${Date.now()}@test.local`, password: 'password123' },
  });
  const ownerToken = owner.body.token;

  await db.run(`UPDATE plans SET seats_limit = 20 WHERE key = 'free'`);

  const invite = await request('POST', '/api/team/invite', {
    token: ownerToken,
    body: { name: 'Member', email: `member-${Date.now()}@test.local`, role: 'member' },
  });
  assert.equal(invite.status, 201);

  const login = await request('POST', '/api/auth/login', {
    body: { email: invite.body.email, password: invite.body.tempPassword },
  });
  const memberToken = login.body.token;

  const before = await request('GET', '/api/me', { token: memberToken });
  assert.equal(before.body.user.role, 'member');

  const promote = await request('PATCH', `/api/team/${invite.body.id}/role`, { token: ownerToken, body: { role: 'admin' } });
  assert.equal(promote.status, 200);

  // Same, already-issued token — no re-login — must now reflect the new role.
  const after = await request('GET', '/api/me', { token: memberToken });
  assert.equal(after.body.user.role, 'admin');
});

test('removing a team member revokes their already-issued token on the next request', async () => {
  const owner = await request('POST', '/api/auth/register', {
    body: { tenantName: 'Revoke Co', name: 'Owner', email: `owner2-${Date.now()}@test.local`, password: 'password123' },
  });
  const ownerToken = owner.body.token;
  await db.run(`UPDATE plans SET seats_limit = 20 WHERE key = 'free'`);

  const invite = await request('POST', '/api/team/invite', {
    token: ownerToken,
    body: { name: 'Member', email: `member2-${Date.now()}@test.local`, role: 'member' },
  });
  const login = await request('POST', '/api/auth/login', {
    body: { email: invite.body.email, password: invite.body.tempPassword },
  });
  const memberToken = login.body.token;

  const before = await request('GET', '/api/me', { token: memberToken });
  assert.equal(before.status, 200);

  const remove = await request('DELETE', `/api/team/${invite.body.id}`, { token: ownerToken });
  assert.equal(remove.status, 200);

  const after = await request('GET', '/api/me', { token: memberToken });
  assert.equal(after.status, 401);
});
