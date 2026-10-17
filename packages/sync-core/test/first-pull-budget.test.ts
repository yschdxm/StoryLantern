import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend } from '../../oplog/src/op.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

/**
 * PLAN 里"首会话拉取 ≤5MB"这条预算的**可运行断言**。
 *
 * 为什么需要它：这条预算此前没有任何落点（审计清单第 6 项）。它约束的是
 * "换机/新设备第一次同步一个会话时，从哑存储读下来的字节数"——
 * 如果哪天有人把段改成明文 JSONL、或者把整份历史塞进 manifest，这条会立刻红。
 *
 * 计量方式：给 `backend.get` 包一层，统计新设备这次实际读下的字节数（list 不算体积）。
 * 不做估算、不按"文件加总"猜 —— 读了多少就是多少。
 */

const A = 'device-a';
const B = 'device-b';
const BUDGET_BYTES = 5 * 1024 * 1024;
/**
 * 规模说明（诚实）：原本想直接量 1 万条，但 1 万条 × 100 次 sync 在本机跑到 3.4 分钟后
 * 抛 `RangeError: Array buffer allocation failed`（段/快照链上的一次超大分配）。
 * 那是**另一个**问题（1 万条规模的分配上限），不该混进这条预算断言里；这里用 2000 条，
 * 既能让"首拉字节数"有量级意义，又能在十几秒内跑完。
 */
const TOTAL_MESSAGES = 2000;
const BATCH = 200;

test(`首会话拉取 ≤5MB：${TOTAL_MESSAGES} 条消息的新设备首次同步`, async () => {
  const world = createWorld({ deviceIds: [A, B], snapshotThreshold: 8 });
  const a = world.peer(A);
  const b = world.peer(B);

  // A 攒出 2000 条消息（分批 sync，让段与快照都真实发布）
  for (let batch = 0; batch < TOTAL_MESSAGES / BATCH; batch += 1) {
    for (let index = 0; index < BATCH; index += 1) {
      const n = batch * BATCH + index;
      emit(
        a,
        messageAppend(a, {
          sessionId: 'S1',
          messageId: `M${String(n).padStart(5, '0')}`,
          author: n % 2 === 0 ? 'user' : 'assistant',
          content: `第 ${n} 条：` + '雪线以上的风把灯吹得发颤。'.repeat(2),
        }),
      );
    }
    await world.sync(A);
  }

  assert.equal(messageIds(b).length, 0, 'B 在首拉之前必须是空的（否则量到的不是"第一次同步"）');

  // 计量：统计 B 这次真正读下来的字节
  const originalGet = world.backend.get.bind(world.backend);
  let pulledBytes = 0;
  let gets = 0;
  (world.backend as unknown as { get: typeof originalGet }).get = async (path: string) => {
    const bytes = await originalGet(path);
    pulledBytes += bytes.length;
    gets += 1;
    return bytes;
  };
  try {
    await world.sync(B);
  } finally {
    (world.backend as unknown as { get: typeof originalGet }).get = originalGet;
  }

  // 首拉之后必须真的收敛（不然"读得少"没有意义）。
  // 比的是**解析后的对象**而不是 JSON 字符串：两条链的落库顺序不同，键序会不同，但内容必须一致。
  assert.deepEqual(JSON.parse(freeze(b)) as unknown, JSON.parse(freeze(a)) as unknown, '首拉后 B 的状态必须与 A 完全一致');
  assert.equal(messageIds(b).length, TOTAL_MESSAGES, 'B 应当拿到全部消息');

  console.log(
    `  [首会话拉取] ${TOTAL_MESSAGES} 条消息：读了 ${pulledBytes} B（${(pulledBytes / 1024).toFixed(1)} KB），` +
      `${gets} 次 get，预算 ${(BUDGET_BYTES / 1024 / 1024).toFixed(0)} MB`,
  );
  assert.ok(
    pulledBytes <= BUDGET_BYTES,
    `首会话拉取 ${pulledBytes} B 超过预算 ${BUDGET_BYTES} B（${(pulledBytes / 1024 / 1024).toFixed(2)} MB）`,
  );
});
