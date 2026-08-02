'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../cloudfunctions/api/service');
const domain = require('../packages/domain');

function clone(value) { return structuredClone(value); }

function matches(row, where) {
  return Object.entries(where || {}).every(([key, expected]) => {
    if (expected && expected.__op === 'in') return expected.values.includes(row[key]);
    if (expected && expected.__op === 'lte') return row[key] <= expected.value;
    return row[key] === expected;
  });
}

function createMemoryDb() {
  const store = Object.create(null);
  let sequence = 0;
  const command = {
    in(values) { return { __op: 'in', values }; },
    lte(value) { return { __op: 'lte', value }; }
  };

  function collection(name) {
    store[name] ||= [];
    let filter = {};
    let sort = null;
    let offset = 0;
    let maximum = Infinity;
    const query = {
      where(value) { filter = value; return query; },
      orderBy(field, direction) { sort = { field, direction }; return query; },
      skip(value) { offset = value; return query; },
      limit(value) { maximum = value; return query; },
      async get() {
        let rows = store[name].filter(row => matches(row, filter)).map(clone);
        if (sort) rows.sort((a, b) => {
          if (a[sort.field] === b[sort.field]) return 0;
          const value = a[sort.field] < b[sort.field] ? -1 : 1;
          return sort.direction === 'desc' ? -value : value;
        });
        return { data: rows.slice(offset, offset + maximum) };
      },
      async add({ data }) {
        const _id = `id-${++sequence}`;
        store[name].push({ _id, ...clone(data) });
        return { _id };
      },
      doc(id) {
        return {
          async update({ data }) {
            const row = store[name].find(item => item._id === id);
            if (!row) throw new Error(`missing ${name}/${id}`);
            Object.assign(row, clone(data));
            return { updated: 1 };
          }
        };
      }
    };
    return query;
  }

  const db = {
    command,
    collection,
    async startTransaction() {
      return { collection, commit: async () => {}, rollback: async () => {} };
    },
    _store: store
  };
  return db;
}

function localFirstPlan(overrides = {}) {
  return {
    id: 'local-first-plan-1',
    name: '本地优先客户',
    plate: '湘A12345',
    vehicle: '测试车辆',
    vehiclePrice: 91800,
    downPaymentRate: 15,
    depositMonths: 1,
    monthlyRate: 1.25,
    loanAmount: 78030,
    amount: 3142.88,
    dueDay: 5,
    rate: 0.005,
    startDate: '2026-01-01',
    totalTerms: 36,
    completedTerms: 0,
    openingCompletedTerms: 0,
    notes: '',
    payments: [],
    ...overrides
  };
}

test('administrator allowlist blocks unknown OpenID before data access', async () => {
  const db = createMemoryDb();
  const api = createApi({
    db,
    getTrustedIdentity: () => ({ openId: 'intruder' }),
    getAdminOpenIds: () => ['admin-1']
  });
  const result = await api.handle({ action: 'session' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal((db._store.users || []).length, 0);
});

test('two administrators never see each other customer rows', async () => {
  const db = createMemoryDb();
  let openId = 'admin-1';
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => ['admin-1', 'admin-2'] });
  await api.handle({ action: 'customers.save', payload: { name: '甲客户' } });
  openId = 'admin-2';
  await api.handle({ action: 'customers.save', payload: { name: '乙客户' } });
  const secondList = await api.handle({ action: 'customers.list', payload: {} });
  assert.deepEqual(secondList.data.map(row => row.name), ['乙客户']);
  openId = 'admin-1';
  const firstList = await api.handle({ action: 'customers.list', payload: {} });
  assert.deepEqual(firstList.data.map(row => row.name), ['甲客户']);
});

test('local-first sync is owner-scoped, idempotent, and keeps newer deletions', async () => {
  const db = createMemoryDb();
  let openId = 'admin-sync-1';
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => ['admin-sync-1', 'admin-sync-2'] });
  const empty = await api.handle({ action: 'sync.pull', payload: {} });
  assert.deepEqual(empty.data, { initialized: false, revision: 0, plans: [], updatedAt: null });

  const upsert = { opId: 'device-a:100:upsert', type: 'plan.upsert', planId: 'local-first-plan-1', changedAt: 100, plan: localFirstPlan() };
  const first = await api.handle({ action: 'sync.push', payload: { operations: [upsert] } });
  assert.equal(first.ok, true);
  assert.equal(first.data.revision, 1);
  assert.equal(first.data.plans.length, 1);

  const repeated = await api.handle({ action: 'sync.push', payload: { operations: [upsert] } });
  assert.equal(repeated.data.revision, 1);
  assert.equal(repeated.data.plans.length, 1);

  const removed = await api.handle({ action: 'sync.push', payload: { operations: [{
    opId: 'device-a:200:delete', type: 'plan.delete', planId: 'local-first-plan-1', changedAt: 200
  }] } });
  assert.equal(removed.data.plans.length, 0);

  const stale = await api.handle({ action: 'sync.push', payload: { operations: [{
    ...upsert, opId: 'device-b:150:stale', changedAt: 150, plan: localFirstPlan({ name: '不应复活' })
  }] } });
  assert.equal(stale.data.plans.length, 0);

  openId = 'admin-sync-2';
  const otherAdmin = await api.handle({ action: 'sync.pull', payload: {} });
  assert.equal(otherAdmin.data.initialized, false);
});

test('local-first sync rejects invalid plans without creating a workspace', async () => {
  const db = createMemoryDb();
  const openId = 'admin-sync-invalid';
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => [openId] });
  const invalid = localFirstPlan({ name: '', vehiclePrice: undefined, loanAmount: undefined });
  const response = await api.handle({ action: 'sync.push', payload: { operations: [{
    opId: 'device-a:100:invalid', type: 'plan.upsert', planId: invalid.id, changedAt: 100, plan: invalid
  }] } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'SYNC_PLAN_INVALID');
  assert.equal((db._store.app_settings || []).length, 0);
});

test('payment transaction splits late fee and updates only the owner contract plans', async () => {
  const db = createMemoryDb();
  const openId = 'admin-1';
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => [openId] });
  await api.handle({ action: 'session' });
  const customerId = (await db.collection('customers').add({ data: { ownerOpenId: openId, name: '测试', status: 'active' } }))._id;
  const contractId = (await db.collection('contracts').add({ data: { ownerOpenId: openId, customerId, status: 'active' } }))._id;
  const schedule = domain.buildRepaymentSchedule({ principalCents: 100000, monthlyRateBps: 100, terms: 2, interestMethod: 'flat', startDateKey: '2026-01-01', dueDay: 5 });
  for (const row of schedule) await db.collection('repayment_plans').add({ data: { ...row, ownerOpenId: openId, customerId, contractId } });
  const response = await api.handle({ action: 'payments.record', payload: {
    contractId,
    amountCents: 51500,
    lateFeeCents: 500,
    startTermNo: 1,
    receivedDateKey: '2026-01-05'
  }});
  assert.equal(response.ok, true);
  assert.equal(response.data.allocations.length, 1);
  assert.equal(response.data.allocations[0].interestCents, 1000);
  assert.equal(response.data.allocations[0].principalCents, 50000);
  const payment = db._store.payments[0];
  assert.equal(payment.ownerOpenId, openId);
  assert.equal(payment.contractAmountCents, 51000);
  assert.equal(db._store.repayment_plans[0].status, 'paid');
});

test('normal payment, overdue reminder, reversal, and settlement work as one cloud workflow', async () => {
  const db = createMemoryDb();
  const openId = 'admin-flow';
  const fixedNow = new Date('2026-01-05T04:00:00.000Z');
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => [openId], now: () => fixedNow });

  const customerResponse = await api.handle({ action: 'customers.save', payload: { name: '真实场景客户', plate: '湘A12345', vehicle: '测试车' } });
  assert.equal(customerResponse.ok, true);
  const customerId = customerResponse.data.customerId;
  const contractResponse = await api.handle({ action: 'contracts.create', payload: {
    customerId,
    interestMethod: 'flat',
    vehiclePriceCents: 9180000,
    downPaymentRateBps: 1500,
    monthlyRateBps: 125,
    terms: 36,
    depositMonths: 1,
    dueDay: 5,
    startDateKey: '2026-01-01',
    dailyLateFeeRateBps: 50
  }});
  assert.equal(contractResponse.ok, true);
  assert.equal(contractResponse.data.repaymentPlanCount, 36);

  const dueToday = await api.handle({ action: 'dashboard.list', payload: { todayDateKey: '2026-01-05' } });
  assert.equal(dueToday.data.today.length, 1);
  const firstPlan = db._store.repayment_plans.find(row => row.termNo === 1);

  const paymentResponse = await api.handle({ action: 'payments.record', payload: {
    contractId: contractResponse.data.contractId,
    amountCents: firstPlan.scheduledAmountCents,
    lateFeeCents: 0,
    startTermNo: 1,
    receivedDateKey: '2026-01-05'
  }});
  assert.equal(paymentResponse.ok, true);
  const afterPayment = await api.handle({ action: 'dashboard.list', payload: { todayDateKey: '2026-01-05' } });
  assert.equal(afterPayment.data.today.length, 0);

  const reversed = await api.handle({ action: 'payments.reverse', payload: { paymentId: paymentResponse.data.paymentId, reason: '测试撤销' } });
  assert.equal(reversed.ok, true);
  const afterReverse = await api.handle({ action: 'dashboard.list', payload: { todayDateKey: '2026-01-08' } });
  assert.equal(afterReverse.data.overdue.length, 1);
  assert.equal(afterReverse.data.overdue[0].daysOverdue, 3);
  assert.equal(afterReverse.data.overdue[0].lateFeeCents, 4714);

  const settlement = await api.handle({ action: 'settlement.get', payload: { contractId: contractResponse.data.contractId } });
  assert.equal(settlement.ok, true);
  assert.equal(settlement.data.remainingPrincipalCents, 7803000);
  assert.equal(settlement.data.remainingInterestCents, 3511350);
  assert.equal(settlement.data.depositBalanceCents, 0);
});

test('legacy migration advances one customer per request and resumes without duplicates', async () => {
  const db = createMemoryDb();
  const openId = 'admin-migration';
  const api = createApi({ db, getTrustedIdentity: () => ({ openId }), getAdminOpenIds: () => [openId] });
  const legacyPlan = index => ({
    id: `legacy-${index}`,
    name: `迁移客户${index}`,
    plate: `TEST-${index}`,
    vehicle: '迁移测试车',
    vehiclePrice: 10000,
    downPaymentRate: 20,
    monthlyRate: 1,
    amount: 4080,
    dueDay: 5,
    rate: 0.005,
    startDate: '2026-01-01',
    totalTerms: 2,
    completedTerms: 0,
    openingCompletedTerms: 0,
    depositMonths: 0,
    payments: []
  });
  const backup = { app: '车辆还款管理工具', version: 1, plans: [legacyPlan(1), legacyPlan(2), legacyPlan(3)] };

  const first = await api.handle({ action: 'migration.import', payload: { backup } });
  assert.equal(first.ok, true);
  assert.equal(first.data.status, 'running');
  assert.deepEqual(first.data.progress, { completed: 1, total: 3, remaining: 2 });
  assert.equal(db._store.customers.length, 1);

  const second = await api.handle({ action: 'migration.import', payload: { backup } });
  assert.equal(second.data.status, 'running');
  assert.deepEqual(second.data.progress, { completed: 2, total: 3, remaining: 1 });

  const third = await api.handle({ action: 'migration.import', payload: { backup } });
  assert.equal(third.data.status, 'completed');
  assert.deepEqual(third.data.progress, { completed: 3, total: 3, remaining: 0 });
  assert.equal(db._store.customers.length, 3);
  assert.equal(db._store.contracts.length, 3);
  assert.equal(db._store.repayment_plans.length, 6);

  const repeated = await api.handle({ action: 'migration.import', payload: { backup } });
  assert.equal(repeated.data.status, 'duplicate');
  assert.equal(db._store.customers.length, 3);
});
