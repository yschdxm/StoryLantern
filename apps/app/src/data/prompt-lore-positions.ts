/**
 * 典籍注入位置（B2/B19）：位置 → 系统块优先级，以及 `position=4` 的 @depth 消息插入。
 *
 * 自有语义（不冒充 ST 原生）：
 *  0 before character 96、1 after character 94、2 before scene 89、3 after scene 87、
 *  5 before examples 85、6 after examples 83。未设 position 仍走旧 `app.lore.matched`（78）。
 * `position=4` 不占 system 预算，作为 `role:"system"` 消息插入（从末尾数 depth 条之前；depth<=0=最后）。
 */

import type { ChatPromptMessage } from './tokens.ts';

export const LORE_POSITION_PRIORITIES: ReadonlyArray<readonly [0 | 1 | 2 | 3 | 5 | 6, number]> = [
  [0, 96],
  [1, 94],
  [2, 89],
  [3, 87],
  [5, 85],
  [6, 83],
];

export interface LoreAtDepthEntry {
  id: string;
  text: string;
  /** 从末尾数第 depth 条之前插入；`<=0` = 最后。 */
  depth: number;
}

export interface LoreDepthInsertion {
  messages: ChatPromptMessage[];
  citationWindow: (string | undefined)[];
  injected: number;
}

/** 把 @depth 典籍插入 messages（引用窗口同步补 `undefined`，保持 1:1 对齐）。 */
export function insertLoreAtDepth(
  messages: readonly ChatPromptMessage[],
  citationWindow: readonly (string | undefined)[],
  entries: readonly LoreAtDepthEntry[],
): LoreDepthInsertion {
  if (entries.length === 0) {
    return { messages: [...messages], citationWindow: [...citationWindow], injected: 0 };
  }
  const length = messages.length;
  const buckets = new Map<number, LoreAtDepthEntry[]>();
  // 同一位置按 id 排序：确定性，与卡片输入顺序无关
  for (const entry of [...entries].sort((left, right) => left.id.localeCompare(right.id) || left.depth - right.depth)) {
    const index = Math.max(0, length - Math.max(0, Math.floor(entry.depth)));
    const list = buckets.get(index);
    if (list === undefined) buckets.set(index, [entry]);
    else list.push(entry);
  }
  const outMessages: ChatPromptMessage[] = [];
  const outWindow: (string | undefined)[] = [];
  for (let index = 0; index <= length; index += 1) {
    for (const entry of buckets.get(index) ?? []) {
      outMessages.push({ role: 'system', content: entry.text });
      outWindow.push(undefined);
    }
    if (index < length) {
      outMessages.push(messages[index] as ChatPromptMessage);
      outWindow.push(citationWindow[index]);
    }
  }
  return { messages: outMessages, citationWindow: outWindow, injected: entries.length };
}
