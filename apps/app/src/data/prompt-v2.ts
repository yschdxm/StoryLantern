/**
 * 新版提示词装配（旧 `prompt.ts` 已删除；调用方是 `chat-request.ts` / `auto-opening.ts`）。
 *
 * 同一套原则、新的卡片模型：系统侧按"块"组织——走 `assemble`（优先级 + 预算 + 理由），
 * 没有就按固定顺序拼接、不裁剪；历史不进块（要保留 role 结构），但进上下文前过滤/限条数/记账；
 * 记忆、摘要、典籍在装配前检索好（检索是词法/异步的，排版是同步的），结果写回块数据。
 *
 * 依据：`docs/specs/角色卡结构设计文档.md` 第 3–12 章、`docs/specs/世界资源设计文档.md` 第 3、8 章。
 */

import { CITATION_INSTRUCTION, formatNumbered } from './citations.ts';
import { isCharacterCard, isItemCard, isLoreCard, isSceneCard } from '../../../../packages/cards/src/index.ts';
import type {
  CardDocument,
  CharacterCard,
  ItemCard,
  LoreCard,
  SceneCard,
  SessionRuntime,
  SessionSetup,
} from '../../../../packages/cards/src/index.ts';
import type { ScoredEntry } from '../../../../packages/lore/src/index.ts';
import { retrieve } from '../../../../packages/oplog/src/index.ts';
import type { AssembleFn, PromptGraph } from '../../../../plugins/writing-pipeline/src/index.ts';
import { formatMemoryBlock, selectMemories, type RetrievedMemory } from './memory-retrieval.ts';
import { renderAllSections, type PromptBlockDataV2, type PromptSummary, type PromptWorldV2 } from './prompt-blocks-v2.ts';
import { loreTextOf } from './prompt-lore.ts';
import { estimateTokens, type ChatPromptMessage, type PromptHistoryItem } from './tokens.ts';import { SETTING_KEYS, type Memory, type MessageRole } from './types.ts';

// 典籍检索的实现搬到了 prompt-lore.ts；这些名字仍从这里导出，避免调用方/测试跟着改
export { loreBooksOf, passesProbability, stableHash } from './prompt-lore.ts';

export type PromptSectionKind =
  | 'custom' | 'setup' | 'rules' | 'character' | 'state' | 'scene'
  | 'items' | 'examples' | 'memory' | 'summary' | 'lore';

export interface PromptTraceBlockV2 {
  id: string; kind: PromptSectionKind; chars: number;
  estimatedTokens: number; included: boolean; reason: string;
}

export interface PromptTraceV2 {
  pipeline: boolean;
  blocks: PromptTraceBlockV2[];
  lore: ScoredEntry[]; memory: RetrievedMemory[]; summaries: PromptSummary[];
  excluded: { role: MessageRole; reason: 'empty' | 'error' | 'limit'; preview: string }[];
  /** 因条件求值未实现而被跳过的规则条数（不能假装全生效）。 */
  rulesOmitted: number; loreDropped: number;
  historyIncluded: number; historyLimit: number; systemChars: number;
  messageChars: number; usedTokens: number; budgetTokens: number; omitted: number;
}

export interface ChatRequestV2 {
  systemPrompt: string; messages: ChatPromptMessage[];
  lore: ScoredEntry[]; memory: RetrievedMemory[]; trace: PromptTraceV2;
}

export interface BuildChatRequestV2Options {
  cite?: boolean; settings: Record<string, string>; sessionTitle: string; setup: SessionSetup;
  /** 本会话相关卡片（成员角色、当前场景、物品、典籍、世界包里的卡都由调用方筛好）。 */
  cards: readonly CardDocument[]; runtime: SessionRuntime; history: readonly PromptHistoryItem[];
  memories?: readonly Memory[]; summaries?: readonly PromptSummary[]; preselectedSummaries?: PromptSummary[];
  assemble?: AssembleFn; budgetTokens?: number; loreBudgetChars?: number;
}

export const DEFAULT_HISTORY_LIMIT_V2 = 40;
const HISTORY_LIMIT_MAX = 500;
export const SUMMARY_INJECT_LIMIT_V2 = 3;

function historyLimitOf(settings: Record<string, string>): number {
  const raw = Number(settings[SETTING_KEYS.historyLimit]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), HISTORY_LIMIT_MAX) : DEFAULT_HISTORY_LIMIT_V2;
}

function previewOf(item: PromptHistoryItem): string {
  return item.content.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function splitHistory(history: readonly PromptHistoryItem[], limit: number) {
  const usable: PromptHistoryItem[] = [];
  const excluded: PromptTraceV2['excluded'] = [];
  for (const item of history) {
    if (item.status === 'error') excluded.push({ role: item.role, reason: 'error', preview: previewOf(item) });
    else if (item.content.trim() === '') excluded.push({ role: item.role, reason: 'empty', preview: previewOf(item) });
    else usable.push(item);
  }
  const overflow = usable.length > limit ? usable.slice(0, usable.length - limit) : [];
  for (const item of overflow) excluded.push({ role: item.role, reason: 'limit', preview: previewOf(item) });
  return { kept: usable.slice(-limit), excluded };
}

function toMessages(kept: readonly PromptHistoryItem[], cite: boolean): ChatPromptMessage[] {
  return kept.map((item, index) => ({
    role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system',
    content: cite ? formatNumbered(item.content, index + 1) : item.content,
  }));
}

/**
 * 概率判定的种子：规格要求"最后一条消息的 id"，但 `PromptHistoryItem` 没有 id 字段。
 * 调用方若在历史项上带了 id 就优先用它；否则退化为 `role:content`（同样跨设备稳定）。
 */
function lastMessageKeyOf(kept: readonly PromptHistoryItem[]): string {
  const last = kept[kept.length - 1];
  if (last === undefined) return '';
  const id = (last as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : `${last.role}:${last.content}`;
}

/** 从卡片里建索引：全部按 id 排序，因此同一份输入无论数组顺序如何都得到同样的装配。 */
export function buildPromptWorldV2(cards: readonly CardDocument[], setup: SessionSetup): PromptWorldV2 {
  const sorted = [...cards].sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  const characterById = new Map<string, CharacterCard>();
  const sceneById = new Map<string, SceneCard>();
  const itemById = new Map<string, ItemCard>();
  const loreCards: LoreCard[] = [];
  for (const card of sorted) {
    if (isCharacterCard(card) && !characterById.has(card.meta.id)) characterById.set(card.meta.id, card);
    else if (isSceneCard(card) && !sceneById.has(card.meta.id)) sceneById.set(card.meta.id, card);
    else if (isItemCard(card) && !itemById.has(card.meta.id)) itemById.set(card.meta.id, card);
    else if (isLoreCard(card) && !loreCards.some((known) => known.meta.id === card.meta.id)) loreCards.push(card);
  }
  const order = new Map(setup.characters.map((id, index) => [id, index]));
  const all = [...characterById.values()];
  const members =
    setup.characters.length === 0
      ? all
      : all.filter((card) => order.has(card.meta.id)).sort((a, b) => (order.get(a.meta.id) ?? 0) - (order.get(b.meta.id) ?? 0));
  return { members, characterById, sceneById, itemById, loreCards };
}

/** 装配数据的唯一构造函数（测试也用它，避免手搓内部形状）。 */
export function createPromptBlockDataV2(options: {
  custom: string; setup: SessionSetup; cards: readonly CardDocument[]; runtime: SessionRuntime;
  history: ReadonlyArray<{ role: MessageRole; content: string }>;
  memories?: readonly Memory[]; summaries?: readonly PromptSummary[]; preselectedSummaries?: readonly PromptSummary[];
  loreBudgetChars?: number; lastMessageKey?: string;
}): PromptBlockDataV2 {
  return {
    custom: options.custom,
    setup: options.setup,
    world: buildPromptWorldV2(options.cards, options.setup),
    runtime: options.runtime,
    history: options.history,
    memories: options.memories ?? [],
    summaries: options.summaries ?? [],
    ...(options.preselectedSummaries === undefined ? {} : { preselectedSummaries: options.preselectedSummaries }),
    ...(options.loreBudgetChars === undefined ? {} : { loreBudgetChars: options.loreBudgetChars }),
    lastMessageKey: options.lastMessageKey ?? '',
    retrieval: {},
    outcomes: { matchedLore: [], loreDropped: 0, matchedMemories: [], matchedSummaries: [], rulesOmitted: 0 },
  };
}

/** FNV-1a：跨设备同结果，禁止 Math.random。 */
function lastUserQuery(history: ReadonlyArray<{ role: MessageRole; content: string }>): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item !== undefined && item.role === 'user' && item.content.trim() !== '') return item.content;
  }
  return history[history.length - 1]?.content ?? '';
}

function memoryTextOf(data: PromptBlockDataV2): string | undefined {
  if (data.memories.length === 0) return undefined;
  const result = selectMemories({ memories: data.memories, messages: data.history });
  data.outcomes.matchedMemories = result.matched;
  return result.matched.length === 0 ? undefined : formatMemoryBlock(result.matched);
}

function summaryTextOf(data: PromptBlockDataV2): string | undefined {
  if (data.summaries.length === 0) return undefined;
  const byId = new Map(data.summaries.map((summary) => [summary.id, summary]));
  const ranked =
    data.preselectedSummaries === undefined
      ? retrieve(
          lastUserQuery(data.history),
          data.summaries.map((summary) => ({
            id: summary.id,
            text: summary.text,
            kind: 'summary' as const,
            covers: summary.covers,
          })),
          { limit: SUMMARY_INJECT_LIMIT_V2, kinds: ['summary'] },
        ).map((item) => byId.get(item.id))
      : data.preselectedSummaries.map((summary) => byId.get(summary.id));
  const matched = ranked.filter((summary): summary is PromptSummary => summary !== undefined).slice(0, SUMMARY_INJECT_LIMIT_V2);
  data.outcomes.matchedSummaries = matched;
  return matched.length === 0 ? undefined : `【相关摘要】\n${matched.map((summary) => summary.text.trim()).join('\n')}`;
}

function precomputeRetrieval(data: PromptBlockDataV2): void {
  const memory = memoryTextOf(data);
  if (memory !== undefined) data.retrieval.memory = memory;
  const summary = summaryTextOf(data);
  if (summary !== undefined) data.retrieval.summary = summary;
  const lore = loreTextOf(data);
  if (lore !== undefined) data.retrieval.lore = lore;
}

function kindOf(id: string): PromptSectionKind | undefined {
  if (id === 'app.system.custom') return 'custom';
  if (id === 'app.setup') return 'setup';
  if (id === 'app.rules') return 'rules';
  if (id === 'app.character' || id.startsWith('app.character.')) return 'character';
  if (id === 'app.state') return 'state';
  if (id === 'app.scene') return 'scene';
  if (id === 'app.items') return 'items';
  if (id === 'app.examples') return 'examples';
  if (id === 'app.memory.matched') return 'memory';
  if (id === 'app.summary.matched') return 'summary';
  if (id === 'app.lore.matched') return 'lore';
  return undefined;
}

interface AssembledV2 {
  systemPrompt: string;
  blocks: PromptTraceBlockV2[];
  usedTokens: number;
  omitted: number;
}

function assemblePipeline(
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
    blocks.push({ id: node.id, kind, chars: (node.text ?? '').length, estimatedTokens: node.tokens, included: node.included, reason: node.reason });
  }
  return {
    systemPrompt: included.map((node) => node.text ?? '').filter((text) => text !== '').join('\n'),
    blocks,
    usedTokens: graph.usedTokens,
    omitted: graph.omitted,
  };
}

function assembleFallback(data: PromptBlockDataV2): AssembledV2 {
  const sections = renderAllSections(data);
  const blocks = sections.map(
    (section): PromptTraceBlockV2 => ({
      id: section.id,
      kind: kindOf(section.id) ?? 'custom',
      chars: section.text.length,
      estimatedTokens: estimateTokens(section.text),
      included: true,
      reason: '',
    }),
  );
  return {
    systemPrompt: sections.map((section) => section.text).join('\n'),
    blocks,
    usedTokens: blocks.reduce((sum, block) => sum + block.estimatedTokens, 0),
    omitted: 0,
  };
}

export function buildChatRequestV2(options: BuildChatRequestV2Options): ChatRequestV2 {
  const limit = historyLimitOf(options.settings);
  const { kept, excluded } = splitHistory(options.history, limit);
  const messages = toMessages(kept, options.cite === true);
  const data = createPromptBlockDataV2({
    custom: (options.settings[SETTING_KEYS.systemPrompt] ?? '').trim(),
    setup: options.setup,
    cards: options.cards,
    runtime: options.runtime,
    history: kept.map((item) => ({ role: item.role, content: item.content })),
    memories: options.memories ?? [],
    summaries: options.summaries ?? [],
    ...(options.preselectedSummaries === undefined ? {} : { preselectedSummaries: options.preselectedSummaries }),
    ...(options.loreBudgetChars === undefined ? {} : { loreBudgetChars: options.loreBudgetChars }),
    lastMessageKey: lastMessageKeyOf(kept),
  });
  precomputeRetrieval(data);

  const assemble = options.assemble;
  const pipeline = assemble !== undefined;
  const budgetTokens = pipeline ? (options.budgetTokens ?? 2048) : 0;
  const assembled =
    assemble === undefined ? assembleFallback(data) : assemblePipeline(assemble, data, options.sessionTitle, budgetTokens);
  let systemPrompt = assembled.systemPrompt;
  let blocks = assembled.blocks;
  let usedTokens = assembled.usedTokens;

  // 引用说明只改"交给模型的那份"；两条装配路径都在这里统一追加（与旧实现一致）
  if (options.cite === true && messages.length > 0) {
    const citationTokens = estimateTokens(CITATION_INSTRUCTION);
    systemPrompt = systemPrompt === '' ? CITATION_INSTRUCTION : `${systemPrompt}\n${CITATION_INSTRUCTION}`;
    usedTokens += citationTokens;
    blocks = [
      ...blocks,
      {
        id: 'citation.instruction',
        kind: 'custom',
        chars: CITATION_INSTRUCTION.length,
        estimatedTokens: citationTokens,
        included: true,
        reason: '',
      },
    ];
  }

  const messageChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    systemPrompt,
    messages,
    lore: data.outcomes.matchedLore,
    memory: data.outcomes.matchedMemories,
    trace: {
      pipeline,
      blocks,
      lore: data.outcomes.matchedLore,
      memory: data.outcomes.matchedMemories,
      summaries: data.outcomes.matchedSummaries,
      excluded,
      rulesOmitted: data.outcomes.rulesOmitted,
      loreDropped: data.outcomes.loreDropped,
      historyIncluded: messages.length,
      historyLimit: limit,
      systemChars: systemPrompt.length,
      messageChars,
      usedTokens,
      budgetTokens,
      omitted: assembled.omitted,
    },
  };
}
