/**
 * 内核的类型聚合层。
 *
 * 契约本身定义在 `@storylantern/plugin-api`（依赖方向：plugin-api ← kernel）；
 * 本文件只补上内核自己的运行时设施（Logger 实现等），并重新导出契约，
 * 让内核内部代码可以继续从 `./types.ts` 取类型。
 */
export type {
  ActivationOutcome,
  ConfigLike,
  ConfigResult,
  Disposer,
  Logger,
  PluginContext,
  PluginLike,
} from '../../plugin-api/src/contract.ts';

import type { Logger } from '../../plugin-api/src/contract.ts';

/** 默认 logger：写入 stdout/stderr，保持零依赖。 */
export function createLogger(
  scope: string,
  sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
): Logger {
  const prefix = scope ? `[${scope}] ` : '';
  return {
    debug: (message, ...args) => sink.debug(`${prefix}${message}`, ...args),
    info: (message, ...args) => sink.info(`${prefix}${message}`, ...args),
    warn: (message, ...args) => sink.warn(`${prefix}${message}`, ...args),
    error: (message, ...args) => sink.error(`${prefix}${message}`, ...args),
  };
}

/** 静默 logger，用于测试。 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
