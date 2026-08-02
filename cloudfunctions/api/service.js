'use strict';

const crypto = require('node:crypto');
const domain = require('./shared/domain');
const migration = require('./shared/migration');

const COLLECTIONS = [
  'users',
  'customers',
  'contracts',
  'repayment_plans',
  'payments',
  'deposits',
  'app_settings',
  'audit_logs',
  'migration_jobs'
];

const MIGRATION_BATCH_SIZE = 1;

function createApi(options) {
  const db = options.db;
  const command = db.command;
  const now = options.now || (() => new Date());

  function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  }

  function cleanText(value, maxLength = 200) {
    return String(value || '').trim().slice(0, maxLength);
  }

  function requireInteger(value, name, minimum = 0) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum) fail('VALIDATION_ERROR', `${name}不合法。`);
    return number;
  }

  async function getOne(collection, where, transaction = db) {
    const result = await transaction.collection(collection).where(where).limit(1).get();
    return result.data && result.data[0] || null;
  }

  async function getAll(collection, where, orderBy) {
    const rows = [];
    let skip = 0;
    const pageSize = 100;
    while (true) {
      let query = db.collection(collection).where(where);
      if (orderBy) query = query.orderBy(orderBy.field, orderBy.direction || 'asc');
      const result = await query.skip(skip).limit(pageSize).get();
      rows.push(...result.data);
      if (result.data.length < pageSize) break;
      skip += pageSize;
      if (skip > 10000) fail('DATA_LIMIT', `${collection}数据超过单次处理上限。`);
    }
    return rows;
  }

  async function resolveAdmin() {
    const identity = options.getTrustedIdentity();
    const openId = cleanText(identity && identity.openId, 128);
    if (!openId) fail('UNAUTHENTICATED', '没有取得可信的微信登录身份。');
    const allowlist = options.getAdminOpenIds();
    if (!allowlist.length || !allowlist.includes(openId)) fail('FORBIDDEN', '当前微信账号不在管理员白名单。');
    let user = await getOne('users', { ownerOpenId: openId });
    if (!user) {
      const timestamp = now();
      const result = await db.collection('users').add({
        data: {
          ownerOpenId: openId,
          role: 'admin',
          status: 'active',
          appId: cleanText(identity.appId, 128),
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1
        }
      });
      user = { _id: result._id, ownerOpenId: openId, role: 'admin', status: 'active' };
    }
    if (user.status !== 'active' || user.role !== 'admin') fail('FORBIDDEN', '管理员账号已停用。');
    return user;
  }

  async function audit(transaction, ownerOpenId, action, entityType, entityId, summary = {}) {
    await transaction.collection('audit_logs').add({
      data: {
        ownerOpenId,
        action,
        entityType,
        entityId,
        summary,
        createdAt: now(),
        schemaVersion: 1
      }
    });
  }

  async function session(user) {
    return {
      role: user.role,
      status: user.status,
      ownerOpenIdMasked: `${user.ownerOpenId.slice(0, 6)}…${user.ownerOpenId.slice(-4)}`,
      version: 'v0.9 内部试用版',
      appName: '大进车贷助手'
    };
  }

  async function listCustomers(ownerOpenId, payload) {
    const keyword = cleanText(payload.keyword, 40);
    const rows = await getAll('customers', { ownerOpenId, status: 'active' }, { field: 'updatedAt', direction: 'desc' });
    if (!keyword) return rows;
    return rows.filter(row => [row.name, row.plate, row.vehicle].some(value => String(value || '').includes(keyword)));
  }

  async function saveCustomer(ownerOpenId, payload) {
    const timestamp = now();
    const data = {
      ownerOpenId,
      name: cleanText(payload.name, 60),
      plate: cleanText(payload.plate, 30),
      vehicle: cleanText(payload.vehicle, 100),
      notes: cleanText(payload.notes, 500),
      status: 'active',
      updatedAt: timestamp,
      schemaVersion: 1
    };
    if (!data.name) fail('VALIDATION_ERROR', '客户姓名不能为空。');
    if (payload.customerId) {
      const existing = await getOne('customers', { _id: payload.customerId, ownerOpenId });
      if (!existing) fail('NOT_FOUND', '没有找到客户。');
      await db.collection('customers').doc(existing._id).update({ data });
      await audit(db, ownerOpenId, 'customer.update', 'customer', existing._id, { name: data.name });
      return { customerId: existing._id };
    }
    const result = await db.collection('customers').add({ data: { ...data, createdAt: timestamp } });
    await audit(db, ownerOpenId, 'customer.create', 'customer', result._id, { name: data.name });
    return { customerId: result._id };
  }

  async function createContract(ownerOpenId, payload) {
    const customer = await getOne('customers', { _id: cleanText(payload.customerId, 128), ownerOpenId, status: 'active' });
    if (!customer) fail('NOT_FOUND', '没有找到对应客户。');
    const interestMethod = payload.interestMethod === 'annuity' ? 'annuity' : 'flat';
    const vehiclePriceCents = requireInteger(payload.vehiclePriceCents, '车辆价格', 1);
    const downPaymentRateBps = requireInteger(payload.downPaymentRateBps, '首付比例');
    if (downPaymentRateBps >= 10000) fail('VALIDATION_ERROR', '首付比例必须小于100%。');
    const downPaymentCents = Math.round(vehiclePriceCents * downPaymentRateBps / 10000);
    const principalCents = vehiclePriceCents - downPaymentCents;
    const monthlyRateBps = requireInteger(payload.monthlyRateBps, '月利率');
    const terms = requireInteger(payload.terms, '期数', 1);
    if (terms > 120) fail('VALIDATION_ERROR', '第一版合同期数最多120期。');
    const dueDay = requireInteger(payload.dueDay, '还款日', 1);
    const dailyLateFeeRateBps = requireInteger(payload.dailyLateFeeRateBps || 0, '日滞纳金比例');
    const startDateKey = cleanText(payload.startDateKey, 10);
    const schedule = domain.buildRepaymentSchedule({ principalCents, monthlyRateBps, terms, interestMethod, startDateKey, dueDay });
    const transaction = await db.startTransaction();
    try {
      const timestamp = now();
      const contractResult = await transaction.collection('contracts').add({ data: {
        ownerOpenId,
        customerId: customer._id,
        interestMethod,
        vehiclePriceCents,
        downPaymentRateBps,
        downPaymentCents,
        principalCents,
        monthlyRateBps,
        quotedMonthlyPaymentCents: domain.calculateMonthlyPaymentCents(principalCents, monthlyRateBps, terms, interestMethod),
        terms,
        dueDay,
        startDateKey,
        dailyLateFeeRateBps,
        depositMonths: requireInteger(payload.depositMonths || 0, '押金月数'),
        status: 'active',
        calculationVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }});
      for (const row of schedule) {
        await transaction.collection('repayment_plans').add({ data: {
          ...row,
          ownerOpenId,
          customerId: customer._id,
          contractId: contractResult._id,
          dailyLateFeeRateBps,
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1
        }});
      }
      await audit(transaction, ownerOpenId, 'contract.create', 'contract', contractResult._id, { customerId: customer._id, terms, interestMethod });
      await transaction.commit();
      return { contractId: contractResult._id, repaymentPlanCount: schedule.length };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async function customerDetail(ownerOpenId, payload) {
    const customer = await getOne('customers', { _id: cleanText(payload.customerId, 128), ownerOpenId });
    if (!customer) fail('NOT_FOUND', '没有找到客户。');
    const contracts = await getAll('contracts', { ownerOpenId, customerId: customer._id }, { field: 'createdAt', direction: 'desc' });
    const contract = contracts.find(item => item.status === 'active') || contracts[0] || null;
    if (!contract) return { customer, contract: null, repaymentPlans: [], payments: [], deposits: [] };
    const [repaymentPlans, payments, deposits] = await Promise.all([
      getAll('repayment_plans', { ownerOpenId, contractId: contract._id }, { field: 'termNo', direction: 'asc' }),
      getAll('payments', { ownerOpenId, contractId: contract._id }, { field: 'receivedDateKey', direction: 'desc' }),
      getAll('deposits', { ownerOpenId, contractId: contract._id }, { field: 'createdAt', direction: 'desc' })
    ]);
    return { customer, contract, repaymentPlans, payments, deposits };
  }

  async function dashboard(ownerOpenId, payload) {
    const todayDateKey = cleanText(payload.todayDateKey, 10);
    domain.daysBetweenDateKeys(todayDateKey, todayDateKey);
    const today = new Date(`${todayDateKey}T00:00:00.000Z`);
    today.setUTCDate(today.getUTCDate() + 3);
    const upcomingDateKey = today.toISOString().slice(0, 10);
    const all = await getAll('repayment_plans', {
      ownerOpenId,
      status: command.in(['pending', 'partial']),
      dueDateKey: command.lte(upcomingDateKey)
    }, { field: 'dueDateKey', direction: 'asc' });
    const relevant = domain.summarizeDashboard(all, todayDateKey);
    const customerIds = [...new Set([...relevant.today, ...relevant.upcoming, ...relevant.overdue].map(item => item.customerId))];
    const customers = customerIds.length ? await getAll('customers', { ownerOpenId, _id: command.in(customerIds) }) : [];
    const customerMap = Object.fromEntries(customers.map(item => [item._id, item]));
    const enrich = items => items.map(item => ({ ...item, customer: customerMap[item.customerId] || null }));
    return { today: enrich(relevant.today), upcoming: enrich(relevant.upcoming), overdue: enrich(relevant.overdue) };
  }

  async function recordPayment(ownerOpenId, payload) {
    const contractId = cleanText(payload.contractId, 128);
    const amountCents = requireInteger(payload.amountCents, '到账总额', 1);
    const lateFeeCents = requireInteger(payload.lateFeeCents || 0, '滞纳金');
    if (lateFeeCents > amountCents) fail('VALIDATION_ERROR', '滞纳金不能超过到账总额。');
    const contractAmountCents = amountCents - lateFeeCents;
    const startTermNo = requireInteger(payload.startTermNo || 1, '起始期数', 1);
    const transaction = await db.startTransaction();
    try {
      const contract = await getOne('contracts', { _id: contractId, ownerOpenId, status: 'active' }, transaction);
      if (!contract) fail('NOT_FOUND', '没有找到有效合同。');
      const query = await transaction.collection('repayment_plans').where({ ownerOpenId, contractId }).orderBy('termNo', 'asc').get();
      const allocation = domain.allocateContractPayment(query.data, contractAmountCents, startTermNo);
      if (allocation.unallocatedCents) fail('PAYMENT_EXCEEDS_BALANCE', '到账合同款超过剩余应付款。', allocation);
      const timestamp = now();
      const paymentResult = await transaction.collection('payments').add({ data: {
        ownerOpenId,
        customerId: contract.customerId,
        contractId,
        paymentType: 'repayment',
        receivedDateKey: cleanText(payload.receivedDateKey, 10),
        amountCents,
        lateFeeCents,
        contractAmountCents,
        allocations: allocation.allocations,
        notes: cleanText(payload.notes, 300),
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }});
      for (const item of allocation.allocations) {
        const row = query.data.find(value => value.termNo === item.termNo);
        const paidPrincipalCents = (row.paidPrincipalCents || 0) + item.principalCents;
        const paidInterestCents = (row.paidInterestCents || 0) + item.interestCents;
        const status = paidPrincipalCents + paidInterestCents >= row.scheduledAmountCents ? 'paid' : 'partial';
        await transaction.collection('repayment_plans').doc(row._id).update({ data: { paidPrincipalCents, paidInterestCents, status, updatedAt: timestamp } });
      }
      await audit(transaction, ownerOpenId, 'payment.record', 'payment', paymentResult._id, { contractId, amountCents, lateFeeCents });
      await transaction.commit();
      return { paymentId: paymentResult._id, allocations: allocation.allocations };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async function reversePayment(ownerOpenId, payload) {
    const transaction = await db.startTransaction();
    try {
      const payment = await getOne('payments', { _id: cleanText(payload.paymentId, 128), ownerOpenId, status: 'active' }, transaction);
      if (!payment) fail('NOT_FOUND', '没有找到可撤销的收款。');
      const timestamp = now();
      for (const item of payment.allocations || []) {
        const row = await getOne('repayment_plans', { contractId: payment.contractId, ownerOpenId, termNo: item.termNo }, transaction);
        if (!row) fail('DATA_INTEGRITY_ERROR', `第${item.termNo}期账单不存在。`);
        const paidPrincipalCents = Math.max(0, (row.paidPrincipalCents || 0) - item.principalCents);
        const paidInterestCents = Math.max(0, (row.paidInterestCents || 0) - item.interestCents);
        const paid = paidPrincipalCents + paidInterestCents;
        const status = paid === 0 ? 'pending' : paid >= row.scheduledAmountCents ? 'paid' : 'partial';
        await transaction.collection('repayment_plans').doc(row._id).update({ data: { paidPrincipalCents, paidInterestCents, status, updatedAt: timestamp } });
      }
      await transaction.collection('payments').doc(payment._id).update({ data: { status: 'reversed', reversedAt: timestamp, updatedAt: timestamp } });
      await audit(transaction, ownerOpenId, 'payment.reverse', 'payment', payment._id, { reason: cleanText(payload.reason, 300) });
      await transaction.commit();
      return { paymentId: payment._id, status: 'reversed' };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async function getSettlement(ownerOpenId, payload) {
    const contractId = cleanText(payload.contractId, 128);
    const plans = await getAll('repayment_plans', { ownerOpenId, contractId }, { field: 'termNo', direction: 'asc' });
    if (!plans.length) fail('NOT_FOUND', '没有找到合同账单。');
    const deposits = await getAll('deposits', { ownerOpenId, contractId, status: 'active' });
    const depositBalanceCents = deposits.reduce((sum, item) => sum + (item.direction === 'out' ? -item.amountCents : item.amountCents), 0);
    return domain.settlementBreakdown(plans, Math.max(0, depositBalanceCents));
  }

  async function recordDeposit(ownerOpenId, payload) {
    const contract = await getOne('contracts', { _id: cleanText(payload.contractId, 128), ownerOpenId, status: 'active' });
    if (!contract) fail('NOT_FOUND', '没有找到有效合同。');
    const direction = payload.direction === 'out' ? 'out' : 'in';
    const amountCents = requireInteger(payload.amountCents, '押金金额', 1);
    const timestamp = now();
    const result = await db.collection('deposits').add({ data: {
      ownerOpenId,
      customerId: contract.customerId,
      contractId: contract._id,
      direction,
      type: cleanText(payload.type, 40) || (direction === 'in' ? 'received' : 'refunded'),
      amountCents,
      occurredDateKey: cleanText(payload.occurredDateKey, 10),
      notes: cleanText(payload.notes, 300),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1
    }});
    await audit(db, ownerOpenId, 'deposit.record', 'deposit', result._id, { contractId: contract._id, direction, amountCents });
    return { depositId: result._id };
  }

  async function importRecord(ownerOpenId, record, migrationJobId, sourceFingerprint) {
    const duplicate = await getOne('customers', { ownerOpenId, legacyId: record.customer.legacyId, source: 'legacy-localstorage-v1' });
    if (duplicate) return { status: 'skipped', legacyId: record.customer.legacyId, customerId: duplicate._id };
    const transaction = await db.startTransaction();
    try {
      const timestamp = now();
      const customerResult = await transaction.collection('customers').add({ data: {
        ...record.customer,
        ownerOpenId,
        source: 'legacy-localstorage-v1',
        migrationJobId,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }});
      const contractResult = await transaction.collection('contracts').add({ data: {
        ...record.contract,
        ownerOpenId,
        customerId: customerResult._id,
        source: 'legacy-localstorage-v1',
        migrationJobId,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }});
      const termIdMap = {};
      for (const row of record.repaymentPlans) {
        const result = await transaction.collection('repayment_plans').add({ data: {
          ...row,
          ownerOpenId,
          customerId: customerResult._id,
          contractId: contractResult._id,
          source: 'legacy-localstorage-v1',
          migrationJobId,
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1
        }});
        termIdMap[row.termNo] = result._id;
      }
      for (const payment of record.payments) {
        await transaction.collection('payments').add({ data: {
          ...payment,
          ownerOpenId,
          customerId: customerResult._id,
          contractId: contractResult._id,
          allocations: payment.allocations.map(item => ({ ...item, repaymentPlanId: termIdMap[item.termNo] })),
          source: 'legacy-localstorage-v1',
          migrationJobId,
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1
        }});
      }
      for (const deposit of record.deposits) {
        await transaction.collection('deposits').add({ data: {
          ...deposit,
          ownerOpenId,
          customerId: customerResult._id,
          contractId: contractResult._id,
          source: 'legacy-localstorage-v1',
          migrationJobId,
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp,
          schemaVersion: 1
        }});
      }
      await audit(transaction, ownerOpenId, 'migration.customer.import', 'customer', customerResult._id, { legacyId: record.customer.legacyId, sourceFingerprint });
      await transaction.commit();
      return { status: 'imported', legacyId: record.customer.legacyId, customerId: customerResult._id, contractId: contractResult._id };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async function importLegacy(ownerOpenId, payload) {
    const raw = typeof payload.backup === 'string' ? payload.backup : JSON.stringify(payload.backup || {});
    const sourceFingerprint = crypto.createHash('sha256').update(raw).digest('hex');
    const existingJob = await getOne('migration_jobs', { ownerOpenId, sourceFingerprint });
    if (existingJob && existingJob.status === 'completed') {
      return {
        migrationJobId: existingJob._id,
        status: 'duplicate',
        results: existingJob.results || [],
        progress: existingJob.progress || null
      };
    }
    const preview = migration.previewLegacyBackup(payload.backup);
    if (!preview.valid) fail('MIGRATION_PREVIEW_FAILED', '迁移预览未通过。', { errors: preview.errors, warnings: preview.warnings });
    if (!payload.confirmed) {
      const { records: _records, ...publicPreview } = preview;
      return { status: 'preview', sourceFingerprint, ...publicPreview };
    }
    if (preview.records.length > 100) fail('MIGRATION_BATCH_LIMIT', '一次最多迁移100位客户，请拆分备份。');
    const timestamp = now();
    let job = existingJob;
    if (!job) {
      const jobResult = await db.collection('migration_jobs').add({ data: {
        ownerOpenId,
        sourceFingerprint,
        source: preview.source,
        summary: preview.summary,
        status: 'running',
        results: [],
        progress: { completed: 0, total: preview.records.length, remaining: preview.records.length },
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: 1
      }});
      job = { _id: jobResult._id, status: 'running', results: [] };
    }
    const previousResults = Array.isArray(job.results) ? job.results : [];
    const handledLegacyIds = new Set(previousResults.map(item => item.legacyId));
    const pendingRecords = preview.records.filter(record => !handledLegacyIds.has(record.customer.legacyId));
    const batch = pendingRecords.slice(0, MIGRATION_BATCH_SIZE);
    const batchResults = [];
    for (const record of batch) {
      try {
        batchResults.push(await importRecord(ownerOpenId, record, job._id, sourceFingerprint));
      } catch (error) {
        batchResults.push({ status: 'failed', legacyId: record.customer.legacyId, error: error.message });
      }
    }
    const results = [...previousResults, ...batchResults];
    const remaining = Math.max(0, preview.records.length - results.length);
    const status = remaining > 0
      ? 'running'
      : results.some(item => item.status === 'failed') ? 'partial' : 'completed';
    const progress = { completed: results.length, total: preview.records.length, remaining };
    await db.collection('migration_jobs').doc(job._id).update({ data: { status, results, progress, updatedAt: now() } });
    if (status !== 'running') {
      await audit(db, ownerOpenId, 'migration.import', 'migration_job', job._id, { status, sourceFingerprint, summary: preview.summary });
    }
    return {
      migrationJobId: job._id,
      status,
      sourceFingerprint,
      summary: preview.summary,
      results,
      batchResults,
      progress
    };
  }

  async function exportBackup(ownerOpenId) {
    const data = {};
    for (const collection of COLLECTIONS.filter(name => name !== 'users')) {
      data[collection] = await getAll(collection, { ownerOpenId });
    }
    const exportedAt = now().toISOString();
    const controlTotals = {
      customers: data.customers.length,
      contracts: data.contracts.length,
      payments: data.payments.length,
      paymentAmountCents: data.payments.filter(item => item.status === 'active').reduce((sum, item) => sum + (item.amountCents || 0), 0)
    };
    const payload = { app: '大进车贷助手', version: 2, exportedAt, ownerOpenId, controlTotals, data };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { ...payload, checksum };
  }

  const actions = {
    session: (_payload, user) => session(user),
    'dashboard.list': (payload, user) => dashboard(user.ownerOpenId, payload),
    'customers.list': (payload, user) => listCustomers(user.ownerOpenId, payload),
    'customers.save': (payload, user) => saveCustomer(user.ownerOpenId, payload),
    'customers.detail': (payload, user) => customerDetail(user.ownerOpenId, payload),
    'contracts.create': (payload, user) => createContract(user.ownerOpenId, payload),
    'payments.record': (payload, user) => recordPayment(user.ownerOpenId, payload),
    'payments.reverse': (payload, user) => reversePayment(user.ownerOpenId, payload),
    'settlement.get': (payload, user) => getSettlement(user.ownerOpenId, payload),
    'deposits.record': (payload, user) => recordDeposit(user.ownerOpenId, payload),
    'migration.preview': (payload, user) => importLegacy(user.ownerOpenId, { backup: payload.backup, confirmed: false }),
    'migration.import': (payload, user) => importLegacy(user.ownerOpenId, { backup: payload.backup, confirmed: true }),
    'backup.export': (_payload, user) => exportBackup(user.ownerOpenId)
  };

  return {
    async handle(event) {
      try {
        const action = cleanText(event.action, 80);
        if (!actions[action]) fail('UNKNOWN_ACTION', '不支持的操作。');
        const user = await resolveAdmin();
        const data = await actions[action](event.payload || {}, user);
        return { ok: true, data };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: error.code ? error.message : '服务暂时不可用，请稍后重试。',
            details: error.details || null
          }
        };
      }
    }
  };
}

module.exports = { createApi, COLLECTIONS };
