import { defineConfig } from '../../../packages/plugin-api/src/index.ts';
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';

export const name = 'settings-store';

export const Config = defineConfig({
  namespace: { type: 'string', default: 'app', description: '设置命名空间，多套配置档互不干扰' },
});

export interface SettingsStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
}

/** 设置服务。真实实现会写 oplog（`setting.set` op），这里先给出同一接口的最小实现。 */
export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
  const namespace = typeof config.namespace === 'string' ? config.namespace : 'app';
  const values = new Map<string, unknown>();

  const store: SettingsStore = {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    set(key: string, value: unknown) {
      values.set(key, value);
      void ctx.emit('settings/changed', { namespace, key, value });
    },
    all() {
      return Object.fromEntries(values);
    },
  };

  ctx.set('settings', store);
  ctx.effect(() => () => {
    values.clear();
  });
}
