/** 内核公共类型。此文件不得 import 任何其它模块。 */

/** 释放函数：注册即 effect，卸载时按逆序调用。 */
export type Disposer = () => void | Promise<void>;

/** 插件对外形态之一：带 apply 的对象。 */
export interface PluginLike {
  name?: string;
  /** 依赖的 Service key；未满足时插件保持「未激活」而不是抛错。 */
  inject?: readonly string[];
  /** Config schema（由 defineConfig 生成）。 */
  Config?: ConfigLike;
  apply(ctx: unknown, config: Record<string, unknown>): unknown;
}

/** Config 定义的最小契约，避免 types.ts 依赖 config.ts。 */
export interface ConfigLike {
  readonly kind: 'schema';
  validate(value: unknown): ConfigResult;
  toJsonSchema(): Record<string, unknown>;
}

export interface ConfigResult {
  ok: boolean;
  value: Record<string, unknown>;
  /** 硬失败：类型不符、越界、字面量不匹配。非空即不得激活插件。 */
  errors: readonly string[];
  /** 软提示：未声明的配置键（保留原值，向前兼容）。 */
  warnings: readonly string[];
}

/** 插件激活结果。 */
export interface ActivationOutcome {
  id: string;
  name: string;
  status: 'active' | 'disabled' | 'inactive' | 'failed';
  reason?: string | undefined;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** 默认 logger：写入 stdout/stderr，保持零依赖。 */
export function createLogger(scope: string, sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console): Logger {
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
