'use strict';

const config = require('../config');

async function call(action, payload = {}) {
  if (!config.envId) {
    const error = new Error('尚未配置云开发环境ID。');
    error.code = 'ENV_NOT_CONFIGURED';
    throw error;
  }
  const result = await wx.cloud.callFunction({
    name: config.cloudFunctionName,
    data: { action, payload }
  });
  const response = result.result;
  if (!response || !response.ok) {
    const error = new Error(response && response.error && response.error.message || '云端请求失败。');
    error.code = response && response.error && response.error.code || 'CLOUD_ERROR';
    error.details = response && response.error && response.error.details;
    throw error;
  }
  return response.data;
}

function showError(error) {
  wx.showModal({
    title: '操作未完成',
    content: error && error.message || '请稍后重试。',
    showCancel: false
  });
}

module.exports = { call, showError };
