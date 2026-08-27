(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinLocalSnapshots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SNAPSHOTS_KEY = 'dajinLocalSnapshotsRc1MigrationTestV1';
  const MAX_SNAPSHOTS = 10;

  function isHash(value) {
    return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  }

  function isSnapshot(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.id === 'string' && value.id.length > 0
      && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
      && Number.isInteger(value.dataRevision) && value.dataRevision >= 0
      && isHash(value.hash) && Array.isArray(value.plans)
      && (value.reason === 'business-change' || value.reason === 'before-restore');
  }

  class LocalSnapshotManager {
    constructor(options = {}) {
      this.storage = options.storage || globalThis.localStorage;
      this.storageKey = options.storageKey || SNAPSHOTS_KEY;
      this.maxSnapshots = options.maxSnapshots || MAX_SNAPSHOTS;
      this.hashText = options.hashText;
      this.now = options.now || (() => Date.now());
      this.lastError = null;
      this.lastStorageWriteError = null;
      this.lastCaptureResult = null;
      this.pending = Promise.resolve();
      this.sequence = 0;
    }

    read() {
      try {
        const raw = this.storage.getItem(this.storageKey);
        if (raw === null) return [];
        const value = JSON.parse(raw);
        if (!Array.isArray(value)) throw new Error('本地历史版本格式异常。');
        return value.filter(isSnapshot);
      } catch (error) {
        this.lastError = error;
        return [];
      }
    }

    write(items) {
      try {
        this.storage.setItem(this.storageKey, JSON.stringify(items.slice(-this.maxSnapshots)));
        this.lastStorageWriteError = null;
        return true;
      } catch (error) {
        this.lastError = error;
        this.lastStorageWriteError = error;
        return false;
      }
    }

    calculateHash(raw) {
      if (typeof this.hashText !== 'function') return Promise.reject(new Error('快照哈希模块不可用。'));
      return Promise.resolve(this.hashText(raw));
    }

    capture(rawData, dataRevision, expectedHash = null, reason = 'business-change') {
      const raw = String(rawData == null ? '' : rawData);
      this.pending = this.pending.catch(() => null).then(async () => {
        let plans;
        try { plans = JSON.parse(raw); }
        catch (error) { this.lastError = error; return { ok: false, reason: 'invalid-data' }; }
        if (!Array.isArray(plans) || !Number.isInteger(dataRevision) || dataRevision < 0) {
          return { ok: false, reason: 'invalid-data' };
        }
        const hash = await this.calculateHash(raw);
        if (expectedHash && expectedHash !== hash) return { ok: false, reason: 'hash-mismatch' };
        const nowMs = this.now();
        if (!Number.isFinite(nowMs)) return { ok: false, reason: 'invalid-time' };
        const snapshot = {
          id: `${nowMs}-${dataRevision}-${++this.sequence}`,
          createdAt: new Date(nowMs).toISOString(),
          dataRevision,
          hash,
          plans: JSON.parse(JSON.stringify(plans)),
          reason: reason === 'before-restore' ? 'before-restore' : 'business-change'
        };
        const items = this.read();
        items.push(snapshot);
        if (!this.write(items)) return { ok: false, reason: 'storage-write-failed' };
        return { ok: true, snapshot };
      }).catch(error => {
        this.lastError = error;
        return { ok: false, reason: 'capture-failed' };
      }).then(result => {
        this.lastCaptureResult = result;
        return result;
      });
      return this.pending;
    }

    async getValidSnapshot(id) {
      const snapshot = this.read().find(item => item.id === id);
      if (!snapshot) return null;
      try {
        const raw = JSON.stringify(snapshot.plans);
        const hash = await this.calculateHash(raw);
        return hash === snapshot.hash ? JSON.parse(JSON.stringify(snapshot)) : null;
      } catch (error) {
        this.lastError = error;
        return null;
      }
    }

    async listValid() {
      const valid = [];
      for (const item of this.read()) {
        const checked = await this.getValidSnapshot(item.id);
        if (checked) valid.push(checked);
      }
      return valid.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }

    whenIdle() { return this.pending; }
  }

  return { LocalSnapshotManager, MAX_SNAPSHOTS, SNAPSHOTS_KEY, isSnapshot };
});
