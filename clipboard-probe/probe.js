(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinClipboardProbe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const TEST_LENGTHS = [2500, 3000, 3500, 4000, 4300, 4500, 4700];
  const CURRENT_PAYLOAD_CHARS = 8 * 1024;
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function utf8Bytes(value) {
    if (!encoder) throw new Error('当前环境不支持 TextEncoder。');
    return encoder.encode(String(value)).byteLength;
  }

  function makeAsciiText(length) {
    const pattern = 'DAJIN-CLIPBOARD-0123456789-';
    return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
  }

  function bytesToBase64Url(bytes) {
    let base64;
    if (typeof Buffer !== 'undefined') base64 = Buffer.from(bytes).toString('base64');
    else {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
      }
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function safeSplitRaw(text, maxChars) {
    const source = String(text);
    const parts = [];
    let offset = 0;
    while (offset < source.length) {
      let end = Math.min(offset + maxChars, source.length);
      if (end < source.length) {
        const before = source.charCodeAt(end - 1);
        const after = source.charCodeAt(end);
        if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end -= 1;
      }
      parts.push(source.slice(offset, end));
      offset = end;
    }
    return parts;
  }

  async function sha256Text(value) {
    if (!root.crypto?.subtle) throw new Error('当前环境不支持 Web Crypto SHA-256。');
    const digest = await root.crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  async function buildMockBackupJson() {
    const plans = [];
    let compact = '';
    for (let customer = 1; customer <= 200; customer += 1) {
      const payments = Array.from({ length: 10 }, (_, index) => ({
        id: `mock-payment-${customer}-${index + 1}`,
        date: `2026-${String((index % 12) + 1).padStart(2, '0')}-15`,
        total: 4000 + customer + index,
        lateFee: index * 10,
        principal: 4000 + customer,
        startTermIndex: index + 1,
        allocations: [{ termIndex: index + 1, principal: 4000 + customer }]
      }));
      plans.push({
        id: `mock-customer-${customer}`,
        name: `模拟客户${customer}`,
        plate: `测A${String(customer).padStart(5, '0')}`,
        vehicle: `模拟车辆${customer}型🚗`,
        contractAmount: 100000 + customer * 100,
        terms: 36,
        completedTerms: customer % 12,
        notes: '仅用于剪贴板容量与编码比较，不包含真实客户数据。'.repeat(2),
        payments
      });
      compact = JSON.stringify(plans);
      if (utf8Bytes(compact) >= 100 * 1024) break;
    }
    const checksum = await sha256Text(compact);
    return JSON.stringify({
      app: '大进车贷助手',
      version: 1,
      exportedAt: '2026-08-27T00:00:00.000Z',
      dataRevision: 100,
      checksum,
      plans
    });
  }

  function segmentText(payload, options = {}) {
    return [
      '-----BEGIN DAJIN MIGRATION SEGMENT-----',
      '【大进车贷助手一次性迁移分段】',
      '格式版本: DJINMIG1',
      `migrationId: ${options.migrationId || '20260827-120000-ABCDEF0123456789'}`,
      `segmentIndex: ${options.segmentIndex || 1}`,
      `segmentTotal: ${options.segmentTotal || 99}`,
      `dataRevision: ${options.dataRevision || 100}`,
      `fullChecksum: ${options.fullChecksum || `sha256:${'a'.repeat(64)}`}`,
      `segmentChecksum: ${options.segmentChecksum || `sha256:${'b'.repeat(64)}`}`,
      'payload:',
      payload,
      '-----END DAJIN MIGRATION SEGMENT-----'
    ].join('\n');
  }

  async function analyzeEncodings(compactJson) {
    const rawBytes = encoder.encode(compactJson);
    const base64Url = bytesToBase64Url(rawBytes);
    const currentPayload = makeAsciiText(CURRENT_PAYLOAD_CHARS);
    const currentText = segmentText(currentPayload);
    const rows = [3000, 3500].map(payloadChars => {
      const base64Parts = [];
      for (let offset = 0; offset < base64Url.length; offset += payloadChars) base64Parts.push(base64Url.slice(offset, offset + payloadChars));
      const rawParts = safeSplitRaw(compactJson, payloadChars);
      return {
        payloadChars,
        base64Segments: base64Parts.length,
        rawSegments: rawParts.length,
        base64MaxCompleteChars: Math.max(...base64Parts.map((part, index) => segmentText(part, { segmentIndex: index + 1, segmentTotal: base64Parts.length }).length)),
        rawMaxCompleteChars: Math.max(...rawParts.map((part, index) => segmentText(part, { segmentIndex: index + 1, segmentTotal: rawParts.length }).length)),
        rawRoundTrip: rawParts.join('') === compactJson,
        rawSurrogateSafe: rawParts.every((part, index) => {
          if (!part || index === rawParts.length - 1) return true;
          const code = part.charCodeAt(part.length - 1);
          return !(code >= 0xD800 && code <= 0xDBFF);
        })
      };
    });
    return {
      rawChars: compactJson.length,
      rawCodePoints: Array.from(compactJson).length,
      rawBytes: rawBytes.byteLength,
      base64UrlChars: base64Url.length,
      currentPayloadChars: currentPayload.length,
      currentCompleteChars: currentText.length,
      currentCompleteBytes: utf8Bytes(currentText),
      currentHeaderChars: currentText.length - currentPayload.length,
      rows
    };
  }

  function resultText(original, pasted) {
    const exact = pasted === original;
    return {
      originalChars: original.length,
      pastedChars: pasted.length,
      pastedBytes: utf8Bytes(pasted),
      exact,
      message: exact ? '完整：粘贴内容与原文逐字一致。' : `不完整：${pasted.length < original.length ? `截断 ${original.length - pasted.length} 字符` : '长度或内容不一致'}。`
    };
  }

  function initPage(doc = document) {
    const support = doc.getElementById('support');
    support.textContent = `navigator.clipboard.writeText：${root.navigator?.clipboard?.writeText ? '支持' : '不支持'}；execCommand(copy)：${typeof doc.execCommand === 'function' ? '可调用' : '不可调用'}。复制API返回成功不代表内容完整，必须粘贴回来验证。`;
    const list = doc.getElementById('probe-list');
    TEST_LENGTHS.forEach(length => {
      const article = doc.createElement('article');
      article.className = 'probe-card';
      article.innerHTML = `<h3>${length}字符 ASCII</h3><div class="actions"><button type="button" data-copy="clipboard">A · Clipboard复制</button><button type="button" class="secondary" data-copy="exec">B · execCommand复制</button></div><p class="copy-status">尚未复制。</p><label>粘贴回来验证<textarea rows="3" spellcheck="false" placeholder="复制后长按粘贴到这里"></textarea></label><p class="verify-status">原始字符数：${length}；等待粘贴。</p>`;
      const original = makeAsciiText(length);
      const copyStatus = article.querySelector('.copy-status');
      const textarea = article.querySelector('textarea');
      article.querySelector('[data-copy="clipboard"]').addEventListener('click', async () => {
        try {
          if (!root.navigator?.clipboard?.writeText) throw new Error('当前环境不支持 navigator.clipboard.writeText');
          await root.navigator.clipboard.writeText(original);
          copyStatus.textContent = 'Clipboard API已返回；请粘贴回来验证，尚不能判定完整。';
        } catch (error) { copyStatus.textContent = `Clipboard API失败：${error.message || error}`; }
      });
      article.querySelector('[data-copy="exec"]').addEventListener('click', () => {
        const helper = doc.createElement('textarea');
        helper.value = original;
        helper.setAttribute('readonly', '');
        helper.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        doc.body.appendChild(helper);
        helper.focus(); helper.select(); helper.setSelectionRange(0, helper.value.length);
        let ok = false;
        try { ok = Boolean(doc.execCommand('copy')); } catch (_error) {}
        helper.remove();
        copyStatus.textContent = ok ? 'execCommand已返回；请粘贴回来验证，尚不能判定完整。' : 'execCommand调用失败。';
      });
      textarea.addEventListener('input', () => {
        const result = resultText(original, textarea.value);
        const output = article.querySelector('.verify-status');
        output.className = `verify-status ${result.exact ? 'pass' : 'fail'}`;
        output.textContent = `原始字符数：${result.originalChars}；实际粘贴字符数：${result.pastedChars}；UTF-8：${result.pastedBytes}字节；${result.message}`;
      });
      list.appendChild(article);
    });

    const diagnostics = doc.getElementById('encoding-diagnostics');
    buildMockBackupJson().then(analyzeEncodings).then(result => {
      diagnostics.innerHTML = `<dl><dt>当前8KiB payload</dt><dd>${result.currentPayloadChars}字符</dd><dt>当前完整分段</dt><dd>${result.currentCompleteChars}字符 / ${result.currentCompleteBytes} UTF-8字节（头部${result.currentHeaderChars}字符）</dd><dt>模拟原始JSON</dt><dd>${result.rawChars}字符 / ${result.rawBytes} UTF-8字节</dd><dt>原始JSON Unicode码点</dt><dd>${result.rawCodePoints}</dd><dt>Base64URL</dt><dd>${result.base64UrlChars}字符</dd></dl><table><thead><tr><th>payload</th><th>Base64URL段数</th><th>原始JSON段数</th><th>最大完整段</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${row.payloadChars}</td><td>${row.base64Segments}段</td><td>${row.rawSegments}段</td><td>Base64 ${row.base64MaxCompleteChars}字 / 原始 ${row.rawMaxCompleteChars}字</td></tr>`).join('')}</tbody></table><p>${result.rows.every(row => row.rawRoundTrip && row.rawSurrogateSafe) ? '原始JSON分段已验证：不切断Unicode代理对，按顺序拼接可逐字恢复。' : '原始JSON分段验证失败。'}</p>`;
    }).catch(error => { diagnostics.textContent = `诊断生成失败：${error.message || error}`; });
  }

  return { TEST_LENGTHS, CURRENT_PAYLOAD_CHARS, utf8Bytes, makeAsciiText, bytesToBase64Url, safeSplitRaw, buildMockBackupJson, segmentText, analyzeEncodings, resultText, initPage };
});
