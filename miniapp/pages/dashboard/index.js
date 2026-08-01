'use strict';

const api = require('../../shared/api');
const format = require('../../shared/format');

function groupOverdue(items) {
  const groups = new Map();
  items.forEach(item => {
    const key = item.customerId;
    if (!groups.has(key)) groups.set(key, {
      customerId: key,
      customer: item.customer,
      items: [],
      remainingContractCents: 0,
      lateFeeCents: 0,
      totalCents: 0,
      maxDays: 0
    });
    const group = groups.get(key);
    group.items.push(item);
    group.remainingContractCents += item.remainingContractCents;
    group.lateFeeCents += item.lateFeeCents;
    group.totalCents += item.remainingContractCents + item.lateFeeCents;
    group.maxDays = Math.max(group.maxDays, item.daysOverdue);
  });
  return [...groups.values()].sort((a, b) => b.maxDays - a.maxDays);
}

Page({
  data: {
    loading: true,
    error: '',
    todayDateKey: '',
    today: [],
    upcoming: [],
    overdueGroups: [],
    counts: { today: 0, upcoming: 0, overdue: 0 }
  },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const todayDateKey = format.todayDateKey();
    this.setData({ loading: true, error: '', todayDateKey });
    try {
      const result = await api.call('dashboard.list', { todayDateKey });
      const today = result.today.map(item => ({ ...item, amountText: format.money(item.remainingContractCents) }));
      const upcoming = result.upcoming.map(item => ({ ...item, amountText: format.money(item.remainingContractCents) }));
      const overdueGroups = groupOverdue(result.overdue).map(group => ({
        ...group,
        remainingText: format.money(group.remainingContractCents),
        lateFeeText: format.money(group.lateFeeCents),
        totalText: format.money(group.totalCents)
      }));
      this.setData({
        today,
        upcoming,
        overdueGroups,
        counts: { today: today.length, upcoming: upcoming.length, overdue: overdueGroups.length }
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  openCustomer(event) {
    wx.navigateTo({ url: `/pages/customer-detail/index?customerId=${event.currentTarget.dataset.id}` });
  }
});
