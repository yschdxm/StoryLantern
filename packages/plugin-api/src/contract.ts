/**
 * 插件契约：**只描述形状，不含任何运行时实现**。
 *
 * 依赖方向是刻意的：`plugin-api`（契约 + 基础件）← `kernel`（运行时实现）。
 * 因此第三方插件只需依赖本包，就能：
 *   - 用 `defineConfig` 声明可校验、可投影成 JSON Schema 的配置；
 *   - 用 `Registry` 提供可撤销的注册表；
 *   - 用 `apply(ctx, config)` 的签名写实现，而**不需要**引用宿主内部代码。
 */

/** 释放函数：注册即 effect，卸载时按逆序调用。 */
export type Disposer = () => void | Promise<void>;

export interface ConfigResult {
  ok: boolean;
  value: Record<string, unknown>;
  /** 硬失败：类型不符、越界、字面量不匹配。非空即不得激活插件。 */
  errors: readonly string[];
  /** 软提示：未声明的配置键（保留原值，向前兼容）。 */
  warnings: readonly string[];
}

/** Config 定义的最小契约。 */
export interface ConfigLike {
  readonly kind: 'schema';
  validate(value: unknown): ConfigResult;
  defaults(): Record<string, unknown>;
  toJsonSchema(): Record<string, unknown>;
}

/** 插件对外形态之一：带 apply 的对象。 */
export interface PluginLike {
  name?: string;
  /** 依赖的 Service key；未满足时插件保持「未激活」而不是抛错。 */
  inject?: readonly string[];
  /** Config schema（由 defineConfig 生成）。 */
  Config?: ConfigLike;
  apply(ctx: unknown, config: Record<string, unknown>): unknown;
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

/** 上下文的最小可用形状：插件只需要这些就能工作（不需要知道内核实现）。 */
export interface PluginContext {
  set<T>(key: string, value: T, options?: { owner?: string }): Disposer;
  get<T>(key: string): T | undefined;
  require<T>(key: string): T;
  has(key: string): boolean;
  effect(setup: () => Disposer | void): Disposer;
  on(event: string, listener: (...args: never[]) => unknown): Disposer;
  emit(event: string, ...args: unknown[]): Promise<void>;
  waterfall<T>(event: string, value: T, context?: unknown): Promise<T>;
  inject(deps: readonly string[], apply: (ctx: PluginContext) => unknown, label?: string): Disposer;
  extend(label?: string): PluginContext;
  readonly logger: Logger;
}
