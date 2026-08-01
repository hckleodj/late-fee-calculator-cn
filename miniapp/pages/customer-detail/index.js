'use strict';

const api = require('../../shared/api');
const domain = require('../../shared/domain');
const format = require('../../shared/format');

function decoratePlan(row) {
  const remaining = domain.remainingContractCents(row);
  return {
    ...row,
    scheduledText: format.money(row.scheduledAmountCents),
    remainingText: format.money(remaining),
    paidText: format.money((row.paidPrincipalCents || 0) + (row.paidInterestCents || 0)),
    statusText: row.status === 'paid' ? '已结清' : row.status === 'partial' ? '部分还款' : '待还'
  };
}

Page({
  data: {
    customerId: '', loading: true, error: '', detail: null, settlement: null,
    paymentForm: { amount: '', lateFee: '0', receivedDateKey: format.todayDateKey(), startTermNo: '1', notes: '' },
    depositForm: { amount: '', directionIndex: 0, occurredDateKey: format.todayDateKey(), notes: '' },
    depositDirections: ['收取押金', '退还/支出押金'],
    savingPayment: false,
    savingDeposit: false
  },
  onLoad(options) { this.setData({ customerId: options.customerId || '' }); },
  onShow() { if (this.data.customerId) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await api.call('customers.detail', { customerId: this.data.customerId });
      detail.repaymentPlans = detail.repaymentPlans.map(decoratePlan);
      detail.payments = detail.payments.map(item => ({
        ...item,
        amountText: format.money(item.amountCents),
        lateFeeText: format.money(item.lateFeeCents)
      }));
      detail.deposits = detail.deposits.map(item => ({ ...item, amountText: format.money(item.amountCents) }));
      if (detail.contract) {
        detail.contract.vehiclePriceText = format.money(detail.contract.vehiclePriceCents);
        detail.contract.principalText = format.money(detail.contract.principalCents);
        detail.contract.paymentText = format.money(detail.contract.quotedMonthlyPaymentCents);
        detail.contract.methodText = detail.contract.interestMethod === 'annuity' ? '标准等额本息' : '平息 / 固定月息';
      }
      const next = detail.repaymentPlans.find(row => row.status !== 'paid');
      this.setData({
        detail,
        'paymentForm.startTermNo': String(next ? next.termNo : 1),
        'paymentForm.amount': next ? String(domain.centsToYuan(domain.remainingContractCents(next))) : ''
      });
      if (detail.contract) await this.loadSettlement(detail.contract._id);
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  async loadSettlement(contractId) {
    const result = await api.call('settlement.get', { contractId });
    this.setData({ settlement: {
      ...result,
      paidPrincipalText: format.money(result.paidPrincipalCents),
      paidInterestText: format.money(result.paidInterestCents),
      remainingPrincipalText: format.money(result.remainingPrincipalCents),
      remainingInterestText: format.money(result.remainingInterestCents),
      contractSettlementText: format.money(result.contractSettlementCents),
      depositBalanceText: format.money(result.depositBalanceCents)
    }});
  },
  onPaymentField(event) { this.setData({ [`paymentForm.${event.currentTarget.dataset.key}`]: event.detail.value }); },
  onPaymentDate(event) { this.setData({ 'paymentForm.receivedDateKey': event.detail.value }); },
  async savePayment() {
    if (this.data.savingPayment || !this.data.detail.contract) return;
    this.setData({ savingPayment: true });
    try {
      const form = this.data.paymentForm;
      await api.call('payments.record', {
        contractId: this.data.detail.contract._id,
        amountCents: domain.yuanToCents(form.amount),
        lateFeeCents: domain.yuanToCents(form.lateFee || 0),
        receivedDateKey: form.receivedDateKey,
        startTermNo: Number(form.startTermNo),
        notes: form.notes
      });
      wx.showToast({ title: '收款已登记' });
      await this.load();
    } catch (error) { api.showError(error); }
    finally { this.setData({ savingPayment: false }); }
  },
  reversePayment(event) {
    const paymentId = event.currentTarget.dataset.id;
    wx.showModal({
      title: '撤销收款记录',
      content: '撤销后各期欠款会自动恢复，原记录仍保留在审计日志中。',
      success: async result => {
        if (!result.confirm) return;
        try {
          await api.call('payments.reverse', { paymentId, reason: '管理员在小程序中撤销' });
          wx.showToast({ title: '已撤销' });
          await this.load();
        } catch (error) { api.showError(error); }
      }
    });
  },
  onDepositField(event) { this.setData({ [`depositForm.${event.currentTarget.dataset.key}`]: event.detail.value }); },
  onDepositDirection(event) { this.setData({ 'depositForm.directionIndex': Number(event.detail.value) }); },
  onDepositDate(event) { this.setData({ 'depositForm.occurredDateKey': event.detail.value }); },
  async saveDeposit() {
    if (this.data.savingDeposit || !this.data.detail.contract) return;
    this.setData({ savingDeposit: true });
    try {
      const form = this.data.depositForm;
      await api.call('deposits.record', {
        contractId: this.data.detail.contract._id,
        amountCents: domain.yuanToCents(form.amount),
        direction: form.directionIndex === 1 ? 'out' : 'in',
        occurredDateKey: form.occurredDateKey,
        notes: form.notes
      });
      wx.showToast({ title: '押金已登记' });
      this.setData({ 'depositForm.amount': '', 'depositForm.notes': '' });
      await this.load();
    } catch (error) { api.showError(error); }
    finally { this.setData({ savingDeposit: false }); }
  },
  copyOverdueMessage() {
    const detail = this.data.detail;
    const today = format.todayDateKey();
    const overdue = detail.repaymentPlans.filter(row => row.status !== 'paid' && domain.daysBetweenDateKeys(row.dueDateKey, today) < 0);
    if (!overdue.length) return wx.showToast({ title: '当前没有逾期账单', icon: 'none' });
    let contractTotal = 0;
    let feeTotal = 0;
    const lines = overdue.map(row => {
      const remaining = domain.remainingContractCents(row);
      const days = -domain.daysBetweenDateKeys(row.dueDateKey, today);
      const fee = domain.calculateLateFeeCents(remaining, row.dailyLateFeeRateBps || 0, days);
      contractTotal += remaining; feeTotal += fee;
      return `第${row.termNo}期：应付日${row.dueDateKey}，逾期${days}天，剩余${format.money(remaining)}元，参考滞纳金${format.money(fee)}元`;
    });
    const text = `您好，${detail.customer.name}，您目前有${overdue.length}期车辆款项已逾期。\n\n${lines.join('\n')}\n\n逾期未付合同款：${format.money(contractTotal)}元\n参考滞纳金：${format.money(feeTotal)}元\n合计应付：${format.money(contractTotal + feeTotal)}元\n\n请您今天安排付款，谢谢。`;
    wx.setClipboardData({ data: text });
  },
  copySettlement() {
    const detail = this.data.detail;
    const value = this.data.settlement;
    if (!value) return;
    const text = `${detail.customer.name}合同结清核算\n剩余本金：${value.remainingPrincipalText}元\n剩余合同利息：${value.remainingInterestText}元\n合同结清参考：${value.contractSettlementText}元\n押金余额：${value.depositBalanceText}元\n押金不自动抵扣，最终以合同及双方确认为准。`;
    wx.setClipboardData({ data: text });
  }
});
