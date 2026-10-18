/**
 * 通用退避（B27）：指数 + 上限 + **注入式** jitter。
 *
 * 为什么把随机数当参数：测试要能逐位断言序列（`random: () => 0`），
 * 生产再传 `Math.random`。模块里不直接调用 `Math.random`。
 */

export interface BackoffOptions {
  /** 第一次重试的基础等待（毫秒）。 */
  baseMs?: number;
  /** 单次等待上限。 */
  maxMs?: number;
  /** jitter 比例：等待时间的最多 [0, ratio] 倍随机浮动。 */
  jitterRatio?: number;
  /** 注入随机源；返回 [0,1)。生产可传 Math.random。 */
  random?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'random'>> = {
  baseMs: 500,
  maxMs: 8_000,
  jitterRatio: 0.2,
};

/**
 * 第 `attempt` 次重试（1 起）的等待：`min(base * 2^(attempt-1), max)` + jitter。
 * attempt ≤ 0 按 1 处理（调用方传错也不会出现 0 间隔）。
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const jitterRatio = options.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  const random = options.random ?? Math.random;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const raw = Math.min(baseMs * 2 ** (safeAttempt - 1), maxMs);
  const jitter = raw * jitterRatio * Math.min(Math.max(random(), 0), 1);
  return Math.round(raw + jitter);
}

/** 从错误里取 wire/data 的 `code`（没有就是 undefined）；不依赖具体类。 */
export function failureCodeOf(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 哪些失败值得退避后重试：传输失败 / 超时 / 5xx / 429。
 *
 * **不重试**：`not-configured`、`offline`、`aborted`、`model-error` 的 4xx
 * （配置错、用户主动停止、请求本身不被接受，重试只会重复失败或违背用户意图）。
 */
export function isRetryableChatFailure(cause: unknown): boolean {
  const code = failureCodeOf(cause);
  if (code === 'aborted' || code === 'offline' || code === 'not-configured' || code === 'no-host') return false;
  if (code === 'transport-failed' || code === 'timeout' || code === 'network-error') return true;

  const message = cause instanceof Error ? cause.message : String(cause);
  if (/接口返回\s*(5\d\d|429)/.test(message)) return true;
  if (/\b(5\d\d|429)\b/.test(message) && /接口|HTTP|status/i.test(message)) return true;
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|网络|超时/i.test(message)) return true;
  return false;
}

export interface RetryDecision {
  retry: boolean;
  /** 需要等待多久再试（retry=false 时无意义，给 0）。 */
  waitMs: number;
}

/**
 * 是否重试 + 等多久（纯函数）。
 * `attempt` = **已经重试过的次数**（首次失败传 0）。
 */
export function decideRetry(
  cause: unknown,
  attempt: number,
  options: BackoffOptions & { maxRetries?: number } = {},
): RetryDecision {
  const maxRetries = options.maxRetries ?? 1;
  if (attempt >= maxRetries || !isRetryableChatFailure(cause)) return { retry: false, waitMs: 0 };
  return { retry: true, waitMs: backoffDelayMs(attempt + 1, options) };
}

/** 可注入的 sleep（测试可传即时版本，真实路径用定时器）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在一个候选模型上执行"失败→退避→重试一次"。
 *
 * `onRetry` 拿到错误与等待时长（调用方写进 trace attempts，界面要能看到"等过"）。
 * 非可重试错误原样抛出；可重试错误用完 maxRetries 后也原样抛出（交给回退链的下一候选）。
 */
export async function withBackoffRetry<T>(
  run: () => Promise<T>,
  options: BackoffOptions & {
    maxRetries?: number;
    onRetry?: (cause: unknown, waitMs: number, attempt: number) => void;
  } = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (cause) {
      const decision = decideRetry(cause, attempt, options);
      if (!decision.retry) throw cause;
      attempt += 1;
      options.onRetry?.(cause, decision.waitMs, attempt);
      await sleep(decision.waitMs);
    }
  }
}
