import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createContext } from '../../packages/kernel/src/context.ts';
import { activateComposition, composeProfile } from '../../packages/kernel/src/loader.ts';
import { ActivationTracker } from '../../packages/kernel/src/plugin.ts';
import { parseYaml } from '../../packages/kernel/src/yaml.ts';
import type { LocaleService } from '../../packages/plugin-api/src/index.ts';
import type { AssembleFn, PromptGraph } from '../../plugins/writing-pipeline/src/index.ts';
import type { BlockRegistry } from '../../plugins/context-blocks/src/index.ts';
import { resolver } from '../../apps/app/src/resolver.ts';

/**
 * 装配语义的 golden 快照。
 *
 * 这是 M2「与真实 ST 差分对齐」的地基：先把自己**今天的行为**钉住，
 * 任何改动（排序、预算、文案、块集合）都会变成一次可见的 diff，而不是悄悄漂移。
 *
 * 更新快照：`UPDATE_GOLDEN=1 node --test "eval/**\/*.test.ts"`
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const GOLDEN_DIR = path.join(ROOT, 'eval/context/golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** 固定输入：不随语言变化的会话内容。 */
const TRANSCRIPT = [
  '旅人：风从北面灌进走廊，把灯芯压得只剩一线。',
  '星野：她先把地图上的折痕抚平，然后才抬眼。',
  '旅人：我把铜铃放在桌上，问她认不认得这个声音。',
  '星野：她说认得，然后从袖中抽出一张更旧的地图。',
];

async function buildRuntime(options: { fixedBudget?: number; styleFirst?: boolean } = {}): Promise<{
  locale: LocaleService;
  assemble: AssembleFn;
  tracker: ActivationTracker;
  ctx: ReturnType<typeof createContext>;
}> {
  const fixedBudget = options.fixedBudget ?? 256;
  const corePatch = parseYaml(await readFile(path.join(ROOT, 'bundles/core/storylantern.patch.yml'), 'utf8'));
  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(
    ctx,
    composeProfile([{ source: 'golden', rows: corePatch }]),
    resolver,
    { tracker },
  );
  await ctx.settle();

  // 补两个确定性的块：一个必然纳入、一个必然被预算裁掉。
  // 注册顺序可以翻转——用来验证"装配结果与注册顺序无关"。
  const styleGuide = {
    id: 'style-guide',
    placement: 'system' as const,
    priority: 90,
    render: () => '文风：克制，以动作与对白推进。',
  };
  const longLore = {
    id: 'long-lore',
    placement: 'after-history' as const,
    priority: 5,
    render: () => '设定'.repeat(400),
  };

  const blocks = ctx.require<BlockRegistry>('context.blocks');
  const ordered = options.styleFirst === false ? [longLore, styleGuide] : [styleGuide, longLore];
  for (const block of ordered) blocks.register(block.id, block);

  const base = ctx.require<AssembleFn>('context.assemble');
  return {
    ctx,
    tracker,
    locale: ctx.require<LocaleService>('locale'),
    assemble: (context, budget) => base(context, budget ?? fixedBudget),
  };
}

/** 只保留可比较、可读的部分：固定 JSON 形状，便于人看 diff。 */
function toSnapshot(graph: PromptGraph): Record<string, unknown> {
  return {
    order: graph.order,
    usedTokens: graph.usedTokens,
    budgetTokens: graph.budgetTokens,
    omitted: graph.omitted,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      included: node.included,
      tokens: node.tokens,
      reason: node.reason,
    })),
  };
}

async function compareGolden(name: string, actual: unknown): Promise<void> {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await writeFile(file, serialized, 'utf8');
    return;
  }
  let expected: string;
  try {
    expected = await readFile(file, 'utf8');
  } catch {
    assert.fail(`缺少 golden 快照 ${name}.json；用 UPDATE_GOLDEN=1 生成后提交`);
  }
  assert.equal(serialized, expected, `装配结果与 golden 快照不一致（${name}）。若是有意改动，请用 UPDATE_GOLDEN=1 重新生成并 review diff。`);
}

for (const locale of ['zh-CN', 'en'] as const) {
  test(`装配 golden 快照（${locale}）：块顺序、token 预算与裁剪理由都稳定`, async () => {
    const runtime = await buildRuntime();
    runtime.locale.setLocale(locale);
    const graph = runtime.assemble(
      { sessionTitle: 'golden', characterName: '星野', userName: '旅人', transcript: TRANSCRIPT },
      256,
    );

    // 语义不变量先断言（比"和上次一样"更强的约束）
    assert.equal(graph.nodes.every((node) => !node.reason.startsWith('pipeline.')), true,
      '缺翻译时返回的是 key——说明有文案没注册进 locale');
    assert.equal(graph.usedTokens <= graph.budgetTokens, true);
    assert.deepEqual(graph.order, graph.nodes.filter((node) => node.included).map((node) => node.id));
    assert.equal(graph.nodes.find((node) => node.id === 'long-lore')?.included, false, '长块必须被裁掉');
    assert.equal(graph.nodes.find((node) => node.id === 'character')?.included, true, '角色块必须纳入');

    await compareGolden(`promptgraph.${locale}`, toSnapshot(graph));
    await runtime.ctx.dispose();
  });
}

test('确定性：块注册顺序不影响装配结果（排序有 id 兜底）', async () => {
  const first = await buildRuntime({ styleFirst: true });
  const graphA = first.assemble({ sessionTitle: 's', characterName: '星野', userName: '旅人', transcript: TRANSCRIPT }, 256);
  await first.ctx.dispose();

  const second = await buildRuntime({ styleFirst: false });
  const graphB = second.assemble({ sessionTitle: 's', characterName: '星野', userName: '旅人', transcript: TRANSCRIPT }, 256);
  await second.ctx.dispose();

  assert.equal(graphA.nodes.length, 4, '应当恰好 4 个块（character/history/style-guide/long-lore）');
  assert.deepEqual(
    graphB.nodes.map((node) => node.id),
    graphA.nodes.map((node) => node.id),
    '同一批块应当产生同一批节点（与注册顺序无关）',
  );
  assert.deepEqual(graphB.order, graphA.order, '纳入顺序也必须一致');
});

test('预算变化只影响"裁掉哪些"，不影响已纳入块的相对顺序', async () => {
  const runtime = await buildRuntime();
  const small = runtime.assemble({ sessionTitle: 's', characterName: '星野', userName: '旅人', transcript: TRANSCRIPT }, 256);
  const large = runtime.assemble({ sessionTitle: 's', characterName: '星野', userName: '旅人', transcript: TRANSCRIPT }, 4096);

  assert.equal(large.omitted <= small.omitted, true, '预算变大不该裁掉更多');
  const smallOrder = small.order.filter((id) => large.order.includes(id));
  assert.deepEqual(smallOrder, large.order.filter((id) => small.order.includes(id)), '共同纳入的块顺序必须一致');
  await runtime.ctx.dispose();
});
