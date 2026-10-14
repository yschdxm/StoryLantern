import {
  characterUpsert,
  messageAppend,
  sessionCreate,
  ulid,
  type HlcClock,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import type { LegacyDump } from './op-types.ts';
import { authorOf, normalizeRole } from './op-views.ts';

/**
 * 旧表（M1 之前的直写表）→ op。
 *
 * 这是一次性迁移：把已经存在的角色/会话/消息"补写"成 op，时间戳沿用旧记录，
 * 因此迁移后聊天里的时间、列表顺序都和原来一致。之后旧表就只是历史包袱。
 *
 * 两个刻意的细节：
 *  - 角色先写"创建"再写"更新"（createdAt ≠ updatedAt 时）：
 *    否则 createdHlc 会等于 updatedHlc，"创建时间"就丢了；
 *  - 旧表里的孤儿会话（所属角色已删）照样保留，只是没有 characterId。
 */

export function opsFromLegacy(
  dump: LegacyDump,
  base: () => { deviceId: string; clock: HlcClock },
  now: () => number = () => Date.now(),
): Op[] {
  const characterIds = new Map<string, string>();
  const sessionIds = new Map<string, string>();
  const ops: Op[] = [];

  for (const character of dump.characters) {
    const id = ulid();
    characterIds.set(String(character.id), id);
    const fields = {
      characterId: id,
      name: character.name,
      description: character.description ?? '',
      personality: character.personality ?? '',
      scenario: character.scenario ?? '',
      firstMessage: character.firstMessage ?? '',
      exampleDialogue: character.exampleDialogue ?? '',
    };
    const createdAt = character.createdAt ?? character.updatedAt ?? now();
    ops.push(characterUpsert(base(), fields, { hlc: { t: createdAt, c: 0 } }));
    const updatedAt = character.updatedAt ?? createdAt;
    if (updatedAt > createdAt) ops.push(characterUpsert(base(), fields, { hlc: { t: updatedAt, c: 0 } }));
  }

  for (const session of dump.sessions) {
    const id = ulid();
    sessionIds.set(String(session.id), id);
    const characterId = characterIds.get(String(session.characterId));
    ops.push(
      sessionCreate(
        base(),
        characterId === undefined ? { sessionId: id, title: session.title } : { sessionId: id, title: session.title, characterId },
        { hlc: { t: session.createdAt ?? now(), c: 0 } },
      ),
    );
  }

  for (const message of dump.messages) {
    const sessionId = sessionIds.get(String(message.sessionId));
    if (sessionId === undefined) continue;
    ops.push(
      messageAppend(
        base(),
        {
          sessionId,
          messageId: ulid(),
          author: authorOf(normalizeRole(message.role)),
          content: message.content,
          ...(message.status === 'error' ? { status: 'error' as const } : {}),
        },
        { hlc: { t: message.createdAt ?? now(), c: 0 } },
      ),
    );
  }

  return ops;
}
