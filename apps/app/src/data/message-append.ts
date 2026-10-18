/**
 * 追加消息时把 `meta` 放进**正确的位置参数**。
 *
 * 为什么单独一个函数：`MessageStore.append(sessionId, role, content, status?, createdAt?, meta?)`
 * 是位置参数；`createdAt` 省略而 `meta` 存在时，直接展开会把 `meta` 挤到 `createdAt` 位
 * （真机上表现为消息时间显示 `NaN`、思考链/引用全部丢失）。这里把"补时间戳"收口一处。
 */

import type { MessageStore } from './repository.ts';
import type { Message, MessageMeta, MessageStatus } from './types.ts';

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
