import { HlcClock } from '../../../../packages/oplog/src/index.ts';
import type { CharacterRecord, Materializer } from '../../../../packages/oplog/src/index.ts';
import type { MessageAuthor } from '../../../../packages/oplog/src/op.ts';
import type { Character, Message, MessageRole, Session } from './types.ts';

/**
 * 物化状态 → 界面用的领域对象。
 *
 * 这些转换是"读模型"的最后一公里：界面只认 `Character/Session/Message`，
 * 不认 op 里的 HLC/revision。放一起，改一处就够。
 */

export function authorOf(role: MessageRole): MessageAuthor {
  // 应用侧叫 assistant（模型在说话），协议侧叫 character（角色在说话）：同一个东西，两处各用顺手的名字
  if (role === 'assistant') return 'character';
  if (role === 'user') return 'user';
  return 'system';
}

export function roleOf(author: MessageAuthor): MessageRole {
  if (author === 'character') return 'assistant';
  if (author === 'user') return 'user';
  return 'system';
}

export function characterView(record: CharacterRecord): Character {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    personality: record.personality,
    scenario: record.scenario,
    firstMessage: record.firstMessage,
    exampleDialogue: record.exampleDialogue,
    createdAt: record.createdHlc.t,
    updatedAt: record.updatedHlc.t,
  };
}

export function sessionView(materializer: Materializer, sessionId: string): Session | undefined {
  const record = materializer.state.sessions[sessionId];
  if (record === undefined || record.deleted !== undefined) return undefined;
  const character = record.characterId === undefined ? undefined : materializer.state.characters[record.characterId];
  const messages = materializer.orderOf(sessionId);
  const last = messages[messages.length - 1];
  const lastAt = last === undefined ? 0 : last.appendHlc.t;
  return {
    id: record.id,
    title: record.title,
    characterId: record.characterId ?? '',
    characterName: character?.name ?? '',
    createdAt: record.createdHlc.t,
    // "最近活跃"= 标题改动与最后一条消息里较晚的那个
    updatedAt: Math.max(record.titleHlc.t, lastAt),
    messageCount: messages.length,
    lastMessage: last === undefined ? '' : (materializer.textOf(last.id) ?? ''),
  };
}

export function messageView(materializer: Materializer, messageId: string): Message | undefined {
  const record = materializer.state.messages[messageId];
  if (record === undefined || record.deleted !== undefined) return undefined;
  return {
    id: record.id,
    sessionId: record.sessionId,
    role: roleOf(record.author),
    content: materializer.textOf(messageId) ?? '',
    status: materializer.statusOf(messageId) === 'error' ? 'error' : 'done',
    createdAt: record.appendHlc.t,
  };
}

/** 供 migration 用：把旧表的 role 收敛成三种。 */
export function normalizeRole(role: string): MessageRole {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

export type { HlcClock };
