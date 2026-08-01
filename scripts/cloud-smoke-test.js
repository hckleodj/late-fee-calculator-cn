'use strict';

const apiUrl = process.env.DAJIN_API_URL;
const password = process.env.DAJIN_ADMIN_PASSWORD;
const origin = process.env.DAJIN_WEB_ORIGIN;

if (!apiUrl || !password || !origin) {
  throw new Error('缺少 DAJIN_API_URL、DAJIN_ADMIN_PASSWORD 或 DAJIN_WEB_ORIGIN。');
}

async function request(action, payload = {}, token = '', requestOrigin = origin) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: requestOrigin,
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ action, payload })
  });
  const result = await response.json();
  return { status: response.status, result };
}

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function call(action, payload, token) {
  const response = await request(action, payload, token);
  assert(response.status === 200 && response.result.ok, `${action} 调用失败`, response);
  return response.result.data;
}

async function createContractCase(token, label, startDateKey) {
  const customer = await call('customers.save', {
    name: `【验收测试】${label}`,
    plate: `TEST-${label}`,
    vehicle: '验收样本车（非真实客户）',
    notes: '2026-08-01 云端上线验收数据，请勿作为真实业务记录。'
  }, token);
  const contract = await call('contracts.create', {
    customerId: customer.customerId,
    interestMethod: 'flat',
    vehiclePriceCents: 9180000,
    downPaymentRateBps: 1500,
    monthlyRateBps: 125,
    terms: 36,
    dueDay: 1,
    startDateKey,
    dailyLateFeeRateBps: 50,
    depositMonths: 1
  }, token);
  const detail = await call('customers.detail', { customerId: customer.customerId }, token);
  return { customerId: customer.customerId, contractId: contract.contractId, detail };
}

(async () => {
  const forbidden = await request('web.auth.login', { password }, '', 'https://unauthorized.example');
  assert(forbidden.status === 403 && forbidden.result.error?.code === 'ORIGIN_FORBIDDEN', '未授权来源没有被拒绝', forbidden);

  const login = await request('web.auth.login', { password });
  assert(login.status === 200 && login.result.ok && login.result.data.token, '管理员登录失败', login);
  const token = login.result.data.token;

  const normal = await createContractCase(token, '正常还款', '2026-08-01');
  const normalFirst = normal.detail.repaymentPlans[0];
  assert(normal.detail.contract.quotedMonthlyPaymentCents === 314288, '平息月供与真实样本不一致', normal.detail.contract);
  await call('payments.record', {
    contractId: normal.contractId,
    amountCents: normalFirst.scheduledAmountCents,
    lateFeeCents: 0,
    startTermNo: 1,
    receivedDateKey: '2026-08-01',
    notes: '云端验收：正常支付首期'
  }, token);
  const normalAfter = await call('customers.detail', { customerId: normal.customerId }, token);
  assert(normalAfter.repaymentPlans[0].status === 'paid', '正常还款后首期未结清', normalAfter.repaymentPlans[0]);

  const overdue = await createContractCase(token, '逾期还款', '2026-06-01');
  await call('payments.record', {
    contractId: overdue.contractId,
    amountCents: 150000,
    lateFeeCents: 10000,
    startTermNo: 1,
    receivedDateKey: '2026-08-01',
    notes: '云端验收：逾期部分还款，含100元滞纳金'
  }, token);
  const overdueAfter = await call('customers.detail', { customerId: overdue.customerId }, token);
  assert(overdueAfter.repaymentPlans[0].status === 'partial', '逾期部分还款未保留剩余款', overdueAfter.repaymentPlans[0]);
  const dashboard = await call('dashboard.list', { todayDateKey: '2026-08-01' }, token);
  const overdueRows = dashboard.overdue.filter(item => item.customerId === overdue.customerId);
  assert(overdueRows.length >= 2 && overdueRows.every(item => item.lateFeeCents > 0), '多期逾期或逐期滞纳金未正确生成', overdueRows);

  const settlementCase = await createContractCase(token, '中途结清', '2026-05-01');
  const firstThree = settlementCase.detail.repaymentPlans.slice(0, 3);
  const firstThreeTotal = firstThree.reduce((sum, item) => sum + item.scheduledAmountCents, 0);
  await call('payments.record', {
    contractId: settlementCase.contractId,
    amountCents: firstThreeTotal,
    lateFeeCents: 0,
    startTermNo: 1,
    receivedDateKey: '2026-08-01',
    notes: '云端验收：已还前三期'
  }, token);
  await call('deposits.record', {
    contractId: settlementCase.contractId,
    direction: 'in',
    amountCents: 200000,
    occurredDateKey: '2026-08-01',
    notes: '云端验收：押金独立记账'
  }, token);
  const settlement = await call('settlement.get', { contractId: settlementCase.contractId }, token);
  assert(settlement.contractSettlementCents === settlement.remainingPrincipalCents + settlement.remainingInterestCents, '结清金额构成不一致', settlement);
  assert(settlement.depositBalanceCents === 200000, '押金余额不正确', settlement);
  assert(settlement.totalIfDepositNotOffsetCents === settlement.contractSettlementCents, '押金错误参与默认结清金额', settlement);
  assert(settlement.totalIfDepositOffsetCents === settlement.contractSettlementCents - 200000, '押金抵扣备选金额不正确', settlement);

  const backup = await call('backup.export', {}, token);
  assert(backup.controlTotals.customers >= 3 && backup.checksum?.length === 64, '云端备份控制总数或校验和不正确', backup.controlTotals);

  console.log(JSON.stringify({
    ok: true,
    login: { forbiddenOrigin: forbidden.status, expiresInSeconds: login.result.data.expiresInSeconds },
    normalPayment: {
      customerId: normal.customerId,
      monthlyPaymentCents: normal.detail.contract.quotedMonthlyPaymentCents,
      firstTermStatus: normalAfter.repaymentPlans[0].status
    },
    overduePayment: {
      customerId: overdue.customerId,
      firstTermStatus: overdueAfter.repaymentPlans[0].status,
      overdueTerms: overdueRows.length,
      lateFeeCents: overdueRows.reduce((sum, item) => sum + item.lateFeeCents, 0)
    },
    settlement: {
      customerId: settlementCase.customerId,
      paidTerms: 3,
      remainingPrincipalCents: settlement.remainingPrincipalCents,
      remainingInterestCents: settlement.remainingInterestCents,
      contractSettlementCents: settlement.contractSettlementCents,
      depositBalanceCents: settlement.depositBalanceCents,
      totalIfDepositOffsetCents: settlement.totalIfDepositOffsetCents
    },
    backup: { controlTotals: backup.controlTotals, checksumLength: backup.checksum.length }
  }, null, 2));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, message: error.message, details: error.details || null }, null, 2));
  process.exit(1);
});
