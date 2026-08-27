(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinBackupTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT_VERSION = 'DJINSEG1';
  const DEFAULT_PAYLOAD_BYTES = 8 * 1024;
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
  const BEGIN_MARKER = '-----BEGIN DAJIN BACKUP SEGMENT-----';
  const END_MARKER = '-----END DAJIN BACKUP SEGMENT-----';

  class BackupTransferError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'BackupTransferError';
      this.code = code;
      this.details = details;
    }
  }

  function utf8Encode(value) {
    if (typeof TextEncoder !== 'function') throw new BackupTransferError('unsupported', '当前浏览器不支持 UTF-8 编码，无法生成分段备份。');
    return new TextEncoder().encode(String(value));
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'function') throw new BackupTransferError('unsupported', '当前浏览器不支持 UTF-8 解码，无法恢复分段备份。');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new BackupTransferError('invalid-utf8', '分段内容不是有效的 UTF-8 数据，禁止恢复。'); }
  }

  function utf8Bytes(value) { return utf8Encode(value).byteLength; }

  function bytesToBase64Url(bytes) {
    let base64;
    if (typeof Buffer !== 'undefined') base64 = Buffer.from(bytes).toString('base64');
    else {
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
      }
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const clean = String(value || '').replace(/\s+/g, '');
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) throw new BackupTransferError('invalid-base64url', '分段内容不是有效的 Base64URL，禁止恢复。');
    const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - clean.length % 4) % 4);
    try {
      if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(padded, 'base64'));
      const binary = atob(padded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch (error) {
      throw new BackupTransferError('invalid-base64url', '分段内容无法解码，禁止恢复。');
    }
  }

  function isHash(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }

  function generateBackupId(date = new Date(), cryptoApi = globalThis.crypto) {
    const pad = value => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const bytes = new Uint8Array(3);
    if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return `${stamp}-${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function segmentText(segment) {
    return [
      BEGIN_MARKER,
      '【大进车贷助手分段备份】',
      `格式版本: ${segment.formatVersion}`,
      `backupId: ${segment.backupId}`,
      `segmentIndex: ${segment.segmentIndex}`,
      `segmentTotal: ${segment.segmentTotal}`,
      `dataRevision: ${segment.dataRevision}`,
      `fullChecksum: ${segment.fullChecksum}`,
      `segmentChecksum: ${segment.segmentChecksum}`,
      'payload:',
      segment.payload,
      END_MARKER
    ].join('\n');
  }

  async function buildSegments(options = {}) {
    const compactJson = String(options.compactJson || '');
    const hashText = options.hashText;
    const payloadBytes = options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
    if (!compactJson) throw new BackupTransferError('empty-backup', '备份内容为空，无法生成分段。');
    if (typeof hashText !== 'function') throw new BackupTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    if (!Number.isInteger(payloadBytes) || payloadBytes < 1024 || payloadBytes > 8 * 1024) throw new BackupTransferError('invalid-segment-size', '分段有效载荷必须配置为 1KiB 至 8KiB。');
    if (!Number.isInteger(options.dataRevision) || options.dataRevision < 0) throw new BackupTransferError('invalid-revision', '备份数据版本异常。');
    if (!isHash(options.fullChecksum)) throw new BackupTransferError('invalid-full-checksum', '完整数据校验值异常。');

    const encoded = bytesToBase64Url(utf8Encode(compactJson));
    const payloads = [];
    for (let offset = 0; offset < encoded.length; offset += payloadBytes) payloads.push(encoded.slice(offset, offset + payloadBytes));
    const backupId = options.backupId || generateBackupId(options.date);
    const segments = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index], segmentChecksum = await hashText(payload);
      const segment = { formatVersion: FORMAT_VERSION, backupId, segmentIndex: index + 1, segmentTotal: payloads.length, dataRevision: options.dataRevision, fullChecksum: options.fullChecksum, segmentChecksum, payload };
      segment.text = segmentText(segment);
      segment.textBytes = utf8Bytes(segment.text);
      segments.push(segment);
    }
    return {
      backupId,
      segments,
      diagnostics: {
        compactJsonBytes: utf8Bytes(compactJson),
        base64UrlBytes: utf8Bytes(encoded),
        payloadBytes,
        segmentTotal: segments.length,
        maxSegmentTextBytes: Math.max(...segments.map(item => item.textBytes))
      }
    };
  }

  function parseBlock(block) {
    const valueFor = name => {
      const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'mi').exec(block);
      return match ? match[1].trim() : null;
    };
    const payloadMatch = /(?:^|\n)payload\s*:\s*\n([\s\S]*?)$/i.exec(block.trim());
    const segment = {
      formatVersion: valueFor('格式版本'),
      backupId: valueFor('backupId'),
      segmentIndex: Number(valueFor('segmentIndex')),
      segmentTotal: Number(valueFor('segmentTotal')),
      dataRevision: Number(valueFor('dataRevision')),
      fullChecksum: valueFor('fullChecksum'),
      segmentChecksum: valueFor('segmentChecksum'),
      payload: payloadMatch ? payloadMatch[1].replace(/\s+/g, '') : ''
    };
    if (segment.formatVersion !== FORMAT_VERSION) throw new BackupTransferError('format-version', '分段备份格式版本不支持。');
    if (!/^[A-Za-z0-9-]{8,80}$/.test(segment.backupId || '')) throw new BackupTransferError('invalid-backup-id', '分段的 backupId 格式异常。');
    if (!Number.isInteger(segment.segmentIndex) || !Number.isInteger(segment.segmentTotal) || segment.segmentTotal < 1 || segment.segmentIndex < 1 || segment.segmentIndex > segment.segmentTotal) throw new BackupTransferError('index-out-of-range', '存在越界的分段编号，禁止恢复。');
    if (!Number.isInteger(segment.dataRevision) || segment.dataRevision < 0) throw new BackupTransferError('invalid-revision', '分段的数据版本异常。');
    if (!isHash(segment.fullChecksum) || !isHash(segment.segmentChecksum)) throw new BackupTransferError('invalid-checksum', '分段的校验值格式异常。');
    if (!segment.payload || !/^[A-Za-z0-9_-]+$/.test(segment.payload)) throw new BackupTransferError('invalid-payload', '分段有效载荷为空或格式异常。');
    return segment;
  }

  function parseSegments(text) {
    const source = String(text || '');
    if (!source.trim()) throw new BackupTransferError('empty-input', '请先粘贴分段备份。');
    if (utf8Bytes(source) > MAX_IMPORT_BYTES) throw new BackupTransferError('too-large', '分段备份文本超过8MiB，已停止处理。');
    const blocks = [];
    let offset = 0;
    while (offset < source.length) {
      const begin = source.indexOf(BEGIN_MARKER, offset);
      if (begin < 0) break;
      const contentStart = begin + BEGIN_MARKER.length, end = source.indexOf(END_MARKER, contentStart);
      if (end < 0) throw new BackupTransferError('incomplete-block', '有一段没有完整结束，禁止恢复。');
      blocks.push(source.slice(contentStart, end));
      offset = end + END_MARKER.length;
    }
    if (!blocks.length) throw new BackupTransferError('not-segmented', '没有识别到大进车贷助手分段备份。');
    return blocks.map(parseBlock);
  }

  async function restoreSegments(text, options = {}) {
    const hashText = options.hashText;
    if (typeof hashText !== 'function') throw new BackupTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    const segments = parseSegments(text);
    const backupIds = [...new Set(segments.map(item => item.backupId))];
    if (backupIds.length !== 1) throw new BackupTransferError('mixed-backup-id', '混入了不同批次的备份分段，禁止恢复。', { backupIds });
    const totals = [...new Set(segments.map(item => item.segmentTotal))];
    if (totals.length !== 1) throw new BackupTransferError('inconsistent-total', '各分段声明的总段数不一致，禁止恢复。');
    const revisions = [...new Set(segments.map(item => item.dataRevision))];
    const checksums = [...new Set(segments.map(item => item.fullChecksum))];
    if (revisions.length !== 1 || checksums.length !== 1) throw new BackupTransferError('inconsistent-metadata', '各分段的数据版本或完整校验值不一致。');
    const counts = new Map();
    segments.forEach(item => counts.set(item.segmentIndex, (counts.get(item.segmentIndex) || 0) + 1));
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([index]) => index).sort((a, b) => a - b);
    if (duplicates.length) throw new BackupTransferError('duplicate-segment', `检测到重复的第${duplicates.join('、第')}段，请删除重复段后重试。`, { duplicates });
    const total = totals[0], missing = [];
    for (let index = 1; index <= total; index += 1) if (!counts.has(index)) missing.push(index);
    if (missing.length) throw new BackupTransferError('missing-segment', `备份不完整，缺少第${missing.join('段、第')}段，禁止恢复。`, { missing });
    for (const segment of segments) {
      const checksum = await hashText(segment.payload);
      if (checksum !== segment.segmentChecksum) throw new BackupTransferError('segment-checksum', `第${segment.segmentIndex}段校验失败。`, { segmentIndex: segment.segmentIndex });
    }
    const ordered = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const compactJson = utf8Decode(base64UrlToBytes(ordered.map(item => item.payload).join('')));
    let value;
    try { value = JSON.parse(compactJson); }
    catch (error) { throw new BackupTransferError('invalid-json', '分段拼接后的 JSON 已损坏，禁止恢复。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.plans)) throw new BackupTransferError('invalid-structure', '分段备份缺少完整的 plans 数据。');
    if (value.dataRevision !== revisions[0] || value.checksum !== checksums[0]) throw new BackupTransferError('payload-metadata', '备份文件与分段头信息不一致。');
    const actualFullChecksum = await hashText(JSON.stringify(value.plans));
    if (actualFullChecksum !== checksums[0]) throw new BackupTransferError('full-checksum', '完整数据校验失败，禁止恢复。');
    return { value, segments: ordered, backupId: backupIds[0], fullChecksum: checksums[0], dataRevision: revisions[0] };
  }

  return {
    FORMAT_VERSION,
    DEFAULT_PAYLOAD_BYTES,
    BEGIN_MARKER,
    END_MARKER,
    BackupTransferError,
    utf8Bytes,
    generateBackupId,
    buildSegments,
    parseSegments,
    restoreSegments
  };
});
