'use strict';

const api = require('../../shared/api');
const domain = require('../../shared/domain');
const format = require('../../shared/format');

Page({
  data: {
    saving: false,
    interestMethods: ['平息 / 固定月息', '标准等额本息'],
    interestMethodIndex: 0,
    preview: null,
    form: {
      name: '', plate: '', vehicle: '', notes: '',
      vehiclePrice: '91800', downPaymentRate: '15', monthlyRate: '1.25', terms: '36',
      depositMonths: '1', dueDay: '5', startDateKey: format.todayDateKey(), dailyLateFeeRate: '0.5'
    }
  },
  onLoad() { this.calculatePreview(); },
  onField(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [`form.${key}`]: event.detail.value });
    if (['vehiclePrice', 'downPaymentRate', 'monthlyRate', 'terms'].includes(key)) this.calculatePreview();
  },
  onMethod(event) {
    this.setData({ interestMethodIndex: Number(event.detail.value) });
    this.calculatePreview();
  },
  onStartDate(event) { this.setData({ 'form.startDateKey': event.detail.value }); },
  calculatePreview() {
    try {
      const form = this.data.form;
      const price = domain.yuanToCents(form.vehiclePrice);
      const downRate = domain.percentToBps(form.downPaymentRate);
      const down = Math.round(price * downRate / 10000);
      const loan = price - down;
      const rate = domain.percentToBps(form.monthlyRate);
      const terms = Number(form.terms);
      const method = this.data.interestMethodIndex === 1 ? 'annuity' : 'flat';
      const payment = domain.calculateMonthlyPaymentCents(loan, rate, terms, method);
      this.setData({ preview: {
        loanText: format.money(loan),
        downText: format.money(down),
        paymentText: format.money(payment)
      }});
    } catch (_error) {
      this.setData({ preview: null });
    }
  },
  async submit() {
    if (this.data.saving) return;
    const form = this.data.form;
    if (!form.name.trim()) return api.showError(new Error('请填写客户姓名。'));
    this.setData({ saving: true });
    try {
      const customer = await api.call('customers.save', {
        name: form.name,
        plate: form.plate,
        vehicle: form.vehicle,
        notes: form.notes
      });
      await api.call('contracts.create', {
        customerId: customer.customerId,
        interestMethod: this.data.interestMethodIndex === 1 ? 'annuity' : 'flat',
        vehiclePriceCents: domain.yuanToCents(form.vehiclePrice),
        downPaymentRateBps: domain.percentToBps(form.downPaymentRate),
        monthlyRateBps: domain.percentToBps(form.monthlyRate),
        terms: Number(form.terms),
        depositMonths: Number(form.depositMonths || 0),
        dueDay: Number(form.dueDay),
        startDateKey: form.startDateKey,
        dailyLateFeeRateBps: domain.percentToBps(form.dailyLateFeeRate || 0)
      });
      wx.showToast({ title: '客户合同已建立', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/customer-detail/index?customerId=${customer.customerId}` }), 500);
    } catch (error) {
      api.showError(error);
    } finally {
      this.setData({ saving: false });
    }
  }
});
