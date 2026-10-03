(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RentalDocument = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const disclaimer = '本方案单用于展示本次车辆租赁报价及拟定付款安排，不代表已成交。具体付款方式、预付租金抵扣、提前退租、逾期处理及租期届满后的相关权利义务，以双方最终签署的《车辆租赁合同》及相关附件约定为准。';
  // Explicit customer-facing allowlist. Never spread the internal result into a template.
  function customerData(result) {
    const { schemeId, customer, vehicle, terms, firstDate, fixedMonthlyCents, batteryMonthlyCents, prepaidMonths, depositMonths, tailAdjustmentCents } = result;
    const paymentSchedule = Object.freeze(result.paymentSchedule.map(({ term, dueDate, plannedCents, offsetCents, dueCents, batteryRentCents, comprehensiveDueCents }) => Object.freeze({ term, dueDate, plannedCents, offsetCents, dueCents, batteryRentCents, comprehensiveDueCents })));
    return Object.freeze({ schemeId, customer, vehicle, terms, firstDate, fixedMonthlyCents, batteryMonthlyCents, prepaidMonths, depositMonths, tailAdjustmentCents, paymentSchedule });
  }
  function table(data, rows = data.paymentSchedule) {
    if(data.batteryMonthlyCents>0)return `<table class="rental-table"><thead><tr><th>期次</th><th>应付日期</th><th>计划租金</th><th>预付抵扣</th><th>租金应付</th><th>租电费</th><th>综合应付</th></tr></thead><tbody>${rows.map(row=>`<tr data-term="${row.term}"><td>${row.term}</td><td>${escape(row.dueDate)}</td><td>${money(row.plannedCents)}</td><td>${money(row.offsetCents)}</td><td>${money(row.dueCents)}</td><td>${money(row.batteryRentCents)}</td><td>${money(row.comprehensiveDueCents)}</td></tr>`).join('')}</tbody></table>`;
    return `<table class="rental-table"><colgroup><col style="width:8%"><col style="width:23%"><col style="width:23%"><col style="width:23%"><col style="width:23%"></colgroup><thead><tr><th>期次</th><th>应付日期</th><th>计划租金</th><th>预付租金抵扣</th><th>本期实际应付</th></tr></thead><tbody>${rows.map(row => `<tr data-term="${row.term}"><td>${row.term}</td><td>${escape(row.dueDate)}</td><td>${money(row.plannedCents)}</td><td>${money(row.offsetCents)}</td><td>${money(row.dueCents)}</td></tr>`).join('')}</tbody></table>`;
  }
  function meta(data) {
    const fields = [['方案编号', data.schemeId], ['客户姓名', data.customer || '未填写'], ['车辆', data.vehicle || '未填写'], ['租赁期限', `${data.terms}期`], ['固定月租', `¥${money(data.fixedMonthlyCents)}`], ['首次付款日', data.firstDate], ['预付租金', `${data.prepaidMonths}个月`], ['押金', `${data.depositMonths}个月`]];
    if(data.batteryMonthlyCents>0)fields.push(['月租电费',`¥${money(data.batteryMonthlyCents)}/月`],['标准月综合应付',`¥${money(data.fixedMonthlyCents+data.batteryMonthlyCents)}（逐期以付款计划为准）`]);
    return `<div class="rental-meta">${fields.map(([label, value]) => `<div><span>${label}：</span><strong>${escape(value)}</strong></div>`).join('')}</div>`;
  }
  function notes(data) {
    return `${data.batteryMonthlyCents>0?'租电费从第1期起单独收取；预付租金只抵合同租金，不抵租电费。':''}金额单位：元。预付租金按约定月数抵扣前几期；押金按固定月租折算，不抵扣租金。${data.tailAdjustmentCents ? `最后一期计划租金为${money(data.paymentSchedule.at(-1).plannedCents)}元，已调整尾差。` : ''}每月按首次付款日对应日付款；遇短月取月末，后续恢复原约定日。`;
  }
  function documentHtml(data, rows = data.paymentSchedule, page = 1, pages = 1) {
    const final = page === pages;
    return `<article class="rental-sheet"><div class="rental-brand">HOKU MOTORS / 好车库</div><h2>车辆租赁方案单</h2>${meta(data)}<div class="rental-table-caption">付款计划 <span>金额单位：元</span></div>${table(data, rows)}<p class="rental-explanation">${escape(notes(data))}</p>${final ? `<p class="rental-disclaimer">${disclaimer}</p><div class="rental-signatures"><span>客户参考：________________</span><span>方案日期：______年____月____日</span></div>` : '<p class="rental-continuation">付款计划续下页；完整方案说明及签名栏见末页。</p>'}<div class="rental-page">${escape(data.schemeId)} · 第 ${page} / ${pages} 页</div></article>`;
  }
  function pdfPages(data, rowsPerPage = 36) {
    const pages = Math.ceil(data.terms / rowsPerPage);
    return Array.from({ length: pages }, (_, index) => documentHtml(data, data.paymentSchedule.slice(index * rowsPerPage, (index + 1) * rowsPerPage), index + 1, pages));
  }
  function text(data) {
    return `车辆租赁方案\n方案编号：${data.schemeId}\n客户姓名：${data.customer || '未填写'}\n车辆：${data.vehicle || '未填写'}\n租赁期限：${data.terms}期\n固定月租：${money(data.fixedMonthlyCents)}元${data.batteryMonthlyCents>0?`\n月租电费：${money(data.batteryMonthlyCents)}元/月\n标准月综合应付：${money(data.fixedMonthlyCents+data.batteryMonthlyCents)}元（逐期以付款计划为准）`:''}\n预付租金：${data.prepaidMonths}个月\n押金：${data.depositMonths}个月\n首次付款日：${data.firstDate}\n\n${notes(data)}\n\n${disclaimer}`;
  }
  return { customerData, table, meta, notes, documentHtml, pdfPages, text, money };
});
