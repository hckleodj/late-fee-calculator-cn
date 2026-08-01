'use strict';

const cloud = require('wx-server-sdk');
const { createApi } = require('./service');
const { createWebHandler } = require('./web');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const api = createApi({
  db,
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

const webHandler = createWebHandler({
  env: process.env,
  createScopedApi(ownerId) {
    return createApi({
      db,
      getTrustedIdentity() { return { openId: ownerId, appId: 'cloudbase-web' }; },
      getAdminOpenIds() { return [ownerId]; }
    });
  }
});

exports.main = async event => {
  const value = event || {};
  const isHttp = Boolean(value.httpMethod || value.requestContext || (value.headers && Object.prototype.hasOwnProperty.call(value, 'body')));
  return isHttp ? webHandler(value) : api.handle(value);
};
