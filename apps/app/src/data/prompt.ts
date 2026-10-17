import { CITATION_INSTRUCTION, formatNumbered } from './citations.ts';
import { scanLore, type ScoredEntry } from '../../../../packages/lore/src/index.ts';
import type { AssembleFn, PromptGraph } from '../../../../plugins/writing-pipeline/src/index.ts';
import { characterBlockText, memoryBlockText, summaryBlockTextOf, type PromptBlockData, type PromptSummary } from './prompt-blocks.ts';
import { formatMemoryBlock, selectMemories, type RetrievedMemory } from './memory-retrieval.ts';
import { SETTING_KEYS, type Lorebook, type Memory, type MessageRole } from './types.ts';

/**
 * ⚠️ **已被 `prompt-v2.ts` 取代（ADR-0011，2026-10-17）。**
 * 聊天页现在调用 `buildChatRequestV2`；本文件保留是为了不一次性删掉旧测试与旧调用方，
 * 新代码不要再往这里加东西。旧的块（角色卡 6 字段 + 世界书 + memory/summary）语义见 git 历史。
 */

/**
 * 组装模型请求。
 *
 * 为什么放在前端：M1 之后"上下文"的唯一来源是 op 日志（角色卡 + 历史消息都在前端物化状态里），
 * 宿主不该再存一份。这样也只有一个地方在决定"给模型看什么"——可解释性从这里开始。
 *
 * 两条路径：
 *  - **走管线**（默认）：系统侧的块交给 `context.assemble`（优先级 + 预算 + 每条理由），
 *    因此"为什么某段没进去"有答案；关掉 bundle 里的 `pipeline` 就退化为下面那条。
 *  - **兜底拼接**：没有管线时按固定顺序拼，不裁剪，但同样产出 `trace`，界面照实说明"未启用管线"。
 *
 * 历史消息**不进块**：块产出的是文本，而对话必须保留 role 结构；
 * 因此块负责系统提示，历史由这里按条数与角色组装，被排除的同样记账。
 */

export interface ChatPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 请求可解释性：这次调用到底带了什么、裁了什么、为什么。 */
export type PromptBlockKind = 'custom' | 'character' | 'memory' | 'summary' | 'lore';

export interface PromptTraceBlock {
  id: string;
  kind: PromptBlockKind;
  chars: number;
  estimatedTokens: number;
  included: boolean;
  /** 管线给的理由（已本地化）；兜底路径为空串，界面据此说明"未启用管线"。 */
  reason: string;
}

export type ExclusionReason = 'empty' | 'error' | 'limit';

export interface PromptTraceExcluded {
  role: MessageRole;
  reason: ExclusionReason;
  preview: string;
}

export interface PromptTrace {
  /** 是否走了管线（有预算与裁剪理由）。 */
  pipeline: boolean;
  blocks: PromptTraceBlock[];
  lore: ScoredEntry[];
  /** 本次实际注入的长期记忆。 */
  memory: RetrievedMemory[];
  /** 本次实际注入的分层摘要（M4）。 */
  summaries: PromptSummary[];
  /** 被排除的历史消息及原因（空内容 / 生成失败 / 超出条数上限）。 */
  excluded: PromptTraceExcluded[];
  historyIncluded: number;
  historyLimit: number;
  systemChars: number;
  messageChars: number;
  usedTokens: number;
  budgetTokens: number;
  omitted: number;
}

export interface ChatRequest {
  systemPrompt: string;
  messages: ChatPromptMessage[];
  /** 本次实际注入的世界书条目（空数组 = 没命中任何设定）。 */
  lore: ScoredEntry[];
  /** 本次实际注入的长期记忆。 */
  memory: RetrievedMemory[];
  /** 本次请求的构成说明（界面里的"本次请求"面板）。 */
  trace: PromptTrace;
}

export interface PromptCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  exampleDialogue: string;
  /** 角色自带的系统提示；非空时优先于设置里的全局提示（导入卡片时不再丢掉）。 */
  systemPrompt?: string | undefined;
}

export interface PromptHistoryItem {
  role: MessageRole;
  content: string;
  status?: 'done' | 'streaming' | 'error';
}

export interface BuildPromptOptions {
  /**
   * 是否给交给模型的历史消息加编号、并追加一句引用说明（默认关）。
   *
   * 为什么做成开关：真实聊天要它（不然「引用正确」这条判据无从判），
   * 而底层装配的单元测试关心的是「谁进了上下文」，不该被编号前缀干扰。
   * 打开时只改**交给模型的 messages**；给关键词扫描的那份保持原文。
   */
  cite?: boolean;
  /** 调用方预选的摘要（向量检索在装配前算好）；不给就走块内的词法检索。 */
  preselectedSummaries?: PromptSummary[];
  settings: Record<string, string>;
  character?: PromptCharacter;
  history: readonly PromptHistoryItem[];
  /** 该角色可用的世界书（调用方已按角色筛过；全局书也算）。 */
  lorebooks?: readonly Lorebook[];
  /** 该角色可用的长期记忆（调用方已按角色筛过；全局记忆也算）。 */
  memories?: readonly Memory[];
  /** 该会话已有的分层摘要（M4；调用方已按会话筛过）。 */
  summaries?: readonly PromptSummary[];
  /** 世界书预算（字符）；不传用扫描器默认值。 */
  loreBudgetChars?: number;
  /** 组装管线（来自组合出来的插件）。缺省时走兜底拼接。 */
  assemble?: AssembleFn;
  /** 系统提示的 token 预算（只有走管线时生效）。 */
  budgetTokens?: number;
  /** 会话标题（块的上下文里会用到）。 */
  sessionTitle?: string;
}

/** 历史上限：不限制会让上下文无限膨胀，而"无限"在真机上表现为越来越慢、越来越贵。 */
export const DEFAULT_HISTORY_LIMIT = 40;

/** 粗估 token：中文约 1 token/字，英文约 1 token/4 字符（与管线里的实现必须一致，有测试盯着）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function historyLimitOf(settings: Record<string, string>): number {
  const raw = Number(settings[SETTING_KEYS.historyLimit]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(raw), 500);
}

export function buildChatRequest(options: BuildPromptOptions): ChatRequest {
  const limit = historyLimitOf(options.settings);
  const character = options.character;
  // 系统提示的优先顺序：**角色自带的**（导入卡片时带过来的）> 设置里的全局提示。
  // 角色卡作者写的那段话通常比全局模板更懂这个角色，所以让角色优先。
  const globalPrompt = (options.settings[SETTING_KEYS.systemPrompt] ?? '').trim();
  const characterPrompt = (options.character?.systemPrompt ?? '').trim();
  const custom = characterPrompt !== '' ? characterPrompt : globalPrompt;

  // 只把"能进上下文"的消息拿去扫描世界书：失败消息里的关键词不该触发设定
  const usable: Array<{ role: MessageRole; content: string }> = [];
  const excluded: PromptTraceExcluded[] = [];
  for (const item of options.history) {
    const preview = item.content.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (item.status === 'error') {
      excluded.push({ role: item.role, reason: 'error', preview });
      continue;
    }
    if (item.content.trim() === '') {
      excluded.push({ role: item.role, reason: 'empty', preview });
      continue;
    }
    usable.push({ role: item.role, content: item.content });
  }

  // 超出上限的最旧消息：记清楚被裁了什么，而不是悄悄丢掉
  const overflow = usable.length > limit ? usable.slice(0, usable.length - limit) : [];
  for (const item of overflow) {
    excluded.push({ role: item.role, reason: 'limit', preview: item.content.replace(/\s+/g, ' ').trim().slice(0, 40) });
  }
  const kept = usable.slice(-limit);
  // 交给模型的历史消息**带编号**：不让它指认来源，「引用正确」这条判据就无从判。
  // 注意只改这里 —— 下面给关键词扫描用的 messages 保持原文，否则编号会污染扫描。
  const messages: ChatPromptMessage[] = kept.map((item, index) => ({
    role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system',
    content: options.cite === true ? formatNumbered(item.content, index + 1) : item.content,
  }));

  const data: PromptBlockData = {
    custom,
    ...(character === undefined ? {} : { character }),
    lorebooks: (options.lorebooks ?? []) as PromptBlockData['lorebooks'],
    memories: (options.memories ?? []) as PromptBlockData['memories'],
    summaries: options.summaries ?? [],
    ...(options.preselectedSummaries === undefined ? {} : { preselectedSummaries: options.preselectedSummaries }),
    history: kept,
  };

  let systemPrompt = '';
  let blocks: PromptTraceBlock[] = [];
  let lore: ScoredEntry[] = [];
  let memory: RetrievedMemory[] = [];
  let matchedSummaries: PromptSummary[] = [];
  let usedTokens = 0;
  let budgetTokens = 0;
  let omitted = 0;
  let pipeline = false;

  if (options.assemble !== undefined) {
    pipeline = true;
    budgetTokens = options.budgetTokens ?? 2048;
    const graph: PromptGraph = options.assemble(
      {
        sessionTitle: options.sessionTitle ?? '',
        ...(character === undefined ? {} : { characterName: character.name }),
        // 历史走结构化的 messages，不进块（见文件头说明）
        transcript: [],
        data: data as unknown as Record<string, unknown>,
      },
      budgetTokens,
    );
    const included = graph.order
      .map((id) => graph.nodes.find((node) => node.id === id))
      .filter((node): node is PromptGraph['nodes'][number] => node !== undefined && node.included);
    systemPrompt = included
      .map((node) => node.text ?? '')
      .filter((text) => text !== '')
      .join('\n');
    blocks = graph.nodes
      .filter((node) => kindOf(node.id) !== undefined)
      .map((node) => ({
        id: node.id,
        kind: kindOf(node.id) as PromptBlockKind,
        chars: (node.text ?? '').length,
        estimatedTokens: node.tokens,
        included: node.included,
        reason: node.reason,
      }));
    usedTokens = graph.usedTokens;
    omitted = graph.omitted;
  } else {
    // 兜底：没有管线时的固定顺序拼接（不裁剪，但一样记账）
    budgetTokens = 0;
    const loreResult = scanLore({
      books: (options.lorebooks ?? []) as PromptBlockData['lorebooks'],
      messages: kept.map((item) => ({ role: item.role, content: item.content })),
    });
    lore = loreResult.matched;
    const memoryResult = selectMemories({
      memories: options.memories ?? [],
      messages: kept.map((item) => ({ role: item.role, content: item.content })),
    });
    memory = memoryResult.matched;

    const parts: Array<{ kind: PromptBlockKind; text: string }> = [];
    if (custom !== '') parts.push({ kind: 'custom', text: custom });
    const card = characterBlockText(character);
    if (card !== undefined) parts.push({ kind: 'character', text: card });
    if (memoryResult.matched.length > 0) parts.push({ kind: 'memory', text: formatMemoryBlock(memoryResult.matched) });
    // 摘要走**检索**（与管线里的块同一份实现，避免两处漂移）
    const summaryText = summaryBlockTextOf(data);
    matchedSummaries = data.matchedSummaries ?? [];
    if (summaryText !== undefined) parts.push({ kind: 'summary', text: summaryText });
    if (loreResult.matched.length > 0) {
      parts.push({ kind: 'lore', text: `【相关设定】\n${loreResult.matched.map((entry) => entry.content.trim()).join('\n')}` });
    }

    systemPrompt = parts.map((part) => part.text).join('\n');
    blocks = parts.map((part) => ({
      id: `fallback.${part.kind}`,
      kind: part.kind,
      chars: part.text.length,
      estimatedTokens: estimateTokens(part.text),
      included: true,
      reason: '',
    }));
    usedTokens = blocks.reduce((sum, block) => sum + block.estimatedTokens, 0);
  }

  if (pipeline) {
    // 世界书/记忆块在渲染时把命中写回了 data
    lore = data.matchedLore ?? [];
    memory = data.matchedMemories ?? [];
    matchedSummaries = data.matchedSummaries ?? [];
  }

  // 引用说明：两条装配路径（管线 / 兜底）都在这里统一追加，字数照实计入 usedTokens
  if (options.cite === true && messages.length > 0) {
    const citationTokens = estimateTokens(CITATION_INSTRUCTION);
    systemPrompt = systemPrompt === '' ? CITATION_INSTRUCTION : systemPrompt + '\n' + CITATION_INSTRUCTION;
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
    lore,
    memory,
    trace: {
      pipeline,
      blocks,
      lore,
      memory,
      summaries: matchedSummaries,
      excluded,
      historyIncluded: messages.length,
      historyLimit: limit,
      systemChars: systemPrompt.length,
      messageChars,
      usedTokens,
      budgetTokens,
      omitted,
    },
  };
}

/** 只有应用自己注册的块会出现在面板里（第三方块的 id 不认识就不猜）。 */
function kindOf(id: string): PromptBlockKind | undefined {
  if (id === 'app.system.custom') return 'custom';
  if (id === 'app.character.card') return 'character';
  if (id === 'app.memory.matched') return 'memory';
  if (id === 'app.summary.matched') return 'summary';
  if (id === 'app.lore.matched') return 'lore';
  return undefined;
}

/** 角色卡 → 系统提示（兜底路径与块共用同一份实现，避免两处写法漂移）。 */
export function characterPrompt(character: PromptCharacter | undefined): string {
  return characterBlockText(character) ?? '';
}
