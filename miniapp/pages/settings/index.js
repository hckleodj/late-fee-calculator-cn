'use strict';

const api = require('../../shared/api');
const format = require('../../shared/format');
const config = require('../../config');

Page({
  data: {
    config,
    session: null,
    loading: true,
    error: '',
    backupText: '',
    preview: null,
    migrationResult: null,
    exporting: false,
    importing: false
  },
  onShow() { this.loadSession(); },
  async loadSession() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ session: await api.call('session') }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ loading: false }); }
  },
  onBackupText(event) { this.setData({ backupText: event.detail.value, preview: null, migrationResult: null }); },
  async previewMigration() {
    if (!this.data.backupText.trim()) return api.showError(new Error('请粘贴旧网页导出的完整备份文本或JSON。'));
    this.setData({ importing: true });
    try {
      const preview = await api.call('migration.preview', { backup: this.data.backupText });
      preview.summary.receivedText = format.money(preview.summary.receivedCents);
      preview.summary.principalText = format.money(preview.summary.contractPrincipalCents);
      preview.summary.interestText = format.money(preview.summary.scheduledInterestCents);
      this.setData({ preview });
    } catch (error) { api.showError(error); }
    finally { this.setData({ importing: false }); }
  },
  importMigration() {
    const preview = this.data.preview;
    if (!preview) return;
    wx.showModal({
      title: '确认导入云数据库',
      content: `将导入${preview.summary.customers}位客户、${preview.summary.contracts}份合同。重复旧ID会跳过，不会覆盖云端已有数据。`,
      confirmText: '确认导入',
      success: async result => {
        if (!result.confirm) return;
        this.setData({ importing: true });
        try {
          const migrationResult = await api.call('migration.import', { backup: this.data.backupText });
          this.setData({ migrationResult });
          wx.showToast({ title: '导入处理完成' });
        } catch (error) { api.showError(error); }
        finally { this.setData({ importing: false }); }
      }
    });
  },
  async exportBackup() {
    this.setData({ exporting: true });
    try {
      const backup = await api.call('backup.export');
      const text = `【大进车贷助手云端备份】\n版本：v2\n导出时间：${backup.exportedAt}\n校验值：${backup.checksum}\n数据：\n${JSON.stringify(backup, null, 2)}`;
      await new Promise((resolve, reject) => wx.setClipboardData({ data: text, success: resolve, fail: reject }));
      wx.showModal({ title: '备份已复制', content: '请粘贴到微信文件传输助手或受保护的文件中保存。备份包含客户交易资料，请勿转发。', showCancel: false });
    } catch (error) { api.showError(error); }
    finally { this.setData({ exporting: false }); }
  }
});
