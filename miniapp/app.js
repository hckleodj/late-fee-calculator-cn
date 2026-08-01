'use strict';

const config = require('./config');

App({
  globalData: {
    config,
    session: null
  },
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: '基础库版本过低', content: '请升级微信后再使用云开发功能。', showCancel: false });
      return;
    }
    wx.cloud.init({
      env: config.envId || undefined,
      traceUser: true
    });
  }
});
