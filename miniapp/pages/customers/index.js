'use strict';

const api = require('../../shared/api');

Page({
  data: { loading: true, keyword: '', customers: [], error: '' },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onKeyword(event) { this.setData({ keyword: event.detail.value }); },
  search() { this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      this.setData({ customers: await api.call('customers.list', { keyword: this.data.keyword }) });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  addCustomer() { wx.navigateTo({ url: '/pages/customer-edit/index' }); },
  openCustomer(event) { wx.navigateTo({ url: `/pages/customer-detail/index?customerId=${event.currentTarget.dataset.id}` }); }
});
