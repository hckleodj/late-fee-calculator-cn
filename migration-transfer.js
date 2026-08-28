(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DajinMigrationTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FORMAT_VERSION = 'DJINMIG2';
  const LEGACY_FORMAT_VERSION = 'DJINMIG1';
  const ENCODING = 'raw-json';
  const TARGET_SEGMENT_CHARS = 3900;
  const HARD_MAX_SEGMENT_CHARS = 4000;
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
  const BEGIN_MARKER = '-----BEGIN DAJIN MIGRATION SEGMENT-----';
  const END_MARKER = '-----END DAJIN MIGRATION SEGMENT-----';
  const HASH_PLACEHOLDER = `sha256:${'0'.repeat(64)}`;

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
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) throw new MigrationTransferError('invalid-base64url', '旧版迁移分段不是有效的 Base64URL，禁止导入。');
    const padded = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - clean.length % 4) % 4);
    try {
      if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(padded, 'base64'));
      const binary = atob(padded), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch (_error) { throw new MigrationTransferError('invalid-base64url', '旧版迁移分段无法解码，禁止导入。'); }
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
    return [BEGIN_MARKER, '【大进车贷助手一次性迁移分段】', `格式版本: ${segment.formatVersion}`, `encoding: ${segment.encoding}`, `migrationId: ${segment.migrationId}`, `segmentIndex: ${segment.segmentIndex}`, `segmentTotal: ${segment.segmentTotal}`, `dataRevision: ${segment.dataRevision}`, `fullChecksum: ${segment.fullChecksum}`, `segmentChecksum: ${segment.segmentChecksum}`, `payloadChars: ${segment.payload.length}`, 'payload:', segment.payload, END_MARKER].join('\n');
  }
  function legacySegmentText(payload, metadata) {
    return [BEGIN_MARKER, '【大进车贷助手一次性迁移分段】', `格式版本: ${LEGACY_FORMAT_VERSION}`, `migrationId: ${metadata.migrationId}`, `segmentIndex: ${metadata.segmentIndex}`, `segmentTotal: ${metadata.segmentTotal}`, `dataRevision: ${metadata.dataRevision}`, `fullChecksum: ${metadata.fullChecksum}`, `segmentChecksum: ${HASH_PLACEHOLDER}`, 'payload:', payload, END_MARKER].join('\n');
  }
  function safeSliceEnd(source, offset, maxChars) {
    let end = Math.min(offset + maxChars, source.length);
    if (end < source.length) {
      const before = source.charCodeAt(end - 1), after = source.charCodeAt(end);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end -= 1;
    }
    return end;
  }
  function payloadCapacity(textBuilder, maxSegmentChars) {
    let low = 1, high = maxSegmentChars, best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), text = textBuilder('A'.repeat(mid));
      if (text.length <= maxSegmentChars) { best = mid; low = mid + 1; } else high = mid - 1;
    }
    if (best < 1) throw new MigrationTransferError('segment-overhead', '迁移分段头信息过长，无法在安全字符上限内生成。');
    return best;
  }
  function splitWithDynamicHeader(source, totalGuess, metadata, maxSegmentChars, legacy = false) {
    const parts = [];
    let offset = 0, index = 1;
    while (offset < source.length) {
      const common = { ...metadata, segmentIndex: index, segmentTotal: totalGuess };
      const capacity = payloadCapacity(payload => legacy ? legacySegmentText(payload, common) : segmentText({ ...common, formatVersion: FORMAT_VERSION, encoding: ENCODING, segmentChecksum: HASH_PLACEHOLDER, payload }), maxSegmentChars);
      const end = safeSliceEnd(source, offset, capacity);
      if (end <= offset) throw new MigrationTransferError('unicode-boundary', '无法在不破坏 Unicode 字符的情况下生成迁移分段。');
      parts.push(source.slice(offset, end)); offset = end; index += 1;
      if (index > 100000) throw new MigrationTransferError('too-many-segments', '迁移分段数量异常，已停止生成。');
    }
    return parts;
  }
  function stableDynamicSplit(source, metadata, maxSegmentChars, legacy = false) {
    let totalGuess = 1, parts = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      parts = splitWithDynamicHeader(source, totalGuess, metadata, maxSegmentChars, legacy);
      if (parts.length === totalGuess) return parts;
      totalGuess = parts.length;
    }
    throw new MigrationTransferError('segment-convergence', '迁移分段长度计算未收敛，已停止生成。');
  }

  async function buildMigrationSegments(options = {}) {
    const compactJson = String(options.compactJson || ''), hashText = options.hashText;
    const maxSegmentChars = options.maxSegmentChars ?? TARGET_SEGMENT_CHARS;
    if (!compactJson) throw new MigrationTransferError('empty-migration', '迁移内容为空，无法生成分段。');
    if (typeof hashText !== 'function') throw new MigrationTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    if (!Number.isInteger(maxSegmentChars) || maxSegmentChars < 1000 || maxSegmentChars > HARD_MAX_SEGMENT_CHARS) throw new MigrationTransferError('invalid-segment-size', '完整迁移分段字符上限必须为1000至4000。');
    if (!Number.isInteger(options.dataRevision) || options.dataRevision < 0) throw new MigrationTransferError('invalid-revision', '迁移数据版本异常。');
    if (!isHash(options.fullChecksum)) throw new MigrationTransferError('invalid-full-checksum', '完整数据校验值异常。');
    const migrationId = options.migrationId || generateMigrationId(options.date), metadata = { migrationId, dataRevision: options.dataRevision, fullChecksum: options.fullChecksum };
    const payloads = stableDynamicSplit(compactJson, metadata, maxSegmentChars), segments = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index], segmentChecksum = await hashText(payload);
      const segment = { formatVersion: FORMAT_VERSION, encoding: ENCODING, migrationId, segmentIndex: index + 1, segmentTotal: payloads.length, dataRevision: options.dataRevision, fullChecksum: options.fullChecksum, segmentChecksum, payload };
      segment.text = segmentText(segment); segment.textChars = segment.text.length; segment.textBytes = utf8Bytes(segment.text);
      if (segment.textChars > maxSegmentChars || segment.textChars > HARD_MAX_SEGMENT_CHARS) throw new MigrationTransferError('segment-too-long', `第${segment.segmentIndex}段超过4000字符，已禁止生成本次迁移。`, { segmentIndex: segment.segmentIndex, textChars: segment.textChars });
      segments.push(segment);
    }
    if (segments.map(item => item.payload).join('') !== compactJson) throw new MigrationTransferError('round-trip', '迁移分段未能逐字还原原始JSON，已禁止生成。');
    const base64Url = bytesToBase64Url(utf8Encode(compactJson)), legacyParts = stableDynamicSplit(base64Url, metadata, maxSegmentChars, true);
    return { migrationId, segments, diagnostics: { encoding: ENCODING, compactJsonChars: compactJson.length, compactJsonBytes: utf8Bytes(compactJson), maxSegmentChars, hardMaxSegmentChars: HARD_MAX_SEGMENT_CHARS, segmentTotal: segments.length, maxSegmentTextChars: Math.max(...segments.map(item => item.textChars)), maxSegmentTextBytes: Math.max(...segments.map(item => item.textBytes)), base64UrlChars: base64Url.length, legacyBase64SegmentTotal: legacyParts.length, segmentsSaved: legacyParts.length - segments.length } };
  }

  function valueFor(header, name) { const match = new RegExp(`^${name}\\s*:\\s*(.+)$`, 'mi').exec(header); return match ? match[1].trim() : null; }
  function validateParsedSegment(segment) {
    if (![FORMAT_VERSION, LEGACY_FORMAT_VERSION].includes(segment.formatVersion)) throw new MigrationTransferError('format-version', '迁移分段格式版本不支持。');
    if (!/^[A-Za-z0-9-]{16,100}$/.test(segment.migrationId || '')) throw new MigrationTransferError('invalid-migration-id', '分段的 migrationId 格式异常。');
    if (!Number.isInteger(segment.segmentIndex) || !Number.isInteger(segment.segmentTotal) || segment.segmentTotal < 1 || segment.segmentIndex < 1 || segment.segmentIndex > segment.segmentTotal) throw new MigrationTransferError('index-out-of-range', '存在越界的迁移分段编号，禁止导入。');
    if (!Number.isInteger(segment.dataRevision) || segment.dataRevision < 0) throw new MigrationTransferError('invalid-revision', '迁移分段的数据版本异常。');
    if (!isHash(segment.fullChecksum) || !isHash(segment.segmentChecksum)) throw new MigrationTransferError('invalid-checksum', '迁移分段的校验值格式异常。');
    if (!segment.payload) throw new MigrationTransferError('invalid-payload', '迁移分段有效载荷为空，禁止导入。');
    if (segment.formatVersion === FORMAT_VERSION && segment.encoding !== ENCODING) throw new MigrationTransferError('invalid-encoding', '迁移分段编码方式不受支持。');
    if (segment.formatVersion === LEGACY_FORMAT_VERSION && !/^[A-Za-z0-9_-]+$/.test(segment.payload)) throw new MigrationTransferError('invalid-payload', '旧版迁移分段有效载荷格式异常。');
    return segment;
  }
  function parseMigrationSegments(text) {
    const source = String(text || '');
    if (!source.trim()) throw new MigrationTransferError('empty-input', '请先粘贴迁移分段。');
    if (utf8Bytes(source) > MAX_IMPORT_BYTES) throw new MigrationTransferError('too-large', '迁移分段文本超过8MiB，已停止处理。');
    const segments = []; let offset = 0;
    while (offset < source.length) {
      const begin = source.indexOf(BEGIN_MARKER, offset); if (begin < 0) break;
      let headerStart = begin + BEGIN_MARKER.length; if (source[headerStart] === '\r') headerStart += 1;
      if (source[headerStart] !== '\n') throw new MigrationTransferError('incomplete-block', '迁移分段头部格式损坏，禁止导入。');
      headerStart += 1;
      const payloadLabel = source.indexOf('\npayload:\n', headerStart);
      if (payloadLabel < 0) throw new MigrationTransferError('incomplete-block', '迁移分段缺少payload，禁止导入。');
      const header = source.slice(headerStart, payloadLabel), payloadStart = payloadLabel + '\npayload:\n'.length, formatVersion = valueFor(header, '格式版本');
      let payload, endMarkerStart;
      if (formatVersion === FORMAT_VERSION) {
        const payloadChars = Number(valueFor(header, 'payloadChars'));
        if (!Number.isInteger(payloadChars) || payloadChars < 1) throw new MigrationTransferError('invalid-payload-length', '迁移分段payload字符数异常。');
        const payloadEnd = payloadStart + payloadChars; payload = source.slice(payloadStart, payloadEnd);
        if (payload.length !== payloadChars || source[payloadEnd] !== '\n' || source.slice(payloadEnd + 1, payloadEnd + 1 + END_MARKER.length) !== END_MARKER) throw new MigrationTransferError('payload-length-mismatch', '迁移分段payload长度不一致，禁止导入。');
        endMarkerStart = payloadEnd + 1;
      } else {
        endMarkerStart = source.indexOf(`\n${END_MARKER}`, payloadStart);
        if (endMarkerStart < 0) throw new MigrationTransferError('incomplete-block', '旧版迁移分段没有完整结束，禁止导入。');
        payload = source.slice(payloadStart, endMarkerStart).replace(/\s+/g, ''); endMarkerStart += 1;
      }
      segments.push(validateParsedSegment({ formatVersion, encoding: formatVersion === FORMAT_VERSION ? valueFor(header, 'encoding') : 'base64url', migrationId: valueFor(header, 'migrationId'), segmentIndex: Number(valueFor(header, 'segmentIndex')), segmentTotal: Number(valueFor(header, 'segmentTotal')), dataRevision: Number(valueFor(header, 'dataRevision')), fullChecksum: valueFor(header, 'fullChecksum'), segmentChecksum: valueFor(header, 'segmentChecksum'), payload }));
      offset = endMarkerStart + END_MARKER.length;
    }
    if (!segments.length) throw new MigrationTransferError('not-migration-segment', '没有识别到大进车贷助手迁移分段。');
    return segments;
  }
  function validateSegmentSet(segments, options = {}) {
    const allowIncomplete = Boolean(options.allowIncomplete), migrationIds = [...new Set(segments.map(item => item.migrationId))];
    if (migrationIds.length !== 1) throw new MigrationTransferError('mixed-migration-id', '混入了不同批次的迁移分段，禁止导入。', { migrationIds });
    const totals = [...new Set(segments.map(item => item.segmentTotal))];
    if (totals.length !== 1) throw new MigrationTransferError('inconsistent-total', '各迁移分段声明的总段数不一致，禁止导入。');
    const revisions = [...new Set(segments.map(item => item.dataRevision))], checksums = [...new Set(segments.map(item => item.fullChecksum))], formats = [...new Set(segments.map(item => `${item.formatVersion}:${item.encoding}`))];
    if (revisions.length !== 1 || checksums.length !== 1 || formats.length !== 1) throw new MigrationTransferError('inconsistent-metadata', '各迁移分段的数据版本、校验值或编码方式不一致。');
    const counts = new Map(); segments.forEach(item => counts.set(item.segmentIndex, (counts.get(item.segmentIndex) || 0) + 1));
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([index]) => index).sort((a, b) => a - b);
    if (duplicates.length) throw new MigrationTransferError('duplicate-segment', `检测到重复的第${duplicates.join('、第')}段，请删除重复段后重试。`, { duplicates });
    const total = totals[0], missing = []; for (let index = 1; index <= total; index += 1) if (!counts.has(index)) missing.push(index);
    if (missing.length && !allowIncomplete) throw new MigrationTransferError('missing-segment', `迁移数据不完整，缺少第${missing.join('段、第')}段，禁止导入。`, { missing });
    return { migrationId: migrationIds[0], segmentTotal: total, dataRevision: revisions[0], fullChecksum: checksums[0], formatVersion: segments[0].formatVersion, encoding: segments[0].encoding, missing };
  }
  function validateBusinessStructure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.plans) || !value.plans.length) throw new MigrationTransferError('invalid-structure', '迁移数据缺少非空plans数组。');
    const ids = new Set();
    for (const plan of value.plans) {
      if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.id !== 'string' || !plan.id.trim()) throw new MigrationTransferError('invalid-customer', '迁移数据存在无效客户结构。');
      if (ids.has(plan.id)) throw new MigrationTransferError('duplicate-customer-id', `客户ID重复：${plan.id}，禁止导入。`, { id: plan.id }); ids.add(plan.id);
      if (plan.payments !== undefined && !Array.isArray(plan.payments)) throw new MigrationTransferError('invalid-payments', `客户 ${plan.id} 的payments结构异常。`);
      for (const payment of plan.payments || []) if (!payment || typeof payment !== 'object' || (payment.allocations !== undefined && !Array.isArray(payment.allocations))) throw new MigrationTransferError('invalid-allocations', `客户 ${plan.id} 的收款或allocations结构异常。`);
    }
  }
  async function restoreMigrationSegments(input, options = {}) {
    const hashText = options.hashText;
    if (typeof hashText !== 'function') throw new MigrationTransferError('hash-unavailable', 'SHA-256 校验功能不可用。');
    const segments = Array.isArray(input) ? input : parseMigrationSegments(input);
    if (!segments.length) throw new MigrationTransferError('empty-input', '请先粘贴迁移分段。');
    const metadata = validateSegmentSet(segments);
    for (const segment of segments) { const checksum = await hashText(segment.payload); if (checksum !== segment.segmentChecksum) throw new MigrationTransferError('segment-checksum', `第${segment.segmentIndex}段校验失败。`, { segmentIndex: segment.segmentIndex }); }
    const ordered = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex), joined = ordered.map(item => item.payload).join('');
    const compactJson = metadata.formatVersion === LEGACY_FORMAT_VERSION ? utf8Decode(base64UrlToBytes(joined)) : joined;
    let value; try { value = JSON.parse(compactJson); } catch (_error) { throw new MigrationTransferError('invalid-json', '迁移分段拼接后的JSON已损坏，禁止导入。'); }
    validateBusinessStructure(value);
    if (value.dataRevision !== metadata.dataRevision || value.checksum !== metadata.fullChecksum) throw new MigrationTransferError('payload-metadata', '迁移数据与分段头信息不一致。');
    const actualFullChecksum = await hashText(JSON.stringify(value.plans)); if (actualFullChecksum !== metadata.fullChecksum) throw new MigrationTransferError('full-checksum', '完整客户数据校验失败，禁止导入。');
    return { value, compactJson, segments: ordered, ...metadata };
  }

  return { FORMAT_VERSION, LEGACY_FORMAT_VERSION, ENCODING, TARGET_SEGMENT_CHARS, HARD_MAX_SEGMENT_CHARS, BEGIN_MARKER, END_MARKER, MigrationTransferError, utf8Bytes, generateMigrationId, segmentText, safeSliceEnd, buildMigrationSegments, parseMigrationSegments, validateSegmentSet, validateBusinessStructure, restoreMigrationSegments };
});
