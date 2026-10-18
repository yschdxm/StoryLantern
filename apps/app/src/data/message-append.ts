/**
 * 追加消息时把 `meta` 放进**正确的位置参数**。
 *
 * 为什么单独一个函数：`MessageStore.append(sessionId, role, content, status?, createdAt?, meta?)`
 * 是位置参数；`createdAt` 省略而 `meta` 存在时，直接展开会把 `meta` 挤到 `createdAt` 位
 * （真机上表现为消息时间显示 `NaN`、思考链/引用全部丢失）。这里把"补时间戳"收口一处。
 */

import type { MessageStore } from './repository.ts';
import type { Message, MessageMeta, MessageStatus, MessageTokens } from './types.ts';

/** 接口回来的真实用量（字段可选：有的端点只给一部分）。 */
export interface RealUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * `meta.tokens` 的取值：**有真实 usage 用真实的（estimated:false），没有才本地估算（estimated:true）**。
 *
 * 只给了一半真实值时，缺的那半**不瞎补**、直接省略——宁可少一个数，也不把估算冒充成接口值。
 */
export function tokensMetaOf(
  usage: RealUsage | undefined,
  estimatedPrompt: number,
  estimatedCompletion: number,
): MessageTokens {
  if (usage !== undefined && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)) {
    return {
      ...(usage.promptTokens === undefined ? {} : { prompt: usage.promptTokens }),
      ...(usage.completionTokens === undefined ? {} : { completion: usage.completionTokens }),
      estimated: false,
    };
  }
  return {
    ...(estimatedPrompt > 0 ? { prompt: estimatedPrompt } : {}),
    completion: estimatedCompletion,
    estimated: true,
  };
}

export interface AppendMessageOptions {
  status?: MessageStatus;
  createdAt?: number;
  meta?: MessageMeta;
}

export async function appendMessageWithMeta(
  messages: MessageStore,
  sessionId: string,
  role: Message['role'],
  content: string,
  options: AppendMessageOptions,
  meta?: MessageMeta,
): Promise<Message> {
  const messageMeta = meta ?? options.meta;
  if (messageMeta === undefined) {
    return messages.append(
      sessionId,
      role,
      content,
      options.status ?? 'done',
      ...(options.createdAt === undefined ? [] : [options.createdAt]),
    );
  }
  // meta 在最后一位：createdAt 必须显式占位（缺失就补当前时间，语义与仓储默认一致）
  return messages.append(sessionId, role, content, options.status ?? 'done', options.createdAt ?? Date.now(), messageMeta);
}
