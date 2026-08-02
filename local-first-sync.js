'use strict';

(() => {
  const API_URL = 'https://dajin-car-loan-v09-d5c3yb395b1ee-1461974653.ap-shanghai.app.tcloudbase.com/api';
  const TOKEN_KEY = 'dajinLocalFirstSessionV1';
  const LEGACY_TOKEN_KEY = 'dajinWebSession';
  const OUTBOX_KEY = 'dajinLocalFirstOutboxV1';
  const SNAPSHOT_KEY = 'dajinLocalFirstSnapshotV1';
  const DEVICE_KEY = 'dajinLocalFirstDeviceV1';
  const CLOCK_KEY = 'dajinLocalFirstClockV1';
  const MAX_BATCH = 50;
  let syncing = false;
  let rerunRequested = false;
  let retryTimer = 0;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function deviceId() {
    let value = localStorage.getItem(DEVICE_KEY);
    if (!value) {
      value = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, value);
    }
    return value;
  }

  function nextChangedAt() {
    const previous = Number(localStorage.getItem(CLOCK_KEY) || 0);
    const value = Math.max(Date.now(), previous + 1);
    localStorage.setItem(CLOCK_KEY, String(value));
    return value;
  }

  function outbox() {
    const value = readJson(OUTBOX_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  function saveOutbox(value) {
    writeJson(OUTBOX_KEY, value);
  }

  function statusButton() {
    return document.getElementById('sync-status-button');
  }

  function sessionToken() {
    let token = sessionStorage.getItem(TOKEN_KEY) || '';
    if (!token) {
      token = sessionStorage.getItem(LEGACY_TOKEN_KEY) || '';
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
    }
    return token;
  }

  function setStatus(state, text, detail = '') {
    const button = statusButton();
    if (!button) return;
    button.dataset.state = state;
    button.textContent = text;
    button.title = detail || text;
    const detailNode = document.getElementById('sync-detail');
    if (detailNode) detailNode.textContent = detail || text;
  }

  function operationFor(type, planId, plan) {
    const changedAt = nextChangedAt();
    const id = deviceId();
    return {
      opId: `${id}:${changedAt.toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      type,
      planId,
      changedAt,
      ...(plan ? { plan: clone(plan) } : {})
    };
  }

  function planMap(plans) {
    return new Map((Array.isArray(plans) ? plans : []).map(plan => [plan.id, plan]));
  }

  function queueDiff(plans, forceAll = false) {
    const previousPlans = forceAll ? [] : readJson(SNAPSHOT_KEY, []);
    const previous = planMap(previousPlans);
    const current = planMap(plans);
    const queued = new Map(outbox().map(operation => [operation.planId, operation]));
    for (const [id, plan] of current) {
      const before = previous.get(id);
      if (forceAll || !before || JSON.stringify(before) !== JSON.stringify(plan)) {
        queued.set(id, operationFor('plan.upsert', id, plan));
      }
    }
    for (const id of previous.keys()) {
      if (!current.has(id)) queued.set(id, operationFor('plan.delete', id));
    }
    saveOutbox([...queued.values()]);
    writeJson(SNAPSHOT_KEY, plans);
  }

  function applyOperations(plans, operations) {
    const value = planMap(plans);
    for (const operation of operations) {
      if (operation.type === 'plan.delete') value.delete(operation.planId);
      else if (operation.type === 'plan.upsert' && operation.plan) value.set(operation.planId, clone(operation.plan));
    }
    return [...value.values()];
  }

  function replaceLocal(plans) {
    const cleanPlans = clone(Array.isArray(plans) ? plans : []);
    window.DajinLocalFirstApp.replacePlans(cleanPlans);
    writeJson(SNAPSHOT_KEY, cleanPlans);
  }

  async function apiCall(action, payload = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const token = sessionToken();
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ action, payload }),
        cache: 'no-store',
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('同步超时，将自动重试。');
      throw new Error('网络不可用，数据已保存在本地。');
    } finally {
      clearTimeout(timeout);
    }
    let result;
    try { result = await response.json(); }
    catch (_error) { throw new Error('云端返回内容无法识别。'); }
    if (!response.ok || !result.ok) {
      const error = new Error(result.error && result.error.message || '云同步失败。');
      error.code = result.error && result.error.code;
      error.details = result.error && result.error.details;
      if (response.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(LEGACY_TOKEN_KEY);
      }
      throw error;
    }
    return result.data;
  }

  async function pushPending() {
    let pending = outbox();
    while (pending.length) {
      const batch = pending.slice(0, MAX_BATCH);
      const result = await apiCall('sync.push', { operations: batch }, 20000);
      const acknowledged = new Set(result.acknowledgedOpIds || batch.map(item => item.opId));
      pending = outbox().filter(item => !acknowledged.has(item.opId));
      saveOutbox(pending);
      replaceLocal(applyOperations(result.plans || [], pending));
    }
  }

  async function pullAndMerge() {
    let pending = outbox();
    if (pending.length) {
      await pushPending();
      return;
    }
    const remote = await apiCall('sync.pull');
    pending = outbox();
    const localPlans = window.DajinLocalFirstApp.getPlans();
    if (!remote.initialized) {
      if (!pending.length && localPlans.length) {
        queueDiff(localPlans, true);
        pending = outbox();
      }
      if (pending.length) await pushPending();
      return;
    }
    replaceLocal(applyOperations(remote.plans || [], pending));
    if (pending.length) await pushPending();
  }

  function scheduleRetry(delayMs = 30000) {
    clearTimeout(retryTimer);
    if (!outbox().length) return;
    retryTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') syncNow();
      else scheduleRetry(delayMs);
    }, delayMs);
  }

  async function syncNow() {
    if (syncing) {
      rerunRequested = true;
      return;
    }
    if (!sessionToken()) {
      setStatus(outbox().length ? 'pending' : 'login', outbox().length ? '待登录同步' : '登录同步', '本地功能可正常使用；登录后同步到其他设备。');
      return;
    }
    if (!navigator.onLine) {
      setStatus('pending', '待同步', '当前离线，数据已保存在本机，联网后自动重试。');
      scheduleRetry();
      return;
    }
    syncing = true;
    setStatus('syncing', '同步中…', '页面已经可以继续操作，云同步在后台进行。');
    try {
      await pullAndMerge();
      setStatus('synced', '已同步', `本地已保存，云端同步完成${outbox().length ? '，仍有少量操作待重试' : ''}。`);
    } catch (error) {
      if (error.code === 'UNAUTHENTICATED') {
        setStatus('pending', '待登录同步', '登录已失效；本地功能不受影响，重新登录后自动同步。');
      } else {
        setStatus('pending', '待同步', error.message);
      }
      scheduleRetry();
    } finally {
      syncing = false;
      if (rerunRequested) {
        rerunRequested = false;
        queueMicrotask(syncNow);
      }
    }
  }

  function recordLocalChange(plans) {
    queueDiff(plans);
    setStatus('pending', '待同步', '本地已保存，正在等待云端同步。');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(syncNow, 350);
  }

  function openLogin() {
    const dialog = document.getElementById('sync-login-dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  function bindUi() {
    const button = statusButton();
    const dialog = document.getElementById('sync-login-dialog');
    const form = document.getElementById('sync-login-form');
    const close = document.getElementById('close-sync-login');
    if (button) button.addEventListener('click', () => sessionToken() ? syncNow() : openLogin());
    if (close) close.addEventListener('click', () => dialog.close());
    if (form) form.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = event.submitter;
      const error = document.getElementById('sync-login-error');
      const password = new FormData(form).get('password');
      submit.disabled = true;
      submit.textContent = '登录中…';
      error.textContent = '';
      try {
        const result = await apiCall('web.auth.login', { password });
        sessionStorage.setItem(TOKEN_KEY, result.token);
        sessionStorage.setItem(LEGACY_TOKEN_KEY, result.token);
        form.reset();
        dialog.close();
        await syncNow();
      } catch (loginError) {
        error.textContent = loginError.message;
      } finally {
        submit.disabled = false;
        submit.textContent = '登录并同步';
      }
    });
  }

  function start() {
    if (!window.DajinLocalFirstApp) return;
    bindUi();
    if (!localStorage.getItem(SNAPSHOT_KEY)) {
      const existingLocalPlans = window.DajinLocalFirstApp.getPlans();
      if (existingLocalPlans.length) queueDiff(existingLocalPlans, true);
      else writeJson(SNAPSHOT_KEY, []);
    }
    setStatus(outbox().length ? 'pending' : 'local', outbox().length ? '待同步' : '本地已保存', '页面先读取本地数据，云同步不会阻塞操作。');
    queueMicrotask(syncNow);
    window.addEventListener('online', syncNow);
    window.addEventListener('focus', syncNow);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  }

  window.DajinLocalFirstSync = { start, recordLocalChange, syncNow };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
