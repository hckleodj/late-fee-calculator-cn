'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const L=require('../installment-ledger.js');
const {buildPage,samplePlan}=require('./page-harness.js');
const base=()=>samplePlan({amount:3142.88,vehiclePrice:91800,downPaymentRate:15,monthlyRate:1.25,loanAmount:78030,totalTerms:36,startDate:'2026-10-05',dueDay:5,rate:.005,batteryMonthlyRent:728,batteryRentEffectiveTermIndex:0,batteryRentByTerm:Array(36).fill(728)});
const at='2026-09-30';
async function form(fixture,values={}){
 const h=await buildPage();h.context.fixture=fixture;
 const run=s=>vm.runInContext(s,h.context);
 run('todayNoon=()=>new Date(2026,8,30,12);plans=[fixture];editPlan(fixture.id)');
 for(const [id,value] of Object.entries(values))h.getElement(id).value=value;
 await h.getElement('plan-form').dispatch('submit');await run('businessChangePending');return {...h,run};
}
test('review 1: defer unstarted initial battery schedule to term 3 without charging terms 1-2',async()=>{
 const p=base(),h=await form(p,{'battery-effective-term':'3'});
 assert.equal(h.context.lastAlert,undefined);
 const saved=JSON.parse(h.storage.getItem('lateFeePaymentPlansV1'))[0];
 assert.equal(saved.batteryRentEffectiveTermIndex,2);assert.deepEqual(saved.batteryRentByTerm.slice(0,4),[0,0,728,728]);
 assert.equal(L.statement(saved,'2026-10-05')[0].baseDue,3142.88);assert.equal(L.statement(saved,'2026-12-05')[2].baseDue,3870.88);
 assert.equal(h.run('backupStateManager.snapshot().dataRevision'),5);assert.equal(h.run('backupStateManager.snapshot().dirtySinceBackup'),true);
 assert.deepEqual(JSON.parse(JSON.stringify(h.run('localSnapshotManager.read().at(-1).plans[0].batteryRentByTerm.slice(0,4)'))),[0,0,728,728]);
});
test('review 1: advance/cancel untouched initial schedule; missing rent remains zero',()=>{
 const p=base();p.batteryRentEffectiveTermIndex=3;p.batteryRentByTerm=[0,0,0,...Array(33).fill(728)];
 const q=structuredClone(p);L.configure(q,p,728,1,at);assert.deepEqual(q.batteryRentByTerm.slice(0,4),[0,728,728,728]);
 const r=structuredClone(q);L.configure(r,q,0,2,at);assert.ok(r.batteryRentByTerm.every(n=>n===0));
 const old=base();delete old.batteryMonthlyRent;delete old.batteryRentEffectiveTermIndex;delete old.batteryRentByTerm;const copy=structuredClone(old);L.configure(copy,old,0,0,at);assert.deepEqual(copy,old);
});
test('review 1: begun, completed, or prepaid periods never get cleared as initial correction',()=>{
 const p=base();p.startDate='2026-09-05';const q=structuredClone(p);L.configure(q,p,800,2,at);assert.deepEqual(q.batteryRentByTerm.slice(0,4),[728,728,800,800]);
 const prepaid=L.receive(base(),{id:'prepay',date:at,total:3870.88,lateFee:0,startTermIndex:0},at).copy;
 const changed=structuredClone(prepaid);L.configure(changed,prepaid,800,2,at);assert.deepEqual(changed.batteryRentByTerm.slice(0,4),[728,728,800,800]);assert.deepEqual(changed.payments,prepaid.payments);
 assert.throws(()=>L.configure(structuredClone(prepaid),prepaid,800,0,at),/历史期/);
});
function feeFixture(){const p=base();p.startDate='2026-01-05';return L.receive(p,{id:'fee',date:'2026-01-10',total:96.77,lateFee:96.77,startTermIndex:0},'2026-01-30').copy}
test('review 2: reject historical overcollection even if future accrual hides it today',()=>{
 const p=feeFixture(),raw=JSON.stringify(p);
 assert.throws(()=>L.receive(p,{id:'backdated',date:'2026-01-06',total:1000,lateFee:0,startTermIndex:0},'2026-01-30'),/2026-01-10.*后续已收滞纳金/);
 assert.equal(JSON.stringify(p),raw);
});
test('review 2: editing payment date also checks historical fee dates; no input mutation',()=>{
 const p=L.receive(feeFixture(),{id:'base',date:'2026-01-20',total:1000,lateFee:0,startTermIndex:0},'2026-01-30').copy,raw=JSON.stringify(p);
 assert.throws(()=>L.receive(p,{id:'base',date:'2026-01-06',total:1000,lateFee:0,startTermIndex:0},'2026-01-30'),/2026-01-10/);assert.equal(JSON.stringify(p),raw);
});
test('review 2: valid later receipts and unchanged legacy excess credit remain allowed',()=>{
 const p=feeFixture(),q=L.receive(p,{id:'later',date:'2026-01-11',total:1000,lateFee:0,startTermIndex:0},'2026-01-30').copy;
 assert.deepEqual(q.payments[0],p.payments[0]);assert.equal(L.statement(q,'2026-01-10')[0].lateFeeCredit,0);
 const old=base();old.startDate='2026-01-05';old.payments=[{id:'legacy',date:'2026-01-10',total:120,principal:0,lateFee:120,startTermIndex:0,allocations:[]}];
 const r=L.receive(old,{id:'later',date:'2026-01-11',total:1000,lateFee:0,startTermIndex:0},'2026-01-30').copy;
 assert.deepEqual(r.payments[0],old.payments[0]);assert.equal(L.statement(r,'2026-01-10')[0].lateFeeCredit,23.23);
});
function legacy(){const p=samplePlan({completedTerms:1,payments:[{id:'old',date:'2026-08-05',total:4960,principal:4960,lateFee:0,allocations:[{termIndex:0,principal:4960}]}]});for(const k of ['vehiclePrice','downPaymentRate','monthlyRate','loanAmount'])delete p[k];return p}
const fill={'contract-price':'120000','contract-down-rate':'20','contract-monthly-rate':'1','battery-rent':'728','battery-effective-term':'2'};
test('review 3: legacy metadata completion with same monthly rent permits battery setup',async()=>{
 const p=legacy(),old=structuredClone(p.payments),h=await form(p,fill);assert.equal(h.context.lastAlert,undefined);
 const saved=JSON.parse(h.storage.getItem('lateFeePaymentPlansV1'))[0];assert.equal(saved.amount,4960);assert.equal(saved.loanAmount,96000);assert.equal(saved.completedTerms,1);assert.deepEqual(saved.payments,old);assert.equal(saved.batteryRentByTerm[0],0);assert.equal(saved.batteryRentByTerm[1],728);assert.ok(L.validate(saved));
 const result=h.run('settlementBreakdown(plans[0])');assert.equal(result.paidPrincipal,4000);assert.equal(result.paidInterest,960);
});
test('review 3: filling absent null/empty fields preserves already known financial terms',async()=>{
 const p=legacy();p.vehiclePrice=120000;p.downPaymentRate=null;p.monthlyRate='';
 const h=await form(p,fill);assert.equal(h.context.lastAlert,undefined);assert.equal(h.run('plans[0].vehiclePrice'),120000);
});
test('review 3: reject metadata completion which changes the old monthly amount',async()=>{
 const p=legacy(),raw=JSON.stringify(p),h=await form(p,{...fill,'contract-price':'121000'});assert.match(h.context.lastAlert,/不能直接修改/);assert.equal(JSON.stringify(p),raw);assert.equal(h.storage.getItem('lateFeePaymentPlansV1'),h.originalRaw);
});
test('review 3: same monthly amount does not authorize overwriting known financing terms',async()=>{
 const p=legacy();p.vehiclePrice=120000;const h=await form(p,{...fill,'contract-price':'96000','contract-down-rate':'0'});
 assert.match(h.context.lastAlert,/不能直接修改/);assert.equal(h.storage.getItem('lateFeePaymentPlansV1'),h.originalRaw);
});

test('review 3: equivalent numeric strings in legacy core fields do not prevent completion',async()=>{
 const p=legacy();p.amount='4960.00';p.rate='0.0500';p.dueDay='5';p.totalTerms='24';const h=await form(p,fill);
 assert.equal(h.context.lastAlert,undefined);assert.equal(h.run('plans[0].amount'),4960);assert.deepEqual(JSON.parse(JSON.stringify(h.run('plans[0].payments'))),p.payments);
});
