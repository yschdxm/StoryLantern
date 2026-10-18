/**
 * 两条装配路径的 trace 收口（B20/B21 字段也在这里落到 `PromptTraceBlockV2`）。
 *
 * 从 `prompt-v2.ts` 抽出来是为了给它留出行数：装配器本身（`prompt-v2`）已经贴着 400 行门禁，
 * 而"管线图 / 兜底拼接 → trace"只是映射，放这里不改变调用方（`prompt-v2` re-export 由调用方自己 import）。
 */

import type { AssembleFn, PromptGraph } from '../../../../plugins/writing-pipeline/src/index.ts';
import { renderAllSections, type PromptBlockDataV2 } from './prompt-blocks-v2.ts';
import { estimateTokens } from './tokens.ts';
import type { PromptSectionKind, PromptTraceBlockV2 } from './prompt-v2.ts';

export interface AssembledV2 {
  systemPrompt: string;
  blocks: PromptTraceBlockV2[];
  usedTokens: number;
  omitted: number;
}

export function kindOf(id: string): PromptSectionKind | undefined {
  if (id === 'app.system.custom') return 'custom';
  if (id === 'app.setup') return 'setup';
  if (id === 'app.rules') return 'rules';
  if (id === 'app.character' || id.startsWith('app.character.')) return 'character';
  if (id === 'app.state') return 'state';
  if (id === 'app.scene') return 'scene';
  if (id === 'app.items') return 'items';
  if (id === 'app.examples') return 'examples';
  if (id === 'app.memory.matched') return 'memory';
  if (id === 'app.authors_note') return 'authorsNote';
  if (id === 'app.summary.matched') return 'summary';
  if (id === 'app.lore.matched') return 'lore';
  if (id.startsWith('app.lore.pos')) return 'lore';
  return undefined;
}

export function assemblePipeline(
  assemble: AssembleFn,
  data: PromptBlockDataV2,
  sessionTitle: string,
  budgetTokens: number,
): AssembledV2 {
  const graph: PromptGraph = assemble(
    // 历史不进块（保留 role 结构），transcript 传空；也不传 characterName，
    // 避免 context-blocks 的内置 `character` 块再生成一段"你是「…」"与角色块重复。
    { sessionTitle, transcript: [], data: data as unknown as Record<string, unknown> },
    budgetTokens,
  );
  const included = graph.order
    .map((id) => graph.nodes.find((node) => node.id === id))
    .filter((node): node is PromptGraph['nodes'][number] => node !== undefined && node.included);
  const blocks: PromptTraceBlockV2[] = [];
  for (const node of graph.nodes) {
    const kind = kindOf(node.id);
    if (kind === undefined) continue;
    blocks.push({
      id: node.id,
      kind,
      chars: (node.text ?? '').length,
      estimatedTokens: node.tokens,
      included: node.included,
      reason: node.reason,
      ...(node.source === undefined ? {} : { source: node.source }),
      ...(node.truncated === true ? { truncated: true, droppedChars: node.droppedChars ?? 0 } : {}),
      ...(node.tokenBudget === undefined ? {} : { tokenBudget: node.tokenBudget }),
    });
  }
  return {
    systemPrompt: included.map((node) => node.text ?? '').filter((text) => text !== '').join('\n'),
    blocks,
    usedTokens: graph.usedTokens,
    omitted: graph.omitted,
  };
}

/** 兜底路径：无全局预算，但**每块预算/来源**照常生效（与管线路径一致的块内截断）。 */
export function assembleFallback(data: PromptBlockDataV2): AssembledV2 {
  const sections = renderAllSections(data);
  const blocks = sections.map(
    (section): PromptTraceBlockV2 => ({
      id: section.id,
      kind: kindOf(section.id) ?? 'custom',
      chars: section.text.length,
      estimatedTokens: estimateTokens(section.text),
      included: true,
      reason: '',
      ...(section.source === undefined ? {} : { source: section.source }),
      ...(section.truncated === true ? { truncated: true, droppedChars: section.droppedChars ?? 0 } : {}),
      ...(section.tokenBudget === undefined ? {} : { tokenBudget: section.tokenBudget }),
    }),
  );
  return {
    systemPrompt: sections.map((section) => section.text).join('\n'),
    blocks,
    usedTokens: blocks.reduce((sum, block) => sum + block.estimatedTokens, 0),
    omitted: 0,
  };
}
