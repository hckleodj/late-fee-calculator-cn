(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinMigrationTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT_VERSION = 'DJINMIG1';
  const DEFAULT_PAYLOAD_BYTES = 8 * 1024;
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
  const BEGIN_MARKER = '-----BEGIN DAJIN MIGRATION SEGMENT-----';
  const END_MARKER = '-----END DAJIN MIGRATION SEGMENT-----';

  class MigrationTransferError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'MigrationTransferError';
      this.code = code;
      this.details = details;
    }
  }

  function utf8Encode(value) {
    if (typeof TextEncoder !== 'function') throw new MigrationTransferError('unsupported', '当前浏览器不支持 UTF-8 编码，无法生成迁移分段。');
    return new TextEncoder().encode(String(value));
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'function') throw new MigrationTransferError('unsupported', '当前浏览器不支持 UTF-8 解码，无法导入迁移分段。');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_error) { throw new MigrationTransferError('invalid-utf8', '迁移分段不是有效的 UTF-8 数据，禁止导入。'); }
  }

  function utf8Bytes(value) { return utf8Encode(value).byteLength; }

  function bytesToBase64Url(bytes) {
    let base64;
    if (typeof Buffer !== 'undefined') base64 = Buffer.from(bytes).toString('base64');
    else {
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const clean = String(value || '').replace(/\s+/g, '');
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) throw new MigrationTransferError('invalid-base64url', '迁移分段不是有效的 Base64URL，禁止导入。');
    const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - clean.length % 4) % 4);
    try {
      if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(padded, 'base64'));
      const binary = atob(padded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch (_error) {
      throw new MigrationTransferError('invalid-base64url', '迁移分段无法解码，禁止导入。');
    }
  }

  function isHash(value) { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value); }

  function generateMigrationId(date = new Date(), cryptoApi = globalThis.crypto) {
    const pad = value => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const bytes = new Uint8Array(8);
    if (!cryptoApi?.getRandomValues) throw new MigrationTransferError('random-unavailable', '当前浏览器缺少安全随机数能力，无法生成迁移批次。');
    cryptoApi.getRandomValues(bytes);
    return `${stamp}-${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function segmentText(segment) {
    return [
      BEGIN_MARKER,
      '【大进车贷助手一次性迁移分段】',
      `格式版本: ${segment.formatVersion}`,
      `migrationId: ${segment.migrationId}`,
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

  async function buildMigrationSegments(options = {}) {
    const compactJson = String(options.compactJson || ''), hashText = options.hashText;
    const payloadBytes = options.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
    if (!compactJson) throw new MigrationTransferError('empty-migration', '迁移内容为空，无法生成分段。');
    if (typeof hashText !== 'function') throw new MigrationTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    if (!Number.isInteger(payloadBytes) || payloadBytes < 1024 || payloadBytes > 8 * 1024) throw new MigrationTransferError('invalid-segment-size', '迁移分段有效载荷必须为 1KiB 至 8KiB。');
    if (!Number.isInteger(options.dataRevision) || options.dataRevision < 0) throw new MigrationTransferError('invalid-revision', '迁移数据版本异常。');
    if (!isHash(options.fullChecksum)) throw new MigrationTransferError('invalid-full-checksum', '完整数据校验值异常。');

    const encoded = bytesToBase64Url(utf8Encode(compactJson)), payloads = [];
    for (let offset = 0; offset < encoded.length; offset += payloadBytes) payloads.push(encoded.slice(offset, offset + payloadBytes));
    const migrationId = options.migrationId || generateMigrationId(options.date);
    const segments = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index], segmentChecksum = await hashText(payload);
      const segment = { formatVersion: FORMAT_VERSION, migrationId, segmentIndex: index + 1, segmentTotal: payloads.length, dataRevision: options.dataRevision, fullChecksum: options.fullChecksum, segmentChecksum, payload };
      segment.text = segmentText(segment);
      segment.textBytes = utf8Bytes(segment.text);
      segments.push(segment);
    }
    return { migrationId, segments, diagnostics: { compactJsonBytes: utf8Bytes(compactJson), base64UrlBytes: utf8Bytes(encoded), payloadBytes, segmentTotal: segments.length, maxSegmentTextBytes: Math.max(...segments.map(item => item.textBytes)) } };
  }

  function parseBlock(block) {
    const valueFor = name => {
      const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'mi').exec(block);
      return match ? match[1].trim() : null;
    };
    const payloadMatch = /(?:^|\n)payload\s*:\s*\n([\s\S]*?)$/i.exec(block.trim());
    const segment = {
      formatVersion: valueFor('格式版本'),
      migrationId: valueFor('migrationId'),
      segmentIndex: Number(valueFor('segmentIndex')),
      segmentTotal: Number(valueFor('segmentTotal')),
      dataRevision: Number(valueFor('dataRevision')),
      fullChecksum: valueFor('fullChecksum'),
      segmentChecksum: valueFor('segmentChecksum'),
      payload: payloadMatch ? payloadMatch[1].replace(/\s+/g, '') : ''
    };
    if (segment.formatVersion !== FORMAT_VERSION) throw new MigrationTransferError('format-version', '迁移分段格式版本不支持。');
    if (!/^[A-Za-z0-9-]{16,100}$/.test(segment.migrationId || '')) throw new MigrationTransferError('invalid-migration-id', '分段的 migrationId 格式异常。');
    if (!Number.isInteger(segment.segmentIndex) || !Number.isInteger(segment.segmentTotal) || segment.segmentTotal < 1 || segment.segmentIndex < 1 || segment.segmentIndex > segment.segmentTotal) throw new MigrationTransferError('index-out-of-range', '存在越界的迁移分段编号，禁止导入。');
    if (!Number.isInteger(segment.dataRevision) || segment.dataRevision < 0) throw new MigrationTransferError('invalid-revision', '迁移分段的数据版本异常。');
    if (!isHash(segment.fullChecksum) || !isHash(segment.segmentChecksum)) throw new MigrationTransferError('invalid-checksum', '迁移分段的校验值格式异常。');
    if (!segment.payload || !/^[A-Za-z0-9_-]+$/.test(segment.payload)) throw new MigrationTransferError('invalid-payload', '迁移分段有效载荷为空或格式异常。');
    return segment;
  }

  function parseMigrationSegments(text) {
    const source = String(text || '');
    if (!source.trim()) throw new MigrationTransferError('empty-input', '请先粘贴迁移分段。');
    if (utf8Bytes(source) > MAX_IMPORT_BYTES) throw new MigrationTransferError('too-large', '迁移分段文本超过8MiB，已停止处理。');
    const blocks = [];
    let offset = 0;
    while (offset < source.length) {
      const begin = source.indexOf(BEGIN_MARKER, offset);
      if (begin < 0) break;
      const contentStart = begin + BEGIN_MARKER.length, end = source.indexOf(END_MARKER, contentStart);
      if (end < 0) throw new MigrationTransferError('incomplete-block', '有一段没有完整结束，禁止导入。');
      blocks.push(source.slice(contentStart, end));
      offset = end + END_MARKER.length;
    }
    if (!blocks.length) throw new MigrationTransferError('not-migration-segment', '没有识别到大进车贷助手迁移分段。');
    return blocks.map(parseBlock);
  }

  function validateSegmentSet(segments, options = {}) {
    const allowIncomplete = Boolean(options.allowIncomplete);
    const migrationIds = [...new Set(segments.map(item => item.migrationId))];
    if (migrationIds.length !== 1) throw new MigrationTransferError('mixed-migration-id', '混入了不同批次的迁移分段，禁止导入。', { migrationIds });
    const totals = [...new Set(segments.map(item => item.segmentTotal))];
    if (totals.length !== 1) throw new MigrationTransferError('inconsistent-total', '各迁移分段声明的总段数不一致，禁止导入。');
    const revisions = [...new Set(segments.map(item => item.dataRevision))], checksums = [...new Set(segments.map(item => item.fullChecksum))];
    if (revisions.length !== 1 || checksums.length !== 1) throw new MigrationTransferError('inconsistent-metadata', '各迁移分段的数据版本或完整校验值不一致。');
    const counts = new Map();
    segments.forEach(item => counts.set(item.segmentIndex, (counts.get(item.segmentIndex) || 0) + 1));
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([index]) => index).sort((a, b) => a - b);
    if (duplicates.length) throw new MigrationTransferError('duplicate-segment', `检测到重复的第${duplicates.join('、第')}段，请删除重复段后重试。`, { duplicates });
    const total = totals[0], missing = [];
    for (let index = 1; index <= total; index += 1) if (!counts.has(index)) missing.push(index);
    if (missing.length && !allowIncomplete) throw new MigrationTransferError('missing-segment', `迁移数据不完整，缺少第${missing.join('段、第')}段，禁止导入。`, { missing });
    return { migrationId: migrationIds[0], segmentTotal: total, dataRevision: revisions[0], fullChecksum: checksums[0], missing };
  }

  async function restoreMigrationSegments(input, options = {}) {
    const hashText = options.hashText;
    if (typeof hashText !== 'function') throw new MigrationTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    const segments = Array.isArray(input) ? input : parseMigrationSegments(input);
    if (!segments.length) throw new MigrationTransferError('empty-input', '请先粘贴迁移分段。');
    const metadata = validateSegmentSet(segments);
    for (const segment of segments) {
      const checksum = await hashText(segment.payload);
      if (checksum !== segment.segmentChecksum) throw new MigrationTransferError('segment-checksum', `第${segment.segmentIndex}段校验失败。`, { segmentIndex: segment.segmentIndex });
    }
    const ordered = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const compactJson = utf8Decode(base64UrlToBytes(ordered.map(item => item.payload).join('')));
    let value;
    try { value = JSON.parse(compactJson); }
    catch (_error) { throw new MigrationTransferError('invalid-json', '迁移分段拼接后的 JSON 已损坏，禁止导入。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.plans)) throw new MigrationTransferError('invalid-structure', '迁移数据缺少完整的 plans 数组。');
    if (value.dataRevision !== metadata.dataRevision || value.checksum !== metadata.fullChecksum) throw new MigrationTransferError('payload-metadata', '迁移数据与分段头信息不一致。');
    const actualFullChecksum = await hashText(JSON.stringify(value.plans));
    if (actualFullChecksum !== metadata.fullChecksum) throw new MigrationTransferError('full-checksum', '完整客户数据校验失败，禁止导入。');
    return { value, segments: ordered, ...metadata };
  }

  return { FORMAT_VERSION, DEFAULT_PAYLOAD_BYTES, BEGIN_MARKER, END_MARKER, MigrationTransferError, utf8Bytes, generateMigrationId, buildMigrationSegments, parseMigrationSegments, validateSegmentSet, restoreMigrationSegments };
});
