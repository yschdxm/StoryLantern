import { defineConfig } from '../../../packages/plugin-api/src/index.ts';
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';

export const name = 'log-sink';

export const Config = defineConfig({
  capacity: { type: 'number', default: 200, min: 1, max: 100000, integer: true, description: '环形缓冲保留的条目数' },
});

export interface LogSink {
  entries: string[];
  write(line: string): void;
}

/** 提供一个有界的日志落地服务；注册即 effect，卸载时缓冲被清空。 */
export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
  const capacity = typeof config.capacity === 'number' ? config.capacity : 200;
  const entries: string[] = [];

  const sink: LogSink = {
    entries,
    write(line: string) {
      entries.push(line);
      while (entries.length > capacity) entries.shift();
    },
  };

  ctx.set('log.sink', sink);
  ctx.effect(() => () => {
    entries.length = 0;
  });
}
