import type { Op } from './op.ts';
import { cloneHlc, isNewerThanRecord } from './materialize-support.ts';
import type { CharacterRecord, MaterializedState } from './state-types.ts';

/**
 * 角色卡的物化（纯函数，直接改传进来的 state）。
 *
 * 语义：整体覆盖 + LWW，删除是与写入共用时间线的墓碑。
 * 抽成模块级函数是为了让"角色该怎样收敛"只写一份、且能单独测。
 */

interface UpsertPayload {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
}

export function applyCharacterUpsert(state: MaterializedState, op: Op): void {
  const payload = op.payload as UpsertPayload;
  const id = op.entity.id;
  const existing = state.characters[id];

  // 乱序到达的旧写入必须被忽略，否则两台设备的最终状态会不同
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return;

  state.characters[id] = {
    id,
    name: payload.name,
    description: payload.description,
    personality: payload.personality,
    scenario: payload.scenario,
    firstMessage: payload.firstMessage,
    exampleDialogue: payload.exampleDialogue,
    // 复活墓碑时保留最初的创建时间；新角色则用这次写入的时间
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
}

export function applyCharacterDelete(state: MaterializedState, op: Op): void {
  const id = op.entity.id;
  const existing = state.characters[id];

  if (existing === undefined) {
    // 删除一个从没见过的角色 → 也要记成墓碑：别的设备可能还持有这张卡，需要它来收敛
    state.characters[id] = {
      id,
      name: '',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleDialogue: '',
      createdHlc: cloneHlc(op.hlc),
      updatedHlc: cloneHlc(op.hlc),
      opId: op.opId,
      deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
    };
    return;
  }

  // 删除必须比"最近一次写入（upsert 或删除）"更新才生效——更旧的删除直接被忽略
  if (!isNewerThanRecord(op, existing)) return;
  existing.deleted = { hlc: cloneHlc(op.hlc), opId: op.opId };
}

/** 界面用的角色列表：按最后更新时间倒序，墓碑不出现在结果里。 */
export function listCharacters(state: MaterializedState): CharacterRecord[] {
  return Object.values(state.characters)
    .filter((character) => character.deleted === undefined)
    .sort((a, b) => {
      if (a.updatedHlc.t !== b.updatedHlc.t) return b.updatedHlc.t - a.updatedHlc.t;
      if (a.updatedHlc.c !== b.updatedHlc.c) return b.updatedHlc.c - a.updatedHlc.c;
      return b.opId.localeCompare(a.opId);
    });
}
