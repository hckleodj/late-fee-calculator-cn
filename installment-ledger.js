(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.InstallmentLedger=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const cents=value=>Math.round(Number(value)*100);
  const yuan=value=>value/100;
  function amount(value){return (typeof value==='number'||typeof value==='string')&&/^\d+(\.\d{1,2})?$/.test(String(value))&&Number.isSafeInteger(cents(value))&&Number(value)<=100000000}
  function day(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))throw Error('收款日期无效，需核对原始记录。');
    const [y,m,d]=value.split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));
    if(date.toISOString().slice(0,10)!==value)throw Error('收款日期无效，需核对原始记录。');
    return Math.floor(date.getTime()/86400000);
  }
  function dueDay(plan,index){const [y,m]=plan.startDate.split('-').map(Number),date=new Date(Date.UTC(y,m-1+index,1)),last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(Number(plan.dueDay),last));return Math.floor(date.getTime()/86400000)}
  function opening(plan){if(Number.isInteger(Number(plan.openingCompletedTerms)))return Number(plan.openingCompletedTerms);const terms=(plan.payments||[]).flatMap(p=>p.allocations||[]).map(a=>Number(a.termIndex)).filter(Number.isInteger);return terms.length?Math.min(Number(plan.completedTerms)||0,...terms):Number(plan.completedTerms)||0}
  function battery(plan,index){if(Array.isArray(plan.batteryRentByTerm))return cents(plan.batteryRentByTerm[index]||0);return index>=Number(plan.batteryRentEffectiveTermIndex||0)?cents(plan.batteryMonthlyRent||0):0}
  function base(plan,index,asOf){
    const beforeOpening=index<opening(plan),contract=cents(plan.amount),rent=battery(plan,index);let contractPaid=beforeOpening?contract:0,batteryPaid=beforeOpening?rent:0;
    for(const p of plan.payments||[]){if(asOf!==undefined&&day(p.date)>asOf)continue;for(const a of p.allocations||[])if(Number(a.termIndex)===index){contractPaid+=cents(a.principal||0);batteryPaid+=cents(a.batteryRent||0)}}
    return {contract,rent,contractPaid,batteryPaid,contractRemaining:Math.max(0,contract-contractPaid),batteryRemaining:Math.max(0,rent-batteryPaid)};
  }
  // Charge (due date, payment date] on the previous balance; payment reduces the next day's base.
  // Round once per term, after summing all segments, to avoid payment-count-dependent rounding.
  function feeFromWeighted(weighted,rate){
    const [mantissa,exponent='0']=String(rate).toLowerCase().split('e'),digits=(mantissa.split('.')[1]||'').length;
    const n=BigInt(mantissa.replace('.','')),scale=digits-Number(exponent),den=10n**BigInt(Math.max(0,scale)),num=BigInt(weighted)*n*10n**BigInt(Math.max(0,-scale));
    return Number((num*2n+den)/(2n*den));
  }
  function accrued(plan,index,asOf){
    if(index<opening(plan))return {cents:0,segments:[]};
    const due=dueDay(plan,index);let cursor=due,left=cents(plan.amount)+battery(plan,index),weighted=0n;const segments=[];
    const events=(plan.payments||[]).map((p,order)=>({date:day(p.date),order,paid:(p.allocations||[]).filter(a=>Number(a.termIndex)===index).reduce((n,a)=>n+cents(a.principal||0)+cents(a.batteryRent||0),0)})).filter(e=>e.paid>0&&e.date<=asOf).sort((a,b)=>a.date-b.date||a.order-b.order);
    function charge(end){if(end>cursor&&left>0){const days=end-cursor;weighted+=BigInt(left)*BigInt(days);segments.push({fromDay:cursor,toDay:end,days,base: yuan(left)})}cursor=Math.max(cursor,end)}
    for(const e of events){charge(Math.max(due,e.date));left=Math.max(0,left-e.paid)}charge(asOf);
    return {cents:feeFromWeighted(weighted,Number(plan.rate)),segments};
  }
  // Legacy receipts remain byte-for-byte unchanged. Their fee-only split is a read-time view,
  // oldest eligible term first at the receipt date; an excess stays as a credit on that term.
  function feePaid(plan,asOf,derived=null){
    const paid=Array(Number(plan.totalTerms)).fill(0);
    const receipts=(plan.payments||[]).map((p,order)=>({p,order,date:day(p.date)})).filter(e=>e.date<=asOf).sort((a,b)=>a.date-b.date||a.order-b.order);
    for(const {p,date} of receipts){
      if(p.allocationVersion===2){for(const a of p.allocations||[])paid[a.termIndex]+=cents(a.lateFee||0);continue}
      if(plan.legacyLateFeeAllocations&&Object.hasOwn(plan.legacyLateFeeAllocations,p.id)){for(const a of plan.legacyLateFeeAllocations[p.id])paid[a.termIndex]+=cents(a.lateFee);continue}
      const before=paid.slice();let left=cents(p.lateFee||0);if(!left)continue;
      const start=Math.min(paid.length-1,Math.max(opening(plan),Number(p.startTermIndex??p.allocations?.[0]?.termIndex??opening(plan))));
      for(let i=start;i<paid.length&&left>0;i++){const n=Math.min(left,Math.max(0,accrued(plan,i,date).cents-paid[i]));paid[i]+=n;left-=n}
      if(left>0&&start<paid.length)paid[start]+=left;
      if(derived)derived[p.id]=paid.flatMap((n,i)=>n>before[i]?[{termIndex:i,lateFee:yuan(n-before[i])}]:[]);
    }
    return paid;
  }
  function freezeLegacyFees(plan){
    const derived=Object.create(null);feePaid(plan,Infinity,derived);
    if(Object.keys(derived).length)plan.legacyLateFeeAllocations={...(plan.legacyLateFeeAllocations||{}),...derived};
  }
  function waived(plan,index,asOf){return (plan.lateFeeWaivers||[]).filter(w=>w.termIndex===index&&day(w.date)<=asOf&&(!w.reversedAt||day(w.reversedAt)>asOf)).reduce((n,w)=>n+cents(w.amount),0)}
  function checkWaivers(plan){
    for(const w of plan.lateFeeWaivers||[]){
      if(w.reversedAt)continue;
      const b=base(plan,w.termIndex,day(w.date));
      if(b.contractRemaining||b.batteryRemaining)throw Error('该期已有滞纳金减免，请先撤销减免，再修改或撤销基础款收款。');
      if(waived(plan,w.termIndex,day(w.date))+feePaid(plan,day(w.date))[w.termIndex]>accrued(plan,w.termIndex,day(w.date)).cents)throw Error('此次修改会使历史减免及已收金额超过应计滞纳金，请先核对减免记录。');
    }
  }
  function waive(plan,{id,termIndex,amount:discount,reason,date},asOf){
    if(!Number.isInteger(termIndex)||termIndex<opening(plan)||termIndex>=Number(plan.totalTerms)||!amount(discount)||Number(discount)<=0||!String(reason||'').trim()||day(date)>day(asOf))throw Error('请填写有效期数、减免金额、原因和日期。');
    const row=statement(plan,date)[termIndex];
    if(row.remaining>0)throw Error('合同月租及当期租电费必须全额付清后，才能减免滞纳金。');
    if(cents(discount)>cents(row.remainingLateFee))throw Error('减免金额不能超过剩余未收滞纳金。');
    const copy=JSON.parse(JSON.stringify(plan));freezeLegacyFees(copy);
    if((copy.lateFeeWaivers||[]).some(w=>w.id===id))throw Error('减免记录重复。');
    (copy.lateFeeWaivers||=[]).push({id,termIndex,amount:Number(discount),reason:String(reason).trim(),date});checkWaivers(copy);return copy;
  }
  function reverseWaiver(plan,id,asOf){const copy=JSON.parse(JSON.stringify(plan)),record=(copy.lateFeeWaivers||[]).find(w=>w.id===id);if(!record||record.reversedAt)throw Error('减免记录不存在或已撤销。');if(day(asOf)<day(record.date))throw Error('撤销日期不能早于减免日期。');record.reversedAt=asOf;return copy}
  function statement(plan,asOf){
    const date=day(asOf),paidFees=feePaid(plan,date);
    return Array.from({length:Number(plan.totalTerms)},(_,i)=>{
      const b=base(plan,i,date),fee=accrued(plan,i,date),discount=waived(plan,i,date),remainingFee=Math.max(0,fee.cents-paidFees[i]-discount);
      return {termIndex:i,contractRent:yuan(b.contract),batteryRent:yuan(b.rent),baseDue:yuan(b.contract+b.rent),contractRentPaid:yuan(b.contractPaid),batteryRentPaid:yuan(b.batteryPaid),contractRentRemaining:yuan(b.contractRemaining),batteryRentRemaining:yuan(b.batteryRemaining),remaining:yuan(b.contractRemaining+b.batteryRemaining),accruedLateFee:yuan(fee.cents),paidLateFee:yuan(paidFees[i]),waivedLateFee:yuan(discount),remainingLateFee:yuan(remainingFee),lateFeeCredit:yuan(Math.max(0,paidFees[i]-fee.cents)),totalDue:yuan(b.contractRemaining+b.batteryRemaining+remainingFee),segments:fee.segments};
    });
  }
  function recompute(plan){let i=opening(plan);while(i<Number(plan.totalTerms)){const b=base(plan,i);if(b.contractRemaining||b.batteryRemaining)break;i++}plan.completedTerms=i;return i}
  function validate(plan){
    try{
      if(plan.batteryMonthlyRent!==undefined&&!amount(plan.batteryMonthlyRent))return false;
      if(plan.batteryRentEffectiveTermIndex!==undefined&&(!Number.isInteger(plan.batteryRentEffectiveTermIndex)||plan.batteryRentEffectiveTermIndex<0||plan.batteryRentEffectiveTermIndex>=Number(plan.totalTerms)))return false;
      if(plan.batteryRentByTerm!==undefined&&(!Array.isArray(plan.batteryRentByTerm)||plan.batteryRentByTerm.length!==Number(plan.totalTerms)||!plan.batteryRentByTerm.every(amount)))return false;
      if(plan.legacyLateFeeAllocations!==undefined){
        if(!plan.legacyLateFeeAllocations||typeof plan.legacyLateFeeAllocations!=='object'||Array.isArray(plan.legacyLateFeeAllocations))return false;
        for(const [id,rows] of Object.entries(plan.legacyLateFeeAllocations)){
          const receipt=(plan.payments||[]).find(p=>p.id===id&&p.allocationVersion!==2);
          if(!receipt||!Array.isArray(rows)||rows.some(a=>!Number.isInteger(a.termIndex)||a.termIndex<0||a.termIndex>=Number(plan.totalTerms)||!amount(a.lateFee)))return false;
          if(rows.reduce((n,a)=>n+cents(a.lateFee),0)!==cents(receipt.lateFee))return false;
        }
      }
      if(plan.lateFeeWaivers!==undefined){
        if(!Array.isArray(plan.lateFeeWaivers))return false;const ids=new Set();
        for(const w of plan.lateFeeWaivers){if(typeof w.id!=='string'||!/^[A-Za-z0-9._:-]+$/.test(w.id)||ids.has(w.id)||!Number.isInteger(w.termIndex)||w.termIndex<0||w.termIndex>=Number(plan.totalTerms)||!amount(w.amount)||Number(w.amount)<=0||typeof w.reason!=='string'||!w.reason.trim())return false;ids.add(w.id);day(w.date);if(w.reversedAt&&day(w.reversedAt)<day(w.date))return false}
        checkWaivers(plan);
      }
      for(const p of plan.payments||[]){if(!validChannelCost(p))return false;if(p.allocationVersion!==undefined&&p.allocationVersion!==2)return false;if(p.allocationVersion!==2)continue;
        day(p.date);if(![p.total,p.principal,p.batteryRent,p.lateFee].every(amount))return false;
        if(!Number.isInteger(p.startTermIndex)||p.startTermIndex<0||p.startTermIndex>=Number(plan.totalTerms))return false;
        const sums={principal:0,batteryRent:0,lateFee:0},seen=new Set();
        for(const a of p.allocations){if(!Number.isInteger(a.termIndex)||a.termIndex<0||a.termIndex>=Number(plan.totalTerms)||seen.has(a.termIndex))return false;seen.add(a.termIndex);for(const k of Object.keys(sums)){if(!amount(a[k]??0))return false;sums[k]+=cents(a[k]??0)}}
        for(const k of Object.keys(sums))if(sums[k]!==cents(p[k]))return false;
        if(cents(p.total)!==sums.principal+sums.batteryRent+sums.lateFee)return false;
      }return true;
    }catch(e){return false}
  }
  // Channel costs never participate in repayment allocation or statements.
  const paymentChannels={CCB:'建行收款码',WECHAT:'微信经营收款',CASH:'现金类渠道'};
  function channelCost(total,channel,fee){
    if(!Object.hasOwn(paymentChannels,channel))throw Error('请选择收款渠道。');
    if(!amount(total)||Number(total)<=0||!amount(fee))throw Error('付款金额和手续费须为有效非负金额，最多两位小数。');
    const channelFee=channel==='CASH'?0:Number(fee);
    return {paymentAmount:Number(total),paymentChannel:channel,channelFee,netReceived:yuan(Math.max(cents(total)-cents(channelFee),0))};
  }
  function validChannelCost(p){
    const keys=['paymentAmount','paymentChannel','channelFee','netReceived'];
    if(keys.every(k=>p[k]===undefined))return true; // Legacy receipts stay untouched.
    try{if(keys.some(k=>p[k]===undefined)||typeof p.paymentAmount!=='number'||typeof p.channelFee!=='number'||typeof p.netReceived!=='number')return false;
      const cost=channelCost(p.paymentAmount,p.paymentChannel,p.channelFee);
      return cents(p.paymentAmount)===cents(p.total)&&p.channelFee===cost.channelFee&&p.netReceived===cost.netReceived;
    }catch(error){return false}
  }
  function suggestedChannelFee(total,channel,settings){
    if(channel==='CASH')return 0;
    const rate=settings?.[channel];
    if(rate===undefined||rate===null)return null;
    if(!amount(total))return null;
    return yuan(Math.round(cents(total)*rate/100));
  }
  function localToday(){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`}
  // Inspect saved history, including reversed waivers; never replay receipts to change a rate.
  function hasLateFeeHistory(plan){
    return (plan.payments||[]).some(p=>Number(p.lateFee)>0||(p.allocations||[]).some(a=>Number(a.lateFee)>0))
      ||Object.keys(plan.legacyLateFeeAllocations||{}).length>0||(plan.lateFeeWaivers||[]).length>0;
  }
  function assertRateChange(existing,rate){
    if(!Number.isFinite(Number(rate))||Number(rate)<0)throw Error('参考日违约金比例须为非负数字。');
    if(existing&&Number(rate)!==Number(existing.rate)&&hasLateFeeHistory(existing))throw Error('已有滞纳金收款、分配或减免历史（含已撤销记录），不能直接修改参考日违约金比例，请先核对历史账务。');
  }
  function configure(plan,existing,rent,effective,asOf=localToday()){
    if(!amount(rent))throw Error('月租电费请输入非负金额，最多2位小数。');
    if(!Number.isInteger(effective)||effective<0||effective>=Number(plan.totalTerms))throw Error('租电费生效期须在合同期数内。');
    if(existing&&Number(existing.batteryMonthlyRent||0)===Number(rent)&&Number(existing.batteryRentEffectiveTermIndex||0)===effective&&Number(existing.totalTerms)===Number(plan.totalTerms))return;
    if(!existing&&Number(rent)===0)return;
    if(existing&&!existing.batteryRentByTerm&&!existing.batteryMonthlyRent&&Number(rent)===0)return;
    if(existing&&effective<Number(existing.completedTerms))throw Error('不能修改已完成历史期的租电费，请选择未结清期或未来期。');
    // Before any battery period starts, an uncollected contract's initial schedule can
    // be corrected. Once a charge has started or a receipt exists, preserve history.
    const resetInitial=existing&&Number(existing.completedTerms)===0&&opening(existing)===0&&!(existing.payments||[]).length
      &&Array.from({length:Number(existing.totalTerms)},(_,i)=>i).every(i=>battery(existing,i)===0||dueDay(existing,i)>day(asOf));
    const values=Array.from({length:Number(plan.totalTerms)},(_,i)=>existing&&!resetInitial?yuan(battery(existing,i)):0);
    for(let i=effective;i<values.length;i++){
      if(existing){const b=base(existing,i);if(!b.contractRemaining&&!b.batteryRemaining)continue;
        if(values[i]!==Number(rent)&&battery(existing,i)>0&&(existing.payments||[]).some(p=>(p.allocations||[]).some(a=>Number(a.termIndex)===i)))throw Error(`第${i+1}期已有收款记录，请从未登记收款的期次修改租电费，避免改变历史计费。`);
      }values[i]=Number(rent);
    }
    freezeLegacyFees(plan);
    plan.batteryMonthlyRent=Number(rent);plan.batteryRentEffectiveTermIndex=effective;plan.batteryRentByTerm=values;
  }
  function receive(plan,{id,date,total,lateFee=0,startTermIndex,automatic=true},asOf){
    if(!amount(total)||Number(total)<=0||!amount(lateFee)||Number(lateFee)>Number(total))throw Error('到账总额及滞纳金须为有效的非负两位小数金额。');
    if(day(date)>day(asOf))throw Error('实际收款日期不能晚于今天。');
    if(!Number.isInteger(startTermIndex)||startTermIndex<opening(plan)||startTermIndex>=Number(plan.totalTerms))throw Error('收款期数无效。');
    const copy=JSON.parse(JSON.stringify(plan));copy.openingCompletedTerms=opening(plan);freezeLegacyFees(copy);
    const oldIndex=(copy.payments||[]).findIndex(p=>p.id===id);copy.payments=(copy.payments||[]).filter(p=>p.id!==id);if(copy.legacyLateFeeAllocations)delete copy.legacyLateFeeAllocations[id];
    const entries=new Map();const entry=i=>{if(!entries.has(i))entries.set(i,{termIndex:i,principal:0,batteryRent:0,lateFee:0});return entries.get(i)};
    let left=cents(total)-cents(lateFee);
    // Resolve from saved balances after removing only the receipt being edited.
    // The clicked term and today's month must never choose the FIFO starting point.
    const dueRows=statement(copy,date);
    const first=dueRows.findIndex((r,i)=>{const b=base(copy,i);return b.contractRemaining>0||b.batteryRemaining>0||r.remainingLateFee>0});
    startTermIndex=first>=0?Math.max(opening(copy),first):Number(copy.totalTerms);
    if(automatic){
      const view={...copy,payments:[...copy.payments,{id,date,allocationVersion:2,allocations:[]}]},temporary=view.payments[view.payments.length-1];
      for(let i=startTermIndex;i<Number(copy.totalTerms)&&left>0;i++){
        const b=base(copy,i),contract=Math.min(left,b.contractRemaining);left-=contract;const rent=Math.min(left,b.batteryRemaining);left-=rent;
        if(contract||rent){const a=entry(i);a.principal=yuan(contract);a.batteryRent=yuan(rent)}
        temporary.allocations=[...entries.values()];
        const fee=Math.min(left,cents(statement(view,date)[i].remainingLateFee));left-=fee;if(fee)entry(i).lateFee=yuan(fee);
      }
      if(left)throw Error(`有 ${yuan(left).toFixed(2)} 元无法分配，请核对到账金额。`);
      lateFee=yuan([...entries.values()].reduce((n,a)=>n+cents(a.lateFee),0));
    }else
    for(let i=startTermIndex;i<Number(copy.totalTerms)&&left>0;i++){
      const b=base(copy,i),contract=Math.min(left,b.contractRemaining);left-=contract;const rent=Math.min(left,b.batteryRemaining);left-=rent;
      if(contract||rent){const a=entry(i);a.principal=yuan(contract);a.batteryRent=yuan(rent)}
    }
    if(left)throw Error(`有 ${yuan(left).toFixed(2)} 元基础款无法分配，请核对金额。`);
    const candidate={id,date,total:Number(total),lateFee:Number(lateFee),principal:0,batteryRent:0,startTermIndex,allocationVersion:2,allocations:[...entries.values()]};
    copy.payments.splice(oldIndex<0?copy.payments.length:oldIndex,0,candidate);
    const due=statement(copy,date);let feeLeft=automatic?0:cents(lateFee);
    for(let i=startTermIndex;i<due.length&&feeLeft>0;i++){const n=Math.min(feeLeft,cents(due[i].remainingLateFee));if(n){entry(i).lateFee=yuan(n);feeLeft-=n}}
    if(feeLeft)throw Error('登记滞纳金超过收款日剩余应计金额，请核对收款日期、期数及金额。');
    candidate.allocations=[...entries.values()].sort((a,b)=>a.termIndex-b.termIndex);
    candidate.principal=yuan(candidate.allocations.reduce((n,a)=>n+cents(a.principal),0));candidate.batteryRent=yuan(candidate.allocations.reduce((n,a)=>n+cents(a.batteryRent),0));
    // Backdated edits must not invalidate a later fee receipt. Legacy excess credits are preserved.
    const checkpoints=new Set([asOf,...[...(plan.payments||[]),...copy.payments].filter(p=>Number(p.lateFee)>0&&day(p.date)<=day(asOf)).map(p=>p.date)]);
    for(const checkpoint of checkpoints){
      const before=statement(plan,checkpoint),after=statement(copy,checkpoint);
      if(after.some((a,i)=>cents(a.lateFeeCredit)>cents(before[i].lateFeeCredit)))throw Error(`此次修改会使 ${checkpoint} 的后续已收滞纳金超过应计金额，请先核对后续收款。`);
    }
    for(const a of candidate.allocations){if(!a.batteryRent)delete a.batteryRent;if(!a.lateFee)delete a.lateFee}
    checkWaivers(copy);recompute(copy);return {copy,candidate,unallocated:0};
  }
  function undo(plan,id){
    const copy=JSON.parse(JSON.stringify(plan));copy.openingCompletedTerms=opening(plan);freezeLegacyFees(copy);
    copy.payments=(copy.payments||[]).filter(p=>p.id!==id);
    if(copy.legacyLateFeeAllocations)delete copy.legacyLateFeeAllocations[id];
    checkWaivers(copy);recompute(copy);return copy;
  }
  return {hasLateFeeHistory,assertRateChange,paymentChannels,channelCost,validChannelCost,suggestedChannelFee,cents,yuan,amount,day,dueDay,opening,battery,base,accrued,statement,recompute,validate,configure,receive,freezeLegacyFees,undo,waive,reverseWaiver};
});
