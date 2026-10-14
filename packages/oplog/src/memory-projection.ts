import type { Op } from './op.ts';
import type { MemoryAuthor } from './memory-ops.ts';
import { cloneHlc, isNewerThanRecord, type ApplyResult } from './materialize-support.ts';
import type { MemoryRecord, MaterializedState } from './state-types.ts';

/**
 * 长期记忆的物化（纯函数）：与世界书同一套语义——整体 LWW + 墓碑，墓碑与写入共用时间线。
 *
 * 记忆**没有父实体**（不像世界书条目挂在书下面），因此不会出现孤儿：
 * 一条记忆从它出现的时刻起就是完整的。
 */

interface UpsertPayload {
  characterId?: string;
  text: string;
  keys: string[];
  importance: number;
  sourceSessionId?: string;
  sourceMessageIds: string[];
  createdBy: MemoryAuthor;
}

export function applyMemoryUpsert(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as UpsertPayload;
  const id = op.entity.id;
  const existing = state.memories[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.memories[id] = {
    id,
    ...(payload.characterId === undefined || payload.characterId === '' ? {} : { characterId: payload.characterId }),
    text: payload.text,
    keys: [...payload.keys],
    importance: payload.importance,
    ...(payload.sourceSessionId === undefined || payload.sourceSessionId === '' ? {} : { sourceSessionId: payload.sourceSessionId }),
    sourceMessageIds: [...payload.sourceMessageIds],
    createdBy: payload.createdBy,
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  return 'applied';
}

export function applyMemoryDelete(state: MaterializedState, op: Op): ApplyResult {
  const id = op.entity.id;
  const existing = state.memories[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.memories[id] = {
    id,
    ...(existing?.characterId === undefined ? {} : { characterId: existing.characterId }),
    text: existing?.text ?? '',
    keys: existing?.keys ?? [],
    importance: existing?.importance ?? 0,
    ...(existing?.sourceSessionId === undefined ? {} : { sourceSessionId: existing.sourceSessionId }),
    sourceMessageIds: existing?.sourceMessageIds ?? [],
    createdBy: existing?.createdBy ?? 'user',
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
    deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
  };
  return 'applied';
}

/** 全部活着的记忆（界面列表用；顺序由调用方决定）。 */
export function listMemories(state: MaterializedState): MemoryRecord[] {
  return Object.values(state.memories).filter((memory) => memory.deleted === undefined);
}

/**
 * 某个角色能用的记忆：绑定了它的 + 全局的。
 * 与 `lorebooksFor` 同一个思路——检索只看相关的那一批。
 */
export function memoriesFor(state: MaterializedState, characterId: string | undefined): MemoryRecord[] {
  return listMemories(state).filter(
    (memory) => memory.characterId === undefined || (characterId !== undefined && memory.characterId === characterId),
  );
}
