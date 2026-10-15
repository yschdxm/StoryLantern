import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUsage, type UsageRecord } from '../../../packages/oplog/src/index.ts';
import {
  createUsageStore,
  localDay,
  parseBudget,
  parsePriceTable,
  usageKey,
  USAGE_KEY_PREFIX,
} from '../src/data/usage-store.ts';

/**
 * 用量仓与预算闸门（M4 判据 3 的应用侧）。
 *
 * 两条诚实性约束在这个文件里被钉住：
 * 1. **非法输入要拒绝并说明**（价格表/预算），不能静默当空——否则用户会以为"设了却没生效"；
 * 2. **闸门必须真的能拦住**：所以既要有"记了用量之后会拦"，也要有"没设预算时永不拦"。
 *    另外用量按"设备 + 日期"分键，跨设备不该互相覆盖。
 */

const PRICES = [{ modelId: 'p1', promptPer1k: 0.01, completionPer1k: 0.03 }];

function storeWith(initial: Record<string, string>) {
  const settings: Record<string, string> = { ...initial };
  const writes: string[] = [];
  const store = createUsageStore({
    settings: () => settings,
    setSetting: async (key, value) => {
      settings[key] = value;
      writes.push(key);
    },
  });
  return { store, settings, writes };
}

test('价格表解析：合法则通过；非法输入拒绝并给出能照做的说明', () => {
  const ok = parsePriceTable(JSON.stringify(PRICES));
  assert.equal(ok.error, undefined);
  assert.equal(ok.value[0]?.modelId, 'p1');

  assert.equal(parsePriceTable('').value.length, 0, '留空 = 没有价格表（不是错误）');
  assert.match(parsePriceTable('{').error ?? '', /合法 JSON/);
  assert.match(parsePriceTable('{"modelId":"x"}').error ?? '', /必须是一个数组/);
  assert.match(parsePriceTable('[{"promptPer1k":1,"completionPer1k":2}]').error ?? '', /modelId/);
  assert.match(parsePriceTable('[{"modelId":"x","promptPer1k":"1","completionPer1k":2}]').error ?? '', /必须是数字/);
  assert.match(parsePriceTable('[{"modelId":"x","promptPer1k":-1,"completionPer1k":2}]').error ?? '', /不能是负数/);
  // 有错时给出的是"安全默认值"，不是半个表
  assert.deepEqual(parsePriceTable('[{"modelId":"x","promptPer1k":"1","completionPer1k":2}]').value, []);
});

test('预算解析：留空 = 不设上限；非正数/非数字拒绝', () => {
  assert.equal(parseBudget('').value, undefined);
  assert.equal(parseBudget('2.5').value, 2.5);
  assert.match(parseBudget('0').error ?? '', /大于 0/);
  assert.match(parseBudget('-3').error ?? '', /大于 0/);
  assert.match(parseBudget('abc').error ?? '', /大于 0/);
});

test('用量按"设备 + 日期"分键：跨设备不互相覆盖，累计能看到全部', async () => {
  const { store, settings } = storeWith({ 'usage.prices': JSON.stringify(PRICES) });
  const at = new Date('2026-10-15T10:00:00').getTime();
  const record = (promptTokens: number): UsageRecord =>
    computeUsage({ at, task: 'chat', modelId: 'p1', promptTokens, completionTokens: 0, prices: PRICES });

  await store.record('device-a', record(1000)); // 0.01
  await store.record('device-b', record(2000)); // 0.02
  await store.record('device-a', record(1000)); // 0.01

  assert.equal(Object.keys(settings).includes(usageKey('device-a', localDay(at))), true, '键应当是 usage.device.<设备>.<日期>');
  assert.equal(Object.keys(settings).some((key) => key === usageKey('device-b', localDay(at))), true);
  assert.equal(store.today('device-a', at).length, 2);
  assert.equal(store.today('device-b', at).length, 1);
  const totals = store.totals();
  assert.equal(totals.requests, 3);
  assert.equal(totals.costUsd, 0.04);
  assert.equal(totals.byModel['p1']?.requests, 3);
  console.log(`  用量仓：a 2 条 + b 1 条，累计 $${totals.costUsd}（键前缀 ${USAGE_KEY_PREFIX}）`);
});

test('没设预算时永不拦；设了之后"已花 + 这次上界"超了就必须拦', async () => {
  const { store } = storeWith({ 'usage.prices': JSON.stringify(PRICES) });
  // 没设预算：即使估算很大也不拦（这是"可测量"而不是"替用户做主"）
  assert.equal(store.gate(999).ok, true);

  const withBudget = storeWith({ 'usage.prices': JSON.stringify(PRICES), 'usage.budget_usd': '0.05' });
  // 每千 token $0.01/$0.03：1000 输入 + 1000 输出 = $0.04 的上界
  assert.equal(withBudget.store.gate(0.04).ok, true);
  await withBudget.store.record('device-a', computeUsage({ at: Date.now(), task: 'chat', modelId: 'p1', promptTokens: 1000, completionTokens: 1000, prices: PRICES }));
  const blocked = withBudget.store.gate(0.04);
  assert.equal(blocked.ok, false, '已花 $0.04 + 这次 $0.04 → 超过 $0.05 的预算，必须拦');
  assert.equal(blocked.spentUsd, 0.04);
  console.log(`  闸门：花 $${blocked.spentUsd} + 预计 $0.04 > 预算 $0.05 → 拦住`);
});

test('不猜价钱：价格表里没有该模型时，估算为 0 且记入 unpricedRequests', async () => {
  const { store } = storeWith({});
  assert.equal(store.estimateCost('未知模型', 1000, 1000), 0, '没价就不该编一个');
  await store.record(
    'device-a',
    computeUsage({ at: Date.now(), task: 'chat', modelId: '未知模型', promptTokens: 500, completionTokens: 500, prices: [] }),
  );
  assert.equal(store.totals().unpricedRequests, 1, '界面要能显示"有 N 次没价可算"');
  assert.equal(store.totals().costUsd, 0);
});
