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
    this.download = '';
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
  const recentBackupAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentChangeAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const state = {
    lastBackupAt: recentBackupAt,
    lastDataChangeAt: recentChangeAt,
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
    TextDecoder,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
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
      pathname: options.pathname || '/',
      origin: `https://${options.hostname || 'test.local'}`,
      href: `https://${options.hostname || 'test.local'}/${options.search ?? '?backupDebug=1'}`
    },
    navigator: {
      userAgent: 'P0-1 integration test',
      clipboard: { async writeText(text) { context.copiedText = text; } },
      canShare: () => true,
      async share() { context.shareCalls += 1; }
    },
    performance,
    queueMicrotask,
    setTimeout,
    shareCalls: 0,
    copiedText: ''
  });
  context.window = context;
  context.globalThis = context;
  context.window.addEventListener = () => {};
  context.window.getSelection = context.getSelection;
  const sourceRoot = options.sourceRoot || path.join(__dirname, '..');
  const backupModule = fs.readFileSync(path.join(sourceRoot, 'backup-state.js'), 'utf8');
  const snapshotModule = fs.readFileSync(path.join(sourceRoot, 'local-snapshots.js'), 'utf8');
  const migrationPath = path.join(sourceRoot, 'migration-transfer.js');
  const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);
  if (options.loadBackupModule !== false) vm.runInContext(backupModule, context, { filename: 'backup-state.js' });
  vm.runInContext(snapshotModule, context, { filename: 'local-snapshots.js' });
  if (fs.existsSync(migrationPath)) vm.runInContext(fs.readFileSync(migrationPath, 'utf8'), context, { filename: 'migration-transfer.js' });
  for (const file of ['rental-calculation.js','rental-document.js']) {
    const candidate=path.join(sourceRoot,file);
    if(fs.existsSync(candidate)) vm.runInContext(fs.readFileSync(candidate,'utf8'),context,{filename:file});
  }
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


module.exports={MemoryStorage,samplePlan,buildPage,fillPlan};
