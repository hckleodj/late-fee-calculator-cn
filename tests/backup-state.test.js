'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { BackupStateManager, DAY_MS, GRACE_MS, STATE_KEY } = require('../backup-state.js');

class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const hashC = `sha256:${'c'.repeat(64)}`;
const hashes = new Map([['original-data', hashA], ['added-data', hashB], ['edited-data', hashC]]);
const hashText = async raw => hashes.get(raw) || `sha256:${'d'.repeat(64)}`;
const now = Date.parse('2026-08-25T04:00:00.000Z');

function cleanState(overrides = {}) {
  return {
    lastBackupAt: '2026-08-25T03:00:00.000Z',
    lastDataChangeAt: '2026-08-25T02:00:00.000Z',
    dirtySinceBackup: false,
    backupVersion: 1,
    dataRevision: 7,
    lastBackedUpRevision: 7,
    lastBackupHash: hashA,
    lastBackupMethod: 'verified-test',
    ...overrides
  };
}

function manager(storage, options = {}) {
  return new BackupStateManager({ storage, hashText, now: () => now, ...options });
}

test('1. initialization reads existing business data without modifying it', async () => {
  const storage = new MemoryStorage({
    lateFeePaymentPlansV1: 'original-data',
    [STATE_KEY]: JSON.stringify(cleanState())
  });
  const before = storage.getItem('lateFeePaymentPlansV1');
  await manager(storage).initialize(before);
  assert.equal(storage.getItem('lateFeePaymentPlansV1'), before);
});

test('2. opening without a data change does not increment revision', async () => {
  const storage = new MemoryStorage({ [STATE_KEY]: JSON.stringify(cleanState()) });
  const subject = manager(storage);
  await subject.initialize('original-data');
  assert.equal(subject.snapshot().dataRevision, 7);
  assert.equal(subject.snapshot().dirtySinceBackup, false);
});

test('3. adding data increments revision and marks dirty', async () => {
  const storage = new MemoryStorage({ [STATE_KEY]: JSON.stringify(cleanState()) });
  const subject = manager(storage);
  await subject.initialize('original-data');
  await subject.recordDataChange('added-data');
  assert.equal(subject.snapshot().dataRevision, 8);
  assert.equal(subject.snapshot().dirtySinceBackup, true);
  assert.equal(subject.snapshot().currentDataHash, hashB);
});

test('4. editing data increments revision again', async () => {
  const storage = new MemoryStorage({ [STATE_KEY]: JSON.stringify(cleanState()) });
  const subject = manager(storage);
  await subject.initialize('original-data');
  await subject.recordDataChange('added-data');
  await subject.recordDataChange('edited-data');
  assert.equal(subject.snapshot().dataRevision, 9);
  assert.equal(subject.snapshot().currentDataHash, hashC);
});

test('5. calculations and other read-only actions cannot change state by themselves', async () => {
  const storage = new MemoryStorage({ [STATE_KEY]: JSON.stringify(cleanState()) });
  const subject = manager(storage);
  await subject.initialize('original-data');
  const before = subject.snapshot();
  Math.round((200000 - 50000) / 36 * 100) / 100;
  assert.deepEqual(subject.snapshot(), before);
});

test('6-7. JSON download handler does not clear either backup state', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /setBackupDirty\(false\)/);
  const downloadHandler = html.slice(html.indexOf('async function exportBackup'), html.indexOf('function openBackupSavedConfirmation'));
  assert.doesNotMatch(downloadHandler, /dirtySinceBackup|lastBackupAt|setBackupDirty/);
});

test('8. missing state is conservatively rebuilt as dirty', async () => {
  const storage = new MemoryStorage({ lateFeePaymentPlansV1: 'original-data' });
  const subject = manager(storage);
  await subject.initialize('original-data');
  assert.equal(subject.snapshot().dirtySinceBackup, true);
  assert.equal(subject.snapshot().needsBackup, true);
  assert.ok(storage.getItem(STATE_KEY));
});

test('8b. legacy dirty flag is inherited', async () => {
  const storage = new MemoryStorage({
    lateFeeBackupDirtyV1: '1',
    [STATE_KEY]: JSON.stringify(cleanState())
  });
  const subject = manager(storage);
  await subject.initialize('original-data');
  assert.equal(subject.snapshot().dirtySinceBackup, true);
});

test('9. a tampered backup hash is detected', async () => {
  const storage = new MemoryStorage({ [STATE_KEY]: JSON.stringify(cleanState({ lastBackupHash: hashB })) });
  const subject = manager(storage);
  await subject.initialize('original-data');
  assert.equal(subject.snapshot().dirtySinceBackup, true);
  assert.equal(subject.snapshot().currentDataHash, hashA);
  assert.notEqual(subject.snapshot().currentDataHash, subject.snapshot().lastBackupHash);
});

test('24-hour threshold and clock rollback are conservative', async () => {
  const storage = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({
      dirtySinceBackup: true,
      dataRevision: 8,
      lastBackupAt: new Date(now - DAY_MS + 1).toISOString()
    }))
  });
  const subject = manager(storage);
  await subject.initialize('original-data');
  assert.equal(subject.needsBackup(), false);
  assert.equal(subject.needsBackup(now + 1), true);
  assert.equal(subject.needsBackup(Date.parse('2026-08-24T00:00:00.000Z')), true);
});

test('a nominally clean state without backup evidence still needs backup', () => {
  const storage = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({ lastBackupAt: null, lastBackupHash: null }))
  });
  assert.equal(manager(storage).needsBackup(), true);
});

test('P0-3 blocking threshold and persisted 30-minute grace are conservative', async () => {
  const cleanOld = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({ lastBackupAt: new Date(now - DAY_MS - 1).toISOString(), lastDataChangeAt: new Date(now - DAY_MS - 60 * 1000).toISOString() }))
  });
  assert.equal(manager(cleanOld).shouldBlockBackup(), false, 'clean data never blocks solely because backup is old');

  const dirtyRecent = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({ dirtySinceBackup: true, dataRevision: 8, lastBackupAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() }))
  });
  assert.equal(manager(dirtyRecent).shouldBlockBackup(), false, 'dirty data inside 24 hours is only a normal reminder');

  const dirtyOld = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({ dirtySinceBackup: true, dataRevision: 8, lastBackupAt: new Date(now - DAY_MS).toISOString() }))
  });
  const subject = manager(dirtyOld);
  assert.equal(subject.shouldBlockBackup(), true);
  const before = subject.snapshot();
  assert.equal(subject.grantGrace().ok, true);
  assert.equal(subject.shouldBlockBackup(), false);
  assert.equal(subject.snapshot().dirtySinceBackup, true);
  assert.equal(subject.snapshot().lastBackupAt, before.lastBackupAt);
  assert.equal(subject.snapshot().lastBackupHash, before.lastBackupHash);
  assert.equal(subject.snapshot().lastBackedUpRevision, before.lastBackedUpRevision);

  const refreshed = manager(dirtyOld);
  assert.equal(refreshed.isGraceActive(), true, 'grace persists after reopen');
  assert.equal(refreshed.shouldBlockBackup(now + GRACE_MS + 1), true, 'block resumes after 30 minutes');
  assert.equal(refreshed.isGraceActive(now - 1), false, 'clock rollback cannot extend grace beyond 30 minutes');
});

test('successful backup confirmation clears an active grace period', async () => {
  const storage = new MemoryStorage({
    [STATE_KEY]: JSON.stringify(cleanState({ dirtySinceBackup: true, dataRevision: 8, lastBackupAt: new Date(now - DAY_MS).toISOString(), backupGraceUntil: new Date(now + GRACE_MS).toISOString() }))
  });
  const subject = manager(storage);
  await subject.initialize('original-data');
  const result = await subject.confirmBackup({ rawData: 'original-data', expectedRevision: 8, expectedHash: hashA, method: 'json-download' });
  assert.equal(result.ok, true);
  assert.equal(subject.snapshot().dirtySinceBackup, false);
  assert.equal(subject.snapshot().backupGraceUntil, null);
});
