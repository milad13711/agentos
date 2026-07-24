// auth.js — real authentication primitives, no external dependencies.
// Password hashing: scrypt (Node's built-in, OWASP-recommended KDF).
// Session tokens: HMAC-SHA256 signed JSON tokens (a minimal, correct JWT-equivalent).
//
// PRODUCTION NOTE: set AGENTOS_TOKEN_SECRET to a long random value via
// environment variable before deploying. If unset, a random secret is
// generated at boot (fine for local dev; it invalidates tokens on restart).

const crypto = require('node:crypto');

const TOKEN_SECRET = process.env.AGENTOS_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const encoded = base64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// Express-less middleware: takes (req) and returns {tenantId, userId, role} or null.
function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return { tenantId: payload.tenantId, userId: payload.userId, role: payload.role, email: payload.email, isSuperAdmin: !!payload.isSuperAdmin };
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authenticate };
