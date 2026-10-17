/**
 * token 粗估与「发给模型的对话消息」的最小类型。
 *
 * 这些原本住在旧提示词实现 `data/prompt.ts` 里；旧实现删除后，聊天页、摘要、评估仍需要它们，
 * 因此单独成文件（**不依赖任何提示词实现**，只依赖领域类型）。
 */

import type { MessageRole } from './types.ts';

export interface ChatPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PromptHistoryItem {
  role: MessageRole;
  content: string;
  status?: 'done' | 'streaming' | 'error';
}

/** 粗估 token：中文约 1 token/字，英文约 1 token/4 字符（与管线里的实现必须一致，有测试盯着）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
