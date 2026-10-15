import {
  computeUsage,
  priceOf,
  totalUsage,
  withinBudget,
  wouldExceed,
  type BudgetState,
  type ModelPrice,
  type UsageRecord,
  type UsageTask,
  type UsageTotals,
} from '../../../../packages/oplog/src/index.ts';

/**
 * 用量与价格的**应用侧**部分：价格表/预算的设置解析 + 按"设备 + 日期"把用量记进 op。
 *
 * 三条设计：
 * 1. **记进 op**（用现成的 \`setting.set\`）：用量跟着同步走、可被快照覆盖，也不需要新 op 类型。
 *    键是 \`usage.device.<deviceId>.<YYYY-MM-DD>\` —— **每台设备只写自己的键**，所以跨设备不会互相覆盖，
 *    而界面把前缀下一堆键加起来就是全组花费。
 * 2. **不猜价钱**：价格表是空的（或某模型不在表里）时，那条记录 costUsd 记 0 并计入 unpricedRequests，
 *    界面照实显示"有 N 次没价可算"，而不是拿别的模型的价格顶替。
 * 3. **非法输入拒绝并说明**：价格表/预算是用户手填的 JSON，解析失败要给出能照做的错误信息，
 *    不能静默当空（那会让人以为"设了价格却没生效"）。
 */

export const USAGE_KEY_PREFIX = 'usage.device.';

/** 一天的键；日期用本地日历日（用户看的是自己的今天）。 */
export function usageKey(deviceId: string, day: string): string {
  return `${USAGE_KEY_PREFIX}${deviceId}.${day}`;
}

export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface ParseResult<T> {
  value: T;
  /** 有错时给出人能照做的说明；此时 value 是"安全默认值"（空价格表 / 无预算）。 */
  error?: string;
}

/** 价格表：JSON 数组，每项 {modelId, promptPer1k, completionPer1k}。 */
export function parsePriceTable(raw: string | undefined): ParseResult<ModelPrice[]> {
  const text = (raw ?? '').trim();
  if (text === '') return { value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: [], error: '价格表不是合法 JSON：应当是一个数组，例如 [{"modelId":"gpt-x","promptPer1k":0.01,"completionPer1k":0.03}]' };
  }
  if (!Array.isArray(parsed)) return { value: [], error: '价格表必须是一个数组（不是对象）' };
  const prices: ModelPrice[] = [];
  for (const item of parsed) {
    const entry = item as Partial<ModelPrice>;
    if (typeof entry.modelId !== 'string' || entry.modelId === '') {
      return { value: [], error: '价格表里每一项都必须有非空的 modelId' };
    }
    if (typeof entry.promptPer1k !== 'number' || typeof entry.completionPer1k !== 'number') {
      return { value: [], error: `模型 ${entry.modelId} 的 promptPer1k / completionPer1k 必须是数字（每千 token 的美元价）` };
    }
    if (entry.promptPer1k < 0 || entry.completionPer1k < 0) {
      return { value: [], error: `模型 ${entry.modelId} 的价格不能是负数` };
    }
    prices.push({ modelId: entry.modelId, promptPer1k: entry.promptPer1k, completionPer1k: entry.completionPer1k });
  }
  return { value: prices };
}

/** 预算：留空 = 不设上限（返回 undefined）。 */
export function parseBudget(raw: string | undefined): ParseResult<number | undefined> {
  const text = (raw ?? '').trim();
  if (text === '') return { value: undefined };
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { value: undefined, error: '预算必须是一个大于 0 的数字（单位：美元）；留空表示不设上限' };
  }
  return { value };
}

export interface UsageStoreDeps {
  /** 读全部设置（键 → 值）。 */
  settings: () => Record<string, string>;
  /** 写一个设置（内部走 op，所以会同步）。 */
  setSetting: (key: string, value: string) => Promise<void>;
  /** 每台设备每天最多保留多少条记录：一天上百轮对话足够用，超出丢最旧的（不静默把总量改小）。 */
  maxPerDay?: number;
}

export interface UsageStore {
  prices(): ParseResult<ModelPrice[]>;
  budget(): ParseResult<number | undefined>;
  /** 记一条用量（按设备 + 日期归档）。 */
  record(deviceId: string, record: UsageRecord): Promise<void>;
  /** 今天的记录（本机）。 */
  today(deviceId: string, now?: number): UsageRecord[];
  /** 全部设备、全部日期的记录（界面看"累计"用）。 */
  all(): UsageRecord[];
  totals(): UsageTotals;
  /** 发送前判定：已花 + 这次预计 是否超过预算。没设预算时永远 ok。 */
  gate(estimateUsd: number, now?: number): BudgetState;
  /** 估算一次调用的**上界**花费（输出按 maxTokens 估，宁可高估不漏拦）。 */
  estimateCost(modelId: string, promptTokens: number, maxCompletionTokens: number): number;
}

const DEFAULT_MAX_PER_DAY = 500;

export function createUsageStore(deps: UsageStoreDeps): UsageStore {
  const maxPerDay = deps.maxPerDay ?? DEFAULT_MAX_PER_DAY;

  const readDay = (key: string): UsageRecord[] => {
    const raw = deps.settings()[key];
    if (raw === undefined || raw === '') return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as UsageRecord[]) : [];
    } catch {
      // 坏数据不能把应用卡死：当作空，但记录仍然留在设置里（下次写会覆盖）
      return [];
    }
  };

  const allKeys = (): string[] => Object.keys(deps.settings()).filter((key) => key.startsWith(USAGE_KEY_PREFIX));

  return {
    prices: () => parsePriceTable(deps.settings()['usage.prices']),
    budget: () => parseBudget(deps.settings()['usage.budget_usd']),

    async record(deviceId, record) {
      const key = usageKey(deviceId, localDay(record.at));
      const kept = [...readDay(key), record].slice(-maxPerDay);
      await deps.setSetting(key, JSON.stringify(kept));
    },

    today: (deviceId, now = Date.now()) => readDay(usageKey(deviceId, localDay(now))),

    all: () => allKeys().flatMap((key) => readDay(key)),

    totals: () => totalUsage(allKeys().flatMap((key) => readDay(key))),

    gate: (estimateUsd, now = Date.now()) => {
      const budget = parseBudget(deps.settings()['usage.budget_usd']).value;
      const records = allKeys().flatMap((key) => readDay(key));
      if (budget === undefined) return { ok: true, spentUsd: totalUsage(records).costUsd, remainingUsd: 0, unpricedRequests: 0 };
      void now;
      return wouldExceed(records, budget, estimateUsd);
    },

    estimateCost: (modelId, promptTokens, maxCompletionTokens) => {
      const prices = parsePriceTable(deps.settings()['usage.prices']).value;
      if (priceOf(modelId, prices) === undefined) return 0;
      return computeUsage({
        at: Date.now(),
        task: 'chat',
        modelId,
        promptTokens,
        completionTokens: maxCompletionTokens,
        prices,
      }).costUsd;
    },
  };
}

/** 从设置里读价格/预算时的统一入口（界面与发送路径共用，避免两处各写一份解析）。 */
export function readUsageConfig(settings: Record<string, string>): {
  prices: ParseResult<ModelPrice[]>;
  budget: ParseResult<number | undefined>;
} {
  return { prices: parsePriceTable(settings['usage.prices']), budget: parseBudget(settings['usage.budget_usd']) };
}

export { withinBudget };
export type { UsageTask };
