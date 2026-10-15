import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUsage } from '../../../packages/oplog/src/index.ts';
import { createUsageStore } from '../src/data/usage-store.ts';

/**
 * 回归测试：**过期设置快照下，一天内的多条记录必须累加**。
 *
 * 真机实测过这个 bug：摘要那条路把渲染时的 `settings` 快照传给用量仓，于是"读设置 → 追加 → 写回"
 * 每次读到的都是旧值，24 次调用最后只剩 1 条记录（用量面板只显示 1 次）。
 * 修法是在仓里加一层当天记录的内存叠加；这条测试把行为钉住：即使 getter 永远返回同一份**冻住的**
 * 快照，写入也必须累加。
 */

const PRICES = [{ modelId: 'deepseek-flash', promptPer1k: 0.001, completionPer1k: 0.002 }];

function frozenSettings(initial: Record<string, string>): {
  getter: () => Record<string, string>;
  writes: Record<string, string>;
} {
  const snapshot = { ...initial };
  const writes: Record<string, string> = {};
  const getter = (): Record<string, string> => snapshot; // 故意不反映写入 —— 模拟过期快照
  return { getter, writes };
}

test('过期快照下：连续 3 次 record 必须累加成 3 条，而不是互相覆盖成 1 条', async () => {
  const { getter, writes } = frozenSettings({});
  const store = createUsageStore({
    settings: getter,
    setSetting: async (key, value) => {
      writes[key] = value;
    },
  });

  for (let index = 0; index < 3; index += 1) {
    await store.record(
      'device-a',
      computeUsage({ at: 1_700_000_000_000 + index, task: 'summary', modelId: 'deepseek-flash', promptTokens: 100, completionTokens: 10, prices: PRICES }),
    );
  }

  const key = Object.keys(writes)[0] ?? '';
  const written = JSON.parse(writes[key] ?? '[]') as unknown[];
  assert.equal(written.length, 3, '最后一次写回必须包含全部 3 条（旧实现只有 1 条）');
  assert.equal(store.totals().requests, 3, '仓自己读到的总数也必须是 3（预算闸门要用）');
});

test('控制组：用实时 getter 时行为相同（累加 2 条）', async () => {
  const writes: Record<string, string> = {};
  const store = createUsageStore({
    settings: () => writes,
    setSetting: async (key, value) => {
      writes[key] = value;
    },
  });
  await store.record('device-a', computeUsage({ at: 1_700_000_000_000, task: 'chat', modelId: 'deepseek-flash', promptTokens: 1, completionTokens: 1, prices: PRICES }));
  await store.record('device-a', computeUsage({ at: 1_700_000_000_001, task: 'embed', modelId: 'Qwen3-Embedding-8B', promptTokens: 1, completionTokens: 0, prices: PRICES }));
  assert.equal(store.totals().requests, 2);
});
