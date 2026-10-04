'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const L=require('../installment-ledger'),{samplePlan,buildPage}=require('./page-harness');
function settled(){
 let p=samplePlan({amount:1000,totalTerms:2,startDate:'2026-01-05',rate:.01});
 p=L.receive(p,{id:'target',date:'2026-02-10',total:1000,startTermIndex:1},'2026-09-30').copy;
 p=L.receive(p,{id:'older',date:'2026-02-20',total:1000,startTermIndex:0},'2026-09-30').copy;
 for(const i of [0,1])p=L.waive(p,{id:`waiver-${i}`,termIndex:i,amount:L.statement(p,'2026-02-21')[i].remainingLateFee,reason:'协商全免',date:'2026-02-21'},'2026-09-30');
 Object.assign(p.payments[0],L.channelCost(1000,'WECHAT',2));p.payments[0].notes='历史备注';
 return p;
}
test('reproduction: replaying a settled historical receipt invalidates later waiver',()=>{
 const p=settled();assert.ok(L.validate(p));assert.equal(p.completedTerms,2);
 assert.throws(()=>L.receive(p,{id:'target',date:'2026-02-10',total:1000,startTermIndex:1,automatic:true},'2026-09-30'),/历史减免及已收金额超过应计滞纳金/);
});
for(const [field,value] of [['payment-total','999'],['payment-date','2026-02-09'],['payment-term-index','0']])test(`accounting change to ${field} still recalculates and validates`,async()=>{
 const h=await buildPage(),run=s=>vm.runInContext(s,h.context);h.context.fixture=settled();run('plans=[fixture];openPaymentDialog(fixture.id,1,"target")');const before=run('JSON.stringify(plans)');
 h.getElement(field).value=value;await h.getElement('payment-form').dispatch('submit');
 assert.match(h.getElement('payment-error').textContent,/减免/);assert.equal(run('JSON.stringify(plans)'),before);
});

function accounting(p){const copy=structuredClone(p);for(const receipt of copy.payments)for(const key of ['paymentAmount','paymentChannel','channelFee','netReceived'])delete receipt[key];return copy;}
async function pageWith(p){const h=await buildPage();h.run=s=>vm.runInContext(s,h.context);h.context.fixture=p;h.run('plans=[fixture];savePlans()');await h.run('businessChangePending');h.run('openPaymentDialog(fixture.id,1,"target")');return h;}
for(const legacy of [false,true])for(const [label,channel,fee] of [['channel','CCB','2'],['fee','WECHAT','3.25'],['cash','CASH','0'],['same','WECHAT','2']])test(`settled ${label} edit preserves history, legacy=${legacy}`,async()=>{
 const p=settled();if(legacy){delete p.payments[0].allocationVersion;delete p.payments[0].batteryRent;delete p.openingCompletedTerms;}
 const h=await pageWith(p),before=accounting(p),state=JSON.parse(h.storage.getItem('dajinBackupStateV1'));
 h.run('InstallmentLedger.receive=()=>{throw Error("unexpected accounting replay")}');
 h.getElement('payment-channel').value=channel;await h.getElement('payment-channel').dispatch('change');h.getElement('payment-channel-fee').value=fee;await h.getElement('payment-channel-fee').dispatch('input');
 assert.equal(h.getElement('payment-error').textContent,'');assert.match(h.getElement('allocation-preview').innerHTML,/第 2 期/);
 h.getElement('payment-total').value='1000.00';await h.getElement('payment-form').dispatch('submit');await h.run('businessChangePending');
 assert.equal(h.getElement('payment-error').textContent,'');assert.equal(h.getElement('payment-dialog').open,false);
 const after=JSON.parse(h.run('JSON.stringify(plans[0])'));assert.deepEqual(accounting(after),before);assert.equal(after.payments[0].notes,'历史备注');assert.deepEqual(Object.fromEntries(Object.keys(L.channelCost(1000,channel,fee)).map(k=>[k,after.payments[0][k]])),L.channelCost(1000,channel,fee));
 assert.equal(JSON.parse(h.storage.getItem('dajinBackupStateV1')).dataRevision,state.dataRevision+(label==='same'?0:1));
 const artifact=await h.run('createBackupArtifact("download")');assert.deepEqual(accounting(artifact.payload.plans[0]),before);assert.equal(artifact.payload.plans[0].payments[0].netReceived,1000-Number(fee));
 const reloaded=await buildPage({storage:h.storage});assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(plans[0])',reloaded.context)),after);
});
test('fee validation still rejects invalid company costs without changing history',async()=>{
 for(const fee of ['', '-1','1.001']){const h=await pageWith(settled()),before=h.run('JSON.stringify(plans)');h.getElement('payment-channel-fee').value=fee;await h.getElement('payment-form').dispatch('submit');assert.ok(h.getElement('payment-error').textContent);assert.equal(h.run('JSON.stringify(plans)'),before);}
});
test('storage failure rolls back metadata edit without mutating original accounting',async()=>{
 const h=await pageWith(settled()),before=h.run('JSON.stringify(plans)'),raw=h.storage.getItem('lateFeePaymentPlansV1'),write=h.storage.setItem.bind(h.storage);
 h.storage.setItem=(key,value)=>{if(key==='lateFeePaymentPlansV1')throw Error('test quota');write(key,value)};h.getElement('payment-channel-fee').value='3';await h.getElement('payment-form').dispatch('submit');assert.match(h.getElement('payment-error').textContent,/写入失败/);assert.equal(h.run('JSON.stringify(plans)'),before);assert.equal(h.storage.getItem('lateFeePaymentPlansV1'),raw);
});
test('channel edit retains complete business package, vehicles, rental notes and settings',async()=>{
 const h=await pageWith(settled());
 h.run(`vehicles=[{id:'v1',model:'虚构车辆',vin:'LAAAAAAAAAAAAAAAA',plateNumber:'测A01',registrationDate:'',color:'白'}];rentals=[{id:'r1',vehicleId:'v1',renterName:'虚构承租人',status:'RENTING',billingMode:'DAILY',startDate:'2026-01-01',returnDate:null,dailyRate:100,monthlyRate:0,receivedAmount:0,manualReceivable:null,note:'出租备注原样保留',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}];paymentSettings={CCB:.3,WECHAT:.6};savePlans()`);await h.run('businessChangePending');const before=JSON.parse(h.storage.getItem('lateFeePaymentPlansV1'));
 h.getElement('payment-channel-fee').value='3';await h.getElement('payment-form').dispatch('submit');await h.run('businessChangePending');const after=JSON.parse(h.storage.getItem('lateFeePaymentPlansV1'));
 assert.deepEqual(after.vehicles,before.vehicles);assert.deepEqual(after.rentals,before.rentals);assert.deepEqual(after.paymentSettings,before.paymentSettings);assert.equal(after.schemaVersion,2);assert.deepEqual(accounting(after.plans[0]),accounting(before.plans[0]));
});
