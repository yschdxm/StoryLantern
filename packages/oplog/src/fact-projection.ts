import type { Op } from './op.ts';
import type { FactAuthor, FactState } from './fact-ops.ts';
import { cloneHlc, isNewerThanRecord, type ApplyResult } from './materialize-support.ts';
import type { FactRecord, MaterializedState } from './state-types.ts';

/**
 * 设定库（事实）的物化：整体 LWW + 墓碑，与记忆/世界书同一套语义。
 *
 * 与它们的唯一区别是**字段更多**（三元组 + provenance + 审阅状态），但写入规则完全一样：
 * 更新的 HLC 赢；删除与写入共用同一条时间线（否则乱序时"更旧的删除"会盖掉"更新的编辑"）。
 */

interface UpsertPayload {
  characterId?: string;
  subject: string;
  predicate: string;
  object: string;
  text?: string;
  sourceMessageIds: string[];
  confidence?: number;
  state: FactState;
  createdBy: FactAuthor;
  modelId?: string;
}

export function applyFactUpsert(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as UpsertPayload;
  const id = op.entity.id;
  const existing = state.facts[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.facts[id] = {
    id,
    ...(payload.characterId === undefined || payload.characterId === '' ? {} : { characterId: payload.characterId }),
    subject: payload.subject,
    predicate: payload.predicate,
    object: payload.object,
    text: payload.text ?? `${payload.subject}${payload.predicate}${payload.object}`,
    sourceMessageIds: [...payload.sourceMessageIds],
    ...(payload.confidence === undefined ? {} : { confidence: payload.confidence }),
    state: payload.state,
    createdBy: payload.createdBy,
    ...(payload.modelId === undefined || payload.modelId === '' ? {} : { modelId: payload.modelId }),
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  return 'applied';
}

export function applyFactDelete(state: MaterializedState, op: Op): ApplyResult {
  const id = op.entity.id;
  const existing = state.facts[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.facts[id] = {
    id,
    ...(existing?.characterId === undefined ? {} : { characterId: existing.characterId }),
    subject: existing?.subject ?? '',
    predicate: existing?.predicate ?? '',
    object: existing?.object ?? '',
    text: existing?.text ?? '',
    sourceMessageIds: existing?.sourceMessageIds ?? [],
    ...(existing?.confidence === undefined ? {} : { confidence: existing.confidence }),
    state: existing?.state ?? 'proposed',
    createdBy: existing?.createdBy ?? 'user',
    ...(existing?.modelId === undefined ? {} : { modelId: existing.modelId }),
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
    deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
  };
  return 'applied';
}

/** 全部活着的事实（可按角色与状态筛）。 */
export function listFacts(state: MaterializedState, characterId?: string, factState?: FactState): FactRecord[] {
  return Object.values(state.facts).filter(
    (fact) =>
      fact.deleted === undefined &&
      (characterId === undefined || fact.characterId === undefined || fact.characterId === characterId) &&
      (factState === undefined || fact.state === factState),
  );
}
