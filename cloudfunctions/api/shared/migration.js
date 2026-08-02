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

function parseBackupJson(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  const candidates = [trimmed];
  const marker = /数据\s*[：:]\s*/.exec(trimmed);
  if (marker) candidates.push(trimmed.slice(marker.index + marker[0].length).trim());
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  const possibleStarts = [trimmed.indexOf('{'), trimmed.indexOf('[')]
    .filter(index => index >= 0)
    .sort((a, b) => a - b);
  for (const index of possibleStarts) {
    const opener = trimmed[index];
    const closer = opener === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(closer);
    if (end > index) candidates.push(trimmed.slice(index, end + 1));
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); }
    catch (_error) { /* Try the next possible JSON section. */ }
  }
  throw new Error('没有识别到完整JSON，请重新复制从“【大进车贷助手备份】”到最后一个“}”的全部内容。');
}

function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function normalizeLegacyPlan(plan, index) {
  if (!plan || typeof plan !== 'object') return { plan, warnings: [] };
  const normalized = { ...plan };
  const label = `第${index + 1}位客户${plan.name ? `“${String(plan.name).trim()}”` : ''}`;
  const warnings = [];
  const terms = finiteNumber(normalized.totalTerms);
  const amount = finiteNumber(normalized.amount);
  let price = finiteNumber(normalized.vehiclePrice);
  let downRate = finiteNumber(normalized.downPaymentRate);
  let loan = finiteNumber(normalized.loanAmount);
  let monthlyRate = finiteNumber(normalized.monthlyRate);

  if (!(loan > 0) && price > 0 && downRate >= 0 && downRate < 100) {
    loan = price * (1 - downRate / 100);
    normalized.loanAmount = loan;
  }
  if (!(loan > 0) && amount > 0 && terms > 0 && monthlyRate >= 0) {
    const denominator = 1 / terms + monthlyRate / 100;
    if (denominator > 0) {
      loan = amount / denominator;
      normalized.loanAmount = loan;
      warnings.push(`${label}的贷款额由旧月供、期数和月利率倒推。`);
    }
  }
  if (!(downRate >= 0 && downRate < 100) && price > 0 && loan > 0 && loan <= price * 1.000001) {
    downRate = Math.max(0, (1 - loan / price) * 100);
    normalized.downPaymentRate = downRate;
    warnings.push(`${label}的首付比例由旧车价和贷款额倒推。`);
  }
  if (!(price > 0) && loan > 0) {
    price = loan;
    downRate = 0;
    normalized.vehiclePrice = price;
    normalized.downPaymentRate = downRate;
    warnings.push(`${label}的旧备份没有车价，暂按贷款额作为车价、首付0%迁移；合同资料需后续核对。`);
  }
  if (!(monthlyRate >= 0) && loan > 0 && amount > 0 && terms > 0) {
    const derivedRate = (amount - loan / terms) / loan * 100;
    if (derivedRate >= -0.000001) {
      monthlyRate = Math.max(0, derivedRate);
      normalized.monthlyRate = monthlyRate;
      warnings.push(`${label}的月利率由旧月供、贷款额和期数倒推。`);
    }
  }
  if (price > 0) normalized.vehiclePrice = price;
  if (loan > 0) normalized.loanAmount = loan;
  if (downRate >= 0 && downRate < 100) normalized.downPaymentRate = downRate;

  if (Array.isArray(normalized.payments)) {
    normalized.payments = normalized.payments.map((payment, paymentIndex) => {
      if (!payment || typeof payment !== 'object') return payment;
      const copy = { ...payment };
      const total = finiteNumber(copy.total);
      const lateFee = finiteNumber(copy.lateFee) || 0;
      if (!(finiteNumber(copy.principal) >= 0) && total >= lateFee) copy.principal = total - lateFee;
      if (!Array.isArray(copy.allocations)) {
        copy.allocations = [];
        warnings.push(`${label}第${paymentIndex + 1}笔收款缺少旧分配明细，将按起始期数顺序重建。`);
      } else {
        copy.allocations = copy.allocations.map(item => ({ ...item }));
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(copy.date || ''))) {
        copy.date = normalized.startDate;
        warnings.push(`${label}第${paymentIndex + 1}笔收款缺少有效日期，暂用首期日期迁移。`);
      }
      return copy;
    });
  }
  return { plan: normalized, warnings };
}

function normalizeBackupInput(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_BACKUP_BYTES) {
      throw new Error('备份超过5MB，无法导入。');
    }
    input = parseBackupJson(input);
  }
  const plans = Array.isArray(input) ? input : input && input.plans;
  if (!Array.isArray(plans)) throw new Error('没有识别到旧版客户计划数组。');
  const normalized = plans.map(normalizeLegacyPlan);
  return {
    app: input && input.app ? String(input.app) : 'legacy-localstorage',
    version: input && input.version ? Number(input.version) : 1,
    exportedAt: input && input.exportedAt ? String(input.exportedAt) : null,
    plans: normalized.map(item => item.plan),
    compatibilityWarnings: normalized.flatMap(item => item.warnings)
  };
}

function validateLegacyPlan(plan, index) {
  const errors = [];
  const label = `第${index + 1}位客户`;
  if (!plan || typeof plan !== 'object') return [`${label}不是有效对象。`];
  if (!safeLegacyId(plan.id)) errors.push(`${label}的客户ID不合法。`);
  if (typeof plan.name !== 'string' || !plan.name.trim()) errors.push(`${label}缺少客户姓名。`);
  const fieldLabels = { vehiclePrice: '车辆价格', amount: '合同月供', totalTerms: '总期数', dueDay: '每月还款日' };
  const requiredPositive = ['vehiclePrice', 'amount', 'totalTerms', 'dueDay'];
  requiredPositive.forEach(field => {
    if (!Number.isFinite(Number(plan[field])) || Number(plan[field]) <= 0) errors.push(`${label}的${fieldLabels[field]}缺失或不合法。`);
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(plan.startDate || ''))) errors.push(`${label}的首期日期不合法。`);
  if (!Number.isInteger(Number(plan.totalTerms)) || Number(plan.totalTerms) > 360) errors.push(`${label}的总期数必须是1至360的整数。`);
  if (!Number.isInteger(Number(plan.dueDay)) || Number(plan.dueDay) > 31) errors.push(`${label}的每月还款日必须是1至31的整数。`);
  if (!Number.isInteger(Number(plan.completedTerms)) || Number(plan.completedTerms) < 0 || Number(plan.completedTerms) > Number(plan.totalTerms)) {
    errors.push(`${label}的已完成期数不合法。`);
  }
  if (!Number.isFinite(Number(plan.downPaymentRate)) || Number(plan.downPaymentRate) < 0 || Number(plan.downPaymentRate) >= 100) {
    errors.push(`${label}的首付比例缺失或不合法。`);
  }
  if (!Number.isFinite(Number(plan.monthlyRate)) || Number(plan.monthlyRate) < 0) errors.push(`${label}的月利率缺失或不合法。`);
  if (Number(plan.depositMonths || 0) < 0 || Number(plan.depositMonths || 0) > 120) errors.push(`${label}的押金月数不合法。`);
  if (plan.payments !== undefined && !Array.isArray(plan.payments)) errors.push(`${label}的收款记录不是数组。`);
  for (const payment of plan.payments || []) {
    if (!safeLegacyId(payment.id)) errors.push(`${label}存在不合法的收款ID。`);
    if (!Number.isFinite(Number(payment.total)) || Number(payment.total) <= 0) errors.push(`${label}存在不合法的收款金额。`);
    if (!Number.isFinite(Number(payment.lateFee)) || Number(payment.lateFee) < 0 || Number(payment.lateFee) > Number(payment.total)) {
      errors.push(`${label}存在不合法的滞纳金。`);
    }
    if (!Number.isFinite(Number(payment.principal)) || Number(payment.principal) < 0) errors.push(`${label}存在不合法的合同款金额。`);
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

function allocateLegacyPayment(repaymentPlans, startTermIndex, amountCents) {
  let remaining = amountCents;
  const allocations = [];
  for (let index = Math.max(0, startTermIndex); index < repaymentPlans.length && remaining > 0; index += 1) {
    const row = repaymentPlans[index];
    const applied = applyAmountToRow(row, remaining);
    const contractAmountCents = applied.interestCents + applied.principalCents;
    if (contractAmountCents > 0) {
      allocations.push({
        termNo: row.termNo,
        principalCents: applied.principalCents,
        interestCents: applied.interestCents,
        contractAmountCents
      });
    }
    remaining = applied.unallocatedCents;
  }
  return { allocations, unallocatedCents: remaining };
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
  const migrationWarnings = [];

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
    const legacyAllocations = payment.allocations.length
      ? payment.allocations
      : [{ termIndex: Number(payment.startTermIndex || openingCompletedTerms), principal: payment.principal }];
    const mergedAllocations = new Map();
    let unallocatedCents = 0;
    for (const item of legacyAllocations) {
      const rebuilt = allocateLegacyPayment(
        repaymentPlans,
        Number(item.termIndex),
        domain.yuanToCents(item.principal || 0)
      );
      unallocatedCents += rebuilt.unallocatedCents;
      for (const allocation of rebuilt.allocations) {
        const existing = mergedAllocations.get(allocation.termNo) || {
          termNo: allocation.termNo,
          principalCents: 0,
          interestCents: 0,
          contractAmountCents: 0
        };
        existing.principalCents += allocation.principalCents;
        existing.interestCents += allocation.interestCents;
        existing.contractAmountCents += allocation.contractAmountCents;
        mergedAllocations.set(allocation.termNo, existing);
      }
    }
    const originalContractAmountCents = domain.yuanToCents(payment.principal || 0);
    const roundingToleranceCents = Math.max(2, Math.ceil(terms / 2));
    const roundingAdjustmentCents = unallocatedCents > 0 && unallocatedCents <= roundingToleranceCents
      ? unallocatedCents
      : 0;
    if (roundingAdjustmentCents) {
      migrationWarnings.push(`${plan.name}有一笔旧收款存在${roundingAdjustmentCents}分分币尾差，已单独记录，不计入本金或利息。`);
      unallocatedCents = 0;
    }
    const contractAmountCents = originalContractAmountCents - roundingAdjustmentCents;
    payments.push({
      legacyId: payment.id,
      paymentType: 'repayment',
      receivedDateKey: payment.date,
      amountCents: domain.yuanToCents(payment.total),
      lateFeeCents: domain.yuanToCents(payment.lateFee || 0),
      contractAmountCents,
      allocations: [...mergedAllocations.values()].sort((a, b) => a.termNo - b.termNo),
      roundingAdjustmentCents,
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
    }] : [],
    migrationWarnings
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
  const warnings = [
    ...(backup.compatibilityWarnings || []),
    ...records.flatMap(record => record.migrationWarnings || [])
  ];
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
  parseBackupJson,
  normalizeLegacyPlan,
  normalizeBackupInput,
  validateLegacyPlan,
  convertLegacyPlan,
  previewLegacyBackup
};
