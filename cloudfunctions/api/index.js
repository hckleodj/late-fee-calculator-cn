'use strict';

const cloud = require('wx-server-sdk');
const { createApi } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const api = createApi({
  db: cloud.database(),
  getTrustedIdentity() {
    const context = cloud.getWXContext();
    return {
      openId: context.OPENID || '',
      appId: context.APPID || '',
      unionId: context.UNIONID || ''
    };
  },
  getAdminOpenIds() {
    return String(process.env.ADMIN_OPENIDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  }
});

exports.main = async event => api.handle(event || {});
