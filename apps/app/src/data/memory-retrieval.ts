import { scanLore, type ScanBook, type ScoredEntry } from '../../../../packages/lore/src/index.ts';
import type { Memory, MessageRole } from './types.ts';

/**
 * 长期记忆的检索。
 *
 * 刻意**复用世界书的扫描器**：两者都是"关键词命中 → 按优先级/重要度排序 → 预算裁剪"，
 * 差别只在字段名。于是深度窗口、递归、预算、确定性这些规则只有一份实现、一份测试。
 *
 * 映射关系：
 *  - 记忆的 `keys` → 关键词；
 *  - 记忆的 `importance`（0-100，越大越重要）→ 扫描器的 `order`（越小越先）；
 *  - 记忆正文 → 条目正文；
 *  - 记忆**不参与递归**（`recursive: false`）：检索结果不该互相触发，否则"记忆会自己长大"。
 */

/** 记忆 → 扫描器认识的"书"。返回的 bookId 里带着来源，便于把命中映射回记忆。 */
export function memoriesAsBook(memories: readonly Memory[]): ScanBook | undefined {
  const usable = memories.filter((memory) => memory.text.trim() !== '');
  if (usable.length === 0) return undefined;
  return {
    id: 'memory',
    name: '长期记忆',
    enabled: true,
    entries: usable.map((memory) => ({
      id: memory.id,
      keys: memory.keys,
      content: memory.text,
      enabled: true,
      // 重要度越高越靠前：0-100 反过来当 order 用
      order: 100 - Math.max(0, Math.min(100, memory.importance)),
      caseSensitive: false,
      recursive: false,
      depth: 0,
      constant: memory.keys.length === 0,
    })),
  };
}

export interface RetrievedMemory {
  memory: Memory;
  /** 命中的关键词（常量记忆为空）。 */
  matchedKeys: string[];
  reason: ScoredEntry['reason'];
}

export interface MemoryRetrieval {
  matched: RetrievedMemory[];
  /** 命中但被预算挤掉的（界面可以提示"还有 N 条没放下"）。 */
  dropped: RetrievedMemory[];
  charsUsed: number;
}

/**
 * 检索：只看最近这段对话里出现过关键词的记忆，外加"没写关键词"的常量记忆。
 *
 * 为什么要常量记忆：有些事必须永远在场（例如"用户明确要求不要写死亡结局"），
 * 不该依赖关键词恰好被提到。
 */
export function selectMemories(options: {
  memories: readonly Memory[];
  messages: ReadonlyArray<{ role: MessageRole; content: string }>;
  budgetChars?: number;
}): MemoryRetrieval {
  const book = memoriesAsBook(options.memories);
  if (book === undefined) return { matched: [], dropped: [], charsUsed: 0 };

  const result = scanLore({
    books: [book],
    messages: options.messages.map((message) => ({ role: message.role, content: message.content })),
    ...(options.budgetChars === undefined ? {} : { budgetChars: options.budgetChars }),
  });

  const byId = new Map(options.memories.map((memory) => [memory.id, memory]));
  const convert = (entry: ScoredEntry): RetrievedMemory | undefined => {
    const memory = byId.get(entry.entryId);
    return memory === undefined ? undefined : { memory, matchedKeys: entry.matchedKeys, reason: entry.reason };
  };

  return {
    matched: result.matched.map(convert).filter((item): item is RetrievedMemory => item !== undefined),
    dropped: result.dropped.map(convert).filter((item): item is RetrievedMemory => item !== undefined),
    charsUsed: result.charsUsed,
  };
}

/** 拼成注入用的文本块（顺序即最终顺序）。 */
export function formatMemoryBlock(memories: readonly RetrievedMemory[]): string {
  if (memories.length === 0) return '';
  return `【长期记忆】\n${memories.map((item) => `- ${item.memory.text.trim()}`).join('\n')}`;
}
