'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWebHandler, verifyToken, verifyPassword } = require('../cloudfunctions/api/web');

function passwordHash(password, salt = 'test-salt') {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function event(action, payload, token = '', origin = 'https://app.example.com') {
  return {
    httpMethod: 'POST',
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, payload })
  };
}

function body(response) {
  return JSON.parse(response.body);
}

test('web password uses scrypt hash and never accepts malformed stored values', () => {
  const stored = passwordHash('a-long-admin-password');
  assert.equal(verifyPassword('a-long-admin-password', stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
  assert.equal(verifyPassword('anything', 'broken'), false);
});

test('web login issues a scoped expiring session and rejects wrong password', async () => {
  let now = 2_000_000_000_000;
  const handler = createWebHandler({
    now: () => now,
    env: {
      WEB_OWNER_ID: 'web:admin-1',
      WEB_ADMIN_PASSWORD_HASH: passwordHash('a-long-admin-password'),
      WEB_SESSION_SECRET: 'a-secret-that-is-definitely-longer-than-32-characters',
      WEB_ALLOWED_ORIGINS: 'https://app.example.com',
      WEB_SESSION_TTL_SECONDS: '3600'
    },
    createScopedApi(ownerId) {
      return { handle: async request => ({ ok: true, data: { ownerId, action: request.action } }) };
    }
  });
  const denied = await handler(event('web.auth.login', { password: 'wrong-password' }));
  assert.equal(denied.statusCode, 401);
  const login = await handler(event('web.auth.login', { password: 'a-long-admin-password' }));
  assert.equal(login.statusCode, 200);
  const token = body(login).data.token;
  assert.equal(verifyToken(token, 'a-secret-that-is-definitely-longer-than-32-characters', 'web:admin-1', now).sub, 'web:admin-1');
  const session = await handler(event('session', {}, token));
  assert.deepEqual(body(session).data, { ownerId: 'web:admin-1', action: 'session' });
  now += 3_600_001;
  const expired = await handler(event('session', {}, token));
  assert.equal(expired.statusCode, 401);
});

test('web API rejects missing token, unapproved origin, and incomplete configuration', async () => {
  const base = {
    WEB_OWNER_ID: 'web:admin-1',
    WEB_ADMIN_PASSWORD_HASH: passwordHash('a-long-admin-password'),
    WEB_SESSION_SECRET: 'a-secret-that-is-definitely-longer-than-32-characters',
    WEB_ALLOWED_ORIGINS: 'https://app.example.com'
  };
  const handler = createWebHandler({ env: base, createScopedApi: () => ({ handle: async () => ({ ok: true }) }) });
  assert.equal((await handler(event('session', {}))).statusCode, 401);
  assert.equal((await handler(event('session', {}, '', 'https://evil.example'))).statusCode, 403);
  const incomplete = createWebHandler({ env: {}, createScopedApi: () => ({ handle: async () => ({ ok: true }) }) });
  assert.equal((await incomplete(event('session', {}))).statusCode, 403);
});
