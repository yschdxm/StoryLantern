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

// ---------------------------------------------------------------- i18n 契约

/** 一个语言包：key -> 文案。做 UI 的插件必须通过 locale service 取文案，不要硬编码字符串。 */
export type LocaleMessages = Readonly<Record<string, string>>;

export interface TranslateParams {
  /** 插值变量：`{{name}}` 形式；`count` 同时用于复数选择。 */
  [key: string]: string | number;
}

export interface LocaleRegistration {
  /** 命名空间，通常是插件名，避免 key 冲突。 */
  namespace: string;
  /** BCP-47 语言标签，例如 `zh-CN`、`en`。 */
  locale: string;
  messages: LocaleMessages;
}

export interface MissingTranslation {
  namespace: string;
  key: string;
  locale: string;
}

/**
 * 翻译服务（由 `@storylantern/plugin-locale` 提供，插件通过 `inject: ['locale']` 使用）。
 *
 * 约定：
 *  - 找不到 key 时**返回 key 本身**并记入 `missing()`，绝不返回空串或抛错（UI 不该因为漏翻而崩）；
 *  - `register()` 返回 disposer，插件卸载时它的语言包一并撤销。
 */
export interface LocaleService {
  /** 当前生效语言（已解析后的具体标签）。 */
  readonly locale: string;
  /** 翻译。`params` 用于插值与复数（`count`）。 */
  t(key: string, params?: TranslateParams, options?: { namespace?: string }): string;
  /** 切换语言；返回是否真正切换。 */
  setLocale(locale: string): boolean;
  /** 该语言是否被支持（有任意一个语言包）。 */
  supports(locale: string): boolean;
  register(registration: LocaleRegistration): Disposer;
  /** 已注册的语言标签。 */
  locales(): string[];
  /** 缺翻译报告（`t()` 找不到时记录），供界面的"翻译体检"面板使用。 */
  missing(): MissingTranslation[];
  clearMissing(): void;
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
  /** 上下文是否已销毁：清理回调里要据此避免再注册（销毁中写入会被拒绝）。 */
  readonly disposed: boolean;
  readonly logger: Logger;
}
