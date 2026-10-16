import { defineConfig, type PluginContext } from '../../packages/plugin-api/src/index.ts';

/**
 * **仓外插件**示例（M7 准备项：插件生态验证）。
 *
 * 这个目录刻意放在 `fixtures/`，而不是 `plugins/`：它扮演"别人写的插件" ——
 * 只 import **公开的 plugin-api**，不碰内核内部包、不读内核源码，也不知道组合文件长什么样。
 *
 * 它做的事很朴素，但足以证明那条路是通的：
 *  1. 用 `defineConfig` 声明自己的配置（命名空间 + 问候语）；
 *  2. 用 `ctx.set` 暴露一个 Service（别人通过 `ctx.get('external.greeter')` 用它）；
 *  3. 用 `ctx.effect` 做一次清理（内核生命周期的一部分，公开能力）。
 *
 * 激活方式：在组合 patch 里加一行（真实部署由包解析器安装 + import 这个包）：
 *
 * ```yaml
 * - insert:
 *     - id: external-greeter
 *       name: '@example/plugin-external-greeter'
 * ```
 */

export const name = 'external-greeter';

export const Config = defineConfig({
  greeting: { type: 'string', default: 'hello', description: '问候语' },
});

export interface ExternalGreeter {
  greet(who: string): string;
}

export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
  const greeting = typeof config.greeting === 'string' && config.greeting !== '' ? config.greeting : 'hello';

  const greeter: ExternalGreeter = {
    greet(who: string) {
      return `${greeting}, ${who}`;
    },
  };

  ctx.set('external.greeter', greeter);
  ctx.effect(() => () => {
    // 卸下时清掉（这里没有别的状态，写出来是为了让示例覆盖 effect 这条公开能力）
  });
}
