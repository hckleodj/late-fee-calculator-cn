(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.VehicleRentalLedger=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const statuses=['RENTING','RETURNED_UNSETTLED','SETTLED'];
function day(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('日期格式不正确');const n=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)throw new Error('日期不存在');return n/86400000}
function cents(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e9)throw new Error('金额必须为有效非负数字');return Math.round((value+Number.EPSILON)*100)}
// Legacy records are read without mutation; their undated total is the opening base.
function paymentTotals(r){
 const modern=r.historicalReceivedBase!==undefined||r.rentalPayments!==undefined;
 if(modern&&(r.historicalReceivedBase===undefined||!Array.isArray(r.rentalPayments)))throw new Error('出租收款字段缺失');
 const baseCents=cents(modern?r.historicalReceivedBase:r.receivedAmount);
 const ids=new Set();let paidCents=baseCents;
 for(const p of modern?r.rentalPayments:[]){
  if(!p||typeof p.id!=='string'||!/^[A-Za-z0-9._:-]+$/.test(p.id)||ids.has(p.id))throw new Error('收款ID无效或重复');ids.add(p.id);
  day(p.date);
  if(cents(p.amount)<=0||Math.abs(p.amount*100-Math.round(p.amount*100))>0.00001)throw new Error('收款金额须大于零且最多两位小数');
  if(typeof p.note!=='string'||p.note.length>500||typeof p.createdAt!=='string'||!Number.isFinite(Date.parse(p.createdAt)))throw new Error('收款备注或创建时间无效');
  if(!['ACTIVE','REVOKED'].includes(p.status))throw new Error('收款状态无效');
  if(p.status==='REVOKED'){
   if(typeof p.revokedAt!=='string'||!Number.isFinite(Date.parse(p.revokedAt))||Date.parse(p.revokedAt)<Date.parse(p.createdAt)||typeof p.revokeReason!=='string'||!p.revokeReason.trim()||p.revokeReason.length>500)throw new Error('撤销时间或原因无效');
  }else{if(p.revokedAt!==undefined||p.revokeReason!==undefined)throw new Error('有效收款不能带撤销信息');paidCents+=cents(p.amount)}
 }
 if(paidCents>1e11)throw new Error('累计收款超过支持范围');
 if(modern&&cents(r.receivedAmount)!==paidCents)throw new Error('累计已收与流水不一致');
 return {historicalReceivedBase:baseCents/100,receivedAmount:paidCents/100};
}
function receive(r,input,today,now){
 paymentTotals(r);day(today);day(input.date);
 if(input.date>today)throw new Error('收款日期不能晚于今天');
 const next={...r,historicalReceivedBase:paymentTotals(r).historicalReceivedBase,rentalPayments:(r.rentalPayments||[]).map(p=>({...p})),updatedAt:now};
 next.rentalPayments.push({id:input.id,date:input.date,amount:input.amount,note:input.note||'',createdAt:now,status:'ACTIVE'});
 // Calculate the cache only on an explicit accounting action.
 next.receivedAmount=next.historicalReceivedBase+next.rentalPayments.filter(p=>p.status==='ACTIVE').reduce((sum,p)=>sum+cents(p.amount),0)/100;
 next.receivedAmount=cents(next.receivedAmount)/100;paymentTotals(next);return next;
}
function revoke(r,paymentId,reason,now,today){
 paymentTotals(r);const p=r.rentalPayments?.find(p=>p.id===paymentId);
 if(!p||p.status!=='ACTIVE')throw new Error('该笔收款不存在或已撤销');
 if(typeof reason!=='string'||!reason.trim())throw new Error('请填写撤销原因');
 const next={...r,rentalPayments:r.rentalPayments.map(p=>p.id===paymentId?{...p,status:'REVOKED',revokedAt:now,revokeReason:reason.trim()}:{...p}),receivedAmount:(cents(r.receivedAmount)-cents(p.amount))/100,updatedAt:now};
 paymentTotals(next);if(next.status==='SETTLED'&&calculate(next,today).outstanding>0)next.status='RETURNED_UNSETTLED';return next;
}
function billingDays(r,today){
 for(const key of ['chargeStartDay','chargeReturnDay'])if(r[key]!==undefined&&typeof r[key]!=='boolean')throw new Error('首尾日计费选项必须为布尔值');
 const start=day(r.startDate),end=day(r.returnDate||today);
 if(r.returnDate&&end<start)throw new Error('还车日不能早于放车日');
 const chargeStart=r.chargeStartDay===undefined?true:r.chargeStartDay;
 const chargeReturn=r.chargeReturnDay===undefined?false:r.chargeReturnDay;
 return Math.max(0,end-start-(chargeStart?0:1)+(r.returnDate&&chargeReturn?1:0));
}
function calculate(r,today){const days=billingDays(r,today);const systemCents=r.billingMode==='DAILY'?days*cents(r.dailyRate):Math.round(days*cents(r.monthlyRate)/30);const finalCents=r.manualReceivable==null?systemCents:cents(r.manualReceivable);return {days,systemAmount:systemCents/100,receivable:finalCents/100,outstanding:Math.max(0,finalCents-cents(paymentTotals(r).receivedAmount))/100,receivedAmount:paymentTotals(r).receivedAmount,overreceived:Math.max(0,cents(paymentTotals(r).receivedAmount)-finalCents)/100}}
function returnReminder(r,today){
 if(r.status!=='RENTING'||r.returnDate!==null||!r.expectedReturnDate)return null;
 const daysLate=day(today)-day(r.expectedReturnDate);
 return daysLate<0?null:{kind:daysLate===0?'TODAY':'OVERDUE',daysLate};
}
function vehicleSummary(vehicle,rentals,today){
 const records=rentals.filter(r=>r.vehicleId===vehicle.id);let receivable=0,received=0,outstanding=0;
 for(const r of records){const c=calculate(r,today);receivable+=Math.round(c.receivable*100);received+=Math.round(c.receivedAmount*100);outstanding+=Math.round(c.outstanding*100)}
 return {records,count:records.length,receivable:receivable/100,receivedAmount:received/100,outstanding:outstanding/100};
}
function assertRentalAllowed(vehicle,previous,draft,previousVehicle){
 if(!vehicle)throw new Error('车辆不存在');
 if(previousVehicle?.soldAt!==undefined&&previous?.vehicleId!==draft.vehicleId)throw new Error('已售车辆的历史订单不能转移到其他车辆');
 if(vehicle.soldAt!==undefined&&(!previous||previous.vehicleId!==vehicle.id||draft.status==='RENTING'))throw new Error('已售车辆不能新增出租订单或重新在租');
}
function markSold(vehicle,rentals,now){
 if(!vehicle)throw new Error('车辆不存在');
 if(vehicle.soldAt!==undefined)throw new Error('车辆已标记出售');
 if(rentals.some(r=>r.vehicleId===vehicle.id&&r.status==='RENTING'))throw new Error('请先登记还车，再标记已售；未结清租金仍可继续收款');
 if(typeof now!=='string'||!Number.isFinite(Date.parse(now)))throw new Error('出售时间无效');
 return {...vehicle,soldAt:now};
}
function validate(vehicles,rentals){
 if(!Array.isArray(vehicles)||!Array.isArray(rentals))throw new Error('车辆/出租数据格式异常');
 const ids=new Set(),vins=new Set(),rids=new Set(),active=new Set();const id=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]+$/.test(x);
 for(const v of vehicles){if(!v||!id(v.id)||ids.has(v.id)||typeof v.model!=='string'||!v.model.trim()||typeof v.vin!=='string'||! /^[A-HJ-NPR-Z0-9]{17}$/.test(v.vin)||vins.has(v.vin))throw new Error('车辆ID、车型或VIN无效/重复');ids.add(v.id);vins.add(v.vin);for(const k of ['plateNumber','registrationDate','color'])if(typeof v[k]!=='string')throw new Error('车辆字段异常');if(v.registrationDate)day(v.registrationDate);if(v.soldAt!==undefined&&(typeof v.soldAt!=='string'||!Number.isFinite(Date.parse(v.soldAt))))throw new Error('出售时间无效')}
 for(const r of rentals){if(!r||!id(r.id)||rids.has(r.id)||!ids.has(r.vehicleId)||typeof r.renterName!=='string'||!r.renterName.trim()||!statuses.includes(r.status)||!['DAILY','MONTHLY'].includes(r.billingMode)||typeof r.note!=='string')throw new Error('出租记录或车辆关联无效');if(r.renterPhone!==undefined&&(typeof r.renterPhone!=='string'||(r.renterPhone!==''&&!/^[+0-9 ()-]{3,40}$/.test(r.renterPhone))))throw new Error('联系电话格式不正确');if(r.renterContact!==undefined&&(typeof r.renterContact!=='string'||r.renterContact.length>200))throw new Error('联系信息最多200字');if(r.renterIdNumber!==undefined&&(typeof r.renterIdNumber!=='string'||(r.renterIdNumber!==''&&!/^(?:[0-9]{15}|[0-9]{17}[0-9X])$/.test(r.renterIdNumber))))throw new Error('身份证号须为15位或18位，末位可为X');if(r.renterIdPhotos!==undefined&&(!Array.isArray(r.renterIdPhotos)||r.renterIdPhotos.length>2||!r.renterIdPhotos.every(photo=>typeof photo==='string'&&photo.length<=280000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo))))throw new Error('身份证照片格式异常或超过大小限制');rids.add(r.id);billingDays(r,r.startDate);day(r.startDate);if(r.expectedReturnDate!==undefined&&r.expectedReturnDate!==null&&day(r.expectedReturnDate)<day(r.startDate))throw new Error('约定还车日不能早于放车日');if(r.returnDate!==null){if(day(r.returnDate)<day(r.startDate))throw new Error('还车日不能早于放车日')}if((r.status==='RENTING')!==(r.returnDate===null))throw new Error('还车日期与状态不一致');cents(r.dailyRate);cents(r.monthlyRate);cents(r.receivedAmount);paymentTotals(r);if(cents(r.billingMode==='DAILY'?r.dailyRate:r.monthlyRate)<=0)throw new Error('租金必须大于零');if(r.manualReceivable!==null){cents(r.manualReceivable);if(!r.note.trim())throw new Error('人工调整请填写备注说明')}for(const k of ['createdAt','updatedAt'])if(typeof r[k]!=='string'||!Number.isFinite(Date.parse(r[k])))throw new Error('记录时间无效');if(r.status==='RENTING'){if(vehicles.find(v=>v.id===r.vehicleId).soldAt!==undefined)throw new Error('已售车辆不能在租');if(active.has(r.vehicleId))throw new Error('该车辆已有在租记录');active.add(r.vehicleId)}if(r.status==='SETTLED'&&calculate(r,r.returnDate).outstanding>0)throw new Error('尚有未收金额，不能标记结清；请明确将状态改为“已归还未结清”后保存')}
 return true;
}
function validatePaymentSettings(value){
 if(value===undefined)return;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['CCB','WECHAT'].includes(k)))throw new Error('收款渠道设置格式异常');
 for(const rate of Object.values(value))if(rate!==null&&(typeof rate!=='number'||!Number.isFinite(rate)||rate<0||rate>100))throw new Error('默认手续费率须为0至100之间的百分比');
}
function data(value){if(Array.isArray(value))return {plans:value,vehicles:[],rentals:[]};if(!value||!Array.isArray(value.plans))throw new Error('业务数据结构异常');if(value.schemaVersion!==undefined&&value.schemaVersion!==2)throw new Error('不支持的数据版本');if(value.schemaVersion===2&&(!Array.isArray(value.vehicles)||!Array.isArray(value.rentals)))throw new Error('出租数据包字段缺失');const vehicles=value.vehicles??[],rentals=value.rentals??[];validate(vehicles,rentals);validatePaymentSettings(value.paymentSettings);return {plans:value.plans,vehicles,rentals,...(value.paymentSettings===undefined?{}:{paymentSettings:value.paymentSettings})}}
function pack(plans,vehicles=[],rentals=[],paymentSettings){validate(vehicles,rentals);validatePaymentSettings(paymentSettings);return vehicles.length||rentals.length||paymentSettings!==undefined?{schemaVersion:2,plans,vehicles,rentals,...(paymentSettings===undefined?{}:{paymentSettings})}:plans}
return {vehicleSummary,assertRentalAllowed,markSold,paymentTotals,receive,revoke,validatePaymentSettings,day,calculate,returnReminder,validate,data,pack,statuses};
});
