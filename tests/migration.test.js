'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../packages/migration');

function fixturePlan(overrides = {}) {
  return {
    id: 'legacy-customer-1',
    name: '测试客户',
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

test('legacy text wrapper is parsed and previewed without writing data', () => {
  const payload = { app: '车辆还款管理工具', version: 1, plans: [fixturePlan()] };
  const preview = migration.previewLegacyBackup(`【大进车贷助手备份】\n版本：v1\n数据：\n${JSON.stringify(payload)}`);
  assert.equal(preview.valid, true);
  assert.equal(preview.summary.customers, 1);
  assert.equal(preview.summary.repaymentPlans, 36);
  assert.equal(preview.summary.contractPrincipalCents, 7803000);
  assert.equal(preview.summary.scheduledInterestCents, 3511350);
  assert.match(preview.warnings.join('\n'), /押金金额需人工补充/);
});

test('WeChat wrapper, ASCII marker, and JSON code fence are parsed', () => {
  const payload = { app: '车辆还款管理工具', version: 1, plans: [fixturePlan({ depositMonths: 0 })] };
  const preview = migration.previewLegacyBackup(`微信文件传输助手\n数据:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n请妥善保管`);
  assert.equal(preview.valid, true);
  assert.equal(preview.summary.customers, 1);
});

test('missing legacy finance fields are derived only from saved financial values', () => {
  const plan = fixturePlan({ monthlyRate: undefined });
  const preview = migration.previewLegacyBackup({ version: 1, plans: [plan] });
  assert.equal(preview.valid, true);
  assert.ok(Math.abs(preview.records[0].contract.monthlyRateBps - 125) <= 1);
  assert.match(preview.warnings.join('\n'), /月利率由旧月供、贷款额和期数倒推/);
});

test('missing vehicle price falls back to explicit loan amount with a visible warning', () => {
  const plan = fixturePlan({ vehiclePrice: undefined, downPaymentRate: undefined });
  const preview = migration.previewLegacyBackup({ version: 1, plans: [plan] });
  assert.equal(preview.valid, true);
  assert.equal(preview.records[0].contract.principalCents, 7803000);
  assert.equal(preview.records[0].contract.downPaymentRateBps, 0);
  assert.match(preview.warnings.join('\n'), /暂按贷款额作为车价、首付0%迁移/);
});

test('records without enough financial evidence stay blocked with specific reasons', () => {
  const plan = fixturePlan({
    vehiclePrice: undefined,
    downPaymentRate: undefined,
    loanAmount: undefined,
    monthlyRate: undefined
  });
  const preview = migration.previewLegacyBackup({ version: 1, plans: [plan] });
  assert.equal(preview.valid, false);
  assert.match(preview.errors.join('\n'), /车辆价格缺失/);
  assert.match(preview.errors.join('\n'), /首付比例缺失/);
  assert.match(preview.errors.join('\n'), /月利率缺失/);
});

test('duplicate legacy customer IDs are blocked before import', () => {
  const plan = fixturePlan();
  const preview = migration.previewLegacyBackup({ version: 1, plans: [plan, { ...plan }] });
  assert.equal(preview.valid, false);
  assert.match(preview.errors.join('\n'), /重复客户ID/);
});

test('opening completed terms become an auditable migration opening balance', () => {
  const converted = migration.convertLegacyPlan(fixturePlan({ completedTerms: 12, openingCompletedTerms: 12 }));
  assert.equal(converted.payments[0].paymentType, 'migration_opening_balance');
  assert.equal(converted.payments[0].allocations.length, 12);
  assert.equal(converted.repaymentPlans.filter(row => row.status === 'paid').length, 12);
});

test('legacy payment allocation is split into interest and principal', () => {
  const plan = fixturePlan({
    payments: [{
      id: 'payment-1',
      date: '2026-01-05',
      total: 3142.88,
      lateFee: 0,
      principal: 3142.88,
      startTermIndex: 0,
      allocations: [{ termIndex: 0, principal: 3142.87 }, { termIndex: 1, principal: 0.01 }]
    }]
  });
  const preview = migration.previewLegacyBackup({ version: 1, plans: [plan] });
  assert.equal(preview.valid, true);
  const payment = preview.records[0].payments[0];
  assert.equal(payment.allocations[0].interestCents + payment.allocations[0].principalCents, 314287);
  assert.equal(payment.allocations[1].contractAmountCents, 1);
});

test('legacy uniform monthly-payment cents are preserved during migration', () => {
  const payment = index => ({
    id: `rounding-payment-${index}`,
    date: `2026-0${index}-05`,
    total: 33.34,
    lateFee: 0,
    principal: 33.34,
    startTermIndex: index - 1,
    allocations: [{ termIndex: index - 1, principal: 33.34 }]
  });
  const preview = migration.previewLegacyBackup({ version: 1, plans: [fixturePlan({
    vehiclePrice: 100.01,
    downPaymentRate: 0,
    loanAmount: 100.01,
    monthlyRate: 0,
    amount: 33.34,
    totalTerms: 3,
    payments: [payment(1), payment(2), payment(3)]
  })] });
  assert.equal(preview.valid, true);
  assert.equal(preview.records[0].payments.reduce((sum, item) => sum + item.unallocatedCents, 0), 0);
  assert.equal(preview.records[0].payments.at(-1).roundingAdjustmentCents, 1);
  assert.match(preview.warnings.join('\n'), /分币尾差/);
});

test('old records without openingCompletedTerms do not double-count imported payments', () => {
  const plan = fixturePlan({
    completedTerms: 1,
    payments: [{
      id: 'payment-old',
      date: '2026-01-05',
      total: 3142.87,
      lateFee: 0,
      principal: 3142.87,
      startTermIndex: 0,
      allocations: [{ termIndex: 0, principal: 3142.87 }]
    }]
  });
  delete plan.openingCompletedTerms;
  const converted = migration.convertLegacyPlan(plan);
  assert.equal(converted.payments.some(payment => payment.paymentType === 'migration_opening_balance'), false);
  assert.equal(converted.repaymentPlans[0].status, 'paid');
});
