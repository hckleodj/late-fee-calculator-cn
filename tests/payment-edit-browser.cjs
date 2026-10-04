'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),L=require('../installment-ledger'),{samplePlan}=require('./page-harness');
(async()=>{
 let fixture=samplePlan({amount:1000,totalTerms:2,startDate:'2026-01-05',rate:.01});
 for(const r of [{id:'target',date:'2026-02-10',total:1000,startTermIndex:1},{id:'older',date:'2026-02-20',total:1000,startTermIndex:0}])fixture=L.receive(fixture,r,'2026-09-30').copy;
 for(const i of [0,1])fixture=L.waive(fixture,{id:`w-${i}`,termIndex:i,amount:L.statement(fixture,'2026-02-21')[i].remainingLateFee,reason:'虚构全免',date:'2026-02-21'},'2026-09-30');
 Object.assign(fixture.payments[0],L.channelCost(1000,'WECHAT',2));fixture.payments[0].notes='历史备注保留';
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  // All storage and interaction are on a local isolated origin; cloud SDK is blocked.
  await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.hostname!=='127.0.0.1')return r.abort();const file=require('node:path').resolve(__dirname,'..','.'+(u.pathname==='/'?'/index.html':u.pathname));await r.fulfill({path:file});});
  await page.addInitScript(f=>{if(!localStorage.getItem('lateFeePaymentPlansV1')){localStorage.setItem('lateFeePaymentPlansV1',JSON.stringify([f]));localStorage.setItem('dajinBackupStateV1',JSON.stringify({lastBackupAt:new Date().toISOString(),lastDataChangeAt:new Date().toISOString(),dirtySinceBackup:false,backupVersion:1,dataRevision:4,lastBackedUpRevision:4,lastBackupHash:'test-fixture',lastBackupMethod:'isolated-test'}));}},fixture);
  await page.goto('http://127.0.0.1:8879/');
  await page.evaluate(async f=>{plans=[f];savePlans();await businessChangePending;renderPlanModule();openPaymentDialog(f.id,1,'target')},fixture);
  assert.equal(await page.locator('#payment-error').innerText(),'');
  await page.locator('#payment-channel').selectOption('CCB');await page.locator('#payment-channel-fee').fill('3.25');
  assert.equal(await page.locator('#payment-error').innerText(),'');assert.equal(await page.locator('#payment-net-received').innerText(),'996.75 元');
  await page.locator('#save-payment').click();assert.equal(await page.locator('#payment-error').innerText(),'');await page.waitForFunction(()=>!document.getElementById('payment-dialog').open);
  const after=await page.evaluate(()=>plans[0]);const expected=structuredClone(fixture);Object.assign(expected.payments[0],L.channelCost(1000,'CCB',3.25));assert.deepEqual(after,expected);
  await page.reload();assert.deepEqual(await page.evaluate(()=>plans[0]),expected);
  await page.evaluate(()=>openPaymentDialog(plans[0].id,1,'target'));await page.locator('#payment-date').fill('2026-02-09');await page.locator('#save-payment').click();assert.match(await page.locator('#payment-error').innerText(),/减免/);assert.deepEqual(await page.evaluate(()=>plans[0]),expected);
  assert.deepEqual(errors,[]);console.log('PASS: mobile browser channel/fee edit, full snapshot equality, reload and accounting-change guard');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
