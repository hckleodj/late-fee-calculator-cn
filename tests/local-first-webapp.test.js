'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'local-first-sync.js'), 'utf8');

test('local-first page keeps the legacy four-entry mobile UI', () => {
  assert.match(html, /<title>大进车贷助手<\/title>/);
  assert.match(html, /data-panel="reminders">还款提醒/);
  assert.match(html, /data-panel="customers">客户管理/);
  assert.match(html, /data-panel="finance">方案测算/);
  assert.match(html, /data-panel="late-fee">滞纳金计算/);
  assert.match(html, /grid-template-columns:repeat\(4,1fr\)/);
  assert.match(html, /复制客户方案/);
  assert.match(html, /复制纯文字/);
  assert.doesNotMatch(html, /sidebar|后台管理/);
});

test('local data renders before deferred cloud sync and calculators stay local', () => {
  assert.match(html, /<script defer src="\.\/local-first-sync\.js\?v=[a-f0-9]+"><\/script>/);
  assert.ok(html.indexOf('let plans=loadPlans()') < html.indexOf('window.DajinLocalFirstApp='));
  assert.match(html, /renderPlanModule\(\);renderBackupReminder\(\);calculateFinance\(\);calculateLateFee\(\)/);
  assert.doesNotMatch(html, /fetch\(/);
  assert.match(html, /function calculateFinance\(/);
  assert.match(html, /function calculateLateFee\(/);
});

test('sync client persists an outbox, retries on reconnect, and never blocks local saves', () => {
  assert.match(sync, /dajinLocalFirstOutboxV1/);
  assert.match(sync, /recordLocalChange/);
  assert.match(sync, /localStorage/);
  assert.match(sync, /window\.addEventListener\('online', syncNow\)/);
  assert.match(sync, /document\.visibilityState === 'visible'/);
  assert.match(sync, /setTimeout\(syncNow, 350\)/);
  assert.match(sync, /sync\.pull/);
  assert.match(sync, /sync\.push/);
  assert.match(sync, /if \(pending\.length\) \{\s*await pushPending\(\);\s*return;/);
  assert.match(sync, /dajinWebSession/);
  assert.match(sync, /function sessionToken\(\)/);
  assert.match(sync, /本地已保存/);
  assert.match(sync, /待同步/);
  assert.match(sync, /已同步/);
});

test('first local-first start protects existing legacy data and batches imported changes', () => {
  assert.match(sync, /if \(!localStorage\.getItem\(SNAPSHOT_KEY\)\)/);
  assert.match(sync, /if \(existingLocalPlans\.length\) queueDiff\(existingLocalPlans, true\)/);
  assert.match(sync, /const queued = new Map\(outbox\(\)\.map/);
  assert.match(sync, /saveOutbox\(\[\.\.\.queued\.values\(\)\]\)/);
  assert.doesNotMatch(sync, /function queueOperation/);
  assert.match(html, /<link rel="icon" href="data:," \/>/);
});

test('existing legacy plans enter the outbox before the first cloud pull', () => {
  const values = new Map([['lateFeePaymentPlansV1', JSON.stringify([{ id: 'legacy-1', name: '旧版客户' }])]]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const status = { dataset: {}, addEventListener() {} };
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    getElementById(id) { return id === 'sync-status-button' ? status : null; },
    addEventListener() {}
  };
  const app = {
    getPlans() { return [{ id: 'legacy-1', name: '旧版客户' }]; },
    replacePlans() {}
  };
  const window = { DajinLocalFirstApp: app, addEventListener() {} };
  vm.runInNewContext(sync, {
    window,
    document,
    localStorage: storage,
    sessionStorage: storage,
    navigator: { onLine: true },
    queueMicrotask() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    AbortController,
    fetch,
    FormData,
    Date,
    Math,
    JSON,
    Map,
    Set
  });
  const queued = JSON.parse(values.get('dajinLocalFirstOutboxV1'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'plan.upsert');
  assert.equal(queued[0].planId, 'legacy-1');
  assert.deepEqual(JSON.parse(values.get('dajinLocalFirstSnapshotV1')), [{ id: 'legacy-1', name: '旧版客户' }]);
});
