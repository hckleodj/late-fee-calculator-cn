'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sha256Text } = require('../backup-state.js');
const { buildSegments, parseSegments, restoreSegments, utf8Bytes } = require('../backup-transfer.js');

function samplePlan(index = 1) {
  return {
    id: `customer-${index}`,
    name: `分段测试客户${index}`,
    plate: `测A${String(index).padStart(5, '0')}`,
    vehicle: '测试车辆',
    amount: 4960,
    dueDay: 5,
    rate: 0.005,
    startDate: '2026-08-05',
    totalTerms: 24,
    completedTerms: 0,
    notes: '中文内容用于验证UTF-8不会被截断。'.repeat(80),
    payments: []
  };
}

async function fixture(label = 'A', count = 4, payloadBytes = 1024) {
  const plans = Array.from({ length: count }, (_, index) => samplePlan(index + 1));
  const checksum = await sha256Text(JSON.stringify(plans));
  const value = { app: '大进车贷助手', version: 1, exportedAt: '2026-08-26T07:15:00.000Z', dataRevision: 12, checksum, plans };
  const compactJson = JSON.stringify(value);
  const built = await buildSegments({ compactJson, dataRevision: 12, fullChecksum: checksum, payloadBytes, backupId: `20260826-151500-${label.repeat(6)}`, hashText: sha256Text });
  return { plans, value, compactJson, checksum, built };
}

test('8KiB-configurable Base64URL segments preserve compact UTF-8 JSON and required metadata', async () => {
  const { compactJson, built } = await fixture('A');
  assert.ok(built.segments.length > 1);
  assert.equal(built.diagnostics.compactJsonBytes, utf8Bytes(compactJson));
  assert.ok(built.diagnostics.base64UrlBytes > built.diagnostics.compactJsonBytes);
  assert.equal(built.diagnostics.payloadBytes, 1024);
  for (const [index, segment] of built.segments.entries()) {
    assert.equal(segment.segmentIndex, index + 1);
    assert.equal(segment.segmentTotal, built.segments.length);
    assert.ok(utf8Bytes(segment.payload) <= 1024);
    assert.match(segment.text, /格式版本: DJINSEG1/);
    assert.match(segment.text, /fullChecksum: sha256:[a-f0-9]{64}/);
    assert.match(segment.text, /segmentChecksum: sha256:[a-f0-9]{64}/);
  }
});

test('segments restore in arbitrary order and preserve every business field', async () => {
  const { value, built } = await fixture('B');
  const shuffled = [...built.segments].reverse().map(item => item.text).join('\n\n');
  const restored = await restoreSegments(shuffled, { hashText: sha256Text });
  assert.deepEqual(restored.value, value);
});

test('missing segment reports every missing index and forbids restore', async () => {
  const { built } = await fixture('C');
  const removed = built.segments.filter(item => item.segmentIndex !== 2 && item.segmentIndex !== 4).map(item => item.text).join('\n');
  await assert.rejects(() => restoreSegments(removed, { hashText: sha256Text }), error => { assert.equal(error.code, 'missing-segment');assert.deepEqual(error.details.missing, [2, 4]);return true });
});

test('duplicate segment is rejected even when its content is identical', async () => {
  const { built } = await fixture('D');
  const text = [...built.segments.map(item => item.text), built.segments[0].text].join('\n');
  await assert.rejects(() => restoreSegments(text, { hashText: sha256Text }), error => error.code === 'duplicate-segment' && error.details.duplicates[0] === 1);
});

test('segments from different backupIds cannot be mixed', async () => {
  const first = await fixture('E'), second = await fixture('F');
  const mixed = [first.built.segments[0].text, ...second.built.segments.slice(1).map(item => item.text)].join('\n');
  await assert.rejects(() => restoreSegments(mixed, { hashText: sha256Text }), error => error.code === 'mixed-backup-id');
});

test('modified payload identifies the exact segment checksum failure', async () => {
  const { built } = await fixture('G');
  const target = built.segments[1], replacement = target.payload[0] === 'A' ? 'B' : 'A';
  const corrupted = target.text.replace(target.payload, replacement + target.payload.slice(1));
  const text = built.segments.map(item => item.segmentIndex === target.segmentIndex ? corrupted : item.text).join('\n');
  await assert.rejects(() => restoreSegments(text, { hashText: sha256Text }), error => error.code === 'segment-checksum' && error.details.segmentIndex === target.segmentIndex);
});

test('full business checksum rejects a structurally valid but wrong payload', async () => {
  const original = await fixture('H');
  const alteredValue = JSON.parse(original.compactJson);
  alteredValue.plans[0].name = '被修改的客户';
  const rebuilt = await buildSegments({ compactJson: JSON.stringify(alteredValue), dataRevision: 12, fullChecksum: original.checksum, payloadBytes: 1024, backupId: '20260826-151500-IIIIII', hashText: sha256Text });
  await assert.rejects(() => restoreSegments(rebuilt.segments.map(item => item.text).join('\n'), { hashText: sha256Text }), error => error.code === 'full-checksum');
});

test('parser rejects out-of-range metadata before any JSON decode', async () => {
  const { built } = await fixture('J');
  const bad = built.segments[0].text.replace('segmentIndex: 1', `segmentIndex: ${built.segments.length + 1}`);
  assert.throws(() => parseSegments(bad), error => error.code === 'index-out-of-range');
});
