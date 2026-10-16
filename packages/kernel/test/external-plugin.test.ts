import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createContext } from '../src/context.ts';
import { activateComposition, composeProfile, type CompositionHost } from '../src/loader.ts';
import { ActivationTracker } from '../src/plugin.ts';
import type { ExternalGreeter } from '../../../fixtures/external-plugin/index.ts';

/**
 * M7 准备项之一：**仓外插件**能不能用 —— 而且是在"不读内核源码"的前提下。
 *
 * 这里把 `fixtures/external-plugin` 当成"别人写的包"：它只 import 公开的 `plugin-api`，
 * 由组合层用一行 patch 激活。测试做两件事：
 *  1. 真激活它，并断言它暴露的服务能用、配置真的生效了；
 *  2. **读它的源码**断言它没有深入内核内部包（除了 `plugin-api` 之外不出现 `packages/` 的路径）——
 *     否则"外部插件可用"就只是句空话：那些人得先读懂内核。
 */

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** 只认识"外部包"的解析器：真实部署里由包解析器完成（npm 安装 + 动态 import）。 */
const host: CompositionHost = {
  async resolve(name: string) {
    if (name === '@example/plugin-external-greeter') {
      return import('../../../fixtures/external-plugin/index.ts');
    }
    throw new Error(`这个解析器只认识外部示例插件，收到 ${name}`);
  },
};

test('仓外插件：用一行 patch 激活，Service 与配置都生效', async () => {
  const composition = composeProfile([
    {
      source: 'user-patch',
      rows: [
        {
          id: 'external-greeter',
          name: '@example/plugin-external-greeter',
          config: { greeting: '你好' },
        },
      ],
    },
  ]);

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, composition, host, { tracker });

  assert.equal(tracker.get('external-greeter')?.status, 'active');
  const greeter = ctx.get<ExternalGreeter>('external.greeter');
  assert.equal(typeof greeter?.greet, 'function', '外部插件暴露的服务应当能取到');
  assert.equal(greeter?.greet('世界'), '你好, 世界', '配置里的问候语要真的生效');
});

test('配置缺省时用声明里的默认值（外部插件不该假设自己被怎么配）', async () => {
  const composition = composeProfile([
    { source: 'user-patch', rows: [{ id: 'external-greeter', name: '@example/plugin-external-greeter' }] },
  ]);
  const ctx = createContext();
  await activateComposition(ctx, composition, host, { tracker: new ActivationTracker() });
  assert.equal(ctx.get<ExternalGreeter>('external.greeter')?.greet('world'), 'hello, world');
});

test('不读内核源码：这个外部插件只 import 公开的 plugin-api', async () => {
  const source = await readFile(path.join(ROOT, 'fixtures/external-plugin/index.ts'), 'utf8');
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
  assert.equal(imports.length > 0, true, '它总得 import 点什么（公开 API）');
  for (const specifier of imports) {
    assert.match(
      specifier,
      /plugin-api/,
      `外部插件只该依赖公开 plugin-api，实际 import 了：${specifier}（那意味着它得先读懂内核）`,
    );
  }
  // 反向断言：源码里不该出现内核内部模块名
  for (const forbidden of ['kernel/src', 'oplog/src', 'sync-core/src', 'wire/src']) {
    assert.equal(source.includes(forbidden), false, `外部插件源码里不该出现 ${forbidden}`);
  }
});
