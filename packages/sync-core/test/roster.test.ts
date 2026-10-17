import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCollection, DeviceRosterList, parseRoster, safeThroughSeq, serializeRoster } from '../src/roster.ts';

const DAY = 24 * 3600 * 1000;

test('设备名单：登记、退役；只有活跃设备参与 GC 判据', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', addedAt: 0 },
    { deviceId: 'b', addedAt: 0, name: '手机' },
  ]);
  assert.deepEqual(roster.activeIds(), ['a', 'b']);

  assert.equal(roster.revoke('b', 1000), true);
  assert.equal(roster.revoke('b', 2000), false, '重复退役应是无操作');
  assert.deepEqual(roster.activeIds(), ['a']);
});

test('safeThrough：取所有活跃设备声明的最小值；没声明按 0 处理（保守）', () => {
  const sources = [
    { deviceId: 'a', ack: { a: 5, b: 3 } },
    { deviceId: 'b', ack: { a: 4 } },
  ];
  assert.equal(safeThroughSeq(sources, ['a', 'b'], 'a'), 4);
  assert.equal(safeThroughSeq(sources, ['a', 'b'], 'b'), 0, ' b 未声明对 a 的并入进度');

  // 设备 c 从未上报 → 必须是 0，否则会误删它还没拿到的段
  assert.equal(safeThroughSeq(sources, ['a', 'b', 'c'], 'a'), 0);
});

test('保守 GC：未全部确认不回收；宽限期内不回收；两者都满足才回收', () => {
  const now = 10 * DAY;
  const base = { owner: 'a', seq: 3, ownerActive: true, now, graceMs: 30 * DAY, lastSeenAt: now - 40 * DAY };

  assert.equal(decideCollection({ ...base, safeThrough: 2 }).collect, false);
  assert.equal(decideCollection({ ...base, safeThrough: 3 }).collect, true);
  assert.equal(decideCollection({ ...base, safeThrough: 5 }).collect, true);

  const fresh = decideCollection({ ...base, safeThrough: 5, lastSeenAt: now - 1 * DAY });
  assert.equal(fresh.collect, false);
  assert.match(fresh.reason, /宽限期/);
});

test('保守 GC：已退役设备的遗留段在宽限期后回收', () => {
  const now = 10 * DAY;
  const base = { owner: 'gone', seq: 9, safeThrough: 0, now, graceMs: DAY, lastSeenAt: now };

  assert.equal(decideCollection({ ...base, ownerActive: false }).collect, false);
  const old = decideCollection({ ...base, ownerActive: false, lastSeenAt: now - 2 * DAY });
  assert.equal(old.collect, true);
  assert.match(old.reason, /退役/);
});

test('GC 决策对每个候选都给出可读理由（UI 要能解释"为什么不回收"）', () => {
  const decision = decideCollection({
    owner: 'a',
    seq: 7,
    ownerActive: true,
    safeThrough: 4,
    now: 1000,
    lastSeenAt: 0,
    graceMs: 10,
  });
  assert.equal(decision.collect, false);
  assert.match(decision.reason, /safeThrough=4/);
});

test('名单可落盘并恢复（含退役状态）；旧文件的已删除字段被忽略', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', addedAt: 0 },
    { deviceId: 'b', addedAt: 0, name: '手机' },
  ]);
  roster.revoke('b', 1000);

  const restored = parseRoster(serializeRoster(roster));
  assert.deepEqual(restored.activeIds(), ['a']);
  assert.equal(restored.get('b')?.revokedAt, 1000);

  // 旧版本写过 publicKey / stamp：读的时候忽略，不报错
  const legacy = parseRoster(
    JSON.stringify({
      v: 1,
      devices: [{ deviceId: 'c', publicKey: 'old-key', addedAt: 1 }],
      stamp: { v: 1, managementPublicKey: 'x', signature: 'y', at: 1 },
    }),
  );
  assert.deepEqual(legacy.list().map((record) => record.deviceId), ['c']);

  // 缺 deviceId / addedAt 仍然整体拒绝（那是格式错误，不是"还没配对"）
  assert.throws(() => parseRoster(JSON.stringify({ v: 1, devices: [{ addedAt: 0 }] })));
  assert.throws(() => parseRoster(JSON.stringify({ v: 1, devices: [{ deviceId: 'c' }] })));
});

test('黑名单：永久禁用的设备不算活跃，可解除，且重复禁用是幂等的', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', addedAt: 1 },
    { deviceId: 'b', addedAt: 1 },
  ]);

  assert.deepEqual(roster.activeIds().sort(), ['a', 'b']);
  assert.equal(roster.ban('b', 100), true);
  assert.deepEqual(roster.activeIds(), ['a'], '被永久禁用的不再活跃（GC 判定也不能算它）');
  assert.equal(roster.isBanned('b'), true);
  assert.deepEqual(roster.bannedIds(), ['b']);
  assert.equal(roster.ban('b', 200), false, '重复禁用了要返回 false（幂等）');
  assert.equal(roster.ban('nobody', 200), false, '不在名单里的设备不能禁');

  assert.equal(roster.unban('b'), true);
  assert.equal(roster.isBanned('b'), false);
  assert.deepEqual(roster.activeIds().sort(), ['a', 'b']);
});

test('黑名单：临时吊销（revokedAt）与永久禁用（bannedAt）是两件事，可以并存', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', addedAt: 1 },
    { deviceId: 'b', addedAt: 1 },
  ]);
  roster.revoke('b', 50);
  roster.ban('b', 60);
  const record = roster.get('b');
  assert.equal(record?.revokedAt, 50);
  assert.equal(record?.bannedAt, 60);
});
