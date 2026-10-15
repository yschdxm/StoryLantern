/**
 * 用量与成本记账（M4 判据 3「成本有界」的记账半边）。
 *
 * 三条刻意的设计：
 * 1. **不猜价钱**。价格表里没有的模型，costUsd 记 0、并把这条计入 `unpricedRequests` ——
 *    宁可显示"有 N 次没价可算"，也不要拍脑袋填一个数（那才是假数据）。
 * 2. **token 数是调用方给的**。本模块不做分词：调用方（应用）用自己那套估算，
 *    把数字交进来。这样这里就是纯算术，跨端行为一致，也好测。
 *    要记住：**这是估算，不是供应商账单**。
 * 3. **金额用 1e-6 精度四舍五入**。浮点数累加会出现 0.30000000000000004 这类噪声，
 *    显示和断言都会被它坑；十万分之一美元以下的误差对记账没有意义。
 *
 * 本模块是纯函数：不落盘、不发网络请求。存哪里、怎么展示由调用方决定。
 */

export type UsageTask = 'chat' | 'summary' | 'extract' | 'embed';

export interface ModelPrice {
  /** 模型标识（与设置里的配置 id 或供应商标识一致；本模块只做精确匹配）。 */
  modelId: string;
  /** 每 1000 输入 token 的美元价。 */
  promptPer1k: number;
  /** 每 1000 输出 token 的美元价。 */
  completionPer1k: number;
}

export interface UsageRecord {
  /** 发生时刻（毫秒）。 */
  at: number;
  task: UsageTask;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** 价格表里没有这个模型 → true（此时 costUsd 一定是 0，不是"估的"。） */
  unpriced?: boolean;
}

/** 精确匹配价格；找不到就是找不到（不按前缀猜、不拿别的模型顶替）。 */
export function priceOf(modelId: string, prices: readonly ModelPrice[]): ModelPrice | undefined {
  return prices.find((price) => price.modelId === modelId);
}

export interface ComputeUsageInput {
  at: number;
  task: UsageTask;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  prices: readonly ModelPrice[];
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function computeUsage(input: ComputeUsageInput): UsageRecord {
  const price = priceOf(input.modelId, input.prices);
  const base: Omit<UsageRecord, 'costUsd'> = {
    at: input.at,
    task: input.task,
    modelId: input.modelId,
    promptTokens: Math.max(0, Math.floor(input.promptTokens)),
    completionTokens: Math.max(0, Math.floor(input.completionTokens)),
  };
  if (price === undefined) return { ...base, costUsd: 0, unpriced: true };
  const cost = (base.promptTokens / 1000) * price.promptPer1k + (base.completionTokens / 1000) * price.completionPer1k;
  return { ...base, costUsd: round6(cost) };
}

export interface UsageSlice {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  unpricedRequests: number;
}

export interface UsageTotals extends UsageSlice {
  byModel: Record<string, UsageSlice>;
  byTask: Record<string, UsageSlice>;
}

const emptySlice = (): UsageSlice => ({ requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedRequests: 0 });

function add(slice: UsageSlice, record: UsageRecord): void {
  slice.requests += 1;
  slice.promptTokens += record.promptTokens;
  slice.completionTokens += record.completionTokens;
  slice.costUsd = round6(slice.costUsd + record.costUsd);
  if (record.unpriced === true) slice.unpricedRequests += 1;
}

/** 汇总；同时按模型、按任务各切一份（界面上"这个月花了多少、花在哪"要看这个）。 */
export function totalUsage(records: readonly UsageRecord[]): UsageTotals {
  const totals: UsageTotals = { ...emptySlice(), byModel: {}, byTask: {} };
  for (const record of records) {
    add(totals, record);
    const byModel = totals.byModel[record.modelId] ?? emptySlice();
    add(byModel, record);
    totals.byModel[record.modelId] = byModel;
    const byTask = totals.byTask[record.task] ?? emptySlice();
    add(byTask, record);
    totals.byTask[record.task] = byTask;
  }
  return totals;
}

export interface BudgetState {
  ok: boolean;
  spentUsd: number;
  remainingUsd: number;
  /** 有几次因为没价而无法计入 —— 有它就意味着"实际可能比 spentUsd 更高"。 */
  unpricedRequests: number;
}

/**
 * 发送**之前**的预算判定：把"这一次还打算花多少"也一起算进去。
 *
 * 与 withinBudget 的区别：那个看"已经花了多少"，这个回答"再花这一笔会不会超"——
 * 发送路径要的是后者，否则永远只能事后发现超支。
 * 注意 estimateUsd 通常应当是**上界**（例如按 max_tokens 估输出），这样拦截不会漏。
 */
export function wouldExceed(records: readonly UsageRecord[], budgetUsd: number, estimateUsd: number): BudgetState {
  const state = withinBudget(records, budgetUsd);
  const projected = round6(state.spentUsd + Math.max(0, estimateUsd));
  return {
    ok: projected <= budgetUsd,
    spentUsd: state.spentUsd,
    remainingUsd: round6(Math.max(0, budgetUsd - projected)),
    unpricedRequests: state.unpricedRequests,
  };
}

/**
 * 预算判定。**注意**：`unpricedRequests > 0` 时 `spentUsd` 是**下界**，
 * 调用方应当把它显示出来，别让用户以为这是准确花费。
 */
export function withinBudget(records: readonly UsageRecord[], budgetUsd: number): BudgetState {
  const totals = totalUsage(records);
  return {
    ok: totals.costUsd <= budgetUsd,
    spentUsd: totals.costUsd,
    remainingUsd: round6(Math.max(0, budgetUsd - totals.costUsd)),
    unpricedRequests: totals.unpricedRequests,
  };
}
