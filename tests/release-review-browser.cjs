'use strict';
// Separate disposable browser context and fictional JSON import only.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const L=require('../installment-ledger.js'),{samplePlan}=require('./page-harness.js');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'));
  await page.goto(process.env.RENTAL_TEST_URL||'http://127.0.0.1:8877');
  const future=samplePlan({id:'review-future',name:'虚构生效期测试',amount:3142.88,vehiclePrice:91800,downPaymentRate:15,monthlyRate:1.25,loanAmount:78030,totalTerms:36,startDate:'2026-10-05',rate:.005,batteryMonthlyRent:728,batteryRentEffectiveTermIndex:0,batteryRentByTerm:Array(36).fill(728)});
  const fee=L.receive({...structuredClone(future),id:'review-fee',name:'虚构分段计费测试',startDate:'2026-01-05'},{id:'old-fee',date:'2026-01-10',total:96.77,lateFee:96.77,startTermIndex:0},'2026-09-30').copy;
  const legacy=samplePlan({id:'review-legacy',name:'虚构旧客户补录',completedTerms:1,payments:[{id:'old',date:'2026-08-05',total:4960,principal:4960,lateFee:0,allocations:[{termIndex:0,principal:4960}]}]});for(const k of ['vehiclePrice','downPaymentRate','monthlyRate','loanAmount'])delete legacy[k];
  await page.locator('[data-panel="customers"]').click();await page.locator('#open-backup').click();
  await page.locator('#backup-file').setInputFiles({name:'fictional-review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'大进车贷助手',version:1,plans:[future,fee,legacy]}))});
  await page.waitForFunction(()=>plans.length===3);await page.locator('#export-backup').click();await page.locator('#confirm-backup-saved').click();await page.locator('#finish-backup-confirmation').click();await page.locator('#close-backup').click();
  await page.locator('[data-edit-plan="review-future"]').click();await page.locator('#battery-effective-term').fill('3');await page.locator('#save-plan').click();
  await page.waitForFunction(()=>plans[0].batteryRentEffectiveTermIndex===2);assert.deepEqual(await page.evaluate(()=>plans[0].batteryRentByTerm.slice(0,3)),[0,0,728]);
  await page.reload();assert.deepEqual(await page.evaluate(()=>plans[0].batteryRentByTerm.slice(0,3)),[0,0,728]);
  await page.locator('[data-receive="review-fee"]').first().click();await page.locator('#payment-date').fill('2026-01-06');await page.locator('#payment-total').fill('1000');
  assert.match(await page.locator('#payment-error').innerText(),/2026-01-10.*后续已收滞纳金/);
  const before=await page.evaluate(()=>localStorage.getItem('lateFeePaymentPlansV1'));await page.locator('#save-payment').click();assert.equal(await page.evaluate(()=>localStorage.getItem('lateFeePaymentPlansV1')),before);await page.locator('#cancel-payment').click();
  await page.locator('[data-panel="customers"]').click();await page.locator('[data-edit-plan="review-legacy"]').click();
  for(const [id,value]of Object.entries({'contract-price':'120000','contract-down-rate':'20','contract-monthly-rate':'1','battery-rent':'728','battery-effective-term':'2'}))await page.locator('#'+id).fill(value);
  await page.locator('#save-plan').click();await page.waitForFunction(()=>plans[2].batteryMonthlyRent===728);
  const saved=await page.evaluate(()=>plans[2]);assert.equal(saved.amount,4960);assert.equal(saved.loanAmount,96000);assert.deepEqual(saved.payments,legacy.payments);assert.equal(saved.batteryRentByTerm[0],0);assert.equal(saved.batteryRentByTerm[1],728);
  assert.deepEqual(errors,[]);
  const out=path.resolve(__dirname,'../output/release-review');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify({initialScheduleCorrected:true,reloadPreserved:true,historicalOvercollectionRejected:true,failedSavePreservesData:true,legacyCompletionPreservesPayments:true,errors},null,2));
  console.log('Release review fixes: all three browser scenarios passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
