import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUsage, priceOf, totalUsage, withinBudget, type ModelPrice, type UsageRecord } from '../src/usage.ts';

/**
 * 用量与成本记账的测试。
 *
 * 重点在两条**诚实性约束**上：不知道价钱时不许猜（记 0 并单独计数），
 * 以及金额的浮点噪声要被舍掉（否则 0.1+0.2 会变成 0.30000000000000004，界面和断言都遭殃）。
 */

const PRICES: ModelPrice[] = [
  { modelId: 'mock', promptPer1k: 0.01, completionPer1k: 0.03 },
  { modelId: 'local', promptPer1k: 0, completionPer1k: 0 },
];

test('算价：按每千 token 计价，并且把浮点噪声舍到 1e-6', () => {
  const record = computeUsage({
    at: 1,
    task: 'chat',
    modelId: 'mock',
    promptTokens: 1000,
    completionTokens: 500,
    prices: PRICES,
  });
  assert.equal(record.costUsd, 0.025, '1000 输入 × 0.01 + 500 输出 × 0.03 = 0.025');
  assert.equal(record.unpriced, undefined);

  // 三次 0.1 累加不该出现 0.30000000000000004
  const cents: UsageRecord[] = [0, 1, 2].map((index) =>
    computeUsage({ at: index, task: 'chat', modelId: 'p', promptTokens: 1000, completionTokens: 0, prices: [{ modelId: 'p', promptPer1k: 0.1, completionPer1k: 0 }] }),
  );
  assert.equal(totalUsage(cents).costUsd, 0.3);
});

test('不猜价钱：价格表里没有的模型记 0 并计入 unpricedRequests', () => {
  const unknown = computeUsage({ at: 1, task: 'chat', modelId: 'gpt-未知', promptTokens: 1234, completionTokens: 567, prices: PRICES });
  assert.equal(unknown.costUsd, 0);
  assert.equal(unknown.unpriced, true);
  assert.equal(priceOf('gpt-未知', PRICES), undefined);

  const totals = totalUsage([unknown]);
  assert.equal(totals.unpricedRequests, 1);
  assert.equal(totals.costUsd, 0);

  // 预算判定要如实带出"有几次没价可算"，否则 spentUsd 会被误当成准确花费
  const budget = withinBudget([unknown], 1);
  assert.equal(budget.ok, true);
  assert.equal(budget.unpricedRequests, 1);
});

test('汇总：按模型、按任务各一份，总数与切分自洽', () => {
  const records: UsageRecord[] = [
    computeUsage({ at: 1, task: 'chat', modelId: 'mock', promptTokens: 2000, completionTokens: 1000, prices: PRICES }),
    computeUsage({ at: 2, task: 'summary', modelId: 'mock', promptTokens: 4000, completionTokens: 2000, prices: PRICES }),
    computeUsage({ at: 3, task: 'chat', modelId: 'local', promptTokens: 1000, completionTokens: 1000, prices: PRICES }),
  ];
  const totals = totalUsage(records);
  assert.equal(totals.requests, 3);
  assert.equal(totals.promptTokens, 7000);
  assert.equal(totals.completionTokens, 4000);
  // mock：2000/1000 → 0.05；4000/2000 → 0.10；合计 0.15。local 免费。
  assert.equal(totals.costUsd, 0.15);
  assert.equal(totals.byModel['mock']?.requests, 2);
  assert.equal(totals.byModel['local']?.costUsd, 0);
  assert.equal(totals.byTask['chat']?.requests, 2);
  assert.equal(totals.byTask['summary']?.costUsd, 0.1);
  console.log(`  汇总：3 次请求 7000 输入 / 4000 输出 = $${totals.costUsd}（chat 2 次、summary 1 次）`);
});

test('边界：零 token 是 0 元；负数与小数被规整；空记录汇总为 0', () => {
  assert.equal(computeUsage({ at: 1, task: 'chat', modelId: 'mock', promptTokens: 0, completionTokens: 0, prices: PRICES }).costUsd, 0);
  const weird = computeUsage({ at: 1, task: 'chat', modelId: 'mock', promptTokens: -5, completionTokens: 10.7, prices: PRICES });
  assert.equal(weird.promptTokens, 0, '负数按 0 处理');
  assert.equal(weird.completionTokens, 10, '小数取整');
  const empty = totalUsage([]);
  assert.equal(empty.requests, 0);
  assert.equal(empty.costUsd, 0);
  assert.deepEqual(empty.byModel, {});
});

test('预算：超了就 ok=false，remaining 不出现负数', () => {
  const records = [computeUsage({ at: 1, task: 'chat', modelId: 'mock', promptTokens: 10_000, completionTokens: 10_000, prices: PRICES })];
  // 10000/1000 × (0.01 + 0.03) = 0.4
  const tight = withinBudget(records, 0.3);
  assert.equal(tight.ok, false);
  assert.equal(tight.remainingUsd, 0);
  const loose = withinBudget(records, 1);
  assert.equal(loose.ok, true);
  assert.equal(loose.remainingUsd, 0.6);
  console.log(`  预算：花 $${loose.spentUsd}，剩余 $${loose.remainingUsd}（上限 $1）`);
});
