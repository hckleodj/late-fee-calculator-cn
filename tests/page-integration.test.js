'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { sha256Text } = require('../backup-state.js');

class MemoryStorage {
  constructor(seed = {}) { this.values = new Map(Object.entries(seed)); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.checked = false;
    this.open = false;
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.files = [];
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  async dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) await listener({ currentTarget: this, target: this, preventDefault() {}, ...event });
  }
  appendChild() {}
  remove() {}
  focus() {}
  select() {}
  scrollIntoView() {}
  click() {}
  reset() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  closest() { return null; }
}

function samplePlan(overrides = {}) {
  return {
    id: 'customer-existing',
    name: '原有测试客户',
    plate: '测A00001',
    vehicle: '测试车辆',
    vehiclePrice: 120000,
    downPaymentRate: 20,
    depositMonths: 1,
    monthlyRate: 1,
    loanAmount: 96000,
    amount: 4960,
    dueDay: 5,
    rate: 0.05,
    startDate: '2026-08-05',
    totalTerms: 24,
    completedTerms: 0,
    openingCompletedTerms: 0,
    notes: '',
    payments: [],
    ...overrides
  };
}

async function buildPage(options = {}) {
  const originalPlans = [samplePlan()];
  const originalRaw = JSON.stringify(originalPlans);
  const originalHash = await sha256Text(originalRaw);
  const state = {
    lastBackupAt: '2026-08-25T02:00:00.000Z',
    lastDataChangeAt: '2026-08-25T01:00:00.000Z',
    dirtySinceBackup: false,
    backupVersion: 1,
    dataRevision: 4,
    lastBackedUpRevision: 4,
    lastBackupHash: originalHash,
    lastBackupMethod: 'verified-test'
  };
  const storage = options.storage || (options.empty ? new MemoryStorage() : new MemoryStorage({
    lateFeePaymentPlansV1: originalRaw,
    dajinBackupStateV1: JSON.stringify(state)
  }));
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const flat = getElement('finance-flat'); flat.value = 'flat'; flat.checked = true;
  const annuity = getElement('finance-annuity'); annuity.value = 'annuity';
  const feeNo = getElement('payment-fee-no'); feeNo.value = 'no'; feeNo.checked = true;
  const feeYes = getElement('payment-fee-yes'); feeYes.value = 'yes';
  const body = new FakeElement('body');
  body.appendChild = element => { if (element.id) elements.set(element.id, element); };
  const document = {
    body,
    getElementById: getElement,
    createElement: () => new FakeElement(),
    addEventListener() {},
    execCommand: () => true,
    querySelector(selector) {
      if (selector === 'input[name="finance-method"]:checked') return flat.checked ? flat : annuity;
      if (selector === 'input[name="payment-fee-mode"]:checked') return feeYes.checked ? feeYes : feeNo;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input[name="finance-method"]') return [flat, annuity];
      if (selector === 'input[name="payment-fee-mode"]') return [feeNo, feeYes];
      return [];
    }
  };
  class TestFile extends Blob {
    constructor(parts, name, options) { super(parts, options); this.name = name; }
  }
  const context = vm.createContext({
    Blob,
    File: TestFile,
    TextEncoder,
    URL: Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL() {} }),
    URLSearchParams,
    clearTimeout,
    confirm: options.confirm || (() => true),
    console,
    crypto: crypto.webcrypto,
    document,
    getSelection: () => ({ removeAllRanges() {} }),
    localStorage: storage,
    location: {
      search: options.search ?? '?backupDebug=1',
      hostname: options.hostname || 'test.local',
      origin: `https://${options.hostname || 'test.local'}`,
      href: `https://${options.hostname || 'test.local'}/${options.search ?? '?backupDebug=1'}`
    },
    navigator: {
      userAgent: 'P0-1 integration test',
      clipboard: { async writeText(text) { context.copiedText = text; } },
      canShare: () => true,
      async share() { context.shareCalls += 1; }
    },
    queueMicrotask,
    setTimeout,
    shareCalls: 0,
    copiedText: ''
  });
  context.window = context;
  context.globalThis = context;
  context.window.addEventListener = () => {};
  context.window.getSelection = context.getSelection;
  const backupModule = fs.readFileSync(path.join(__dirname, '..', 'backup-state.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
  vm.runInContext(backupModule, context, { filename: 'backup-state.js' });
  vm.runInContext(scripts.at(-1), context, { filename: 'index-inline.js' });
  await vm.runInContext('backupStateReady', context);
  return { context, elements, getElement, originalRaw, storage };
}

function fillPlan(getElement, values = {}) {
  const data = {
    'plan-id': '',
    'customer-name': '新增测试客户',
    plate: '测A00002',
    vehicle: '测试车辆二',
    'contract-price': '150000',
    'contract-down-rate': '20',
    'contract-deposit-months': '1',
    'contract-monthly-rate': '1',
    'due-day': '8',
    'plan-rate': '0.05',
    'start-date': '2026-08-08',
    'total-terms': '24',
    'completed-terms': '0',
    'plan-notes': '',
    ...values
  };
  Object.entries(data).forEach(([id, value]) => { getElement(id).value = value; });
}

test('page integration covers the nine P0-1 acceptance scenarios', async () => {
  const { context, elements, getElement, originalRaw, storage } = await buildPage();
  const state = () => vm.runInContext('backupStateManager.snapshot()', context);
  const plans = () => JSON.parse(storage.getItem('lateFeePaymentPlansV1'));

  assert.equal(storage.getItem('lateFeePaymentPlansV1'), originalRaw, '1: existing business data must remain byte-for-byte unchanged');
  assert.equal(state().dataRevision, 4, '2: opening must not increment revision');

  fillPlan(getElement);
  await elements.get('plan-form').dispatch('submit');
  await vm.runInContext('backupStateManager.whenIdle()', context);
  assert.equal(plans().length, 2, '3: test customer must be added');
  assert.equal(state().dataRevision, 5, '3: add must increment revision');
  assert.equal(state().dirtySinceBackup, true, '3: add must mark dirty');

  fillPlan(getElement, { 'plan-id': 'customer-existing', 'customer-name': '原有测试客户（已编辑）' });
  await elements.get('plan-form').dispatch('submit');
  await vm.runInContext('backupStateManager.whenIdle()', context);
  assert.equal(plans()[0].name, '原有测试客户（已编辑）', '4: customer must be edited');
  assert.equal(state().dataRevision, 6, '4: edit must increment revision again');

  fillPlan(getElement, { 'plan-id': 'customer-existing', 'customer-name': '原有测试客户（已编辑）' });
  await elements.get('plan-form').dispatch('submit');
  await vm.runInContext('backupStateManager.whenIdle()', context);
  assert.equal(state().dataRevision, 6, '4b: saving identical business data must not increment revision');

  const beforeCalculation = JSON.stringify(state());
  elements.get('car-price').value = '200000';
  elements.get('down-payment-rate').value = '25';
  elements.get('term').value = '36';
  elements.get('deposit-months').value = '1';
  elements.get('monthly-rate').value = '1';
  vm.runInContext('calculateFinance()', context);
  assert.equal(JSON.stringify(state()), beforeCalculation, '5: calculation must not change backup state');

  await vm.runInContext('copyBackupText()', context);
  assert.equal(state().dirtySinceBackup, true, '6: copy must not clear dirty');
  assert.equal(state().lastBackupAt, '2026-08-25T02:00:00.000Z', '6: copy must not update backup time');

  await vm.runInContext('exportBackup()', context);
  assert.equal(context.shareCalls, 1, '7: share path must actually be invoked');
  assert.equal(state().dirtySinceBackup, true, '7: share success must not clear dirty');

  storage.removeItem('dajinBackupStateV1');
  const rebuilt = await vm.runInContext(`(async()=>{const value=new window.DajinBackupState.BackupStateManager({storage:localStorage});await value.initialize(localStorage.getItem('lateFeePaymentPlansV1'));return value.snapshot()})()`, context);
  assert.equal(rebuilt.dirtySinceBackup, true, '8: missing state must rebuild dirty');

  const tampered = { ...state(), dirtySinceBackup: false, dataRevision: 6, lastBackedUpRevision: 6, lastBackupHash: `sha256:${'0'.repeat(64)}` };
  delete tampered.currentDataHash; delete tampered.needsBackup; delete tampered.metadataInvalid; delete tampered.lastError;
  storage.setItem('dajinBackupStateV1', JSON.stringify(tampered));
  const detected = await vm.runInContext(`(async()=>{const value=new window.DajinBackupState.BackupStateManager({storage:localStorage});await value.initialize(localStorage.getItem('lateFeePaymentPlansV1'));return value.snapshot()})()`, context);
  assert.equal(detected.dirtySinceBackup, true, '9: tampered hash must be detected');
  assert.notEqual(detected.currentDataHash, detected.lastBackupHash, '9: current and stored hash must differ');
});

test('missing backup-state.js fails closed without touching business data', () => {
  const originalRaw = JSON.stringify([samplePlan()]);
  const storage = new MemoryStorage({ lateFeePaymentPlansV1: originalRaw });
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const context = vm.createContext({
    URLSearchParams,
    document: { getElementById: getElement },
    location: { hostname: 'hckleodj.github.io' },
    localStorage: storage,
    window: null
  });
  context.window = context;
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
  assert.throws(() => vm.runInContext(scripts.at(-1), context, { filename: 'index-inline-without-module.js' }), /备份状态保护模块未加载/);
  assert.equal(storage.getItem('lateFeePaymentPlansV1'), originalRaw);
  assert.equal(storage.getItem('dajinBackupStateV1'), null);
  assert.match(getElement('recovery-alert-message').textContent, /停止初始化和写入/);
});

test('isolated test host initializes blank data only after click and confirmation', async () => {
  const hostname = 'dajin-p0-1-backup-test.hckleoliu.chatgpt.site';
  let confirmations = 0;
  const page = await buildPage({ empty: true, hostname, confirm: () => { confirmations += 1; return true; } });
  const { context, elements, getElement, storage } = page;

  assert.equal(vm.runInContext('planStorageState.locked', context), true, 'first open must remain read-only');
  assert.equal(vm.runInContext('planStorageState.status', context), 'missing');
  assert.equal(storage.getItem('lateFeePaymentPlansV1'), null, 'opening alone must not create the main key');
  assert.equal(getElement('create-empty-test-environment').hidden, false, 'test host must show the explicit initialization button');

  await elements.get('create-empty-test-environment').dispatch('click');
  await vm.runInContext('backupStateManager.whenIdle()', context);
  assert.equal(confirmations, 1, 'the button must require a second confirmation');
  assert.equal(storage.getItem('lateFeePaymentPlansV1'), '[]', 'confirmed action must create only an empty array');
  assert.equal(storage.getItem('dajinP01TestEnvironmentV1'), '1');
  assert.equal(vm.runInContext('planStorageState.locked', context), false, 'confirmed test initialization must unlock the test page');
  assert.equal(getElement('test-environment-label').hidden, false);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), /id="test-environment-label"[^>]*hidden><strong>测试环境<\/strong>/);

  fillPlan(getElement, { 'customer-name': '隔离环境模拟客户' });
  await elements.get('plan-form').dispatch('submit');
  await vm.runInContext('backupStateManager.whenIdle()', context);
  assert.equal(JSON.parse(storage.getItem('lateFeePaymentPlansV1')).length, 1, 'test customer must be writable after confirmation');

  const refreshed = await buildPage({ storage, hostname });
  assert.equal(vm.runInContext('planStorageState.locked', refreshed.context), false, 'refresh must preserve the initialized test environment');
  assert.equal(JSON.parse(storage.getItem('lateFeePaymentPlansV1'))[0].name, '隔离环境模拟客户');
});

test('formal hostname never exposes or executes blank test initialization', async () => {
  let confirmations = 0;
  const { context, elements, getElement, storage } = await buildPage({
    empty: true,
    hostname: 'hckleodj.github.io',
    confirm: () => { confirmations += 1; return true; }
  });

  assert.equal(getElement('create-empty-test-environment').hidden, true);
  await elements.get('create-empty-test-environment').dispatch('click');
  assert.equal(confirmations, 0, 'formal hostname must reject before confirmation is opened');
  assert.equal(storage.getItem('lateFeePaymentPlansV1'), null);
  assert.equal(storage.getItem('dajinP01TestEnvironmentV1'), null);
  assert.equal(vm.runInContext('planStorageState.locked', context), true);
});
