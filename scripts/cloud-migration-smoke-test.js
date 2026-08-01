'use strict';

const apiUrl = process.env.DAJIN_API_URL;
const password = process.env.DAJIN_ADMIN_PASSWORD;
const origin = process.env.DAJIN_WEB_ORIGIN;

if (!apiUrl || !password || !origin) throw new Error('缺少云端验收环境变量。');

async function request(action, payload = {}, token = '') {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ action, payload })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${action}: ${result.error?.message || response.status}`);
  return result.data;
}

(async () => {
  const login = await request('web.auth.login', { password });
  const token = login.token;
  const backup = {
    app: '车辆还款管理工具',
    version: 1,
    plans: [{
      id: 'legacy-cloud-smoke-20260801',
      name: '【验收测试】旧网页迁移',
      plate: 'TEST-MIGRATION',
      vehicle: '迁移验收样本车（非真实客户）',
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
      notes: '2026-08-01 云端迁移验收数据。',
      payments: []
    }]
  };
  const preview = await request('migration.preview', { backup }, token);
  if (preview.status !== 'preview' || preview.summary.customers !== 1 || preview.summary.repaymentPlans !== 36) {
    throw new Error('迁移预览汇总不正确。');
  }
  const imported = await request('migration.import', { backup }, token);
  if (imported.status !== 'completed' || imported.results[0]?.status !== 'imported') {
    throw new Error('首次迁移导入失败。');
  }
  const duplicate = await request('migration.import', { backup }, token);
  if (duplicate.status !== 'duplicate') throw new Error('重复迁移没有被拦截。');
  const exported = await request('backup.export', {}, token);
  console.log(JSON.stringify({
    ok: true,
    preview: preview.summary,
    firstImport: imported.status,
    repeatedImport: duplicate.status,
    backupCustomers: exported.controlTotals.customers,
    checksumLength: exported.checksum.length
  }, null, 2));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, message: error.message }, null, 2));
  process.exit(1);
});
