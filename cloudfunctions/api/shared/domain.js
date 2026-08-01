'use strict';

const METHOD_FLAT = 'flat';
const METHOD_ANNUITY = 'annuity';
const CENTS_PER_YUAN = 100;
const RATE_SCALE = 10000;

function assertInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
  }
}

function assertMethod(method) {
  if (method !== METHOD_FLAT && method !== METHOD_ANNUITY) {
    throw new TypeError('interestMethod must be flat or annuity');
  }
}

function yuanToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('money must be finite');
  return Math.round((number + Number.EPSILON) * CENTS_PER_YUAN);
}

function centsToYuan(value) {
  assertInteger(value, 'cents');
  return value / CENTS_PER_YUAN;
}

function percentToBps(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError('rate percent must be >= 0');
  return Math.round(number * 100);
}

function multiplyRate(cents, rateBps) {
  assertInteger(cents, 'cents');
  assertInteger(rateBps, 'rateBps');
  return Math.round(cents * rateBps / RATE_SCALE);
}

function distributeEvenly(totalCents, terms) {
  assertInteger(totalCents, 'totalCents');
  assertInteger(terms, 'terms', 1);
  const base = Math.floor(totalCents / terms);
  const remainder = totalCents - base * terms;
  const values = [];
  for (let index = 0; index < terms; index += 1) {
    const before = Math.floor(index * remainder / terms);
    const after = Math.floor((index + 1) * remainder / terms);
    values.push(base + after - before);
  }
  return values;
}

function calculateMonthlyPaymentCents(principalCents, monthlyRateBps, terms, method = METHOD_FLAT) {
  assertInteger(principalCents, 'principalCents', 1);
  assertInteger(monthlyRateBps, 'monthlyRateBps');
  assertInteger(terms, 'terms', 1);
  assertMethod(method);
  if (method === METHOD_FLAT) {
    return Math.round(principalCents / terms + principalCents * monthlyRateBps / RATE_SCALE);
  }
  const rate = monthlyRateBps / RATE_SCALE;
  if (rate === 0) return Math.round(principalCents / terms);
  const factor = (1 + rate) ** terms;
  return Math.round(principalCents * rate * factor / (factor - 1));
}

function principalFromPaymentCents(paymentCents, monthlyRateBps, terms, method = METHOD_FLAT) {
  assertInteger(paymentCents, 'paymentCents', 1);
  assertInteger(monthlyRateBps, 'monthlyRateBps');
  assertInteger(terms, 'terms', 1);
  assertMethod(method);
  const rate = monthlyRateBps / RATE_SCALE;
  if (rate === 0) return Math.round(paymentCents * terms);
  if (method === METHOD_ANNUITY) {
    return Math.round(paymentCents * (1 - (1 + rate) ** (-terms)) / rate);
  }
  return Math.round(paymentCents / (1 / terms + rate));
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new TypeError('dateKey must use YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError('dateKey is not a valid date');
  }
  return { year, month, day, date };
}

function dateKeyFromUTC(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dueDateKeyForTerm(startDateKey, dueDay, termIndex) {
  const start = parseDateKey(startDateKey);
  assertInteger(dueDay, 'dueDay', 1);
  if (dueDay > 31) throw new TypeError('dueDay must be <= 31');
  assertInteger(termIndex, 'termIndex');
  const first = new Date(Date.UTC(start.year, start.month - 1 + termIndex, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dueDay, lastDay));
  return dateKeyFromUTC(first);
}

function daysBetweenDateKeys(laterDateKey, earlierDateKey) {
  const later = parseDateKey(laterDateKey).date;
  const earlier = parseDateKey(earlierDateKey).date;
  return Math.round((later - earlier) / 86400000);
}

function buildFlatSchedule(principalCents, monthlyRateBps, terms) {
  const principals = distributeEvenly(principalCents, terms);
  const totalInterestCents = Math.round(principalCents * monthlyRateBps * terms / RATE_SCALE);
  const interests = distributeEvenly(totalInterestCents, terms);
  let balance = principalCents;
  return principals.map((principal, index) => {
    const openingPrincipalCents = balance;
    balance -= principal;
    return {
      termNo: index + 1,
      openingPrincipalCents,
      scheduledPrincipalCents: principal,
      scheduledInterestCents: interests[index],
      scheduledAmountCents: principal + interests[index],
      closingPrincipalCents: balance
    };
  });
}

function buildAnnuitySchedule(principalCents, monthlyRateBps, terms) {
  const paymentCents = calculateMonthlyPaymentCents(principalCents, monthlyRateBps, terms, METHOD_ANNUITY);
  const schedule = [];
  let balance = principalCents;
  for (let index = 0; index < terms; index += 1) {
    const interest = multiplyRate(balance, monthlyRateBps);
    const principal = index === terms - 1 ? balance : Math.min(balance, Math.max(0, paymentCents - interest));
    const amount = principal + interest;
    schedule.push({
      termNo: index + 1,
      openingPrincipalCents: balance,
      scheduledPrincipalCents: principal,
      scheduledInterestCents: interest,
      scheduledAmountCents: amount,
      closingPrincipalCents: balance - principal
    });
    balance -= principal;
  }
  return schedule;
}

function buildRepaymentSchedule(input) {
  const {
    principalCents,
    monthlyRateBps,
    terms,
    interestMethod = METHOD_FLAT,
    startDateKey,
    dueDay
  } = input;
  assertInteger(principalCents, 'principalCents', 1);
  assertInteger(monthlyRateBps, 'monthlyRateBps');
  assertInteger(terms, 'terms', 1);
  assertMethod(interestMethod);
  const rows = interestMethod === METHOD_FLAT
    ? buildFlatSchedule(principalCents, monthlyRateBps, terms)
    : buildAnnuitySchedule(principalCents, monthlyRateBps, terms);
  return rows.map((row, index) => ({
    ...row,
    dueDateKey: dueDateKeyForTerm(startDateKey, dueDay, index),
    paidPrincipalCents: 0,
    paidInterestCents: 0,
    status: 'pending'
  }));
}

function calculateLateFeeCents(remainingContractCents, dailyLateFeeRateBps, daysOverdue) {
  assertInteger(remainingContractCents, 'remainingContractCents');
  assertInteger(dailyLateFeeRateBps, 'dailyLateFeeRateBps');
  assertInteger(daysOverdue, 'daysOverdue');
  return Math.round(remainingContractCents * dailyLateFeeRateBps * daysOverdue / RATE_SCALE);
}

function remainingContractCents(plan) {
  return Math.max(0,
    plan.scheduledPrincipalCents + plan.scheduledInterestCents
    - (plan.paidPrincipalCents || 0) - (plan.paidInterestCents || 0));
}

function allocateContractPayment(plans, contractAmountCents, startTermNo = 1) {
  assertInteger(contractAmountCents, 'contractAmountCents');
  assertInteger(startTermNo, 'startTermNo', 1);
  let remaining = contractAmountCents;
  const allocations = [];
  const ordered = [...plans].sort((a, b) => a.termNo - b.termNo);
  for (const plan of ordered) {
    if (remaining === 0 || plan.termNo < startTermNo) continue;
    const interestDue = Math.max(0, plan.scheduledInterestCents - (plan.paidInterestCents || 0));
    const principalDue = Math.max(0, plan.scheduledPrincipalCents - (plan.paidPrincipalCents || 0));
    const interestCents = Math.min(remaining, interestDue);
    remaining -= interestCents;
    const principalCents = Math.min(remaining, principalDue);
    remaining -= principalCents;
    if (interestCents || principalCents) {
      allocations.push({
        repaymentPlanId: plan._id || null,
        termNo: plan.termNo,
        interestCents,
        principalCents,
        contractAmountCents: interestCents + principalCents
      });
    }
  }
  return { allocations, unallocatedCents: remaining };
}

function settlementBreakdown(plans, depositBalanceCents = 0) {
  assertInteger(depositBalanceCents, 'depositBalanceCents');
  const totals = plans.reduce((result, plan) => {
    result.paidPrincipalCents += plan.paidPrincipalCents || 0;
    result.paidInterestCents += plan.paidInterestCents || 0;
    result.remainingPrincipalCents += Math.max(0, plan.scheduledPrincipalCents - (plan.paidPrincipalCents || 0));
    result.remainingInterestCents += Math.max(0, plan.scheduledInterestCents - (plan.paidInterestCents || 0));
    return result;
  }, { paidPrincipalCents: 0, paidInterestCents: 0, remainingPrincipalCents: 0, remainingInterestCents: 0 });
  return {
    ...totals,
    contractSettlementCents: totals.remainingPrincipalCents + totals.remainingInterestCents,
    depositBalanceCents,
    totalIfDepositNotOffsetCents: totals.remainingPrincipalCents + totals.remainingInterestCents,
    totalIfDepositOffsetCents: Math.max(0, totals.remainingPrincipalCents + totals.remainingInterestCents - depositBalanceCents)
  };
}

function summarizeDashboard(plans, todayDateKey) {
  parseDateKey(todayDateKey);
  const result = { today: [], upcoming: [], overdue: [] };
  for (const plan of plans) {
    const remaining = remainingContractCents(plan);
    if (!remaining) continue;
    const delta = daysBetweenDateKeys(plan.dueDateKey, todayDateKey);
    const item = { ...plan, remainingContractCents: remaining, delta };
    if (delta === 0) result.today.push(item);
    else if (delta > 0 && delta <= 3) result.upcoming.push(item);
    else if (delta < 0) {
      item.daysOverdue = -delta;
      item.lateFeeCents = calculateLateFeeCents(remaining, plan.dailyLateFeeRateBps || 0, item.daysOverdue);
      result.overdue.push(item);
    }
  }
  return result;
}

module.exports = {
  METHOD_FLAT,
  METHOD_ANNUITY,
  yuanToCents,
  centsToYuan,
  percentToBps,
  multiplyRate,
  distributeEvenly,
  calculateMonthlyPaymentCents,
  principalFromPaymentCents,
  dueDateKeyForTerm,
  daysBetweenDateKeys,
  buildRepaymentSchedule,
  calculateLateFeeCents,
  remainingContractCents,
  allocateContractPayment,
  settlementBreakdown,
  summarizeDashboard
};
