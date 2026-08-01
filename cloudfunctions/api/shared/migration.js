'use strict';

let domain;
try {
  domain = require('../domain');
} catch (_error) {
  // Generated CloudBase copy lives next to domain.js.
  domain = require('./domain');
}

const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

function safeLegacyId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value);
}

function normalizeBackupInput(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_BACKUP_BYTES) {
      throw new Error('备份超过5MB，无法导入。');
    }
    const trimmed = input.trim();
    const markerIndex = trimmed.indexOf('数据：');
    let jsonText = trimmed;
    if (!/^[{[]/.test(trimmed) && markerIndex >= 0) jsonText = trimmed.slice(markerIndex + 3).trim();
    input = JSON.parse(jsonText);
  }
  const plans = Array.isArray(input) ? input : input && input.plans;
  if (!Array.isArray(plans)) throw new Error('没有识别到旧版客户计划数组。');
  return {
    app: input && input.app ? String(input.app) : 'legacy-localstorage',
    version: input && input.version ? Number(input.version) : 1,
    exportedAt: input && input.exportedAt ? String(input.exportedAt) : null,
    plans
  };
}

function validateLegacyPlan(plan, index) {
  const errors = [];
  const label = `第${index + 1}位客户`;
  if (!plan || typeof plan !== 'object') return [`${label}不是有效对象。`];
  if (!safeLegacyId(plan.id)) errors.push(`${label}的客户ID不合法。`);
  if (typeof plan.name !== 'string' || !plan.name.trim()) errors.push(`${label}缺少客户姓名。`);
  const requiredPositive = ['vehiclePrice', 'amount', 'totalTerms', 'dueDay'];
  requiredPositive.forEach(field => {
    if (!Number.isFinite(Number(plan[field])) || Number(plan[field]) <= 0) errors.push(`${label}的${field}不合法。`);
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plan.startDate || ''))) errors.push(`${label}的首期日期不合法。`);
  if (!Number.isInteger(Number(plan.totalTerms)) || Number(plan.totalTerms) > 360) errors.push(`${label}的总期数必须是1至360的整数。`);
  if (!Number.isInteger(Number(plan.completedTerms)) || Number(plan.completedTerms) < 0 || Number(plan.completedTerms) > Number(plan.totalTerms)) {
    errors.push(`${label}的已完成期数不合法。`);
  }
  if (Number(plan.downPaymentRate) < 0 || Number(plan.downPaymentRate) >= 100) errors.push(`${label}的首付比例不合法。`);
  if (Number(plan.monthlyRate) < 0) errors.push(`${label}的月利率不合法。`);
  if (Number(plan.depositMonths || 0) < 0 || Number(plan.depositMonths || 0) > 120) errors.push(`${label}的押金月数不合法。`);
  if (plan.payments !== undefined && !Array.isArray(plan.payments)) errors.push(`${label}的收款记录不是数组。`);
  for (const payment of plan.payments || []) {
    if (!safeLegacyId(payment.id)) errors.push(`${label}存在不合法的收款ID。`);
    if (!Number.isFinite(Number(payment.total)) || Number(payment.total) <= 0) errors.push(`${label}存在不合法的收款金额。`);
    if (!Number.isFinite(Number(payment.lateFee)) || Number(payment.lateFee) < 0 || Number(payment.lateFee) > Number(payment.total)) {
      errors.push(`${label}存在不合法的滞纳金。`);
    }
    if (!Array.isArray(payment.allocations)) errors.push(`${label}存在缺少分配明细的收款。`);
  }
  return errors;
}

function applyAmountToRow(row, amountCents) {
  let remaining = amountCents;
  const interestDue = Math.max(0, row.scheduledInterestCents - row.paidInterestCents);
  const interestCents = Math.min(remaining, interestDue);
  remaining -= interestCents;
  const principalDue = Math.max(0, row.scheduledPrincipalCents - row.paidPrincipalCents);
  const principalCents = Math.min(remaining, principalDue);
  remaining -= principalCents;
  row.paidInterestCents += interestCents;
  row.paidPrincipalCents += principalCents;
  row.status = row.paidInterestCents + row.paidPrincipalCents >= row.scheduledAmountCents ? 'paid' : 'partial';
  return { interestCents, principalCents, unallocatedCents: remaining };
}

function convertLegacyPlan(plan) {
  const vehiclePriceCents = domain.yuanToCents(plan.vehiclePrice);
  const downPaymentRateBps = domain.percentToBps(plan.downPaymentRate);
  const downPaymentCents = Math.round(vehiclePriceCents * downPaymentRateBps / 10000);
  const principalCents = vehiclePriceCents - downPaymentCents;
  const monthlyRateBps = domain.percentToBps(plan.monthlyRate);
  const dailyLateFeeRateBps = Math.round(Number(plan.rate || 0) * 10000);
  const terms = Number(plan.totalTerms);
  const legacyAllocatedTermIndexes = (plan.payments || [])
    .flatMap(payment => payment.allocations || [])
    .map(item => Number(item.termIndex))
    .filter(Number.isInteger);
  const inferredOpeningCompletedTerms = legacyAllocatedTermIndexes.length
    ? Math.min(...legacyAllocatedTermIndexes)
    : Number(plan.completedTerms || 0);
  const openingCompletedTerms = Math.min(terms, Number(plan.openingCompletedTerms ?? inferredOpeningCompletedTerms));
  const repaymentPlans = domain.buildRepaymentSchedule({
    principalCents,
    monthlyRateBps,
    terms,
    interestMethod: 'flat',
    startDateKey: plan.startDate,
    dueDay: Number(plan.dueDay)
  }).map(row => ({ ...row, dailyLateFeeRateBps }));

  const payments = [];
  if (openingCompletedTerms > 0) {
    const allocations = repaymentPlans.slice(0, openingCompletedTerms).map(row => {
      row.paidPrincipalCents = row.scheduledPrincipalCents;
      row.paidInterestCents = row.scheduledInterestCents;
      row.status = 'paid';
      return {
        termNo: row.termNo,
        principalCents: row.scheduledPrincipalCents,
        interestCents: row.scheduledInterestCents,
        contractAmountCents: row.scheduledAmountCents
      };
    });
    payments.push({
      legacyId: `${plan.id}:opening-balance`,
      paymentType: 'migration_opening_balance',
      receivedDateKey: plan.startDate,
      amountCents: allocations.reduce((sum, item) => sum + item.contractAmountCents, 0),
      lateFeeCents: 0,
      contractAmountCents: allocations.reduce((sum, item) => sum + item.contractAmountCents, 0),
      allocations,
      status: 'active'
    });
  }

  for (const payment of plan.payments || []) {
    const allocations = [];
    let unallocatedCents = 0;
    const legacyAllocations = payment.allocations.length
      ? payment.allocations
      : [{ termIndex: Number(payment.startTermIndex || openingCompletedTerms), principal: payment.principal }];
    for (const item of legacyAllocations) {
      const row = repaymentPlans[Number(item.termIndex)];
      const amountCents = domain.yuanToCents(item.principal || 0);
      if (!row) {
        unallocatedCents += amountCents;
        continue;
      }
      const applied = applyAmountToRow(row, amountCents);
      unallocatedCents += applied.unallocatedCents;
      allocations.push({
        termNo: row.termNo,
        principalCents: applied.principalCents,
        interestCents: applied.interestCents,
        contractAmountCents: applied.principalCents + applied.interestCents
      });
    }
    payments.push({
      legacyId: payment.id,
      paymentType: 'repayment',
      receivedDateKey: payment.date,
      amountCents: domain.yuanToCents(payment.total),
      lateFeeCents: domain.yuanToCents(payment.lateFee || 0),
      contractAmountCents: domain.yuanToCents(payment.principal || 0),
      allocations,
      unallocatedCents,
      status: 'active'
    });
  }

  return {
    customer: {
      legacyId: plan.id,
      name: plan.name.trim(),
      plate: String(plan.plate || '').trim(),
      vehicle: String(plan.vehicle || '').trim(),
      notes: String(plan.notes || '').trim(),
      status: 'active'
    },
    contract: {
      legacyId: plan.id,
      interestMethod: 'flat',
      vehiclePriceCents,
      downPaymentRateBps,
      downPaymentCents,
      principalCents,
      monthlyRateBps,
      quotedMonthlyPaymentCents: domain.calculateMonthlyPaymentCents(principalCents, monthlyRateBps, terms, 'flat'),
      terms,
      startDateKey: plan.startDate,
      dueDay: Number(plan.dueDay),
      dailyLateFeeRateBps,
      depositMonths: Number(plan.depositMonths || 0),
      status: 'active',
      calculationVersion: 1
    },
    repaymentPlans,
    payments,
    deposits: Number(plan.depositMonths || 0) > 0 ? [{
      legacyId: `${plan.id}:deposit-note`,
      type: 'legacy_note',
      amountCents: 0,
      depositMonths: Number(plan.depositMonths),
      notes: '旧版仅记录押金月数，未记录押金金额，需人工补充。'
    }] : []
  };
}

function previewLegacyBackup(input) {
  let backup;
  try {
    backup = normalizeBackupInput(input);
  } catch (error) {
    return { valid: false, errors: [error.message], warnings: [], summary: null, records: [] };
  }
  const errors = backup.plans.flatMap(validateLegacyPlan);
  const ids = backup.plans.map(plan => plan && plan.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push('备份中存在重复客户ID。');
  if (errors.length) return { valid: false, errors, warnings: [], summary: null, records: [] };

  const records = backup.plans.map(convertLegacyPlan);
  const warnings = [];
  const missingFinancial = backup.plans.filter(plan => !Number.isFinite(Number(plan.vehiclePrice)) || !Number.isFinite(Number(plan.monthlyRate))).length;
  const depositNeedsAmount = records.filter(record => record.deposits.length).length;
  const unallocatedPayments = records.reduce((count, record) => count + record.payments.filter(payment => payment.unallocatedCents > 0).length, 0);
  if (missingFinancial) warnings.push(`${missingFinancial}位客户缺少完整金融参数。`);
  if (depositNeedsAmount) warnings.push(`${depositNeedsAmount}位客户只有押金月数，押金金额需人工补充。`);
  if (unallocatedPayments) warnings.push(`${unallocatedPayments}笔收款存在无法分配金额，导入前必须处理。`);
  const summary = {
    customers: records.length,
    contracts: records.length,
    repaymentPlans: records.reduce((sum, record) => sum + record.repaymentPlans.length, 0),
    payments: records.reduce((sum, record) => sum + record.payments.length, 0),
    deposits: records.reduce((sum, record) => sum + record.deposits.length, 0),
    contractPrincipalCents: records.reduce((sum, record) => sum + record.contract.principalCents, 0),
    scheduledInterestCents: records.reduce((sum, record) => sum + record.repaymentPlans.reduce((subtotal, row) => subtotal + row.scheduledInterestCents, 0), 0),
    receivedCents: records.reduce((sum, record) => sum + record.payments.filter(payment => payment.paymentType === 'repayment').reduce((subtotal, payment) => subtotal + payment.amountCents, 0), 0)
  };
  return {
    valid: unallocatedPayments === 0,
    source: { app: backup.app, version: backup.version, exportedAt: backup.exportedAt },
    errors: unallocatedPayments ? ['存在无法分配的历史收款，已阻止直接导入。'] : [],
    warnings,
    summary,
    records
  };
}

module.exports = {
  MAX_BACKUP_BYTES,
  normalizeBackupInput,
  validateLegacyPlan,
  convertLegacyPlan,
  previewLegacyBackup
};
