import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCollection, DeviceRosterList, parseRoster, safeThroughSeq, serializeRoster } from '../src/roster.ts';

const DAY = 24 * 3600 * 1000;

test('设备名单：登记、退役、只把活跃设备喂给验签器', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', publicKey: 'pem-a', addedAt: 0 },
    { deviceId: 'b', publicKey: 'pem-b', addedAt: 0, name: '手机' },
  ]);
  assert.deepEqual(roster.activeIds(), ['a', 'b']);
  assert.equal(roster.toVerifierMap().get('b'), 'pem-b');

  assert.equal(roster.revoke('b', 1000), true);
  assert.equal(roster.revoke('b', 2000), false, '重复退役应是无操作');
  assert.deepEqual(roster.activeIds(), ['a']);
  assert.equal(roster.toVerifierMap().has('b'), false);
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

test('名单可落盘并恢复（含退役状态）；没有公钥的设备允许存在但不参与验签', () => {
  // 共享口令（自动发现）模式下没有公钥可记。名单仍然必须落盘——
  // 否则吊销状态一重启就丢，GC 的判据跟着错。
  const roster = new DeviceRosterList([
    { deviceId: 'a', publicKey: 'pem-a', addedAt: 0 },
    { deviceId: 'b', publicKey: '', addedAt: 0, name: '手机' },
  ]);
  roster.revoke('b', 1000);

  const restored = parseRoster(serializeRoster(roster));
  assert.deepEqual(restored.activeIds(), ['a']);
  assert.equal(restored.get('b')?.revokedAt, 1000);
  assert.equal(restored.get('b')?.publicKey, '', '空公钥原样保留，不能因此拒绝整份名单');
  assert.equal(restored.toVerifierMap().has('b'), false, '退役设备不进验签表');
  assert.equal(restored.toVerifierMap().get('a'), 'pem-a');

  // 公钥字段类型不对仍然整体拒绝（那是格式错误，不是"还没配对"）
  assert.throws(() => parseRoster(JSON.stringify({ v: 1, devices: [{ deviceId: 'c', publicKey: 5, addedAt: 0 }] })));
  // 缺 deviceId 也不行
  assert.throws(() => parseRoster(JSON.stringify({ v: 1, devices: [{ publicKey: 'x', addedAt: 0 }] })));
});
