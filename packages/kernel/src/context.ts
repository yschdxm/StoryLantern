import { EventBus } from './events.ts';
import type { Disposer, Logger } from './types.ts';
import { createLogger } from './types.ts';

interface Injector {
  label: string;
  deps: readonly string[];
  apply: (ctx: Context) => unknown;
  active: boolean;
  disposers: Disposer[];
}

interface ServiceRecord {
  value: unknown;
  owner?: string;
}

export interface ContextOptions {
  parent?: Context;
  logger?: Logger;
  label?: string;
}

/**
 * 插件运行时上下文：Service 注册 + 依赖注入 + effect 生命周期 + 事件。
 *
 * 三条不变式：
 *  1. **注册即 effect**：任何注册都必须能通过返回的 disposer 或 `dispose()` 撤销。
 *  2. **依赖驱动激活**：`inject` 的依赖未满足时，插件保持「未激活」而不是抛错，
 *     因此同一份组合可以在缺少可选能力的 profile 里运行。
 *  3. **所有权属于上下文**：子上下文的注册随子上下文销毁，父上下文销毁会级联。
 */
export class Context {
  readonly events = new EventBus();
  readonly logger: Logger;
  readonly parent: Context | undefined;
  readonly label: string;

  static #counter = 0;

  readonly #services = new Map<string, ServiceRecord>();
  readonly #disposers: Disposer[] = [];
  readonly #children: Context[] = [];
  readonly #injectors: Injector[] = [];
  readonly #captures: Disposer[][] = [];
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: ContextOptions = {}) {
    this.parent = options.parent;
    this.label = options.label ?? `ctx#${(Context.#counter += 1)}`;
    const base = options.logger ?? options.parent?.logger ?? createLogger('');
    this.logger = options.parent === undefined ? base : base;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get root(): Context {
    return this.parent === undefined ? this : this.parent.root;
  }

  /** 子上下文：用于「随某对象销毁」的注册（例如一个 Agent、一个会话面板）。 */
  extend(label?: string): Context {
    const child = new Context({ parent: this, ...(label === undefined ? {} : { label }) });
    this.#children.push(child);
    return child;
  }

  // ---- Service 注册 ----

  set<T>(key: string, value: T, options: { owner?: string } = {}): Disposer {
    this.#assertAlive(`set(${key})`);
    const record: ServiceRecord = { value };
    if (options.owner !== undefined) record.owner = options.owner;
    this.#services.set(key, record);
    this.#scheduleFlush();

    let active = true;
    const disposer = (): void => {
      if (!active) return;
      active = false;
      if (this.#services.get(key) === record) {
        this.#services.delete(key);
        this.#scheduleFlush();
      }
    };

    // 让「注册即 effect」在插件忘记返回清理函数时依然成立。
    this.#captures.at(-1)?.push(disposer);
    return disposer;
  }

  /**
   * 捕获 `fn` 执行期间在本上下文注册的全部资源，返回它们的聚合 disposer。
   * 插件即便忘记把 `ctx.set(...)` 的返回值挂到 effect 上，卸载时也不会泄漏。
   */
  async captureServices<T>(fn: () => T | Promise<T>): Promise<{ result: T; disposers: Disposer[] }> {
    const bucket: Disposer[] = [];
    this.#captures.push(bucket);
    try {
      const result = await fn();
      return { result, disposers: bucket };
    } finally {
      this.#captures.pop();
    }
  }

  get<T>(key: string): T | undefined {
    const local = this.#services.get(key);
    if (local !== undefined) return local.value as T;
    return this.parent?.get<T>(key);
  }

  require<T>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) throw new Error(`缺少 Service '${key}'`);
    return value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** 本上下文本地注册的 Service key（不含父级）。 */
  services(): string[] {
    return [...this.#services.keys()].sort();
  }

  /** 用于 inspect：本上下文可见的全部 Service（含父级、就近覆盖）。 */
  visibleServices(): Array<{ key: string; owner?: string; local: boolean }> {
    const seen = new Map<string, { key: string; owner?: string; local: boolean }>();
    let cursor: Context | undefined = this;
    while (cursor) {
      for (const [key, record] of cursor.#services) {
        if (seen.has(key)) continue;
        const item: { key: string; owner?: string; local: boolean } = { key, local: cursor === this };
        if (record.owner !== undefined) item.owner = record.owner;
        seen.set(key, item);
      }
      cursor = cursor.parent;
    }
    return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  // ---- 生命周期 ----

  /** 注册一个 effect：`setup` 返回的 disposer 会随本上下文销毁而调用。 */
  effect(setup: () => Disposer | void): Disposer {
    this.#assertAlive('effect');
    const result = setup();
    const disposer: Disposer = typeof result === 'function' ? result : () => {};
    this.#disposers.push(disposer);

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const index = this.#disposers.indexOf(disposer);
      if (index >= 0) this.#disposers.splice(index, 1);
      await disposer();
    };
  }

  on(event: string, listener: (...args: never[]) => unknown): Disposer {
    this.#assertAlive(`on(${event})`);
    const off = this.events.on(event, listener);
    void this.effect(() => off);
    return off;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    await this.events.emit(event, ...args);
  }

  async waterfall<T>(event: string, value: T, context?: unknown): Promise<T> {
    return this.events.waterfall(event, value, context);
  }

  /**
   * 依赖注入：`deps` 全部可用时执行 `apply`；返回的 disposer 会撤销该注册。
   * 依赖若在之后消失，注册会被自动撤销（例如插件被卸载）。
   */
  inject(deps: readonly string[], apply: (ctx: Context) => unknown, label = 'inject'): Disposer {
    this.#assertAlive(`inject(${deps.join(',')})`);
    const injector: Injector = { label, deps: [...deps], apply, active: false, disposers: [] };
    this.#injectors.push(injector);
    this.#scheduleFlush();

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const index = this.#injectors.indexOf(injector);
      if (index >= 0) this.#injectors.splice(index, 1);
      await this.#deactivate(injector);
    };
  }

  /** 等待所有挂起的注入刷新完成（测试与启动流程需要确定性）。 */
  async settle(): Promise<void> {
    let guard = 0;
    while (guard < 100) {
      guard += 1;
      const pending = this.root.#pending;
      await pending;
      if (this.root.#pending === pending) return;
    }
    throw new Error('settle(): 注入刷新未收敛（可能存在循环依赖）');
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const child of [...this.#children].reverse()) await child.dispose();
    this.#children.length = 0;

    for (const injector of [...this.#injectors]) await this.#deactivate(injector);
    this.#injectors.length = 0;

    for (const disposer of [...this.#disposers].reverse()) await disposer();
    this.#disposers.length = 0;
    this.#services.clear();
  }

  // ---- 内部 ----

  async #deactivate(injector: Injector): Promise<void> {
    if (!injector.active) return;
    injector.active = false;
    for (const disposer of injector.disposers.reverse()) await disposer();
    injector.disposers.length = 0;
  }

  #scheduleFlush(): void {
    const root = this.root;
    root.#pending = root.#pending.then(() => root.#flushTree()).catch((error: unknown) => {
      root.logger.error('注入刷新失败', error);
    });
  }

  async #flushTree(): Promise<void> {
    if (this.#disposed) return;
    await this.#flush();
    for (const child of this.#children) await child.#flushTree();
  }

  async #flush(): Promise<void> {
    for (const injector of [...this.#injectors]) {
      const satisfied = injector.deps.every((dep) => this.has(dep));
      if (satisfied && !injector.active) {
        injector.active = true;
        try {
          const result = await injector.apply(this);
          if (typeof result === 'function') injector.disposers.push(result as Disposer);
        } catch (error) {
          injector.active = false;
          this.logger.error(`注入执行失败：${injector.label}`, error);
          throw error;
        }
      } else if (!satisfied && injector.active) {
        await this.#deactivate(injector);
      }
    }
  }

  #assertAlive(operation: string): void {
    if (this.#disposed) throw new Error(`上下文已销毁，无法执行 ${operation}`);
  }
}

export function createContext(options: ContextOptions = {}): Context {
  return new Context(options);
}
