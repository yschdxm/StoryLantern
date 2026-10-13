import type { Context } from './context.ts';
import type { ActivationTracker } from './plugin.ts';
import type { Disposer } from './types.ts';

export interface InspectMethod {
  description: string;
  run(input?: unknown): unknown | Promise<unknown>;
}

export interface InspectProvider {
  id: string;
  platform: 'host' | 'client';
  description: string;
  methods: Record<string, InspectMethod>;
}

export interface InspectQueryResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * 契约查询注册表。
 *
 * 存在的理由：**文档会漂移，运行时才是权威**。人和 AI 在写插件前先查真实契约，
 * 就不必读内核源码猜 Service 方法、事件名或 Config schema。
 */
export class InspectRegistry {
  readonly #providers = new Map<string, InspectProvider>();

  register(provider: InspectProvider, options: { replace?: boolean } = {}): Disposer {
    const key = `${provider.platform}:${provider.id}`;
    if (this.#providers.has(key) && !options.replace) {
      throw new Error(`Inspect provider 冲突：${key}`);
    }
    this.#providers.set(key, provider);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#providers.get(key) === provider) this.#providers.delete(key);
    };
  }

  list(): Array<{ platform: string; id: string; description: string; methods: string[] }> {
    return [...this.#providers.values()]
      .map((provider) => ({
        platform: provider.platform,
        id: provider.id,
        description: provider.description,
        methods: Object.keys(provider.methods).sort(),
      }))
      .sort((a, b) => `${a.platform}:${a.id}`.localeCompare(`${b.platform}:${b.id}`));
  }

  provider(platform: string, id: string): InspectProvider | undefined {
    return this.#providers.get(`${platform}:${id}`);
  }

  async query(platform: string, id: string, method: string, input?: unknown): Promise<InspectQueryResult> {
    const provider = this.provider(platform, id);
    if (!provider) return { ok: false, error: `未知 Inspect provider：${platform}:${id}` };
    const handler = provider.methods[method];
    if (!handler) {
      return { ok: false, error: `provider ${id} 没有方法 ${method}；可用：${Object.keys(provider.methods).join(', ')}` };
    }
    try {
      return { ok: true, data: await handler.run(input) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface PluginRecord {
  id: string;
  name: string;
  inject: readonly string[];
  config: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
}

/** 内核内置的 Inspect provider：Service / 事件 / 插件行与 Config schema。 */
export function createKernelInspectProvider(
  ctx: Context,
  options: { tracker?: ActivationTracker } = {},
): InspectProvider {
  return {
    id: 'Kernel',
    platform: 'host',
    description: '内核自身的可查询契约：Service、事件、插件行与 Config schema。',
    methods: {
      listService: {
        description: '当前上下文可见的 Service key 与归属（含父级上下文）。',
        run: () => ({ services: ctx.visibleServices() }),
      },
      listEvents: {
        description: '已注册监听器的事件名与监听器数量。',
        run: (input) => {
          const event = typeof input === 'object' && input !== null ? (input as { event?: string }).event : undefined;
          if (event) return { event, listeners: ctx.events.count(event) };
          return { events: ctx.events.events().map((name) => ({ name, listeners: ctx.events.count(name) })) };
        },
      },
      listConfigs: {
        description: '已激活插件行的生效配置与 Config JSON Schema。',
        run: () => {
          const rows = ctx
            .visibleServices()
            .filter((service) => service.key.startsWith('plugin:'))
            .map((service) => ctx.get<PluginRecord>(service.key))
            .filter((record): record is PluginRecord => record !== undefined);
          return {
            configs: rows
              .map((record) => ({
                id: record.id,
                name: record.name,
                config: record.config,
                ...(record.configSchema === undefined ? {} : { schema: record.configSchema }),
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          };
        },
      },
      listPlugins: {
        description: '插件激活台账（active / inactive / disabled / failed 及原因）。',
        run: () => ({ plugins: options.tracker?.list() ?? [] }),
      },
    },
  };
}
