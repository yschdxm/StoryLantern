/**
 * 历史消息 → 发给模型的 messages / 引用窗口 / 概率种子。
 * 从 `prompt-v2.ts` 抽出（那个文件在 400 行门禁边缘），逻辑仍是纯函数。
 */

import { formatNumbered, stripCitationMarkers } from './citations.ts';
import { expandMacros } from './macros.ts';
import type { PromptBlockDataV2 } from './prompt-blocks-v2.ts';
import type { ChatPromptMessage, PromptHistoryItem } from './tokens.ts';

export function toMessages(kept: readonly PromptHistoryItem[], cite: boolean): ChatPromptMessage[] {
  return kept.map((item, index) => ({
    role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system',
    // 编号前先去掉旧回复里已有的引用标记：否则 `[16]` 会被再编号成 `[2] [16]`，模型会把旧编号当新窗口。
    // 扫描用的 history 仍是原文（见 data.history）。
    content: cite ? formatNumbered(stripCitationMarkers(item.content), index + 1) : item.content,
  }));
}

/** 引用窗口：与 messages 顺序一致；没有 id 的消息留 undefined（不伪造 id）。 */
export function citationWindowOf(kept: readonly PromptHistoryItem[]): (string | undefined)[] {
  return kept.map((item) => (typeof item.id === 'string' && item.id !== '' ? item.id : undefined));
}

/** 概率判定的种子：优先用最后一条历史消息的 id；没有 id 时退化为 `role:content`（跨设备稳定）。 */
export function lastMessageKeyOf(kept: readonly PromptHistoryItem[]): string {
  const last = kept[kept.length - 1];
  if (last === undefined) return '';
  return typeof last.id === 'string' && last.id !== '' ? last.id : `${last.role}:${last.content}`;
}

/**
 * post-history 指令：**会话成员**（不含不在场的卡）按 setup 顺序拼接，空串跳过。
 * 作者文本里的 `{{char}}`/`{{user}}` 在这里展开（用户输入/历史不展开）。
 * 它不进 systemPrompt 的块预算，由调用方作为对话末尾的指令发出去（`ChatCall.postHistory`）。
 */
export function postHistoryOf(data: PromptBlockDataV2): string | undefined {
  const parts = data.world.members
    .map((character) => expandMacros(character.prompts?.post_history_instructions ?? '', data.macros).trim())
    .filter((text) => text !== '');
  return parts.length === 0 ? undefined : parts.join('\n');
}
