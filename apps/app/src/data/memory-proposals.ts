import type { ChatPromptMessage } from './tokens.ts';
import type { Memory, MessageRole } from './types.ts';

/**
 * 记忆整理建议：**agent 只做整理，不写正文**。
 *
 * 所以这里只做两件事——把"要整理什么、按什么格式回答"讲清楚，以及把模型的回答**严格**解析成建议。
 * 解析必须能扛住真实模型的坏输出（套代码块、前后多说两句、字段类型不对），
 * 因为"模型没按格式说话"是常态，不是异常。
 */

export interface MemoryProposal {
  text: string;
  keys: string[];
  importance: number;
  /** 与已有记忆重复时，指向那条已有记忆的 id（界面要能提示"已有类似"）。 */
  duplicateOf?: string;
}

/** 系统提示：把任务、边界、输出格式一次讲清。 */
export const PROPOSAL_INSTRUCTION = [
  '你是一个"记忆整理助手"。你的任务是从对话里挑出**值得长期记住**的事实、设定与关系变化。',
  '只做整理，不要续写剧情，不要评价，不要输出对话内容之外的事。',
  '输出必须是 JSON 数组，每个元素: {"text": "一句话，用第三人称陈述", "keys": ["关键词"], "importance": 0-100}。',
  '要求：text 一句话说清一件事；keys 是以后想再次想起它时可能提到的词；importance 表示这件事有多该长期保留。',
  '如果这段对话没有任何值得长期记住的内容，就输出空数组 []。不要编造对话里没有的信息。',
  '除了 JSON 数组不要输出任何其它文字。',
].join('\n');

/** 建议条数上限：一次塞太多，用户会全都不看。 */
export const MAX_PROPOSALS = 8;

export function buildProposalMessages(options: {
  characterName: string;
  history: ReadonlyArray<{ role: MessageRole; content: string; status?: string | undefined }>;
  existing?: readonly Memory[];
  /** 最多看多少条最近消息（越早的越可能是"已经被挤掉但又该记住"的）。 */
  maxMessages?: number;
}): ChatPromptMessage[] {
  const limit = options.maxMessages ?? 60;
  const lines = options.history
    .filter((message) => message.content.trim() !== '' && (message.status === undefined || message.status === 'done'))
    .slice(-limit)
    .map((message) => `${message.role === 'user' ? '用户' : '角色'}：${message.content.trim()}`);

  const existing = (options.existing ?? []).map((memory) => `- ${memory.text.trim()}`);
  const blocks = [
    options.characterName === '' ? '' : `当前角色：${options.characterName}`,
    existing.length === 0 ? '已有记忆：无' : `已有记忆（不要重复这些）：\n${existing.join('\n')}`,
    `对话记录：\n${lines.join('\n')}`,
    `最多给出 ${MAX_PROPOSALS} 条建议。`,
  ].filter((block) => block !== '');

  return [{ role: 'user', content: blocks.join('\n\n') }];
}

/** 归一化：比较"是否重复"时只看实质字符。 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，。、；：！？,.!?;:'"“”‘’（）()【】\[\]-]/g, '');
}

function asKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .slice(0, 12);
  }
  if (typeof value === 'string') {
    return value
      .split(/[，,、\s]+/)
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .slice(0, 12);
  }
  return [];
}

function asImportance(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return 50;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

/** 从模型的回答里挖出 JSON 数组：先直接解析，再退回"掐头去尾"，最后逐行试。 */
function extractArray(raw: string): unknown[] {
  const text = raw.trim();
  const candidates: string[] = [text];

  // 去掉代码块围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

  // 掐头去尾：模型常常前后多说两句
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed !== null && typeof parsed === 'object') {
        // 有的模型会包一层 {"memories": [...]}
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          if (Array.isArray(value)) return value;
        }
      }
    } catch {
      // 继续换下一种截法
    }
  }

  // 最后：逐行找出能独立解析成对象/数组的行（每行一条的松散输出）
  const loose: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*]\s*/, '').replace(/,$/, '');
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') loose.push(parsed);
    } catch {
      // 忽略解不出来的行
    }
  }
  return loose;
}

/**
 * 解析建议。坏数据一律**跳过**而不是抛错：用户看到的是"什么都没整理出来"，
 * 而不是一个崩掉的界面。
 */
export function parseProposals(raw: string, options: { existing?: readonly Memory[] } = {}): MemoryProposal[] {
  const existing = options.existing ?? [];
  const byText = new Map(existing.map((memory) => [normalize(memory.text), memory.id]));
  const seen = new Set<string>();
  const proposals: MemoryProposal[] = [];

  for (const item of extractArray(raw)) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = [record['text'], record['content'], record['memory']].find((value): value is string => typeof value === 'string');
    if (text === undefined || text.trim() === '') continue;
    const clean = text.trim().slice(0, 500);
    const key = normalize(clean);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const duplicateOf = byText.get(key);
    proposals.push({
      text: clean,
      keys: asKeys(record['keys'] ?? record['keywords']),
      importance: asImportance(record['importance']),
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
    });
    if (proposals.length >= MAX_PROPOSALS) break;
  }
  return proposals;
}

/** 建议落地成记忆的草稿（界面确认后调用 `store.actions.saveMemory`）。 */
export function proposalToDraft(
  proposal: MemoryProposal,
  context: { characterId: string; sessionId: string; messageIds?: readonly string[] },
): {
  characterId: string;
  text: string;
  keys: string[];
  importance: number;
  sourceSessionId: string;
  sourceMessageIds: string[];
  createdBy: 'agent';
} {
  return {
    characterId: context.characterId,
    text: proposal.text,
    keys: proposal.keys,
    importance: proposal.importance,
    sourceSessionId: context.sessionId,
    sourceMessageIds: [...(context.messageIds ?? [])],
    createdBy: 'agent',
  };
}
