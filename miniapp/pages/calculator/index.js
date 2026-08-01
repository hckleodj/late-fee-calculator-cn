'use strict';

const domain = require('../../shared/domain');
const format = require('../../shared/format');

Page({
  data: {
    modeIndex: 0,
    methodIndex: 0,
    modes: ['客户方案报价', '按月供倒推'],
    methods: ['平息 / 固定月息', '标准等额本息'],
    form: { carPrice: '200000', downPaymentRate: '25', targetPayment: '4500', terms: '36', depositMonths: '1', monthlyRate: '0.6' },
    result: null,
    late: { amount: '3142.88', rate: '0.5', dueDate: format.todayDateKey(), payDate: format.todayDateKey() },
    lateResult: null
  },
  onLoad() { this.calculate(); this.calculateLateFee(); },
  onMode(event) { this.setData({ modeIndex: Number(event.detail.value) }); this.calculate(); },
  onMethod(event) { this.setData({ methodIndex: Number(event.detail.value) }); this.calculate(); },
  onField(event) { this.setData({ [`form.${event.currentTarget.dataset.key}`]: event.detail.value }); this.calculate(); },
  calculate() {
    try {
      const form = this.data.form;
      const price = domain.yuanToCents(form.carPrice);
      const rate = domain.percentToBps(form.monthlyRate);
      const terms = Number(form.terms);
      const method = this.data.methodIndex === 1 ? 'annuity' : 'flat';
      let loan, down, payment;
      if (this.data.modeIndex === 0) {
        const downRate = domain.percentToBps(form.downPaymentRate);
        down = Math.round(price * downRate / 10000);
        loan = price - down;
        payment = domain.calculateMonthlyPaymentCents(loan, rate, terms, method);
      } else {
        const target = domain.yuanToCents(form.targetPayment);
        loan = Math.min(price, domain.principalFromPaymentCents(target, rate, terms, method));
        down = price - loan;
        payment = domain.calculateMonthlyPaymentCents(loan, rate, terms, method);
      }
      const schedule = domain.buildRepaymentSchedule({ principalCents: loan, monthlyRateBps: rate, terms, interestMethod: method, startDateKey: '2026-01-01', dueDay: 1 });
      const interest = schedule.reduce((sum, row) => sum + row.scheduledInterestCents, 0);
      const result = {
        loanText: format.money(loan), downText: format.money(down), paymentText: format.money(payment),
        interestText: format.money(interest), totalText: format.money(loan + interest),
        downRateText: (down / price * 100).toFixed(2), methodText: this.data.methods[this.data.methodIndex]
      };
      result.message = `车辆价格：${format.money(price)}元\n首付：${result.downRateText}% / ${result.downText}元\n贷款金额：${result.loanText}元\n期数：${terms}个月\n计息方式：${result.methodText}\n参考月供：${result.paymentText}元\n押金：${Number(form.depositMonths || 0)}个月\n总利息：${result.interestText}元`;
      this.setData({ result });
    } catch (_error) { this.setData({ result: null }); }
  },
  copyPlan() { if (this.data.result) wx.setClipboardData({ data: this.data.result.message }); },
  onLateField(event) { this.setData({ [`late.${event.currentTarget.dataset.key}`]: event.detail.value }); this.calculateLateFee(); },
  onLateDate(event) { this.setData({ [`late.${event.currentTarget.dataset.key}`]: event.detail.value }); this.calculateLateFee(); },
  calculateLateFee() {
    try {
      const form = this.data.late;
      const amount = domain.yuanToCents(form.amount);
      const rate = domain.percentToBps(form.rate);
      const days = Math.max(0, domain.daysBetweenDateKeys(form.payDate, form.dueDate));
      const fee = domain.calculateLateFeeCents(amount, rate, days);
      const result = { days, feeText: format.money(fee), totalText: format.money(amount + fee) };
      result.message = `本期应付款：${format.money(amount)}元\n应付日期：${form.dueDate}\n计算日期：${form.payDate}\n逾期天数：${days}天\n参考滞纳金：${result.feeText}元\n参考合计：${result.totalText}元`;
      this.setData({ lateResult: result });
    } catch (_error) { this.setData({ lateResult: null }); }
  },
  copyLateFee() { if (this.data.lateResult) wx.setClipboardData({ data: this.data.lateResult.message }); }
});
