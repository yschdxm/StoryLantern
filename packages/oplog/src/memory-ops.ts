import { createOp, type Op, type StampOptions } from './op.ts';
import type { HlcClock } from './hlc.ts';

/**
 * 长期记忆的 op 构造器与 payload 类型。
 *
 * 单独一个文件，理由与世界书相同：这套字段会随"记忆整理"继续长大，
 * 而 `op.ts` 只该放最核心的东西。
 */

/** 记忆条目：谁写的很重要——用户手写的可信任，agent 建议的应先经确认。 */
export type MemoryAuthor = 'user' | 'agent';

export interface MemoryUpsertPayload {
  memoryId: string;
  /** 绑定的角色；缺省 = 全局。 */
  characterId?: string;
  text: string;
  keys: string[];
  importance: number;
  sourceSessionId?: string;
  sourceMessageIds: string[];
  createdBy: MemoryAuthor;
}

export interface MemoryDeletePayload {
  memoryId: string;
}

export function memoryUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: MemoryUpsertPayload,
  stamp: StampOptions = {},
): Op<MemoryUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'memory.upsert',
    entity: { type: 'memory', id: payload.memoryId },
    payload,
  });
}

export function memoryDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: MemoryDeletePayload,
  stamp: StampOptions = {},
): Op<MemoryDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'memory.delete',
    entity: { type: 'memory', id: payload.memoryId },
    payload,
  });
}
