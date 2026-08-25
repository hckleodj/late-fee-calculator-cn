(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinBackupState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_KEY = 'dajinBackupStateV1';
  const PLAN_KEY = 'lateFeePaymentPlansV1';
  const LEGACY_DIRTY_KEY = 'lateFeeBackupDirtyV1';
  const BACKUP_VERSION = 1;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function defaultState() {
    return {
      lastBackupAt: null,
      lastDataChangeAt: null,
      dirtySinceBackup: true,
      backupVersion: BACKUP_VERSION,
      dataRevision: 0,
      lastBackedUpRevision: 0,
      lastBackupHash: null,
      lastBackupMethod: null
    };
  }

  function isRevision(value) {
    return Number.isInteger(value) && value >= 0;
  }

  function isIsoTimeOrNull(value) {
    return value === null || (typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value)));
  }

  function isHashOrNull(value) {
    return value === null || (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value));
  }

  function normalizeState(input) {
    const fallback = defaultState();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { state: fallback, invalid: true };
    }

    const required = Object.keys(fallback);
    let invalid = required.some(key => !Object.prototype.hasOwnProperty.call(input, key));
    const state = {
      lastBackupAt: isIsoTimeOrNull(input.lastBackupAt) ? input.lastBackupAt : null,
      lastDataChangeAt: isIsoTimeOrNull(input.lastDataChangeAt) ? input.lastDataChangeAt : null,
      dirtySinceBackup: typeof input.dirtySinceBackup === 'boolean' ? input.dirtySinceBackup : true,
      backupVersion: input.backupVersion === BACKUP_VERSION ? BACKUP_VERSION : BACKUP_VERSION,
      dataRevision: isRevision(input.dataRevision) ? input.dataRevision : 0,
      lastBackedUpRevision: isRevision(input.lastBackedUpRevision) ? input.lastBackedUpRevision : 0,
      lastBackupHash: isHashOrNull(input.lastBackupHash) ? input.lastBackupHash : null,
      lastBackupMethod: input.lastBackupMethod === null || typeof input.lastBackupMethod === 'string' ? input.lastBackupMethod : null
    };

    invalid ||= !isIsoTimeOrNull(input.lastBackupAt);
    invalid ||= !isIsoTimeOrNull(input.lastDataChangeAt);
    invalid ||= typeof input.dirtySinceBackup !== 'boolean';
    invalid ||= input.backupVersion !== BACKUP_VERSION;
    invalid ||= !isRevision(input.dataRevision);
    invalid ||= !isRevision(input.lastBackedUpRevision);
    invalid ||= !isHashOrNull(input.lastBackupHash);
    invalid ||= !(input.lastBackupMethod === null || typeof input.lastBackupMethod === 'string');
    invalid ||= state.lastBackedUpRevision > state.dataRevision;

    if (invalid) {
      state.dirtySinceBackup = true;
      if (state.lastBackedUpRevision >= state.dataRevision) {
        state.dataRevision = state.lastBackedUpRevision + 1;
      }
    }
    return { state, invalid };
  }

  async function sha256Text(text) {
    if (!globalThis.crypto || !globalThis.crypto.subtle || typeof TextEncoder === 'undefined') {
      throw new Error('当前浏览器不支持稳定哈希计算。');
    }
    const bytes = new TextEncoder().encode(String(text == null ? '' : text));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  class BackupStateManager {
    constructor(options = {}) {
      this.storage = options.storage || globalThis.localStorage;
      this.stateKey = options.stateKey || STATE_KEY;
      this.planKey = options.planKey || PLAN_KEY;
      this.legacyDirtyKey = options.legacyDirtyKey || LEGACY_DIRTY_KEY;
      this.now = options.now || (() => Date.now());
      this.hashText = options.hashText || sha256Text;
      this.onChange = options.onChange || (() => {});
      this.currentDataHash = null;
      this.metadataInvalid = false;
      this.lastError = null;
      this.hashSequence = 0;
      this.pending = Promise.resolve();
      const loaded = this.readStoredState();
      this.state = loaded.state;
      this.metadataInvalid = loaded.invalid;
    }

    readStoredState() {
      try {
        const raw = this.storage.getItem(this.stateKey);
        if (raw === null) return { state: defaultState(), invalid: true };
        try { return normalizeState(JSON.parse(raw)); }
        catch (_error) { return { state: defaultState(), invalid: true }; }
      } catch (error) {
        this.lastError = error;
        return { state: defaultState(), invalid: true };
      }
    }

    legacyDirty() {
      try { return this.storage.getItem(this.legacyDirtyKey) === '1'; }
      catch (_error) { return true; }
    }

    persist() {
      try {
        this.storage.setItem(this.stateKey, JSON.stringify(this.state));
        return true;
      } catch (error) {
        this.lastError = error;
        this.state.dirtySinceBackup = true;
        return false;
      }
    }

    notify() {
      try { this.onChange(this.snapshot()); }
      catch (_error) { /* Debug rendering must never affect business data. */ }
    }

    initialize(rawData) {
      const raw = String(rawData == null ? '' : rawData);
      if (this.metadataInvalid || this.legacyDirty()) this.state.dirtySinceBackup = true;
      if (this.metadataInvalid && rawData !== null && this.state.dataRevision === 0) this.state.dataRevision = 1;
      this.persist();
      this.pending = this.calculateCurrentHash(raw).then(hash => {
        if (hash !== this.state.lastBackupHash) {
          this.state.dirtySinceBackup = true;
          if (this.state.dataRevision <= this.state.lastBackedUpRevision) {
            this.state.dataRevision = this.state.lastBackedUpRevision + 1;
          }
        }
        if (this.state.dataRevision !== this.state.lastBackedUpRevision) this.state.dirtySinceBackup = true;
        if (!this.timestampsAreConsistent()) this.state.dirtySinceBackup = true;
        if (!this.state.dirtySinceBackup && (!this.state.lastBackupHash || !this.state.lastBackupAt)) {
          this.state.dirtySinceBackup = true;
        }
        this.persist();
        this.notify();
        return this.snapshot();
      }).catch(error => {
        this.lastError = error;
        this.currentDataHash = null;
        this.state.dirtySinceBackup = true;
        this.persist();
        this.notify();
        return this.snapshot();
      });
      this.notify();
      return this.pending;
    }

    timestampsAreConsistent(nowMs = this.now()) {
      if (!Number.isFinite(nowMs)) return false;
      const backupTime = this.state.lastBackupAt === null ? null : Date.parse(this.state.lastBackupAt);
      const changeTime = this.state.lastDataChangeAt === null ? null : Date.parse(this.state.lastDataChangeAt);
      if (backupTime !== null && (!Number.isFinite(backupTime) || backupTime > nowMs)) return false;
      if (changeTime !== null && (!Number.isFinite(changeTime) || changeTime > nowMs)) return false;
      if (!this.state.dirtySinceBackup && changeTime !== null && backupTime !== null && changeTime > backupTime) return false;
      return true;
    }

    calculateCurrentHash(rawData) {
      const sequence = ++this.hashSequence;
      return Promise.resolve(this.hashText(String(rawData == null ? '' : rawData))).then(hash => {
        if (sequence === this.hashSequence) this.currentDataHash = hash;
        return hash;
      });
    }

    recordDataChange(rawData) {
      const nowMs = this.now();
      const nowIso = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null;
      this.state.dirtySinceBackup = true;
      this.state.lastDataChangeAt = nowIso;
      this.state.dataRevision = Math.max(this.state.dataRevision, this.state.lastBackedUpRevision) + 1;
      try { this.storage.setItem(this.legacyDirtyKey, '1'); }
      catch (error) { this.lastError = error; }
      this.persist();
      this.pending = this.calculateCurrentHash(rawData).catch(error => {
        this.lastError = error;
        this.currentDataHash = null;
        this.state.dirtySinceBackup = true;
        this.persist();
        return null;
      }).then(() => {
        this.notify();
        return this.snapshot();
      });
      this.notify();
      return this.pending;
    }

    needsBackup(nowMs = this.now()) {
      if (this.metadataInvalid || !this.state || typeof this.state.dirtySinceBackup !== 'boolean') return true;
      if (!this.state.dirtySinceBackup) {
        if (!this.state.lastBackupAt || !this.state.lastBackupHash) return true;
        if (this.state.dataRevision !== this.state.lastBackedUpRevision) return true;
        return !this.timestampsAreConsistent(nowMs);
      }
      if (!Number.isFinite(nowMs)) return true;
      if (!this.state.lastBackupAt) return true;
      const lastBackupTime = Date.parse(this.state.lastBackupAt);
      if (!Number.isFinite(lastBackupTime) || lastBackupTime > nowMs) return true;
      if (!this.timestampsAreConsistent(nowMs)) return true;
      return nowMs - lastBackupTime >= DAY_MS;
    }

    snapshot() {
      return {
        ...this.state,
        currentDataHash: this.currentDataHash,
        needsBackup: this.needsBackup(),
        metadataInvalid: this.metadataInvalid,
        lastError: this.lastError ? String(this.lastError.message || this.lastError) : null
      };
    }

    whenIdle() {
      return this.pending;
    }
  }

  return {
    BackupStateManager,
    BACKUP_VERSION,
    DAY_MS,
    LEGACY_DIRTY_KEY,
    PLAN_KEY,
    STATE_KEY,
    defaultState,
    normalizeState,
    sha256Text
  };
});
