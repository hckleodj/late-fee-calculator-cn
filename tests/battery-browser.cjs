'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const output=path.resolve(__dirname,'../output/battery-acceptance');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true,ignoreHTTPSErrors:true});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.clock.setFixedTime(new Date('2026-09-29T04:00:00Z'));
  await page.goto(process.env.BATTERY_TEST_URL||'http://127.0.0.1:8877');
  // User-driven JSON import on an empty, disposable context. Never seed the main key.
  await page.locator('[data-panel="customers"]').click();await page.locator('#open-backup').click();
  await page.locator('#backup-file').setInputFiles(path.join(__dirname,'fixtures/battery-demo.json'));
  await page.waitForFunction(()=>plans.length===1&&plans[0].id==='battery-demo');
  // Exercise the existing manual backup confirmation flow before business use.
  await page.locator('#export-backup').click();await page.locator('#confirm-backup-saved').click();await page.locator('#finish-backup-confirmation').click();await page.locator('#close-backup').click();
  await page.locator('[data-panel="reminders"]').click();
  await page.locator('[data-receive="battery-demo"]').first().click();
  await page.locator('#payment-date').fill('2026-09-26');await page.locator('#payment-total').fill('3500');
  assert.match(await page.locator('#allocation-preview').innerText(),/3,142.88/);assert.match(await page.locator('#allocation-preview').innerText(),/357.12/);
  await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].payments.length===1);
  let item=await page.evaluate(()=>installmentItem(plans[0],0));assert.equal(item.remaining,370.88);assert.equal(item.accruedLateFee,102.34);
  await page.screenshot({path:path.join(output,'partial-reminder.png')});
  await page.reload();await page.waitForFunction(()=>plans[0].payments.length===1);assert.equal(await page.evaluate(()=>plans[0].completedTerms),0);
  await page.locator('[data-receive="battery-demo"]').first().click();await page.locator('#payment-total').fill('370.88');await page.locator('#save-payment').click();
  await page.waitForFunction(()=>plans[0].completedTerms===1);
  assert.match(await page.locator('#overdue-list').innerText(),/102.34/);
  await page.locator('[data-receive="battery-demo"]').first().click();assert.equal(await page.locator('#payment-total').inputValue(),'102.34');
  await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].payments.length===3);
  assert.equal(await page.evaluate(()=>installmentItem(plans[0],0).total),0);
  // Backup file is actually downloaded; snapshot restore preserves component fields.
  await page.locator('[data-panel="customers"]').click();await page.locator('#open-backup').click();
  const downloadWait=page.waitForEvent('download');await page.locator('#export-backup').click();const download=await downloadWait;await download.saveAs(path.join(output,'battery-backup.json'));
  const backup=JSON.parse(fs.readFileSync(path.join(output,'battery-backup.json')));assert.equal(backup.plans[0].payments[0].batteryRent,357.12);
  await page.locator('#confirm-backup-saved').click();await page.locator('#finish-backup-confirmation').click();await page.locator('#close-backup').click();
  await page.locator('#open-backup').click();await page.locator('#open-local-snapshots').click();
  const snapshots=await page.evaluate(()=>localSnapshotManager.read()),partial=snapshots.find(s=>s.plans[0].payments.length===1);assert.ok(partial);
  await page.locator(`[data-view-snapshot="${partial.id}"]`).click();await page.locator('#restore-snapshot').click();await page.waitForFunction(()=>plans[0].payments.length===1);
  assert.equal(await page.evaluate(()=>plans[0].payments[0].batteryRent),357.12);await page.locator('#close-backup').click();
  await page.locator('.payment-history summary').first().click();await page.locator('[data-edit-payment]').first().click();
  await page.locator('#payment-total').fill('3400');await page.locator('#save-payment').click();await page.waitForFunction(()=>plans[0].payments[0].total===3400);
  assert.equal(await page.evaluate(()=>installmentItem(plans[0],0).remaining),470.88);
  await page.locator('.payment-history summary').first().click();await page.locator('[data-undo-payment]').first().click();await page.waitForFunction(()=>plans[0].payments.length===0);
  assert.equal(await page.evaluate(()=>plans[0].completedTerms),0);
  await page.locator('[data-edit-plan]').click();await page.locator('#battery-rent').fill('800');await page.locator('#battery-effective-term').fill('2');await page.locator('#save-plan').click();
  await page.waitForFunction(()=>plans[0].batteryMonthlyRent===800);assert.equal(await page.evaluate(()=>plans[0].batteryRentByTerm[0]),728);assert.equal(await page.evaluate(()=>plans[0].batteryRentByTerm[1]),800);
  // Customer preview and both downloads from the same immutable result, including prepaid periods.
  await page.locator('[data-panel="finance"]').click();
  for(const [id,value]of Object.entries({'rental-vehicle':'蔚来（虚构测试）','rental-customer':'虚构测试客户','car-price':'100000','term':'36','prepaid-months':'2','rental-deposit-months':'2','monthly-rate':'1','rental-battery-rent':'728','rental-first-date':'2026-09-29'}))await page.locator('#'+id).fill(value);
  const storageBefore=await page.evaluate(()=>JSON.stringify({...localStorage}));
  await page.locator('#rental-confirm').click();const result=await page.evaluate(()=>calculationResult);assert.equal(result.paymentSchedule[0].comprehensiveDueCents,72800);
  for(let i=0;i<36;i++){const cells=await page.locator('#rental-preview tbody tr').nth(i).locator('td').allTextContents();assert.equal(cells.length,7);assert.equal(cells[6],(result.paymentSchedule[i].comprehensiveDueCents/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}))}
  await page.screenshot({path:path.join(output,'mobile-confirmation.png')});
  for(const format of ['png','pdf']){const waiting=page.waitForEvent('download');await page.locator('#rental-'+format).click();await(await waiting).saveAs(path.join(output,'battery.'+format))}
  assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage})),storageBefore);assert.deepEqual(errors,[]);
  let unexpectedDownloads=0;page.on('download',()=>unexpectedDownloads++);
  await page.evaluate(()=>document.styleSheets[0].disabled=true);await page.locator('#rental-png').click();
  await page.waitForFunction(()=>document.getElementById('rental-export-status').textContent.includes('样式未完整加载'));assert.equal(unexpectedDownloads,0);await page.evaluate(()=>document.styleSheets[0].disabled=false);
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({partial:3500,remaining:370.88,fee:102.34,feeOnlyCollected:true,backupDownloaded:true,snapshotRestored:true,pngPdfDownloaded:true,errors},null,2));console.log('Battery browser acceptance passed');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
