import { defineConfig } from '../../../packages/kernel/src/config.ts';
import type { Context } from '../../../packages/kernel/src/context.ts';
import type { BlockContext, BlockDefinition, BlockPlacement, BlockRegistry } from '../../context-blocks/src/index.ts';

export const name = 'writing-pipeline';
export const inject = ['context.blocks'];

export const Config = defineConfig({
  budgetTokens: {
    type: 'number',
    default: 2048,
    min: 256,
    max: 200000,
    integer: true,
    description: '默认上下文预算',
  },
  historyLimit: { type: 'number', default: 40, min: 0, max: 1000, integer: true, description: '进入上下文的最近消息条数' },
});

const PLACEMENT_ORDER: BlockPlacement[] = ['system', 'before-history', 'at-depth', 'after-history'];

export interface PromptNode {
  id: string;
  placement: BlockPlacement;
  priority: number;
  tokens: number;
  included: boolean;
  /** 可解释性：为什么纳入 / 为什么被裁掉。 */
  reason: string;
  text?: string;
}

export interface PromptGraph {
  nodes: PromptNode[];
  /** 最终进入请求的块顺序。 */
  order: string[];
  usedTokens: number;
  budgetTokens: number;
  omitted: number;
}

/** 粗估 token：中文约 1 token/字，英文约 1 token/4 字符；正式实现会换成真 tokenizer。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/**
 * 把块编译成 PromptGraph。
 *
 * 这是"写作走确定性管线"的最小骨架：每个块都有优先级与 token 预算，
 * 被纳入与被裁掉都要留下可读理由——Request Inspector 展示的就是这份图。
 */
export function assembleBlocks(
  blocks: readonly BlockDefinition[],
  context: BlockContext,
  budgetTokens: number,
): PromptGraph {
  const rendered = blocks
    .map((block) => ({ block, text: block.render(context) }))
    .filter((item): item is { block: BlockDefinition; text: string } => typeof item.text === 'string' && item.text.length > 0)
    .map((item) => ({ block: item.block, text: item.text, tokens: estimateTokens(item.text) }));

  rendered.sort((a, b) => {
    const byPlacement = PLACEMENT_ORDER.indexOf(a.block.placement) - PLACEMENT_ORDER.indexOf(b.block.placement);
    if (byPlacement !== 0) return byPlacement;
    if (a.block.priority !== b.block.priority) return b.block.priority - a.block.priority;
    return a.block.id.localeCompare(b.block.id);
  });

  const nodes: PromptNode[] = [];
  let used = 0;
  for (const item of rendered) {
    const fits = used + item.tokens <= budgetTokens;
    const node: PromptNode = {
      id: item.block.id,
      placement: item.block.placement,
      priority: item.block.priority,
      tokens: item.tokens,
      included: fits,
      reason: fits
        ? `纳入（优先级 ${item.block.priority}，占用 ${item.tokens} tokens）`
        : `预算不足裁掉（已用 ${used}/${budgetTokens}，本块需 ${item.tokens}）`,
      ...(fits ? { text: item.text } : {}),
    };
    if (fits) used += item.tokens;
    nodes.push(node);
  }

  return {
    nodes,
    order: nodes.filter((node) => node.included).map((node) => node.id),
    usedTokens: used,
    budgetTokens,
    omitted: nodes.filter((node) => !node.included).length,
  };
}

export type AssembleFn = (context: BlockContext, budgetTokens?: number) => PromptGraph;

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const blocks = ctx.require<BlockRegistry>('context.blocks');
  const budgetTokens = typeof config.budgetTokens === 'number' ? config.budgetTokens : 2048;
  const historyLimit = typeof config.historyLimit === 'number' ? config.historyLimit : 40;

  // 内置的"最近历史"块，同样走注册表。
  blocks.register('history', {
    id: 'history',
    placement: 'before-history',
    priority: 60,
    render: (context) => {
      const recent = context.transcript.slice(-historyLimit);
      return recent.length > 0 ? recent.join('\n') : undefined;
    },
  });

  const assemble: AssembleFn = (context, budget) =>
    assembleBlocks(blocks.list().map((entry) => entry.value), context, budget ?? budgetTokens);
  ctx.set('context.assemble', assemble);
}
