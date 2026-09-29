'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { BackupStateManager, DAY_MS, sha256Text } = require('../backup-state.js');

const { MemoryStorage, samplePlan, buildPage, fillPlan } = require('./page-harness.js');

const idle = context => vm.runInContext('Promise.all([backupStateManager.whenIdle(),businessChangePending,localSnapshotManager?.whenIdle?.()])', context);
const state = context => vm.runInContext('backupStateManager.snapshot()', context);

test('RC1-01 old customer data is read byte-for-byte without rewrite', async () => {
  const page = await buildPage({ search: '' });
  assert.equal(page.storage.getItem('lateFeePaymentPlansV1'), page.originalRaw);
  assert.equal(vm.runInContext('plans.length', page.context), 1);
});

test('RC1-02 add customer increments revision and creates a snapshot', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  assert.equal(JSON.parse(page.storage.getItem('lateFeePaymentPlansV1')).length, 2);
  assert.equal(state(page.context).dataRevision, 5);
  assert.equal(state(page.context).dirtySinceBackup, true);
  assert.equal(JSON.parse(page.storage.getItem('dajinLocalSnapshotsV1')).length, 1);
});

test('RC1-03 edit customer preserves id and increments revision', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement, { 'plan-id': 'customer-existing', 'customer-name': '原客户已编辑' });
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const plans = JSON.parse(page.storage.getItem('lateFeePaymentPlansV1'));
  assert.equal(plans[0].id, 'customer-existing');
  assert.equal(plans[0].name, '原客户已编辑');
  assert.equal(state(page.context).dataRevision, 5);
});

test('RC1-04 receive payment persists allocations and increments revision', async () => {
  const page = await buildPage({ search: '' });
  page.getElement('payment-plan-id').value = 'customer-existing';
  page.getElement('payment-term-index').value = '0';
  page.getElement('payment-id').value = '';
  page.getElement('payment-date').value = '2026-08-25';
  page.getElement('payment-total').value = '4960';
  page.getElement('payment-fee').value = '0';
  await page.elements.get('payment-form').dispatch('submit');
  await idle(page.context);
  const plan = JSON.parse(page.storage.getItem('lateFeePaymentPlansV1'))[0];
  assert.equal(plan.payments.length, 1);
  assert.equal(plan.payments[0].principal, 4960);
  assert.deepEqual(plan.payments[0].allocations, [{ termIndex: 0, principal: 4960 }]);
  assert.equal(state(page.context).dataRevision, 5);
});

test('RC1-05 flat-interest quote matches required fixed-monthly-rate numbers', async () => {
  const page = await buildPage({ search: '' });
  const result = vm.runInContext(`(()=>{const payment=monthlyPayment(100000,.0129,36,'flat');return {payment:round2(payment),...Object.fromEntries(Object.entries(repaymentTotals(100000,payment,.0129,36,'flat')).map(([key,value])=>[key,round2(value)]))}})()`, page.context);
  assert.equal(result.payment, 4067.78);
  assert.equal(result.totalInterest, 46440);
  assert.equal(result.totalRepayment, 146440);
});

test('RC1-06 reverse-payment and annuity formulas are independently asserted', async () => {
  const page = await buildPage({ search: '' });
  const values = vm.runInContext(`(()=>{const flatPayment=monthlyPayment(100000,.0129,36,'flat');const annuity=monthlyPayment(100000,.01,12,'annuity');return {flatPrincipal:principalFromPayment(flatPayment,.0129,36,'flat'),annuity,annuityPrincipal:principalFromPayment(annuity,.01,12,'annuity')}})()`, page.context);
  assert.ok(Math.abs(values.flatPrincipal - 100000) < 1e-8);
  assert.ok(Math.abs(values.annuity - 8884.878867834166) < 1e-8);
  assert.ok(Math.abs(values.annuityPrincipal - 100000) < 1e-8);
});

test('RC1-07 late fee is 1644.50 and total is 9867.00', async () => {
  const page = await buildPage({ search: '' });
  page.getElement('due').value = '2026-01-01';
  page.getElement('pay').value = '2026-02-10';
  page.getElement('amount').value = '8222.5';
  page.getElement('rate').value = '0.5';
  vm.runInContext('calculateLateFee()', page.context);
  assert.equal(page.getElement('days').textContent, '40 天');
  assert.equal(page.getElement('fee').textContent, '1,644.50 元');
  assert.equal(page.getElement('total').textContent, '9,867.00 元');
});

test('RC1-08 downloading backup never clears dirty or updates backup time', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const before = state(page.context).lastBackupAt;
  await vm.runInContext('exportBackup()', page.context);
  assert.equal(state(page.context).dirtySinceBackup, true);
  assert.equal(state(page.context).lastBackupAt, before);
});

test('RC1-09 final manual confirmation records current revision and hash', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  await vm.runInContext('exportBackup()', page.context);
  assert.equal(await vm.runInContext('finishBackupConfirmation()', page.context), true);
  const current = state(page.context);
  assert.equal(current.dirtySinceBackup, false);
  assert.equal(current.lastBackedUpRevision, current.dataRevision);
  assert.equal(current.lastBackupHash, current.currentDataHash);
  assert.ok(current.lastBackupAt);
});

test('RC1-10 dirty data at 24 hours opens the forced reminder', async () => {
  const page = await buildPage({ search: '' });
  const now = Date.parse('2026-08-25T04:00:00.000Z');
  page.context.fixedNow = now;
  vm.runInContext(`backupStateManager.now=()=>fixedNow;backupStateManager.state.dirtySinceBackup=true;backupStateManager.state.dataRevision=5;backupStateManager.state.lastBackupAt=new Date(fixedNow-${DAY_MS}).toISOString();backupStateManager.state.backupGraceUntil=null;backupStateManager.persist();refreshBackupAccess()`, page.context);
  assert.equal(state(page.context).shouldBlockBackup, true);
  assert.equal(page.getElement('backup-required-dialog').open, true);
});

test('RC1-11 30-minute emergency entry preserves backup evidence', async () => {
  const page = await buildPage({ search: '' });
  const now = Date.parse('2026-08-25T04:00:00.000Z');
  page.context.fixedNow = now;
  vm.runInContext(`backupStateManager.now=()=>fixedNow;backupStateManager.state.dirtySinceBackup=true;backupStateManager.state.dataRevision=5;backupStateManager.state.lastBackupAt=new Date(fixedNow-${DAY_MS}-1).toISOString();backupStateManager.state.backupGraceUntil=null;backupStateManager.persist();refreshBackupAccess()`, page.context);
  const before = state(page.context);
  await page.elements.get('request-backup-grace').dispatch('click');
  await page.elements.get('confirm-backup-grace').dispatch('click');
  const after = state(page.context);
  assert.equal(after.dirtySinceBackup, true);
  assert.equal(after.lastBackupAt, before.lastBackupAt);
  assert.equal(after.lastBackupHash, before.lastBackupHash);
  assert.equal(after.lastBackedUpRevision, before.lastBackedUpRevision);
  assert.equal(after.graceActive, true);
});

test('RC1-12 each successful business write captures local history', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const snapshots = JSON.parse(page.storage.getItem('dajinLocalSnapshotsV1'));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].reason, 'business-change');
  assert.equal(snapshots[0].dataRevision, 5);
});

test('RC1-13 viewing a valid snapshot cannot modify primary data', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const before = page.storage.getItem('lateFeePaymentPlansV1');
  const id = JSON.parse(page.storage.getItem('dajinLocalSnapshotsV1'))[0].id;
  assert.equal(await vm.runInContext(`previewSnapshot(${JSON.stringify(id)})`, page.context), true);
  assert.equal(page.storage.getItem('lateFeePaymentPlansV1'), before);
});

test('RC1-14 restore creates before-restore snapshot and a new dirty revision', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement, { 'plan-id': 'customer-existing', 'customer-name': '历史版本一' });
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const target = JSON.parse(page.storage.getItem('dajinLocalSnapshotsV1'))[0].id;
  fillPlan(page.getElement, { 'plan-id': 'customer-existing', 'customer-name': '当前版本二' });
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const revisionBefore = state(page.context).dataRevision;
  await vm.runInContext(`previewSnapshot(${JSON.stringify(target)})`, page.context);
  assert.equal(await vm.runInContext('restoreSelectedSnapshot()', page.context), true);
  await idle(page.context);
  assert.equal(state(page.context).dataRevision, revisionBefore + 1);
  assert.equal(state(page.context).dirtySinceBackup, true);
  assert.ok(JSON.parse(page.storage.getItem('dajinLocalSnapshotsV1')).some(item => item.reason === 'before-restore'));
});

test('RC1-15 refresh and reopen preserve customer, revision, state and snapshots', async () => {
  const page = await buildPage({ search: '' });
  fillPlan(page.getElement);
  await page.elements.get('plan-form').dispatch('submit');
  await idle(page.context);
  const before = { raw: page.storage.getItem('lateFeePaymentPlansV1'), revision: state(page.context).dataRevision, snapshots: page.storage.getItem('dajinLocalSnapshotsV1') };
  const reopened = await buildPage({ storage: page.storage, search: '' });
  await idle(reopened.context);
  assert.equal(page.storage.getItem('lateFeePaymentPlansV1'), before.raw);
  assert.equal(state(reopened.context).dataRevision, before.revision);
  assert.equal(page.storage.getItem('dajinLocalSnapshotsV1'), before.snapshots);
});

test('RC1-16 legacy dirty flag is inherited conservatively', async () => {
  const raw = JSON.stringify([samplePlan()]);
  const hash = await sha256Text(raw);
  const storedState = { lastBackupAt: '2026-08-25T02:00:00.000Z', lastDataChangeAt: '2026-08-25T01:00:00.000Z', dirtySinceBackup: false, backupVersion: 1, dataRevision: 4, lastBackedUpRevision: 4, lastBackupHash: hash, lastBackupMethod: 'text', backupGraceUntil: null };
  const storage = new MemoryStorage({ lateFeePaymentPlansV1: raw, lateFeeBackupDirtyV1: '1', dajinBackupStateV1: JSON.stringify(storedState) });
  const manager = new BackupStateManager({ storage });
  await manager.initialize(raw);
  assert.equal(manager.snapshot().dirtySinceBackup, true);
});

test('RC1-17 missing, blank, empty, corrupt and invalid main data stay read-only and unchanged', async () => {
  for (const raw of [null, '', '[]', '{broken', JSON.stringify([{ bad: true }])]) {
    const seed = raw === null ? {} : { lateFeePaymentPlansV1: raw };
    const storage = new MemoryStorage(seed);
    const page = await buildPage({ storage, search: '' });
    assert.equal(vm.runInContext('planStorageState.locked', page.context), true);
    assert.equal(storage.getItem('lateFeePaymentPlansV1'), raw);
  }
});
