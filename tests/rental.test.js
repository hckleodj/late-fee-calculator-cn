'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const engine = require('../rental-calculation.js');
const document = require('../rental-document.js');
const { buildPage } = require('./page-harness.js');
const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const pricing = vm.runInNewContext(`${source.slice(source.indexOf('  function monthlyPayment('), source.indexOf('  function updateFinanceMethodNote('))};({monthlyPayment,principalFromPayment,repaymentTotals})`);
const draft = { mode: 'quote', vehicleAmount: '100000', terms: '36', ratePct: '1', prepaidMonths: '0', depositMonths: '2', firstDate: '2026-12-31', vehicle: '虚构测试车辆', customer: '测试客户' };
const calc = overrides => engine.calculate({ ...draft, ...overrides }, pricing);
test('mutable rental assets carry current content hashes to invalidate old cached scripts', () => {
  for(const file of ['installment-ledger.js','rental-calculation.js','rental-document.js','rental-export.js','rental-document.css']) {
    const hash=createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',file))).digest('hex').slice(0,12);
    assert.ok(source.includes(`./${file}?v=${hash}"`),`${file} cache version must match current contents`);
  }
});
test('reported input: 200000 / 36 terms / 1 percent / five prepaid months', async () => {
  const page=await buildPage({search:''});
  for(const [id,value] of Object.entries({'car-price':'200000',term:'36','monthly-rate':'1','prepaid-months':'5','rental-deposit-months':'2','rental-first-date':'2026-09-29'}))page.getElement(id).value=value;
  vm.runInContext('calculateFinance()',page.context);
  assert.equal(page.getElement('finance-error').textContent,'');
  assert.equal(page.getElement('rental-results').hidden,false);
  assert.equal(vm.runInContext('calculationResult.fixedMonthlyCents',page.context),755556);
  assert.equal(vm.runInContext('paymentSchedule.slice(0,5).every(row=>row.dueCents===0)',page.context),true);
  assert.equal(vm.runInContext('paymentSchedule[5].dueCents',page.context),755556);
});
function invariants(result) {
  const sum = key => result.paymentSchedule.reduce((total, row) => total + row[key], 0);
  assert.equal(result.paymentSchedule.length, result.terms);
  assert.equal(sum('plannedCents'), result.totalRentCents);
  assert.equal(sum('offsetCents'), result.prepaidCents);
  assert.equal(sum('dueCents'), result.outstandingCents);
  assert.equal(sum('dueCents') + result.prepaidCents, result.totalRentCents);
  let remaining = result.totalRentCents;
  for (const row of result.paymentSchedule) {
    remaining -= row.plannedCents;
    assert.equal(row.remainingCents, remaining);
    assert.equal(row.plannedCents - row.offsetCents, row.dueCents);
    for (const key of ['plannedCents','offsetCents','dueCents','remainingCents']) assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
  }
  assert.equal(result.paymentSchedule.at(-1).remainingCents, 0);
}
test('A: zero prepaid / 36 terms / total 136000 and final tail correction', () => {
  const result = calc(); invariants(result);
  assert.equal(result.fixedMonthlyCents, 377778);
  assert.equal(result.totalRentCents, 13600000);
  assert.equal(result.paymentSchedule.at(-1).plannedCents, 377770);
  assert.equal(result.tailAdjustmentCents, -8);
});
test('B: prepaid covering exactly two periods does not change monthly rent', () => {
  const result = calc({ prepaidMonths: '2' }); invariants(result);
  assert.equal(result.fixedMonthlyCents, calc().fixedMonthlyCents);
  assert.deepEqual(result.paymentSchedule.slice(0, 3).map(row => row.dueCents), [0,0,377778]);
});
test('C: three prepaid months and two deposit months use fixed monthly rent', () => {
  const result = calc({ prepaidMonths: '3', depositMonths: '2' }); invariants(result);
  assert.equal(result.prepaidCents, 1133334);
  assert.equal(result.depositCents, 755556);
  assert.deepEqual(result.paymentSchedule.slice(0,4).map(row => row.dueCents), [0,0,0,377778]);
  assert.equal(calc({depositMonths:'0'}).fixedMonthlyCents,result.fixedMonthlyCents);
});
test('D: year rollover, Jan 31, leap year and return to original date', () => {
  const result = calc(); invariants(result);
  assert.deepEqual(result.paymentSchedule.slice(0,5).map(row => row.dueDate), ['2026-12-31','2027-01-31','2027-02-28','2027-03-31','2027-04-30']);
  assert.equal(result.paymentSchedule[14].dueDate, '2028-02-29');
  assert.equal(engine.dueDate('2028-02-29', 12), '2029-02-28');
  assert.equal(engine.dueDate('2027-01-30', 2), '2027-03-30');
});
test('all prepaid, zero fee, 1/24/60/120 terms and 1000 varying cases conserve every cent', () => {
  for (const terms of ['1','24','60','120']) {
    const result=calc({ terms, ratePct:'0' });invariants(result);
    const paid=calc({terms,ratePct:'0',prepaidMonths:terms});invariants(paid);assert.ok(paid.paymentSchedule.every(row=>row.dueCents===0));
  }
  for(let index=1;index<=1000;index++) {
    const input={vehicleAmount:(1000+index*7.13).toFixed(2),terms:String(index%120+1),ratePct:(index%100/100).toFixed(2),prepaidMonths:String(index%(index%120+2))};
    invariants(calc(input));
  }
});
test('reject invalid, overpaid, negative, unsafe, excessive precision and impossible dates', () => {
  for (const bad of [{prepaidMonths:'37'},{prepaidMonths:'-1'},{prepaidMonths:'0.5'},{depositMonths:''},{depositMonths:'2.5'},{depositMonths:'121'},{vehicleAmount:'0'},{vehicleAmount:'100000001'},{vehicleAmount:'1.005'},{terms:'1.5'},{terms:'121'},{ratePct:'NaN'},{ratePct:'101'},{firstDate:'2027-02-29'},{firstDate:'2026-13-01'},{firstDate:''},{vehicleAmount:'0.01',terms:'120'}]) assert.throws(()=>calc(bad));
});
test('decimal precision never rounds twice across the half-cent boundary', () => {
  assert.equal(calc({vehicleAmount:'0.01',terms:'1',ratePct:'49.999999'}).totalRentCents,1);
  assert.equal(calc({vehicleAmount:'0.01',terms:'1',ratePct:'50'}).totalRentCents,2);
});
test('budget inversion is full scheme amount and never depends on prepaid', () => {
  const result=calc({mode:'reverse',target:'4500'});invariants(result);
  assert.equal(result.vehicleAmountCents,11911764);
  assert.ok(result.fixedMonthlyCents<=450000);
  assert.equal(calc({mode:'reverse',target:'4500',prepaidMonths:'3'}).vehicleAmountCents,result.vehicleAmountCents);
});
test('customer allowlist, escaping, PDF pagination and all 120 rows preserved', () => {
  const result={...calc({terms:'120',vehicle:'<img src=x onerror=alert(1)>',customer:'<script>hi</script>',phone:'13800000000'}),schemeId:'HK-test'};
  const data=document.customerData(result);
  assert.equal(data.ratePct,undefined);assert.equal(data.vehicleAmountCents,undefined);assert.equal(data.feeCents,undefined);assert.equal(data.phone,undefined);
  for(const key of ['totalRentCents','outstandingCents','prepaidCents','depositCents'])assert.equal(data[key],undefined);
  assert.ok(data.paymentSchedule.every(row=>row.remainingCents===undefined));
  const html=document.documentHtml(data),pages=document.pdfPages(data);
  assert.equal(pages.length,4);assert.equal((pages.join('').match(/data-term=/g)||[]).length,120);
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
  for(const word of ['还款本金','还款利息','剩余本金','贷款年利率','贷款余额','本息合计','月费率','总额','合计','剩余']) assert.ok(!html.includes(word));
  assert.ok(pages.every(page=>page.includes('车辆租赁付款计划确认单')));
  for(const output of [html,pages.join(''),document.text(data),document.meta(data),document.table(data)]) for(const word of ['总额','合计','剩余']) assert.ok(!output.includes(word));
});
test('new quote, confirmation, input invalidation and copy never write customer or backup data', async () => {
  const page=await buildPage({search:''}),before=JSON.stringify([...page.storage.values]);
  const fields={'car-price':'100000',term:'36','monthly-rate':'1','prepaid-months':'3','rental-deposit-months':'2','rental-first-date':'2026-12-31','rental-vehicle':'测试车型','rental-customer':'测试客户'};
  for(const [id,value] of Object.entries(fields))page.getElement(id).value=value;
  vm.runInContext('calculateFinance();openRentalConfirmation()',page.context);
  assert.equal(page.getElement('rental-dialog').open,true);
  assert.equal(vm.runInContext('calculationResult.totalRentCents',page.context),13600000);
  const scheme=vm.runInContext('calculationResult.schemeId',page.context);
  vm.runInContext('calculateFinance()',page.context);
  assert.equal(vm.runInContext('calculationResult.schemeId',page.context),scheme);
  page.getElement('prepaid-months').value='200000';vm.runInContext('calculateFinance()',page.context);
  assert.equal(vm.runInContext('calculationResult',page.context),null);
  assert.equal(page.getElement('rental-dialog').open,false);
  assert.equal(page.getElement('rental-results').hidden,true);
  assert.equal(page.getElement('rental-preview').innerHTML,'');
  assert.equal(JSON.stringify([...page.storage.values]),before);
});

test('full-term prepayment includes positive and negative final rounding adjustments', () => {
  for(const terms of ['36','120']) {
    const result=calc({terms,prepaidMonths:terms});invariants(result);
    assert.equal(result.prepaidCents,result.totalRentCents);
    assert.ok(result.paymentSchedule.every(row=>row.dueCents===0));
  }
});
