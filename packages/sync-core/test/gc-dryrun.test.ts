import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectTrash } from '../src/gc.ts';
import { DeviceRosterList } from '../src/roster.ts';
import type { SyncBackend } from '../src/backend.ts';

/**
 * 回收的默认姿态：**先只分析、不动手**。
 * 这一条比"删得对不对"更重要——回收不可恢复，而判定依赖"所有活跃设备都已并入"这个前提。
 */

function backend(record: string[]): SyncBackend & { deleted: string[] } {
  const deleted: string[] = [];
  const target: SyncBackend & { deleted: string[] } = {
    id: 'fake',
    capabilities: { conditionalPut: true, rangeRead: false, delete: true, listPagination: false, watch: false },
    deleted,
    async list(prefix) {
      record.push(`list:${prefix}`);
      return { entries: [], nextCursor: undefined };
    },
    async get() {
      return new Uint8Array();
    },
    async put(path) {
      record.push(`put:${path}`);
      return { ok: true };
    },
    async delete(path) {
      deleted.push(path);
    },
  };
  return target;
}

/** 段的时间戳是 GC 的宽限期判据：这里给"很久以前发布"的值，才可能被回收。 */
const hosted = {
  'blind-1': {
    lastSeq: 3,
    segments: { '1': 'aaaaaaaa', '2': 'bbbbbbbb', '3': 'cccccccc' },
    bytes: 3,
    epoch: 0,
    segmentsSinceSnapshot: 3,
    publishedAt: { '1': 1_000, '2': 1_000, '3': 1_000 },
  },
};

const roster = new DeviceRosterList([
  { deviceId: 'device-a', addedAt: 0, name: '本机' },
  { deviceId: 'device-b', addedAt: 0, name: '手机' },
]);

test('GC：默认只分析——列出候选但一次都不删', async () => {
  const calls: string[] = [];
  const result = await collectTrash({
    backend: backend(calls),
    deviceId: 'device-a',
    roster,
    ack: { 'device-a': 3 },
    peerAck: { 'device-b': { 'device-a': 3 } },
    hosted,
    peerHosted: {},
    now: () => 10 * 60_000,
    graceMs: 1_000,
  });

  assert.equal(result.candidates.length, 3, '三个段都该是候选');
  assert.equal(result.moved.length, 0, '默认不移动');
  assert.ok(result.reasons.every((line) => line.includes('仅分析')));
});

test('GC：显式 dryRun=false 才真的动（先写一份进 trash，再删原段）', async () => {
  const calls: string[] = [];
  const target = backend(calls);
  const result = await collectTrash({
    backend: target,
    deviceId: 'device-a',
    roster,
    ack: { 'device-a': 3 },
    peerAck: { 'device-b': { 'device-a': 3 } },
    hosted,
    peerHosted: {},
    now: () => 10 * 60_000,
    graceMs: 1_000,
    dryRun: false,
  });

  assert.equal(result.moved.length, 3);
  // 正确行为（真机踩到过旧的假行为）：**删的是原路径**，trash 里留的是副本。
  // 以前这里断言"删的是 trash/… 路径"——那正好把一个 bug 写成了规范：删除一个从来没被创建过的路径，
  // 却报告成功，于是用户点完「确认回收」，共享目录里什么都没少。
  assert.equal(target.deleted.length, 3);
  for (const path of target.deleted) assert.doesNotMatch(path, /trash\//, '删的是原段；trash 里存的是副本');
  const trashed = calls.filter((line) => line.startsWith('put:trash/'));
  assert.equal(trashed.length, 3, '每个被回收的段都要先写一份进 trash');
  for (const path of result.moved) {
    const name = path.split('/').pop() ?? '';
    assert.ok(trashed.some((line) => line.endsWith(name)), 'trash 里要有 ' + path + ' 的副本');
  }
});

test('GC：还有设备没并入时，一个都不回收（宁可多占空间）', async () => {
  const target = backend([]);
  const result = await collectTrash({
    backend: target,
    deviceId: 'device-a',
    roster,
    ack: { 'device-a': 3 },
    // device-b 只并入到第 1 号段
    peerAck: { 'device-b': { 'device-a': 1 } },
    hosted,
    peerHosted: {},
    now: () => 10 * 60_000,
    graceMs: 1_000,
    dryRun: false,
  });

  assert.equal(result.candidates.length, 1, '只有第 1 号段是安全的');
  assert.equal(target.deleted.length, 1);
  assert.ok(result.reasons.some((line) => line.includes('safeThrough')));
});

test('GC：已退役设备超过宽限期后可以回收（离线期间的数据不再保留）', async () => {
  const target = backend([]);
  const withRevoked = new DeviceRosterList([
    { deviceId: 'device-a', addedAt: 0 },
    { deviceId: 'device-b', addedAt: 0, revokedAt: 5 },
  ]);
  const result = await collectTrash({
    backend: target,
    deviceId: 'device-a',
    roster: withRevoked,
    ack: { 'device-a': 1 },
    peerAck: {},
    hosted: { 'blind-1': { lastSeq: 1, segments: { '1': 'aaaaaaaa' }, bytes: 1, epoch: 0, segmentsSinceSnapshot: 1, publishedAt: { '1': 1_000 } } },
    peerHosted: {},
    now: () => 10 * 60_000,
    graceMs: 1_000,
    dryRun: false,
  });
  assert.equal(result.moved.length, 1, '退役设备不参与 safeThrough，因此可以回收');
});

test('GC：后端不支持 delete 时只报告，不假装删掉了', async () => {
  const noDelete: SyncBackend = {
    id: 'fake-no-delete',
    capabilities: { conditionalPut: false, rangeRead: false, delete: false, listPagination: false, watch: false },
    async list() {
      return { entries: [], nextCursor: undefined };
    },
    async get() {
      return new Uint8Array();
    },
    async put() {
      // 不支持 delete 的后端
      return { ok: true };
    },
  };
  const result = await collectTrash({
    backend: noDelete,
    deviceId: 'device-a',
    roster,
    ack: { 'device-a': 3 },
    peerAck: { 'device-b': { 'device-a': 3 } },
    hosted,
    peerHosted: {},
    now: () => 10 * 60_000,
    graceMs: 1_000,
    dryRun: false,
  });
  assert.equal(result.moved.length, 0);
  assert.ok(result.reasons.some((line) => line.includes('不支持 delete')));
});
