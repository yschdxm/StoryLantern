import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/context.ts';
import { createKernelInspectProvider, InspectRegistry } from '../src/inspect.ts';
import { activateComposition, composeProfile, Composition, type CompositionHost } from '../src/loader.ts';
import { ActivationTracker } from '../src/plugin.ts';
import { Registry } from '../../plugin-api/src/index.ts';
import { parseYaml } from '../src/yaml.ts';
import { defineConfig } from '../../plugin-api/src/index.ts';

const corePatch = `
- insert:
    - id: ui-chat
      name: '@test/ui-chat'
    - id: blocks
      name: '@test/context-blocks'
    - id: provider
      name: '@test/provider'
      config:
        provider: anthropic
        retries: 1
    - id: legacy-bridge
      name: '@test/legacy'
      disabled: true
`;

const plugins = new Map<string, unknown>([
  [
    '@test/provider',
    {
      name: 'provider',
      Config: defineConfig({
        provider: { type: 'string', default: 'openai', enum: ['openai', 'anthropic'] },
        retries: { type: 'number', default: 2, min: 0, max: 10, integer: true },
      }),
      apply(ctx: { set(key: string, value: unknown): void }, config: Record<string, unknown>) {
        ctx.set('llm.provider', { id: config.provider, retries: config.retries });
      },
    },
  ],
  [
    '@test/context-blocks',
    {
      name: 'context-blocks',
      inject: ['llm.provider'],
      apply(ctx: { set(key: string, value: unknown): void; get<T>(key: string): T | undefined }) {
        const blocks = new Registry<{ id: string }>();
        blocks.register('character', { id: 'character' });
        ctx.set('context.blocks', blocks);
      },
      config: undefined,
    },
  ],
  [
    '@test/ui-chat',
    {
      name: 'ui-chat',
      apply(ctx: { set(key: string, value: unknown): void }) {
        ctx.set('ui.chat', { mounted: true });
      },
    },
  ],
  [
    '@test/broken',
    {
      name: 'broken',
      apply() {
        throw new Error('故意失败');
      },
    },
  ],
  [
    '@test/bad-config',
    {
      name: 'bad-config',
      Config: defineConfig({ retries: { type: 'number', default: 1 } }),
      apply() {},
    },
  ],
]);

const host: CompositionHost = {
  resolve(name: string) {
    const plugin = plugins.get(name);
    if (!plugin) throw new Error(`未知插件包 ${name}`);
    return plugin;
  },
};

function compose(text: string, source = 'bundle-core'): Composition {
  return composeProfile([{ source, rows: parseYaml(text) }]);
}

test('patch 方言：insert / 覆盖整体替换 config / disabled 生效', () => {
  const composition = compose(corePatch);
  assert.equal(composition.size, 4);
  assert.equal(composition.get('provider')?.config.provider, 'anthropic');
  assert.equal(composition.get('legacy-bridge')?.disabled, true);
  assert.deepEqual(composition.warnings, []);

  // 用户 patch：整体替换 config（不是深合并），并把 legacy 打开
  composition.applyPatch(
    parseYaml(`
- id: provider
  config:
    provider: openai
- id: legacy-bridge
  disabled: false
`),
    'user-patch',
  );
  assert.deepEqual(composition.get('provider')?.config, { provider: 'openai' });
  assert.equal(composition.get('legacy-bridge')?.disabled, false);
  assert.equal(composition.get('provider')?.source, 'user-patch');
});

test('覆盖不存在的 id 按新增处理并记 warning（不静默吞掉配置）', () => {
  const composition = compose('- insert:\n    - id: a\n      name: "@test/provider"\n');
  composition.applyPatch(parseYaml('- id: ghost\n  name: "@test/ghost"\n  config:\n    x: 1\n'), 'user');
  assert.equal(composition.get('ghost')?.config.x, 1);
  assert.equal(composition.warnings.length, 1);
  assert.match(composition.warnings[0] ?? '', /ghost/);
});

test('!!js 条件行：作用域可见，求值结果决定 disabled', () => {
  const composition = new Composition();
  composition.applyPatch(
    parseYaml(`
- insert:
    - id: profile-only
      name: '@test/ui-chat'
      disabled: !!js "!ctx.get('profileContext')"
`),
    'bundle',
    { scope: { ctx: { get: () => undefined } } },
  );
  assert.equal(composition.get('profile-only')?.disabled, true);
});

test('激活组合：依赖驱动的 inactive → active，禁用行不解析，失败行有原因', async () => {
  const ctx = createContext();
  const tracker = new ActivationTracker();
  const composition = compose(corePatch);

  await activateComposition(ctx, composition, host, { tracker });

  assert.equal(tracker.get('ui-chat')?.status, 'active');
  assert.equal(tracker.get('provider')?.status, 'active');
  assert.equal(tracker.get('blocks')?.status, 'active', '声明在 provider 之前也应通过依赖注入激活');
  assert.equal(tracker.get('legacy-bridge')?.status, 'disabled');
  assert.equal(tracker.list().length, 4);

  // 配置已校验并生效
  assert.deepEqual(ctx.get('llm.provider'), { id: 'anthropic', retries: 1 });
  const blocks = ctx.get<Registry<{ id: string }>>('context.blocks');
  assert.equal(blocks?.size, 1);
  assert.equal(blocks?.has('character'), true);
});

test('删除一行 = 该功能消失（CI 断言“没有特性被硬编码”）', async () => {
  const withoutBlocks = corePatch.replace(/ {4}- id: blocks\n {6}name: '@test\/context-blocks'\n/, '');
  assert.notEqual(withoutBlocks, corePatch);

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, compose(withoutBlocks), host, { tracker });

  assert.equal(ctx.get('context.blocks'), undefined, '去掉行后该能力必须消失');
  assert.equal(tracker.get('blocks'), undefined);
  // 其余功能不受影响
  assert.equal(tracker.get('ui-chat')?.status, 'active');
  assert.deepEqual(ctx.get('llm.provider'), { id: 'anthropic', retries: 1 });
});

test('未知插件包 → failed；插件抛错 → failed；配置非法 → failed 且不执行 apply', async () => {
  const composition = compose(`
- insert:
    - id: ghost
      name: '@test/nope'
    - id: broken
      name: '@test/broken'
    - id: bad-config
      name: '@test/bad-config'
      config:
        retries: nope
`);
  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, composition, host, { tracker });

  assert.equal(tracker.get('ghost')?.status, 'failed');
  assert.match(tracker.get('ghost')?.reason ?? '', /无法解析插件包/);
  assert.equal(tracker.get('broken')?.status, 'failed');
  assert.match(tracker.get('broken')?.reason ?? '', /故意失败/);
  assert.equal(tracker.get('bad-config')?.status, 'failed');
  assert.match(tracker.get('bad-config')?.reason ?? '', /配置无效/);
});

test('依赖注入生命周期：依赖出现则激活，依赖消失则连同它注册的 Service 一起撤销', async () => {
  // 先只装 blocks（它 inject llm.provider），此时应保持未激活
  const onlyBlocks = `
- insert:
    - id: blocks
      name: '@test/context-blocks'
`;
  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, compose(onlyBlocks), host, { tracker });

  assert.equal(tracker.get('blocks')?.status, 'inactive');
  assert.equal(ctx.get('context.blocks'), undefined);

  // 依赖出现 → 自动激活，并注册它自己的 Service
  const offProvider = ctx.set('llm.provider', { id: 'manual' });
  await ctx.settle();
  assert.equal(tracker.get('blocks')?.status, 'active');
  assert.equal(ctx.get<Registry<{ id: string }>>('context.blocks')?.has('character'), true);

  // 依赖消失 → 插件被撤销，且它在 apply 期间注册的 Service 一并消失（不泄漏）
  offProvider();
  await ctx.settle();
  assert.equal(tracker.get('blocks')?.status, 'inactive');
  assert.equal(ctx.get('context.blocks'), undefined, '插件卸载后它注册的 Service 必须一起撤销');
});

test('Inspect：可以查询 Service、事件与插件 Config schema', async () => {
  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, compose(corePatch), host, { tracker });
  ctx.on('chat/created', (() => {}) as never);

  const inspect = new InspectRegistry();
  inspect.register(createKernelInspectProvider(ctx, { tracker }));

  assert.deepEqual(
    inspect.list().map((item) => item.id),
    ['Kernel'],
  );

  const services = await inspect.query('host', 'Kernel', 'listService');
  assert.equal(services.ok, true);
  const keys = (services.data as { services: Array<{ key: string }> }).services.map((s) => s.key);
  assert.ok(keys.includes('llm.provider'));
  assert.ok(keys.includes('context.blocks'));

  const events = await inspect.query('host', 'Kernel', 'listEvents');
  assert.deepEqual(events.data, { events: [{ name: 'chat/created', listeners: 1 }] });

  const configs = await inspect.query('host', 'Kernel', 'listConfigs');
  const rows = (configs.data as { configs: Array<{ id: string; schema?: unknown }> }).configs;
  const providerRow = rows.find((row) => row.id === 'provider');
  assert.ok(providerRow);
  assert.equal(typeof providerRow.schema, 'object');

  const missing = await inspect.query('host', 'Kernel', 'nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /没有方法 nope/);
});
