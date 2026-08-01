'use strict';

const crypto = require('node:crypto');

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(password, stored) {
  const [salt, expected] = clean(stored, 1000).split(':');
  if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, expected.length / 2).toString('hex');
  return safeEqual(actual, expected);
}

function issueToken(ownerId, secret, nowMs, ttlSeconds) {
  const payload = encode(JSON.stringify({
    sub: ownerId,
    role: 'admin',
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttlSeconds
  }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret, ownerId, nowMs) {
  const [payload, signature] = clean(token, 4096).split('.');
  if (!payload || !signature || !safeEqual(sign(payload, secret), signature)) return false;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value.sub === ownerId && value.role === 'admin' && Number(value.exp) > Math.floor(nowMs / 1000)
      ? value
      : false;
  } catch (_error) {
    return false;
  }
}

function eventHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function parseBody(event) {
  if (event.body && typeof event.body === 'object') return event.body;
  const raw = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event.body || '');
  return raw ? JSON.parse(raw) : {};
}

function createWebHandler(options) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const ownerId = clean(env.WEB_OWNER_ID, 128);
  const passwordHash = clean(env.WEB_ADMIN_PASSWORD_HASH, 1000);
  const sessionSecret = clean(env.WEB_SESSION_SECRET, 1000);
  const allowedOrigins = clean(env.WEB_ALLOWED_ORIGINS, 2000)
    .split(',').map(value => value.trim()).filter(Boolean);
  const ttlSeconds = Math.min(86400, Math.max(900, Number(env.WEB_SESSION_TTL_SECONDS) || 43200));

  function response(statusCode, body, origin = '') {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    };
    if (origin && allowedOrigins.includes(origin)) {
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
      headers['access-control-allow-headers'] = 'authorization, content-type';
      headers['access-control-allow-methods'] = 'POST, OPTIONS';
    }
    return { statusCode, headers, body: JSON.stringify(body) };
  }

  function configured() {
    return ownerId && passwordHash && sessionSecret.length >= 32 && allowedOrigins.length;
  }

  return async function handleHttp(event) {
    const origin = clean(eventHeader(event, 'origin'), 500);
    if (origin && !allowedOrigins.includes(origin)) {
      return response(403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: '当前网页来源未获授权。' } });
    }
    if (String(event.httpMethod || '').toUpperCase() === 'OPTIONS') return response(204, {}, origin);
    if (!configured()) {
      return response(503, { ok: false, error: { code: 'WEB_NOT_CONFIGURED', message: '网页端云函数环境变量尚未配置。' } }, origin);
    }
    let request;
    try {
      request = parseBody(event);
    } catch (_error) {
      return response(400, { ok: false, error: { code: 'INVALID_JSON', message: '请求内容不是有效JSON。' } }, origin);
    }
    if (request.action === 'web.auth.login') {
      if (!verifyPassword(request.payload && request.payload.password, passwordHash)) {
        return response(401, { ok: false, error: { code: 'LOGIN_FAILED', message: '管理员密码错误。' } }, origin);
      }
      return response(200, {
        ok: true,
        data: { token: issueToken(ownerId, sessionSecret, now(), ttlSeconds), expiresInSeconds: ttlSeconds }
      }, origin);
    }
    const authorization = clean(eventHeader(event, 'authorization'), 5000);
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const identity = verifyToken(token, sessionSecret, ownerId, now());
    if (!identity) {
      return response(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: '登录已失效，请重新登录。' } }, origin);
    }
    const api = options.createScopedApi(identity.sub);
    const result = await api.handle(request);
    return response(result.ok ? 200 : 400, result, origin);
  };
}

module.exports = {
  createWebHandler,
  issueToken,
  verifyToken,
  verifyPassword
};
