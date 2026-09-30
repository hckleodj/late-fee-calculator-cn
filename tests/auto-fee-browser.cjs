'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {samplePlan}=require('./page-harness.js');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'}),ctx=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),page=await ctx.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.clock.setFixedTime(new Date('2026-09-30T04:00:00Z'));await page.goto('http://127.0.0.1:8877/');
  const fixture=samplePlan({id:'auto-demo',name:'虚构自动收款测试',amount:3142.88,vehiclePrice:91800,downPaymentRate:15,monthlyRate:1.25,loanAmount:78030,totalTerms:36,startDate:'2026-09-25',dueDay:25,rate:.005,batteryMonthlyRent:728,batteryRentEffectiveTermIndex:0});
  await page.locator('[data-panel="customers"]').click();await page.locator('#open-backup').click();
  await page.locator('#backup-file').setInputFiles({name:'fictional-auto.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'大进车贷助手',version:1,plans:[fixture]}))});await page.waitForFunction(()=>plans.length===1);
  await page.locator('#export-backup').click();await page.locator('#confirm-backup-saved').click();await page.locator('#finish-backup-confirmation').click();await page.locator('#close-backup').click();
  await page.locator('[data-panel="reminders"]').click();await page.locator('[data-receive="auto-demo"]').first().click();
  assert.equal(await page.locator('input[name="payment-fee-mode"]').count(),0);
  await page.locator('#payment-total').fill('4000');assert.match(await page.locator('#allocation-preview').innerText(),/96.77/);assert.match(await page.locator('#allocation-preview').innerText(),/32.35/);await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].payments.length===1);
  assert.equal(await page.evaluate(()=>plans[0].payments[0].lateFee),96.77);
  await page.locator('[data-panel="customers"]').click();await page.locator('.payment-history summary').first().click();await page.locator('[data-undo-payment]').click();await page.waitForFunction(()=>plans[0].payments.length===0);
  await page.locator('[data-panel="reminders"]').click();await page.locator('[data-receive="auto-demo"]').first().click();await page.locator('#payment-total').fill('3500');await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].payments.length===1);
  await page.locator('[data-receive="auto-demo"]').first().click();let dialogMessage='';page.once('dialog',d=>{dialogMessage=d.message()});await page.locator('#payment-waiver').click();assert.match(dialogMessage,/全额付清/);assert.equal(await page.locator('#waiver-dialog').evaluate(e=>e.open),false);
  await page.locator('#payment-total').fill('370.88');await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].completedTerms===1);
  await page.locator('[data-receive="auto-demo"]').first().click();await page.locator('#payment-waiver').click();await page.locator('#waiver-amount').fill('100');await page.locator('#waiver-reason').fill('协商全免');await page.locator('#waiver-form button[type="submit"]').click();assert.match(await page.locator('#waiver-error').innerText(),/不能超过/);
  await page.locator('#waiver-amount').fill('96.77');await page.locator('#waiver-form button[type="submit"]').click();await page.waitForFunction(()=>plans[0].lateFeeWaivers?.length===1);assert.equal(await page.evaluate(()=>installmentItem(plans[0],0).total),0);assert.equal(await page.evaluate(()=>plans[0].payments.length),2);
  await page.reload();assert.equal(await page.evaluate(()=>plans[0].lateFeeWaivers[0].amount),96.77);assert.equal(await page.evaluate(()=>openInstallments(plans[0]).some(i=>i.termIndex===0)),false);
  await page.locator('[data-panel="customers"]').click();await page.locator('.payment-history summary').nth(1).click();
  const out=path.resolve(__dirname,'../output/auto-fee');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'waiver-mobile.png')});
  await page.locator('[data-reverse-waiver]').click();await page.waitForFunction(()=>plans[0].lateFeeWaivers[0].reversedAt);assert.equal(await page.evaluate(()=>installmentItem(plans[0],0).fee),96.77);
  await page.locator('#open-backup').click();const waiting=page.waitForEvent('download');await page.locator('#export-backup').click();await(await waiting).saveAs(path.join(out,'fictional-backup.json'));const backup=JSON.parse(fs.readFileSync(path.join(out,'fictional-backup.json')));assert.equal(backup.plans[0].lateFeeWaivers[0].reversedAt,'2026-09-30');
  assert.deepEqual(errors,[]);console.log('Automatic payment, waiver/reversal, refresh and downloaded backup passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
