'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('PWA shell is installable and keeps the legacy GitHub Pages entry separate', () => {
  const html = fs.readFileSync(path.join(root, 'webapp/index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'webapp/manifest.webmanifest'), 'utf8'));
  const legacy = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /大进车贷助手/);
  assert.match(html, /manifest\.webmanifest/);
  assert.equal(manifest.display, 'standalone');
  assert.match(legacy, /lateFeePaymentPlansV1/);
});

test('web app stores only a session token and service worker never caches API writes', () => {
  const app = fs.readFileSync(path.join(root, 'webapp/app.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'webapp/sw.js'), 'utf8');
  assert.doesNotMatch(app, /localStorage/);
  assert.match(app, /sessionStorage/);
  assert.match(worker, /event\.request\.method !== 'GET'/);
  assert.doesNotMatch(worker, /apiUrl/);
});

test('shared domain module exposes the same calculations to CommonJS and browser', () => {
  const source = fs.readFileSync(path.join(root, 'packages/domain/index.js'), 'utf8');
  assert.match(source, /module\.exports = domainExports/);
  assert.match(source, /globalThis\.DajinDomain = domainExports/);
});
