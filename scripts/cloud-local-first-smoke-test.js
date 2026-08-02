'use strict';

const apiUrl = process.env.DAJIN_API_URL
  || 'https://dajin-car-loan-v09-d5c3yb395b1ee-1461974653.ap-shanghai.app.tcloudbase.com/api';
const origin = process.env.DAJIN_WEB_ORIGIN
  || 'https://dajin-car-loan-v09-d5c3yb395b1ee-1461974653.tcloudbaseapp.com';

function readSecret() {
  if (process.env.DAJIN_ADMIN_PASSWORD) return Promise.resolve(process.env.DAJIN_ADMIN_PASSWORD);
  if (!process.stdin.isTTY) throw new Error('缺少 DAJIN_ADMIN_PASSWORD。');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write('管理员密码：');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const finish = error => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    process.stdin.on('data', chunk => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('已取消。'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f') value = value.slice(0, -1);
        else value += character;
      }
    });
  });
}

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
  if (!response.ok || !result.ok) {
    const error = new Error(result.error?.message || `HTTP ${response.status}`);
    error.code = result.error?.code;
    throw error;
  }
  return result.data;
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

(async () => {
  const password = await readSecret();
  const login = await request('web.auth.login', { password });
  const token = login.token;
  const stamp = Date.now();
  const planId = `smoke-lite-${stamp.toString(36)}`;
  const upsertOpId = `smoke:${stamp}:upsert`;
  const deleteOpId = `smoke:${stamp + 1}:delete`;
  const initial = await request('sync.pull', {}, token);
  let created = false;
  try {
    const plan = {
      id: planId,
      name: '【同步验收】虚拟客户',
      plate: 'TEST-SYNC',
      vehicle: '同步验收车辆',
      vehiclePrice: 91800,
      downPaymentRate: 15,
      depositMonths: 1,
      monthlyRate: 1.25,
      loanAmount: 78030,
      amount: 3142.88,
      dueDay: 5,
      rate: 0.005,
      startDate: '2026-08-01',
      totalTerms: 36,
      completedTerms: 0,
      openingCompletedTerms: 0,
      notes: '自动验收数据，完成后删除。',
      payments: []
    };
    const pushed = await request('sync.push', { operations: [{
      opId: upsertOpId,
      type: 'plan.upsert',
      planId,
      changedAt: stamp,
      plan
    }] }, token);
    created = true;
    assert(pushed.acknowledgedOpIds.includes(upsertOpId), '云端没有确认写入操作。');
    const afterPush = await request('sync.pull', {}, token);
    assert(afterPush.plans.some(item => item.id === planId), '拉取结果中没有刚写入的虚拟客户。');
  } finally {
    if (created) {
      await request('sync.push', { operations: [{
        opId: deleteOpId,
        type: 'plan.delete',
        planId,
        changedAt: stamp + 1
      }] }, token);
    }
  }
  const final = await request('sync.pull', {}, token);
  assert(!final.plans.some(item => item.id === planId), '虚拟客户清理失败。');
  console.log(JSON.stringify({
    ok: true,
    initializedBefore: initial.initialized,
    planCountBefore: initial.plans.length,
    planCountAfterCleanup: final.plans.length,
    revisionAfterCleanup: final.revision,
    testRecordRemoved: true
  }, null, 2));
})().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'ERROR', message: error.message }, null, 2));
  process.exitCode = 1;
});
