'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const L=require('../installment-ledger.js'),R=require('../rental-calculation.js'),D=require('../rental-document.js');
const {buildPage,samplePlan,fillPlan,MemoryStorage}=require('./page-harness.js');
const plan=(extra={})=>samplePlan({amount:3142.88,vehiclePrice:91800,downPaymentRate:15,monthlyRate:1.25,loanAmount:78030,totalTerms:36,startDate:'2026-01-05',dueDay:5,rate:.005,batteryMonthlyRent:728,batteryRentEffectiveTermIndex:0,...extra});
const receipt=(p,total,date='2026-01-10',fee=0,start=0,id='p1')=>L.receive(p,{id,date,total,lateFee:fee,startTermIndex:start},'2026-09-29').copy;
const row=(p,date='2026-01-10',i=0)=>L.statement(p,date)[i];
test('battery optional; input validation rejects negative, null, infinity, precision and invalid periods',()=>{
  const p=plan();delete p.batteryMonthlyRent;delete p.batteryRentEffectiveTermIndex;
  assert.equal(row(p).baseDue,3142.88);assert.equal(row(plan()).baseDue,3870.88);
  for(const v of [-1,null,Infinity,NaN,1.001,'',true])assert.equal(L.validate(plan({batteryMonthlyRent:v})),false);
  for(const v of [-1,36,.5])assert.equal(L.validate(plan({batteryRentEffectiveTermIndex:v})),false);
});
test('3500 pays contract first, battery 357.12, remaining 370.88; period stays open',()=>{
 const p=receipt(plan(),3500),r=row(p);assert.equal(p.completedTerms,0);assert.equal(r.contractRentPaid,3142.88);assert.equal(r.batteryRentPaid,357.12);assert.equal(r.batteryRentRemaining,370.88);assert.equal(p.payments[0].principal,3142.88);assert.equal(p.payments[0].batteryRent,357.12);assert.ok(L.validate(p));
});
test('full base payment completes base period but keeps accrued fee pending, collectible independently',()=>{
 let p=receipt(plan(),3870.88);assert.equal(p.completedTerms,1);assert.equal(row(p).remaining,0);assert.equal(row(p).accruedLateFee,96.77);
 p=receipt(p,96.77,'2026-01-11',96.77,0,'fee');assert.equal(row(p,'2026-01-11').totalDue,0);assert.equal(p.completedTerms,1);assert.equal(p.payments[1].principal,0);assert.equal(p.payments[1].allocations[0].lateFee,96.77);assert.ok(L.validate(p));
});
test('segmented fee: five days on 3870.88 then three on 370.88 = 102.3352 rounded 102.34',()=>{
 const p=receipt(plan(),3500),r=row(p,'2026-01-13');assert.equal(r.accruedLateFee,102.34);assert.deepEqual(r.segments.map(s=>[s.base,s.days]),[[3870.88,5],[370.88,3]]);assert.equal(row(p,'2026-01-09').remaining,3870.88);assert.equal(row(p).accruedLateFee,96.77);
});
test('due date, early payments, same-day multiple receipts and future-date rejection',()=>{
 assert.equal(row(receipt(plan(),3870.88,'2026-01-05')).accruedLateFee,0);
 assert.equal(row(receipt(plan(),3870.88,'2026-01-01')).accruedLateFee,0);
 let p=receipt(plan(),2000);p=receipt(p,1500,'2026-01-10',0,0,'p2');assert.equal(row(p,'2026-01-13').accruedLateFee,102.34);
 assert.throws(()=>receipt(plan(),1,'2027-01-01'),/晚于今天/);assert.throws(()=>receipt(plan(),1,'2026-02-30'),/日期无效/);
});
test('multiple periods: finish current battery before next contract; exact component conservation',()=>{
 const p=receipt(plan(),7370.88),a=p.payments[0].allocations;assert.deepEqual(a,[{termIndex:0,principal:3142.88,batteryRent:728},{termIndex:1,principal:3142.88,batteryRent:357.12}]);assert.equal(p.completedTerms,1);assert.equal(p.payments[0].principal,6285.76);assert.equal(p.payments[0].batteryRent,1085.12);assert.ok(L.validate(p));
});
test('receipt with fee splits fee explicitly, subtracts only paid fee and rejects excess',()=>{
 const p=receipt(plan(),3550,'2026-01-10',50),r=row(p,'2026-01-13');assert.equal(r.paidLateFee,50);assert.equal(r.remainingLateFee,52.34);assert.equal(r.remaining,370.88);assert.equal(r.totalDue,423.22);assert.ok(L.validate(p));assert.throws(()=>receipt(plan(),500,'2026-01-10',500),/超过/);
});
test('multiple fee periods allocate oldest eligible fee first',()=>{
 const p=receipt(plan(),1000,'2026-03-10',1000);const a=p.payments[0].allocations;assert.equal(a[0].lateFee,1000);assert.equal(a[0].principal,0);assert.equal(row(p,'2026-03-10').paidLateFee,1000);
});
test('legacy receipt allocations stay identical when a new receipt is added, edited, or undone',()=>{
 const old={id:'old',date:'2026-01-06',total:3200,lateFee:0,principal:3200,startTermIndex:0,allocations:[{termIndex:0,principal:3142.88},{termIndex:1,principal:57.12}]};
 const initial=plan({payments:[old],completedTerms:1,openingCompletedTerms:0});
 let p=receipt(initial,100,'2026-01-10',0,0,'new');assert.deepEqual(p.payments[0],old);assert.equal(p.payments[1].batteryRent,100);
 p=receipt(p,200,'2026-01-10',0,0,'new');assert.deepEqual(p.payments[0],old);assert.equal(row(p).batteryRentPaid,200);
 p.payments=p.payments.filter(x=>x.id!=='new');L.recompute(p);assert.deepEqual(p.payments[0],old);assert.equal(row(p).batteryRentRemaining,728);assert.equal(p.completedTerms,0);
});
test('legacy paid late fee is credited without modifying old receipt, overpayment remains visible credit',()=>{
 const legacy={id:'old',date:'2026-01-10',total:4000,lateFee:129.12,principal:3870.88,startTermIndex:0,allocations:[{termIndex:0,principal:3870.88}]};
 const p=plan({amount:3870.88,batteryMonthlyRent:0,payments:[legacy]}),before=JSON.stringify(p);
 const r=row(p);assert.equal(r.paidLateFee,129.12);assert.equal(r.remainingLateFee,0);assert.equal(r.lateFeeCredit,32.35);assert.equal(JSON.stringify(p),before);
});
test('effective periods and per-term schedule preserve completed and future prepaid periods',()=>{
 const old=plan({batteryMonthlyRent:0,completedTerms:2,openingCompletedTerms:2}),p=structuredClone(old);L.configure(p,old,728,2);assert.equal(L.battery(p,1),0);assert.equal(L.battery(p,2),72800);
 const paid=receipt(p,3870.88,'2026-03-05',0,2),updated=structuredClone(paid);L.configure(updated,paid,800,3);assert.equal(L.battery(updated,2),72800);assert.equal(L.battery(updated,3),80000);assert.throws(()=>L.configure(updated,paid,800,2),/历史期/);
 const partial=receipt(plan(),3500);assert.throws(()=>L.configure(structuredClone(partial),partial,800,0),/已有收款/);
 const forward=structuredClone(partial);L.configure(forward,partial,800,1);assert.equal(L.battery(forward,0),72800);assert.equal(L.battery(forward,1),80000);
});
test('initial backfill supports partial legacy contract receipt without reassigning it',()=>{
 const old=plan({batteryMonthlyRent:0,payments:[{id:'old',date:'2026-01-10',total:3000,principal:3000,lateFee:0,allocations:[{termIndex:0,principal:3000}]}]});const p=structuredClone(old);L.configure(p,old,728,0);assert.deepEqual(p.payments,old.payments);assert.equal(row(p).remaining,870.88);
});
test('new records reject component sum tampering, invalid term, unsupported schema',()=>{
 const p=receipt(plan(),3500);for(const mutate of [p=>p.payments[0].principal++,p=>p.payments[0].allocations[0].batteryRent++,p=>p.payments[0].allocations[0].termIndex=99,p=>p.payments[0].allocationVersion=3]){const bad=structuredClone(p);mutate(bad);assert.equal(L.validate(bad),false)}
});
test('random receipts conserve cents and never pay battery before same-term contract',()=>{
 let p=plan({rate:0,totalTerms:12});let remaining=387088*12,totalPaid=0;
 for(let i=0;remaining>0;i++){const n=Math.min(remaining,1+(i*7919+53)%800000);p=receipt(p,n/100,'2026-01-01',0,0,'r'+i);remaining-=n;totalPaid+=n;assert.ok(L.validate(p));for(let j=0;j<12;j++){const b=L.base(p,j);assert.ok(!b.batteryPaid||b.contractRemaining===0)}assert.equal(p.payments.reduce((n,r)=>n+L.cents(r.total),0),totalPaid)}assert.equal(p.completedTerms,12);
});
test('page: battery save changes revision/hash/snapshot; backup and restore keep all fields',async()=>{
 const h=await buildPage(),run=s=>vm.runInContext(s,h.context);fillPlan(h.getElement,{'plan-id':'customer-existing','customer-name':'虚构租电客户','contract-price':'120000','contract-down-rate':'20','contract-monthly-rate':'1','total-terms':'24','battery-rent':'728','battery-effective-term':'1'});
 await h.getElement('plan-form').dispatch('submit');await run('businessChangePending');assert.equal(h.context.lastAlert,undefined);
 const stored=JSON.parse(h.storage.getItem('lateFeePaymentPlansV1'));assert.equal(stored[0].batteryMonthlyRent,728);assert.equal(stored[0].batteryRentByTerm.length,24);
 assert.equal(run('backupStateManager.snapshot().dataRevision'),5);assert.equal(run('backupStateManager.snapshot().dirtySinceBackup'),true);
 const artifact=await run('createBackupArtifact("download")');assert.equal(artifact.payload.plans[0].batteryMonthlyRent,728);assert.notEqual(artifact.hash,await require('../backup-state.js').sha256Text(h.originalRaw));
 const snapshots=run('localSnapshotManager.read()');assert.equal(snapshots.at(-1).plans[0].batteryMonthlyRent,728);
 run('plans[0].batteryMonthlyRent=800;plans[0].batteryRentByTerm.fill(800);savePlans()');await run('businessChangePending');h.context.restoreData=artifact.payload.plans;run('restoreImportedPlans(restoreData,"测试")');await run('businessChangePending');assert.equal(run('plans[0].batteryMonthlyRent'),728);
 const reopened=await buildPage({storage:h.storage});assert.equal(vm.runInContext('plans[0].batteryMonthlyRent',reopened.context),728);
});
test('page: settlement excludes battery, fee-only reminder persists after completedTerms advances',async()=>{
 const h=await buildPage(),run=s=>vm.runInContext(s,h.context);h.context.fixture=receipt(plan(),3500);run('plans=[fixture]');
 const a=run('settlementBreakdown(plans[0])');const contract=run('contractData(plans[0])');assert.ok(Math.abs(a.paidPrincipal-contract.monthlyPrincipal)<.00001);assert.ok(Math.abs(a.paidInterest-contract.monthlyInterest)<.00001);
 h.context.fixture=receipt(plan(),3870.88);run('plans=[fixture]');assert.equal(run('plans[0].completedTerms'),1);assert.equal(run('openInstallments(plans[0])[0].termIndex'),0);assert.match(run('overdueAccountMessage(overdueAccount(plans[0]))'),/月租电费：728.00元/);assert.match(run('overdueAccountMessage(overdueAccount(plans[0]))'),/剩余未收滞纳金/);
});
test('page: no battery leaves legacy reminder format without meaningless zero charge',async()=>{
 const h=await buildPage(),run=s=>vm.runInContext(s,h.context);assert.doesNotMatch(run('reminderMessage(installmentItem(plans[0],0),"today")'),/租电/);assert.equal(h.storage.getItem('lateFeePaymentPlansV1'),h.originalRaw);
});
test('quote preserves pricing, prepayment, final tail; customer documents show separate charge',async()=>{
 const h=await buildPage(),pricing=vm.runInContext('({monthlyPayment,principalFromPayment,repaymentTotals})',h.context),draft={mode:'quote',vehicleAmount:'100000',terms:'36',ratePct:'1',prepaidMonths:'2',depositMonths:'2',firstDate:'2026-01-31',vehicle:'虚构蔚来'};
 const old=R.calculate(draft,pricing),r=R.calculate({...draft,batteryMonthlyRent:728},pricing);for(const k of ['fixedMonthlyCents','totalRentCents','prepaidCents','depositCents','feeCents','outstandingCents','vehicleAmountCents'])assert.equal(r[k],old[k]);
 r.paymentSchedule.forEach((row,i)=>{assert.equal(row.dueCents,old.paymentSchedule[i].dueCents);assert.equal(row.comprehensiveDueCents,row.dueCents+72800)});assert.equal(r.paymentSchedule[0].comprehensiveDueCents,72800);
 const data=D.customerData(r);assert.match(D.text(data),/月租电费：728.00/);assert.match(D.table(data),/综合应付/);assert.match(D.pdfPages(data)[0],/728.00/);assert.doesNotMatch(D.documentHtml(data),/内部月费率|剩余本金/);
});
test('independent daily oracle matches segmented fees across unordered and same-day receipts',()=>{
 let seed=173;const rand=max=>{seed=(seed*16807)%2147483647;return seed%max};
 for(let c=0;c<100;c++){
  const p=plan({totalTerms:1,rate:.005}),events=[];let capacity=387088;
  for(let j=0;j<6;j++){const n=Math.min(capacity,rand(100000));capacity-=n;const d=1+rand(25);events.push({day:d,amount:n});p.payments.push({id:'p'+j,date:`2026-01-${String(d).padStart(2,'0')}`,total:n/100,principal:n/100,lateFee:0,allocations:[{termIndex:0,principal:n/100}]})}
  let weighted=0;for(let d=6;d<=29;d++)weighted+=Math.max(0,387088-events.filter(e=>e.day<d).reduce((n,e)=>n+e.amount,0));
  assert.equal(L.accrued(p,0,L.day('2026-01-29')).cents,Math.floor((weighted+100)/200));
 }
});
test('legacy fee term attribution freezes before later additions and reversals',()=>{
 const old={id:'old',date:'2026-02-10',total:1000,principal:0,lateFee:1000,startTermIndex:0,allocations:[]};
 const p=plan({payments:[old]});const next=receipt(p,100,'2026-02-11',0,0,'new');assert.deepEqual(next.payments[0],old);assert.equal(next.legacyLateFeeAllocations.old.reduce((n,a)=>n+a.lateFee,0),1000);
 const frozen=JSON.stringify(next.legacyLateFeeAllocations);L.freezeLegacyFees(next);assert.equal(JSON.stringify(next.legacyLateFeeAllocations),frozen);assert.ok(L.validate(next));
});
test('backdated payment cannot invalidate a later collected fee',()=>{
 const p=receipt(plan(),96.77,'2026-01-10',96.77);assert.throws(()=>receipt(p,3870.88,'2026-01-06',0,0,'backdated'),/后续已收滞纳金/);
});
test('future fully-paid term keeps its old battery price when changing earlier unpaid periods',()=>{
 const p=receipt(plan(),3870.88,'2026-01-01',0,2),q=structuredClone(p);L.configure(q,p,800,0);assert.equal(L.battery(q,0),80000);assert.equal(L.battery(q,2),72800);
});
test('precise half-cent late fee rounding uses decimal rate',()=>{
 const p=plan({amount:1,batteryMonthlyRent:0,totalTerms:1,rate:.005});assert.equal(row(p,'2026-01-06').accruedLateFee,.01);
});
test('editing a fee receipt changes only that receipt; failed edit does not mutate inputs',()=>{
 let p=receipt(plan(),3550,'2026-01-10',50);const before=JSON.stringify(p);assert.throws(()=>receipt(p,4000,'2026-01-10',1000,0,'p1'));assert.equal(JSON.stringify(p),before);
 p=receipt(p,3520,'2026-01-10',20,0,'p1');assert.equal(p.payments.length,1);assert.equal(row(p).remainingLateFee,76.77);assert.equal(row(p).remaining,370.88);
});
test('undo last legacy receipt preserves opening balance inference and reopens the period',()=>{
 const p=plan({completedTerms:1,payments:[{id:'old',date:'2026-01-05',total:3870.88,principal:3870.88,lateFee:0,allocations:[{termIndex:0,principal:3142.88,batteryRent:728}]}]});delete p.openingCompletedTerms;
 const restored=L.undo(p,'old');assert.equal(restored.completedTerms,0);assert.equal(restored.openingCompletedTerms,0);assert.equal(row(restored).remaining,3870.88);
});
test('undo fee receipt restores fee only, leaving base completion and other allocations unchanged',()=>{
 let p=receipt(plan(),3870.88);p=receipt(p,96.77,'2026-01-11',96.77,0,'fee');const q=L.undo(p,'fee');assert.equal(q.completedTerms,1);assert.equal(row(q,'2026-01-11').remainingLateFee,96.77);assert.deepEqual(q.payments[0],p.payments[0]);
});
