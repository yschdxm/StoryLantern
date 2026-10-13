import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOpOrder, HlcClock } from '../src/hlc.ts';

test('同一毫秒内多次 tick 产生严格递增的 (t, c)', () => {
  const clock = new HlcClock({ now: () => 1000 });
  const first = clock.tick();
  const second = clock.tick();
  const third = clock.tick();

  assert.equal(first.t, 1000);
  assert.equal(first.c, 0);
  assert.equal(second.c, 1);
  assert.equal(third.c, 2);
  assert.ok(compareOpOrder({ hlc: third, opId: 'a' }, { hlc: first, opId: 'z' }) > 0);
});

test('墙上时钟前进时 c 归零', () => {
  let now = 1000;
  const clock = new HlcClock({ now: () => now });
  clock.tick();
  clock.tick();
  now = 2000;
  const ticked = clock.tick();
  assert.deepEqual(ticked, { t: 2000, c: 0 });
});

test('merge：远端口更快时本地采纳远端时间并递增因果计数', () => {
  const clock = new HlcClock({ now: () => 1000 });
  const merged = clock.merge({ t: 5000, c: 3 });
  assert.deepEqual(merged, { t: 5000, c: 4 });
  // 本地时钟被"拉慢"也不会把 t 拉回去
  const after = clock.tick();
  assert.equal(after.t, 5000);
  assert.equal(after.c, 5);
});

test('merge：本地更快时只递增自己的因果计数', () => {
  const clock = new HlcClock({ now: () => 9000 });
  clock.tick();
  const merged = clock.merge({ t: 1000, c: 7 }, 'peer');
  assert.deepEqual(merged, { t: 9000, c: 1 });
});

test('远端时钟超限会被拒绝，避免被错误时钟带飞', () => {
  const clock = new HlcClock({ now: () => 1000, maxDriftMs: 60_000 });
  assert.throws(() => clock.merge({ t: 1000 + 61_000, c: 0 }, 'bad-peer'), /超过允许漂移上限/);
});

test('全序比较：HLC 相同的两个 op 用 opId 破平局，结果稳定', () => {
  const hlc = { t: 1, c: 1 };
  const sorted = [
    { hlc, opId: 'c' },
    { hlc, opId: 'a' },
    { hlc, opId: 'b' },
  ].sort(compareOpOrder);
  assert.deepEqual(
    sorted.map((item) => item.opId),
    ['a', 'b', 'c'],
  );
  assert.equal(compareOpOrder({ hlc, opId: 'a' }, { hlc, opId: 'a' }), 0);
});
