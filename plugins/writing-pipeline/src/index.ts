import { defineConfig } from '../../../packages/plugin-api/src/index.ts';
import type { LocaleService, PluginContext } from '../../../packages/plugin-api/src/index.ts';
import type { BlockContext, BlockDefinition, BlockPlacement, BlockRegistry } from '../../context-blocks/src/index.ts';
import { fallbackTranslator, MESSAGES, MESSAGE_NAMESPACE, type Translator } from './messages.ts';

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
  /** 可解释性：为什么纳入 / 为什么被裁掉（走 locale service）。 */
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
 *
 * `translate` 可注入：插件在运行时会换成 `locale.t`，缺省则用内置中文兜底，
 * 因此这个函数仍是可独立调用的纯函数。
 */
export function assembleBlocks(
  blocks: readonly BlockDefinition[],
  context: BlockContext,
  budgetTokens: number,
  translate: Translator = fallbackTranslator(),
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
        ? translate('pipeline.node.included', { priority: item.block.priority, tokens: item.tokens })
        : translate('pipeline.node.omitted', { used, budget: budgetTokens, tokens: item.tokens }),
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

export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
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

  let translate: Translator = fallbackTranslator();

  const publish = (): void => {
    const assemble: AssembleFn = (context, budget) =>
      assembleBlocks(blocks.list().map((entry) => entry.value), context, budget ?? budgetTokens, translate);
    ctx.set('context.assemble', assemble);
  };

  // 先发布一个能用的版本（无 locale 时走中文兜底）。
  publish();

  // locale 可用后换成真翻译，并注册本插件的语言包；两者都随本插件卸载一起撤销。
  ctx.inject(['locale'], (target) => {
    const locale = target.require<LocaleService>('locale');
    translate = (key, params) => locale.t(key, params, { namespace: MESSAGE_NAMESPACE });
    publish();

    const registrations = Object.entries(MESSAGES).map(([localeTag, messages]) =>
      locale.register({ namespace: MESSAGE_NAMESPACE, locale: localeTag, messages }),
    );

    return () => {
      for (const off of registrations.reverse()) off();
      translate = fallbackTranslator();
      // 上下文销毁期间不能再注册（内核会拒绝）；只有在"locale 消失但插件仍在"时才需要换回兜底。
      if (!target.disposed) publish();
    };
  });
}
