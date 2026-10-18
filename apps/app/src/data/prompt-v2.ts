/**
 * 新版提示词装配（旧 `prompt.ts` 已删除；调用方是 `chat-request.ts` / `auto-opening.ts`）。
 *
 * 同一套原则、新的卡片模型：系统侧按"块"组织——走 `assemble`（优先级 + 预算 + 理由），
 * 没有就按固定顺序拼接、不裁剪；历史不进块（要保留 role 结构），但进上下文前过滤/限条数/记账；
 * 记忆、摘要、典籍在装配前检索好（检索是词法/异步的，排版是同步的），结果写回块数据。
 *
 * 依据：`docs/specs/角色卡结构设计文档.md` 第 3–12 章、`docs/specs/世界资源设计文档.md` 第 3、8 章。
 */

import { CITATION_INSTRUCTION } from './citations.ts';
import { citationWindowOf, lastMessageKeyOf, toMessages } from './prompt-history.ts';
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
import type { AssembleFn } from '../../../../plugins/writing-pipeline/src/index.ts';
import type { BlockSource } from '../../../../plugins/context-blocks/src/index.ts';
import { expandMacros } from './macros.ts';
import { formatMemoryBlock, selectMemories, type RetrievedMemory } from './memory-retrieval.ts';
import type { PromptBlockDataV2, PromptSummary, PromptWorldV2 } from './prompt-blocks-v2.ts';
// 两条装配路径的 trace 收口在 prompt-trace.ts（B20/B21 字段也在那里落到 PromptTraceBlockV2）。
import { assembleFallback, assemblePipeline } from './prompt-trace.ts';
import { ensureAuthorsNoteBlock, readAuthorsNote } from './prompt-authors-note.ts';
// 典籍检索：全局字符预算 + 扫描深度（设置 `chat.lore_scan_depth`）+ 整词匹配 + 单条 token_budget 都在 prompt-lore 里消费。
import { loreScanDepthOf, loreTextOf } from './prompt-lore.ts';
import { insertLoreAtDepth } from './prompt-lore-positions.ts';
import { estimateTokens, type ChatPromptMessage, type PromptHistoryItem } from './tokens.ts';import { SETTING_KEYS, type Memory, type MessageRole } from './types.ts';

// 典籍检索的实现搬到了 prompt-lore.ts；这些名字仍从这里导出，避免调用方/测试跟着改
export { loreBooksOf, passesProbability, stableHash } from './prompt-lore.ts';

export type PromptSectionKind =
  | 'custom' | 'setup' | 'rules' | 'character' | 'state' | 'scene'
  | 'items' | 'examples' | 'memory' | 'summary' | 'lore' | 'postHistory' | 'authorsNote';

export interface PromptTraceBlockV2 {
  id: string; kind: PromptSectionKind; chars: number;
  estimatedTokens: number; included: boolean; reason: string;
  /** B21：实体级来源（角色/场景/物品/典籍/会话/摘要/记忆）。 */
  source?: BlockSource;
  /** B20：本块被块内截断过（末尾 `…`）。 */
  truncated?: boolean;
  /** B20：截断丢掉的 Unicode 码点数。 */
  droppedChars?: number;
  /** B20：本块 token 预算（没设就缺省）。 */
  tokenBudget?: number;
}

export interface PromptTraceV2 {
  pipeline: boolean;
  blocks: PromptTraceBlockV2[];
  lore: ScoredEntry[]; memory: RetrievedMemory[]; summaries: PromptSummary[];
  excluded: { role: MessageRole; reason: 'empty' | 'error' | 'limit'; preview: string }[];
  /** 因条件求值未实现而被跳过的规则条数（不能假装全生效）。 */
  rulesOmitted: number; loreDropped: number;
  /** 每个 position 注入条数（索引 0–7；8 = 未设 position 的旧块）。 */
  lorePositionCounts: number[];
  /** position=7（outlet）未注入条数与名字（无宿主消费者，不静默）。 */
  loreOutletDropped: number; loreOutletsIgnored: string[];
  historyIncluded: number; historyLimit: number; systemChars: number;
  messageChars: number; usedTokens: number; budgetTokens: number; omitted: number;
}

export interface ChatRequestV2 {
  systemPrompt: string; messages: ChatPromptMessage[];
  lore: ScoredEntry[]; memory: RetrievedMemory[]; trace: PromptTraceV2;
  /**
   * **post-history 消息**：成员角色的 `prompts.post_history_instructions`（按 setup 成员顺序拼接）。
   * 它不占 systemPrompt 预算，由调用方作为对话末尾的指令发给模型（`ChatCall.postHistory`）。
   */
  postHistory?: string;
  /**
   * 引用窗口：与 `messages` **一一对应**（第 i 条编号 i+1）。
   * `citationWindow[i]` 是第 i 条消息的 id；调用方没给 id 时该位为 `undefined`。
   */
  citationWindow: readonly (string | undefined)[];
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

/**
 * post-history 指令：**会话成员**（不含不在场的卡）按 setup 顺序拼接，空串跳过。
 * 作者文本里的 `{{char}}`/`{{user}}` 在这里展开（用户输入/历史不展开）。
 * 它不进 systemPrompt 的块预算，由调用方作为对话末尾的指令发出去（`ChatCall.postHistory`）。
 */
function postHistoryOf(data: PromptBlockDataV2): string | undefined {
  const parts = data.world.members
    .map((character) => expandMacros(character.prompts?.post_history_instructions ?? '', data.macros).trim())
    .filter((text) => text !== '');
  return parts.length === 0 ? undefined : parts.join('\n');
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
  loreBudgetChars?: number; loreScanDepth?: number; lastMessageKey?: string; sessionTitle?: string; authorsNote?: string;
}): PromptBlockDataV2 {
  const world = buildPromptWorldV2(options.cards, options.setup);
  const first = world.members[0];
  const charName = first === undefined ? '' : (first.identity.name.trim() || first.meta.name.trim());
  const userName = (options.setup.user_role ?? '').trim();
  return {
    custom: options.custom,
    setup: options.setup,
    world,
    // 宏上下文：只用于作者文本（character/setup/lore/postHistory）；用户输入/历史保持原样。
    macros: { ...(charName === '' ? {} : { charName }), ...(userName === '' ? {} : { userName }) },
    runtime: options.runtime,
    history: options.history,
    memories: options.memories ?? [],
    summaries: options.summaries ?? [],
    ...(options.preselectedSummaries === undefined ? {} : { preselectedSummaries: options.preselectedSummaries }),
    ...(options.loreBudgetChars === undefined ? {} : { loreBudgetChars: options.loreBudgetChars }),
    ...(options.loreScanDepth === undefined ? {} : { loreScanDepth: options.loreScanDepth }),
    ...(options.sessionTitle === undefined ? {} : { sessionTitle: options.sessionTitle }),
    ...(options.authorsNote === undefined ? {} : { authorsNote: options.authorsNote }),
    lastMessageKey: options.lastMessageKey ?? '',
    retrieval: {},
    outcomes: {
      matchedLore: [], loreDropped: 0, matchedMemories: [], matchedSummaries: [], rulesOmitted: 0,
      lorePositionCounts: Array.from({ length: 9 }, () => 0), loreOutletDropped: 0, loreOutletsIgnored: [],
    },
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

export function buildChatRequestV2(options: BuildChatRequestV2Options): ChatRequestV2 {
  const limit = historyLimitOf(options.settings);
  const { kept, excluded } = splitHistory(options.history, limit);
  const loreScanDepth = loreScanDepthOf(options.settings);
  const authorsNote = readAuthorsNote(options.settings);
  let messages = toMessages(kept, options.cite === true);
  let citationWindow = citationWindowOf(kept);
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
    ...(loreScanDepth === undefined ? {} : { loreScanDepth }),
    ...(authorsNote === undefined ? {} : { authorsNote }),
    sessionTitle: options.sessionTitle,
    lastMessageKey: lastMessageKeyOf(kept),
  });
  // post-history 指令来自**会话成员**（data.world.members 已按 setup.characters 顺序排好）。
  const postHistory = postHistoryOf(data);
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

  // post-history 指令：不占 systemPrompt 预算，但要在 trace 里说清"有/没有"（面板可见）。
  const postHistoryTokens = postHistory === undefined ? 0 : estimateTokens(postHistory);
  blocks = [
    ...blocks,
    {
      id: 'app.post_history',
      kind: 'postHistory',
      chars: postHistory?.length ?? 0,
      estimatedTokens: postHistoryTokens,
      included: postHistory !== undefined,
      reason: '',
    },
  ];

  // B18 作者注：已注册块在两条路径按 priority 81 注入；空/未设时补一个可见的 included:false 块。
  blocks = ensureAuthorsNoteBlock(blocks, authorsNote);

  // B19 @depth：作为 system 消息插入（无 position 预算概念）；引用窗口同步补位
  const depthInjection = insertLoreAtDepth(messages, citationWindow, data.retrieval.loreAtDepth ?? []);
  if (depthInjection.injected > 0) {
    messages = depthInjection.messages;
    citationWindow = depthInjection.citationWindow;
  }

  const messageChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return {
    systemPrompt,
    messages,
    lore: data.outcomes.matchedLore,
    memory: data.outcomes.matchedMemories,
    ...(postHistory === undefined ? {} : { postHistory }),
    citationWindow,
    trace: {
      pipeline,
      blocks,
      lore: data.outcomes.matchedLore,
      memory: data.outcomes.matchedMemories,
      summaries: data.outcomes.matchedSummaries,
      excluded,
      rulesOmitted: data.outcomes.rulesOmitted,
      loreDropped: data.outcomes.loreDropped,
      lorePositionCounts: data.outcomes.lorePositionCounts ?? [],
      loreOutletDropped: data.outcomes.loreOutletDropped ?? 0,
      loreOutletsIgnored: data.outcomes.loreOutletsIgnored ?? [],
      historyIncluded: kept.length,
      historyLimit: limit,
      systemChars: systemPrompt.length,
      messageChars,
      usedTokens,
      budgetTokens,
      omitted: assembled.omitted,
    },
  };
}
