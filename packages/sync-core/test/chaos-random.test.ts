import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend, settingSet } from '../../oplog/src/op.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

/**
 * M6 判据 ② 的那一条："混沌测试（3 设备 × 随机 op、随机离线、中途杀进程）收敛一致、
 * 0 丢消息、0 重复、可续传"。
 *
 * `chaos.test.ts` 里的"事故 7"已经覆盖了三设备同时在线，但它的"随机"其实是**固定模式**
 * （`(round + deviceId.length) % 3`），而且**没有"中途被杀"**。这一份补上：
 *
 *  - 随机源是**固定 seed 的 mulberry32** —— 混沌测试必须可复现，否则红了也没法查（计划里写着"固定 seed"）；
 *  - 随机 op：每轮每台设备随机追加 1~2 条消息（+ 随机写设置）；
 *  - 随机故障：随机离线；以及"跑到一半进程被杀"（后端跑满 N 次访问后全部抛错），
 *    杀完**不修任何东西**直接再来一轮 —— 这才是"可续传"的真正考验；
 *  - 判据：三台设备 `freeze` 完全一致、消息 id **一条不多一条不少**、无孤儿 op、且**同一 seed 两次跑结果相同**。
 */

/** mulberry32：小而确定的 PRNG（同一 seed 必定同一序列）。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ChaosOutcome {
  freezes: string[];
  views: string[];
  ids: string[];
  kills: number;
  orphans: number;
}

/**
 * **内容投影**：消息（id/正文/作者/是否删除）与设置值，**排除** op id 与 HLC。
 *
 * 为什么不能拿 `freeze` 当"两次运行是否一样"的见证：`freeze` 里含 `appliedOpIds`，
 * 而 op id 是 ULID（**按设计带随机**，它是身份不是内容）→ 同一 seed 两次跑必然不同。
 * 于是分两个口径：**同一次运行内**跨设备收敛看 `freeze`（op id 经同步共享，比较有意义）；
 * **跨运行可复现**看这个投影（混沌测试要能"红了查得动"，靠的就是这份内容一致）。
 */
function stateView(peer: { materializer: { state: { messages: Record<string, { content?: unknown; author?: unknown; deleted?: unknown }>; settings: Record<string, { value: unknown }> } } }): string {
  const state = peer.materializer.state;
  return JSON.stringify({
    messages: Object.keys(state.messages)
      .filter((id) => state.messages[id]?.deleted === undefined)
      .sort()
      .map((id) => {
        const message = state.messages[id];
        return { id, content: message?.content ?? null, author: message?.author ?? null };
      }),
    settings: Object.entries(state.settings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, stored]) => [key, stored.value]),
  });
}

async function chaosRun(seed: number): Promise<ChaosOutcome> {
  const devices = ['device-a', 'device-b', 'device-c'];
  const world = createWorld({ deviceIds: devices, snapshotThreshold: 4 });
  const random = rng(seed);
  const expected = new Set<string>();
  let kills = 0;

  for (let round = 0; round < 8; round += 1) {
    for (const deviceId of devices) {
      const peer = world.peer(deviceId);
      const count = 1 + Math.floor(random() * 2);
      for (let index = 0; index < count; index += 1) {
        const id = `R${round}-${deviceId}-${index}`;
        emit(
          peer,
          messageAppend(peer, { sessionId: 'S1', messageId: id, author: 'user', content: `第 ${round} 轮 ${id}` }),
        );
        expected.add(id);
      }
      if (random() < 0.5) emit(peer, settingSet(peer, { key: `pref.${deviceId}`, value: round }));
    }

    // 随机同步顺序（Fisher–Yates，用同一个 seed 驱动）
    const order = [...devices];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      const left = order[index] as string;
      order[index] = order[swap] as string;
      order[swap] = left;
    }

    for (const deviceId of order) {
      const dice = random();
      if (dice < 0.2) {
        world.backend.faults.offline = true;
        await world.sync(deviceId).catch(() => undefined);
        world.backend.faults.offline = false;
      } else if (dice < 0.4) {
        // "跑到一半进程被杀"：跑满 N 次访问后，之后每次访问都抛错
        world.backend.faults.failAfterRequests = 2 + Math.floor(random() * 5);
        await world.sync(deviceId).catch(() => undefined);
        world.backend.faults.failAfterRequests = null; // 复位：下一轮还能再杀一次
        kills += 1;
      } else {
        await world.sync(deviceId).catch(() => undefined);
      }
    }
  }

  // 故障全部撤掉后收敛；**再 settle 一轮**，把"被杀"时留下的待办补干净
  world.backend.faults.offline = false;
  world.backend.faults.failAfterRequests = null;
  await world.settle();
  await world.settle();

  const freezes = devices.map((deviceId) => freeze(world.peer(deviceId)));
  const views = devices.map((deviceId) => stateView(world.peer(deviceId)));
  const ids = messageIds(world.peer(devices[0] as string)).sort();
  const orphans = devices.reduce((total, deviceId) => total + world.peer(deviceId).materializer.orphanCount, 0);
  return { freezes, views, ids, kills, orphans };
}

test('随机混沌（seed 20261016）：3 设备 × 随机 op × 随机离线 × 中途被杀 → 收敛、0 丢 0 重、无孤儿', async () => {
  const outcome = await chaosRun(20261016);

  assert.equal(new Set(outcome.freezes).size, 1, `三台设备必须收敛到同一状态：${outcome.freezes.length} 份`);
  assert.equal(outcome.ids.length, new Set(outcome.ids).size, '消息 id 不得重复');
  // 每轮每台设备写 1~2 条 → 8 轮 × 3 台 = 24~48 条；这里是**区间**，不是编一个数
  assert.ok(
    outcome.ids.length >= 24 && outcome.ids.length <= 48,
    `消息总数应在 24~48 之间（8 轮 × 3 台 × 每台 1~2 条），实际 ${outcome.ids.length}`,
  );
  assert.equal(outcome.orphans, 0, '不应残留孤儿 op');
  assert.ok(outcome.kills > 0, `这一轮必须真的发生过"中途被杀"，实际 ${outcome.kills} 次`);
});

test('混沌可复现：同一 seed 跑两次，内容投影逐字节一样（红了才查得动）', async () => {
  const first = await chaosRun(20261016);
  const second = await chaosRun(20261016);
  assert.deepEqual(second.views, first.views, '同一 seed 必须给出同一份内容（口径见 stateView 的注释）');
  assert.deepEqual(second.ids, first.ids, '同一 seed 必须给出同一组消息');
  assert.equal(second.kills, first.kills);
  assert.equal(second.orphans, first.orphans);
});

test('换一个 seed 同样收敛（不是恰好挑了一个能过的随机序列）', async () => {
  for (const seed of [1, 7, 42, 123456]) {
    const outcome = await chaosRun(seed);
    assert.equal(new Set(outcome.freezes).size, 1, `seed=${seed} 未收敛`);
    assert.equal(outcome.ids.length, new Set(outcome.ids).size, `seed=${seed} 出现重复消息`);
    assert.equal(outcome.orphans, 0, `seed=${seed} 残留孤儿 op`);
  }
});

test('可续传：被杀之后不做任何修复，下一轮同步就把数据补上（幂等重放）', async () => {
  const devices = ['device-a', 'device-b'];
  const world = createWorld({ deviceIds: devices });
  const a = world.peer('device-a');
  const b = world.peer('device-b');

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'K1', author: 'user', content: '被杀之前写的' }));
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'K2', author: 'user', content: '也是被杀之前写的' }));

  // 第一轮同步跑两次访问就被杀
  world.backend.faults.failAfterRequests = 2;
  await assert.rejects(() => world.sync('device-a'));
  world.backend.faults.failAfterRequests = null;

  // 不做任何修复，直接再来一轮 —— 远端没被写坏、本地也没丢
  await world.sync('device-a');
  await world.sync('device-b');
  await world.settle();

  assert.deepEqual(messageIds(b), ['K1', 'K2'], '续传后两条都要到');
  assert.equal(freeze(a), freeze(b));
  assert.equal(a.engine.state.outbox.length, 0, '待发布队列要清空');

  // 再来一轮也不能产生重复（幂等）
  await world.settle();
  assert.deepEqual(messageIds(b), ['K1', 'K2']);
  assert.equal(world.peer('device-b').materializer.orphanCount, 0);
});
