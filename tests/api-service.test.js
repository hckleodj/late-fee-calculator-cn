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
