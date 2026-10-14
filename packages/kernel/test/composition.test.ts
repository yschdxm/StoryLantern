import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bundlePatchOf } from '../src/bundle.ts';
import { createContext } from '../src/context.ts';
import { activateComposition, composeProfile, type CompositionHost } from '../src/loader.ts';
import { ActivationTracker } from '../src/plugin.ts';
import { parseYaml } from '../src/yaml.ts';
import type { BlockDefinition, BlockRegistry } from '../../../plugins/context-blocks/src/index.ts';
import type { AssembleFn } from '../../../plugins/writing-pipeline/src/index.ts';
import type { LogSink } from '../../../plugins/log-sink/src/index.ts';
import type { SettingsStore } from '../../../plugins/settings-store/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

async function readText(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), 'utf8');
}

/** 插件解析器：真实部署里由包解析器完成，测试里用静态映射，语义完全一致。 */
const host: CompositionHost = {
  async resolve(name: string) {
    switch (name) {
      case '@storylantern/plugin-log-sink':
        return import('../../../plugins/log-sink/src/index.ts');
      case '@storylantern/plugin-settings-store':
        return import('../../../plugins/settings-store/src/index.ts');
      case '@storylantern/plugin-context-blocks':
        return import('../../../plugins/context-blocks/src/index.ts');
      case '@storylantern/plugin-writing-pipeline':
        return import('../../../plugins/writing-pipeline/src/index.ts');
      case '@storylantern/plugin-sync-memory':
        return import('../../../plugins/sync-memory/src/index.ts');
      case '@storylantern/plugin-sync-folder':
        return import('../../../plugins/sync-folder/src/index.ts');
      case '@storylantern/plugin-locale':
        return import('../../../plugins/locale/src/index.ts');
      case '@storylantern/plugin-sync-webdav':
        return import('../../../plugins/sync-webdav/src/index.ts');
      default:
        throw new Error(`未知插件包 ${name}`);
    }
  },
};

test('bundle 清单：从 package.json 读出 patch 路径', async () => {
  const pkg = JSON.parse(await readText('bundles/core/package.json')) as unknown;
  const manifest = bundlePatchOf(pkg);
  assert.deepEqual(manifest, { name: '@storylantern/bundle-core', patch: './storylantern.patch.yml' });
  assert.equal(bundlePatchOf({ name: 'x' }), undefined);
});

test('组合：core bundle 铺出 8 行，依赖驱动激活，禁用行不加载', async () => {
  const patch = parseYaml(await readText('bundles/core/storylantern.patch.yml'));
  const composition = composeProfile([{ source: '@storylantern/bundle-core', rows: patch }]);
  assert.equal(composition.size, 8);
  assert.deepEqual(composition.warnings, []);

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, composition, host, { tracker });

  const byId = Object.fromEntries(tracker.list().map((outcome) => [outcome.id, outcome.status]));
  assert.deepEqual(byId, {
    locale: 'active',
    'log-sink': 'active',
    settings: 'active',
    blocks: 'active',
    pipeline: 'active',
    'sync-memory': 'active',
    'sync-webdav': 'active',
    'sync-folder': 'disabled',
  });

  // 每个插件只通过 Service 暴露能力，外层不 import 任何实现
  assert.deepEqual(ctx.get<LogSink>('log.sink')?.entries, []);
  assert.equal(typeof ctx.get<SettingsStore>('settings')?.set, 'function');
  assert.equal(typeof ctx.get<BlockRegistry>('context.blocks')?.register, 'function');
  assert.equal(typeof ctx.get<AssembleFn>('context.assemble'), 'function');
  assert.equal(ctx.get<{ kind: string }>('sync.backend.memory')?.kind, 'memory');
  assert.equal(ctx.get('sync.backend.folder'), undefined, '禁用行不得加载');
});

test('写作管线：块图装配带预算裁剪，每个块都有可读理由（Request Inspector 的数据源）', async () => {
  const patch = parseYaml(await readText('bundles/core/storylantern.patch.yml'));
  const ctx = createContext();
  await activateComposition(ctx, composeProfile([{ source: 'core', rows: patch }]), host);

  const blocks = ctx.require<BlockRegistry>('context.blocks');
  const assemble = ctx.require<AssembleFn>('context.assemble');

  // 第三方块与内置块平权：任意插件都能往注册表里加块
  blocks.register('style-guide', {
    id: 'style-guide',
    placement: 'system',
    priority: 90,
    render: () => '文风：克制、以动作与对白推进。',
  });
  blocks.register('long-lore', {
    id: 'long-lore',
    placement: 'after-history',
    priority: 5,
    render: () => '设定：'.repeat(200),
  });

  const graph = assemble(
    {
      sessionTitle: '夜航',
      characterName: '星野',
      userName: '旅人',
      transcript: ['旅人：风很大。', '星野：那就进来说。'],
    },
    60,
  );

  assert.deepEqual(graph.order, ['character', 'style-guide', 'history']);
  assert.equal(graph.omitted, 1);
  const lore = graph.nodes.find((node) => node.id === 'long-lore');
  assert.equal(lore?.included, false);
  assert.match(lore?.reason ?? '', /预算不足裁掉/);
  assert.match(graph.nodes.find((node) => node.id === 'history')?.reason ?? '', /纳入/);
  assert.ok(graph.usedTokens <= 60);
});

test('bundle 叠加：sync bundle 覆盖 core 的禁用行并新增远端后端', async () => {
  const core = parseYaml(await readText('bundles/core/storylantern.patch.yml'));
  const sync = parseYaml(await readText('bundles/sync/storylantern.patch.yml'));

  const composition = composeProfile([
    { source: '@storylantern/bundle-core', rows: core },
    { source: '@storylantern/bundle-sync', rows: sync },
  ]);
  assert.deepEqual(composition.warnings, [], '跨 bundle 覆盖不得产生警告');
  assert.equal(composition.get('sync-folder')?.disabled, false, 'sync bundle 打开 core 默认关闭的行');
  assert.equal(composition.get('sync-folder')?.source, '@storylantern/bundle-sync');
  assert.equal(composition.size, 8, 'core 的 7 行 + 新增 1 行');

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, composition, host, { tracker });

  assert.equal(tracker.get('sync-folder')?.status, 'active');
  assert.equal(tracker.get('sync-webdav')?.status, 'active');
  assert.equal(ctx.get<{ kind: string }>('sync.backend.folder')?.kind, 'folder');
  assert.equal(ctx.get<{ kind: string }>('sync.backend.webdav')?.kind, 'webdav');
  // core 的其它能力不受叠加影响
  assert.equal(typeof ctx.get<AssembleFn>('context.assemble'), 'function');
});

test('删除一行 = 该能力消失，其余不受影响（"没有特性被硬编码"）', async () => {
  const patchText = await readText('bundles/core/storylantern.patch.yml');
  const withoutPipeline = patchText.replace(
    / {4}- id: pipeline\n {6}name: '@storylantern\/plugin-writing-pipeline'\n {6}config:\n {8}budgetTokens: 4096\n {8}historyLimit: 40\n/,
    '',
  );
  assert.notEqual(withoutPipeline, patchText, '测试自身的替换必须命中');

  const ctx = createContext();
  await activateComposition(ctx, composeProfile([{ source: 'core', rows: parseYaml(withoutPipeline) }]), host);

  assert.equal(ctx.get('context.assemble'), undefined, '去掉行后装配能力必须消失');
  assert.equal(typeof ctx.get<BlockRegistry>('context.blocks')?.register, 'function', '其余能力不受影响');
  assert.equal(ctx.get<{ kind: string }>('sync.backend.memory')?.kind, 'memory');
});

test('用户 patch 层可以按 id 覆盖配置并启用禁用行（组合层不需要改代码）', async () => {
  const bundlePatch = parseYaml(await readText('bundles/core/storylantern.patch.yml'));
  const userPatch = parseYaml(
    [
      '- id: sync-folder',
      '  disabled: false',
      '- id: pipeline',
      '  config:',
      '    budgetTokens: 8192',
      '    historyLimit: 10',
    ].join('\n'),
  );

  const ctx = createContext();
  const composition = composeProfile([
    { source: '@storylantern/bundle-core', rows: bundlePatch },
    { source: 'user-patch', rows: userPatch },
  ]);
  await activateComposition(ctx, composition, host);

  assert.equal(composition.get('pipeline')?.config.budgetTokens, 8192);
  assert.deepEqual(composition.get('pipeline')?.config, { budgetTokens: 8192, historyLimit: 10 }, '覆盖是整体替换而非深合并');
  assert.equal(composition.get('sync-folder')?.disabled, false);
  assert.equal(ctx.get<{ kind: string }>('sync.backend.folder')?.kind, 'folder');
});
