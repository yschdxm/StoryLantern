import type { Context } from './context.ts';
import type { ActivationOutcome, ConfigLike, Disposer, PluginLike } from './types.ts';

export interface NormalizedPlugin {
  name: string;
  inject: readonly string[];
  Config: ConfigLike | undefined;
  apply: (ctx: Context, config: Record<string, unknown>) => unknown;
}

function toInject(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

/**
 * 归一化插件的三种形态（照搬 DSH 的约定）：
 *  1. 带 `apply` 的对象；
 *  2. 工厂函数，返回上面的对象；
 *  3. service class —— 原型上有 `apply` 的构造函数，会被 `new` 出来当对象用。
 * 模块命名空间对象（含 `default`）会被解包，因此 `import * as plugin` 直接可用。
 */
export function normalizePlugin(input: unknown, fallbackName = 'anonymous'): NormalizedPlugin {
  const seen = new Set<unknown>();

  const visit = (value: unknown): NormalizedPlugin => {
    if (value === null || value === undefined) throw new Error(`插件 '${fallbackName}' 为空`);
    if (seen.has(value)) throw new Error(`插件 '${fallbackName}' 归一化出现循环`);
    seen.add(value);

    if (typeof value === 'function') {
      const maybeClass = value as unknown as { prototype?: { apply?: unknown } };
      if (typeof maybeClass.prototype?.apply === 'function') {
        const instance = new (value as new () => PluginLike)();
        return visit(instance);
      }
      return visit((value as () => unknown)());
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.apply !== 'function') {
        if ('default' in record && record.default !== undefined) return visit(record.default);
        throw new Error(`插件 '${fallbackName}' 既没有 apply 也没有 default 导出`);
      }
      const plugin: NormalizedPlugin = {
        name: typeof record.name === 'string' ? record.name : fallbackName,
        inject: toInject(record.inject),
        Config: (record.Config ?? record.config) as ConfigLike | undefined,
        apply: (record.apply as NormalizedPlugin['apply']).bind(record),
      };
      return plugin;
    }

    throw new Error(`插件 '${fallbackName}' 形态无法识别（${typeof value}）`);
  };

  const normalized = visit(input);
  if (normalized.Config !== undefined && normalized.Config.kind !== 'schema') {
    throw new Error(`插件 '${normalized.name}' 的 Config 不是 defineConfig 生成的 schema`);
  }
  return normalized;
}

/** 激活结果台账：注入式激活与撤销都会更新它，因此 `settle()` 之后它是权威。 */
export class ActivationTracker {
  readonly #state = new Map<string, ActivationOutcome>();

  record(outcome: ActivationOutcome): void {
    this.#state.set(outcome.id, outcome);
  }

  update(id: string, patch: Partial<Omit<ActivationOutcome, 'id'>>): void {
    const current = this.#state.get(id);
    if (!current) return;
    this.#state.set(id, { ...current, ...patch });
  }

  get(id: string): ActivationOutcome | undefined {
    return this.#state.get(id);
  }

  list(): ActivationOutcome[] {
    return [...this.#state.values()];
  }

  of(status: ActivationOutcome['status']): ActivationOutcome[] {
    return this.list().filter((item) => item.status === status);
  }
}

export interface ActivateOptions {
  id: string;
  name: string;
  plugin: unknown;
  config?: unknown;
  owner?: string;
  tracker?: ActivationTracker;
  logger?: { error(message: string, error?: unknown): void };
}

/**
 * 激活一个插件：
 *  - 先校验 Config（失败即 `failed`，绝不带错配置启动）；
 *  - 依赖不满足 → 注册注入（状态 `inactive`），依赖出现后再运行；
 *  - 运行返回的 disposer 挂到上下文，卸载时自动撤销。
 */
export async function activatePlugin(ctx: Context, options: ActivateOptions): Promise<ActivationOutcome> {
  const { id, name } = options;
  const tracker = options.tracker;

  const finish = async (outcome: ActivationOutcome): Promise<ActivationOutcome> => {
    tracker?.record(outcome);
    return outcome;
  };

  let plugin: NormalizedPlugin;
  try {
    plugin = normalizePlugin(options.plugin, name);
  } catch (error) {
    return finish({ id, name, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
  }

  let config: Record<string, unknown> = {};
  if (plugin.Config) {
    const result = plugin.Config.validate(options.config);
    if (!result.ok) {
      return finish({ id, name, status: 'failed', reason: `配置无效：${result.errors.join('; ')}` });
    }
    config = result.value;
  } else if (options.config !== undefined && options.config !== null) {
    config = options.config as Record<string, unknown>;
  }

  const run = async (target: Context): Promise<Disposer> => {
    const { result, disposers } = await target.captureServices(async () => plugin.apply(target, config));
    const own: Disposer = typeof result === 'function' ? (result as Disposer) : () => {};
    return async () => {
      await own();
      for (const disposer of [...disposers].reverse()) await disposer();
    };
  };

  const missing = plugin.inject.filter((dep) => !ctx.has(dep));

  const record = {
    id,
    name,
    inject: plugin.inject,
    config,
    configSchema: plugin.Config?.toJsonSchema(),
  };

  if (missing.length === 0) {
    try {
      const disposer = await run(ctx);
      ctx.effect(() => disposer);
      // 记录插件行与生效配置，供 inspect 与冲突诊断使用。
      ctx.set(`plugin:${id}`, record, { owner: id });
      return finish({ id, name, status: 'active' });
    } catch (error) {
      return finish({ id, name, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  await finish({ id, name, status: 'inactive', reason: `等待依赖：${missing.join(', ')}` });

  ctx.inject(
    plugin.inject,
    async (target) => {
      try {
        const disposer = await run(target);
        target.set(`plugin:${id}`, record, { owner: id });
        tracker?.update(id, { status: 'active', reason: undefined });
        return () => {
          tracker?.update(id, { status: 'inactive', reason: '依赖消失，已撤销' });
          return disposer();
        };
      } catch (error) {
        tracker?.update(id, {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    `plugin:${id}`,
  );

  return tracker?.get(id) ?? { id, name, status: 'inactive', reason: `等待依赖：${missing.join(', ')}` };
}
