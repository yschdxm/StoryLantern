import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../../../packages/kernel/src/context.ts';
import { activatePlugin } from '../../../packages/kernel/src/plugin.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import * as localePlugin from '../../locale/src/index.ts';
import * as blocksPlugin from '../../context-blocks/src/index.ts';
import * as pipelinePlugin from '../src/index.ts';
import type { BlockRegistry } from '../../context-blocks/src/index.ts';
import { assembleBlocks, type AssembleFn, type PromptGraph } from '../src/index.ts';
import { fallbackTranslator, MESSAGES } from '../src/messages.ts';

function baseKeys(messages: Record<string, string>): string[] {
  return [...new Set(Object.keys(messages).map((key) => key.replace(/\.(one|two|few|many|other|zero)$/, '')))].sort();
}

async function setup(locale: string): Promise<{ ctx: ReturnType<typeof createContext>; assemble: AssembleFn }> {
  const ctx = createContext();
  await activatePlugin(ctx, { id: 'blocks', name: '@storylantern/plugin-context-blocks', plugin: blocksPlugin, config: {} });
  await activatePlugin(ctx, { id: 'locale', name: '@storylantern/plugin-locale', plugin: localePlugin, config: { locale } });
  // 预算必须满足 schema 的下限（256）；用例靠长块把它撑爆来触发"被裁掉"分支。
  await activatePlugin(ctx, { id: 'pipeline', name: '@storylantern/plugin-writing-pipeline', plugin: pipelinePlugin, config: { budgetTokens: 256 } });
  await ctx.settle();
  return { ctx, assemble: ctx.require<AssembleFn>('context.assemble') };
}

function seed(ctx: ReturnType<typeof createContext>): void {
  const blocks = ctx.require<BlockRegistry>('context.blocks');
  blocks.register('long-lore', {
    id: 'long-lore',
    placement: 'after-history',
    priority: 1,
    render: () => '设定'.repeat(200),
  });
}

test('装配理由走 locale service：同一份图在中文与英文下给出对应语言的理由', async () => {
  const zh = await setup('zh-CN');
  seed(zh.ctx);
  const zhGraph = zh.assemble({ sessionTitle: 'S', characterName: '星野', transcript: ['一'] }, 256);
  assert.match(zhGraph.nodes.find((node) => node.id === 'character')?.reason ?? '', /纳入/);
  assert.match(zhGraph.nodes.find((node) => node.id === 'long-lore')?.reason ?? '', /预算不足裁掉/);
  await zh.ctx.dispose();

  const en = await setup('en');
  seed(en.ctx);
  const enGraph = en.assemble({ sessionTitle: 'S', characterName: 'Hoshino', transcript: ['one'] }, 256);
  assert.match(enGraph.nodes.find((node) => node.id === 'character')?.reason ?? '', /Included/);
  assert.match(enGraph.nodes.find((node) => node.id === 'long-lore')?.reason ?? '', /Dropped for budget/);
  await en.ctx.dispose();
});

test('没有 locale 时纯函数仍可用（内置中文兜底），不抛错', () => {
  const graph: PromptGraph = assembleBlocks(
    [
      { id: 'a', placement: 'system', priority: 10, render: () => '内容' },
      { id: 'b', placement: 'after-history', priority: 1, render: () => '长'.repeat(500) },
    ],
    { sessionTitle: 'S', transcript: [] },
    4,
  );
  assert.deepEqual(graph.order, ['a']);
  assert.match(graph.nodes[1]?.reason ?? '', /预算不足裁掉/);
});

test('兜底翻译器：缺 key 返回 key 本身，缺参数保留占位符', () => {
  const tr = fallbackTranslator('en');
  assert.equal(tr('pipeline.node.included', { priority: 1, tokens: 2 }), 'Included (priority 1, 2 tokens)');
  assert.equal(tr('pipeline.node.included'), 'Included (priority {{priority}}, {{tokens}} tokens)');
  assert.equal(tr('nope'), 'nope');
});

test('语言服务可用时，插件的语言包已注册进去（中英 key 对齐）', async () => {
  const { ctx } = await setup('en');
  const locale = ctx.require<LocaleService>('locale');
  assert.equal(locale.t('pipeline.node.included', { priority: 3, tokens: 7 }, { namespace: 'writing-pipeline' }), 'Included (priority 3, 7 tokens)');
  assert.deepEqual(locale.missing(), [], '插件用到的 key 不应出现缺翻译');

  const zh = baseKeys(MESSAGES['zh-CN'] as Record<string, string>);
  const en = baseKeys(MESSAGES['en'] as Record<string, string>);
  assert.deepEqual(en, zh);
  await ctx.dispose();
});
