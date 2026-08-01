'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../packages/domain');

test('flat quote and reverse preserve the existing business formula', () => {
  const principal = domain.yuanToCents(78030);
  const rate = domain.percentToBps(1.25);
  assert.equal(domain.calculateMonthlyPaymentCents(principal, rate, 36, 'flat'), 314288);
  assert.equal(domain.principalFromPaymentCents(314288, rate, 36, 'flat'), 7803012);
});

test('annuity quote and reverse are mutually consistent within one cent-level quote', () => {
  const principal = domain.yuanToCents(150000);
  const rate = domain.percentToBps(0.6);
  const payment = domain.calculateMonthlyPaymentCents(principal, rate, 36, 'annuity');
  const reversed = domain.principalFromPaymentCents(payment, rate, 36, 'annuity');
  assert.ok(Math.abs(reversed - principal) <= 20);
});

test('flat schedule reconciles exact contract totals and the 12-term settlement fixture', () => {
  const schedule = domain.buildRepaymentSchedule({
    principalCents: domain.yuanToCents(78030),
    monthlyRateBps: domain.percentToBps(1.25),
    terms: 36,
    interestMethod: 'flat',
    startDateKey: '2026-01-01',
    dueDay: 5
  });
  const principalTotal = schedule.reduce((sum, row) => sum + row.scheduledPrincipalCents, 0);
  const interestTotal = schedule.reduce((sum, row) => sum + row.scheduledInterestCents, 0);
  assert.equal(principalTotal, 7803000);
  assert.equal(interestTotal, 3511350);

  schedule.slice(0, 12).forEach(row => {
    row.paidPrincipalCents = row.scheduledPrincipalCents;
    row.paidInterestCents = row.scheduledInterestCents;
  });
  const settlement = domain.settlementBreakdown(schedule);
  assert.equal(settlement.paidPrincipalCents, 2601000);
  assert.equal(settlement.paidInterestCents, 1170450);
  assert.equal(settlement.remainingPrincipalCents, 5202000);
  assert.equal(settlement.remainingInterestCents, 2340900);
});

test('31st due day falls back to the last day of a short month', () => {
  assert.equal(domain.dueDateKeyForTerm('2026-01-01', 31, 1), '2026-02-28');
  assert.equal(domain.dueDateKeyForTerm('2028-01-01', 31, 1), '2028-02-29');
});

test('late fee is calculated per installment remaining amount', () => {
  assert.equal(domain.calculateLateFeeCents(314288, 50, 3), 4714);
});

test('contract payment allocates interest then principal and can span terms', () => {
  const plans = domain.buildRepaymentSchedule({
    principalCents: 100000,
    monthlyRateBps: 100,
    terms: 2,
    interestMethod: 'flat',
    startDateKey: '2026-01-01',
    dueDay: 5
  });
  plans.forEach((plan, index) => { plan._id = `plan-${index + 1}`; });
  const result = domain.allocateContractPayment(plans, 60000, 1);
  assert.equal(result.unallocatedCents, 0);
  assert.equal(result.allocations.length, 2);
  assert.equal(result.allocations[0].interestCents, 1000);
  assert.equal(result.allocations[0].principalCents, 50000);
  assert.equal(result.allocations[1].contractAmountCents, 9000);
});

test('deposit remains separate from contract settlement unless explicitly offset', () => {
  const plans = [{
    scheduledPrincipalCents: 50000,
    scheduledInterestCents: 10000,
    paidPrincipalCents: 0,
    paidInterestCents: 0
  }];
  const result = domain.settlementBreakdown(plans, 12000);
  assert.equal(result.contractSettlementCents, 60000);
  assert.equal(result.totalIfDepositNotOffsetCents, 60000);
  assert.equal(result.totalIfDepositOffsetCents, 48000);
});
