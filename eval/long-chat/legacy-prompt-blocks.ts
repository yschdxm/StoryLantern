/* 冻结副本（仅评估回放用）：旧提示词实现的最后一份；录制/回放按它逐字比对，产品代码已删除。 */

import { scanLore, type ScanBook, type ScoredEntry } from '../../packages/lore/src/index.ts';
import { formatMemoryBlock, selectMemories, type RetrievedMemory } from '../../apps/app/src/data/memory-retrieval.ts';
import { retrieve } from '../../packages/oplog/src/index.ts';
import type { BlockContext, BlockDefinition, BlockRegistry } from '../../plugins/context-blocks/src/index.ts';
import type { Memory, MessageRole } from '../../apps/app/src/data/types.ts';

/**
 * ⚠️ **已被 `prompt-blocks-v2.ts` 取代（ADR-0011，2026-10-17）。**
 * 启动时注册的是 v2 的块（`main.tsx`）；本文件保留旧测试，不再接进产品路径。
 */

/**
 * 应用侧的上下文块：**唯一决定"模型看到什么"的代码**都在这里和 `prompt.ts`。
 *
 * 为什么用块注册表而不是在 `prompt.ts` 里拼字符串：
 *  - 每块有自己的优先级与预算参与顺序，超预算时能说清"谁被裁了、为什么"；
 *  - 关掉 bundle 里 `pipeline` 那一行，预算与理由就没了（功能真的消失，而不是静默降级）；
 *  - 第三方块与内置块走同一套机制，将来加"长期记忆""人物关系"这类块不必改内核。
 *
 * 历史消息**不进块**：块产出的是文本，而对话需要保留 role 结构（见 `prompt.ts` 的说明）。
 */

export interface PromptBlockCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  exampleDialogue: string;
}

export interface PromptBlockData {
  /** 设置里的自定义系统提示。 */
  custom: string;
  character?: PromptBlockCharacter;
  lorebooks: readonly ScanBook[];
  /** 长期记忆（已按角色筛过）。 */
  memories: readonly Memory[];
  /** 历史消息（扫描世界书/记忆用；已按角色映射过）。 */
  history: ReadonlyArray<{ role: MessageRole; content: string }>;
  /** 世界书扫描结果：块渲染时写入，供可解释性面板读取。 */
  matchedLore?: ScoredEntry[];
  /** 分层摘要（M4；已按会话筛过）。 */
  summaries?: readonly PromptSummary[];
  /** 长期记忆检索结果：块渲染时写入，供可解释性面板读取。 */
  matchedMemories?: RetrievedMemory[];
  /** 摘要检索结果：块渲染时写入，供可解释性面板读取。 */
  matchedSummaries?: PromptSummary[];
  /**
   * **调用方预选**的摘要（例如向量检索在装配前异步算好）。给了就用它，不再用词法重算。
   * 为什么需要这个口子：块渲染是同步的，而 embedding 必然异步 —— 同步 render 里塞不进网络调用。
   */
  preselectedSummaries?: PromptSummary[];
}

/** 摘要块需要的最小形状（由调用方从应用层的 Summary 映射过来）。 */
export interface PromptSummary {
  id: string;
  text: string;
  level: string;
  covers: readonly string[];
}

/** 一次注入几条摘要。别贪多：摘要顶掉的是历史消息的位置，而历史更近、通常更该在场。 */
export const SUMMARY_INJECT_LIMIT = 3;

/** 块渲染时读取的类型化视图（唯一的 `as` 收口）。 */
function dataOf(context: BlockContext): Partial<PromptBlockData> {
  return (context.data ?? {}) as Partial<PromptBlockData>;
}

export function characterBlockText(character: PromptBlockCharacter | undefined): string | undefined {
  if (character === undefined || character.name.trim() === '') return undefined;
  const parts = [`你要扮演「${character.name}」。`];
  if (character.description.trim() !== '') parts.push(`【设定】${character.description.trim()}`);
  if (character.personality.trim() !== '') parts.push(`【性格】${character.personality.trim()}`);
  if (character.scenario.trim() !== '') parts.push(`【场景】${character.scenario.trim()}`);
  if (character.exampleDialogue.trim() !== '') parts.push(`【对话示例】\n${character.exampleDialogue.trim()}`);
  parts.push('直接以角色身份说话，不要解释你是 AI，也不要用旁白复述设定。');
  return parts.join('\n');
}

/** 世界书块：命中就把条目正文拼成【相关设定】，并把命中详情写回 `data.matchedLore`。 */
export function loreBlockText(context: BlockContext): string | undefined {
  const data = dataOf(context);
  if (data.lorebooks === undefined || data.lorebooks.length === 0) return undefined;
  const result = scanLore({
    books: data.lorebooks,
    messages: (data.history ?? []).map((item) => ({ role: item.role, content: item.content })),
  });
  data.matchedLore = result.matched;
  if (result.matched.length === 0) return undefined;
  return `【相关设定】\n${result.matched.map((entry) => entry.content.trim()).join('\n')}`;
}

/** 长期记忆块：按相关度挑出记忆并注入，命中详情写回 `data.matchedMemories`。 */
export function memoryBlockText(context: BlockContext): string | undefined {
  const data = dataOf(context);
  if (data.memories === undefined || data.memories.length === 0) return undefined;
  const result = selectMemories({
    memories: data.memories,
    messages: (data.history ?? []).map((item) => ({ role: item.role, content: item.content })),
  });
  data.matchedMemories = result.matched;
  if (result.matched.length === 0) return undefined;
  return formatMemoryBlock(result.matched);
}

/**
 * 分层摘要块（M4）：用**检索**挑出与最近对话最相关的几条摘要注入，命中写回 data.matchedSummaries。
 *
 * 为什么用检索而不是把最近的摘要全塞进去：摘要的价值就在久远但相关；
 * 按最近塞等于又做了一遍历史窗口。检索引擎是 oplog 里的零依赖 BM25（见 retrieval.ts）。
 */
export function summaryBlockTextOf(data: Partial<PromptBlockData>): string | undefined {
  const summaries = data.summaries ?? [];
  if (summaries.length === 0) return undefined;
  // 查询 = **最后一条用户消息**。为什么不是"最近 N 条拼起来"：
  // 评估里实测过——把最后 4 条拼起来时，填充句的词面权重会盖过问题本身，
  // 结果检索挑中的摘要与这一问无关（500 条同风格语料下事实可达率反而从 2/5 掉到 1/5）。
  // 当前这一问才是最强信号；没有用户消息（极少数情况）才退回最后一条。
  const history = data.history ?? [];
  let query = '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role === 'user' && item.content.trim() !== '') {
      query = item.content;
      break;
    }
  }
  if (query === '') query = history[history.length - 1]?.content ?? '';
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  // 预选优先：向量检索（或任何外部排序）在装配前算好的结果直接用，避免同步块里再算一遍词法
  const preselected = data.preselectedSummaries;
  if (preselected !== undefined) {
    const matched = preselected
      .map((summary) => byId.get(summary.id))
      .filter((summary): summary is PromptSummary => summary !== undefined)
      .slice(0, SUMMARY_INJECT_LIMIT);
    data.matchedSummaries = matched;
    return matched.length === 0 ? undefined : '【相关摘要】\n' + matched.map((summary) => summary.text.trim()).join('\n');
  }
  const ranked = retrieve(
    query,
    summaries.map((summary) => ({ id: summary.id, text: summary.text, kind: 'summary' as const, covers: summary.covers })),
    { limit: SUMMARY_INJECT_LIMIT, kinds: ['summary'] },
  );
  const matched = ranked
    .map((item) => byId.get(item.id))
    .filter((summary): summary is PromptSummary => summary !== undefined);
  data.matchedSummaries = matched;
  if (matched.length === 0) return undefined;
  return '【相关摘要】\n' + matched.map((summary) => summary.text.trim()).join('\n');
}

/** 注册应用侧的块。返回反注册函数（交给内核的 effect 生命周期）。 */
export function registerPromptBlocks(blocks: BlockRegistry): () => void {
  const definitions: BlockDefinition[] = [
    {
      id: 'app.system.custom',
      placement: 'system',
      // 用户自己写的排在最前，且优先保预算
      priority: 100,
      render: (context) => {
        const custom = dataOf(context).custom?.trim() ?? '';
        return custom === '' ? undefined : custom;
      },
    },
    {
      id: 'app.character.card',
      placement: 'system',
      priority: 90,
      render: (context) => characterBlockText(dataOf(context).character),
    },
    {
      id: 'app.memory.matched',
      placement: 'before-history',
      // 比世界书略高：记忆是"这个人/这段关系"的事实，通常比设定更该在场
      priority: 85,
      render: (context) => memoryBlockText(context),
    },
    {
      id: 'app.summary.matched',
      placement: 'before-history',
      // 夹在记忆与设定之间：摘要是发生过什么，设定是世界是什么
      priority: 82,
      render: (context) => summaryBlockTextOf(dataOf(context)),
    },
    {
      id: 'app.lore.matched',
      placement: 'before-history',
      priority: 80,
      render: (context) => loreBlockText(context),
    },
  ];

  const offs = definitions.map((definition) => blocks.register(definition.id, definition));
  return () => {
    for (const off of offs.reverse()) off();
  };
}
