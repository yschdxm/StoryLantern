/**
 * 卡片模型的物化（纯函数，直接改传进来的 state）。
 *
 * 语义与旧角色卡一致：整文档 LWW + 墓碑（删除与写入共用一条时间线），
 * 因此"先收到更新、后收到创建"也能收敛（`isNewerThanRecord` 只看 HLC）。
 *
 * 会话开局配置（`session.setup`）与卡片的区别：它**没有墓碑**——会话被删时由
 * `session.delete` 处理，setup 只是附着在会话上的文档。
 */

import type { Op } from './op.ts';
import type {
  CardDeletePayload,
  CardLibraryPayload,
  CardUpsertPayload,
  PackDeletePayload,
  PackUpsertPayload,
  SessionSetupPayload,
  StashDeletePayload,
  StashUpsertPayload,
} from './card-ops.ts';
import { cloneHlc, isNewerThanRecord } from './materialize-support.ts';
import { applyRuntimePatch } from './runtime-projection.ts';
import type { CardType } from '../../cards/src/index.ts';
import type { CardRecord, MaterializedState, PackRecord, SetupRecord, StashRecord } from './state-types.ts';

// ---------------------------------------------------------------- 卡片

export function applyCardUpsert(state: MaterializedState, op: Op): void {
  const payload = op.payload as CardUpsertPayload;
  const card = payload.card;
  const id = card.meta.id;
  const existing = state.cards[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return;
  const record: CardRecord = {
    id,
    card,
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  state.cards[id] = record;
}

export function applyCardDelete(state: MaterializedState, op: Op): void {
  const payload = op.payload as CardDeletePayload;
  const id = payload.card_id;
  const existing = state.cards[id];
  if (existing === undefined) {
    // 删除一台设备还没见过的卡：也要留墓碑，否则对端把它的 upsert 推过来就"复活"了
    state.cards[id] = {
      id,
      card: deletedPlaceholder(id),
      createdHlc: cloneHlc(op.hlc),
      updatedHlc: cloneHlc(op.hlc),
      opId: op.opId,
      deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
    };
    return;
  }
  if (!isNewerThanRecord(op, existing)) return;
  existing.deleted = { hlc: cloneHlc(op.hlc), opId: op.opId };
}

/**
 * 墓碑占位卡：`card` 字段类型要求一个文档，但墓碑不会出现在任何读接口里。
 * 用最小合法结构，避免 `undefined` 让下游做空判。
 */
function deletedPlaceholder(id: string): CardRecord['card'] {
  return {
    card_type: 'lore',
    meta: {
      id,
      schema: 'lore/v1',
      name: '',
      version: '0.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: '',
    },
    kind: 'other',
    content: '',
    keys: [],
  };
}

/** 未删除的卡片，按"最近更新"倒序（列表页顺序）。 */
export function listCards(state: MaterializedState, type?: CardType): CardRecord[] {
  return Object.values(state.cards)
    .filter((record) => record.deleted === undefined)
    .filter((record) => (type === undefined ? true : record.card.card_type === type))
    .sort((a, b) => {
      if (a.updatedHlc.t !== b.updatedHlc.t) return b.updatedHlc.t - a.updatedHlc.t;
      if (a.updatedHlc.c !== b.updatedHlc.c) return b.updatedHlc.c - a.updatedHlc.c;
      return b.opId.localeCompare(a.opId);
    });
}

export function liveCard(state: MaterializedState, id: string): CardRecord | undefined {
  const record = state.cards[id];
  return record === undefined || record.deleted !== undefined ? undefined : record;
}

// ---------------------------------------------------------------- 会话开局配置

export function applySessionSetup(state: MaterializedState, op: Op): void {
  const payload = op.payload as SessionSetupPayload;
  const existing = state.setups[payload.session_id];
  if (existing !== undefined && !laterThanRecord(op, existing)) return;
  state.setups[payload.session_id] = {
    sessionId: payload.session_id,
    setup: payload.setup,
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
}

function laterThanRecord(op: Op, record: { updatedHlc: SetupRecord['updatedHlc']; opId: string }): boolean {
  return isNewerThanRecord(op, { updatedHlc: record.updatedHlc, opId: record.opId });
}

// ---------------------------------------------------------------- 世界包

export function applyPackUpsert(state: MaterializedState, op: Op): void {
  const payload = op.payload as PackUpsertPayload;
  const id = payload.pack.id;
  const existing = state.packs[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return;
  const record: PackRecord = {
    id,
    pack: payload.pack,
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  state.packs[id] = record;
}

export function applyPackDelete(state: MaterializedState, op: Op): void {
  const payload = op.payload as PackDeletePayload;
  const id = payload.pack_id;
  const existing = state.packs[id];
  if (existing === undefined) {
    state.packs[id] = {
      id,
      pack: { schema: 'worldpack/v1', id, name: '', version: '0.0.0', language: 'zh-CN', card_ids: [] },
      createdHlc: cloneHlc(op.hlc),
      updatedHlc: cloneHlc(op.hlc),
      opId: op.opId,
      deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
    };
    return;
  }
  if (!isNewerThanRecord(op, existing)) return;
  existing.deleted = { hlc: cloneHlc(op.hlc), opId: op.opId };
}

export function listPacks(state: MaterializedState): PackRecord[] {
  return Object.values(state.packs)
    .filter((record) => record.deleted === undefined)
    .sort((a, b) => b.updatedHlc.t - a.updatedHlc.t || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- 兼容草稿

export function applyStashUpsert(state: MaterializedState, op: Op): void {
  const payload = op.payload as StashUpsertPayload;
  const id = payload.entry.id;
  const existing = state.stash[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return;
  const record: StashRecord = {
    id,
    entry: payload.entry,
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  state.stash[id] = record;
}

export function applyStashDelete(state: MaterializedState, op: Op): void {
  const payload = op.payload as StashDeletePayload;
  const existing = state.stash[payload.stash_id];
  if (existing === undefined || !isNewerThanRecord(op, existing)) return;
  existing.deleted = { hlc: cloneHlc(op.hlc), opId: op.opId };
}

export function liveStash(state: MaterializedState): StashRecord[] {
  return Object.values(state.stash)
    .filter((record) => record.deleted === undefined)
    .sort((a, b) => a.createdHlc.t - b.createdHlc.t || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- 卡片库启停

/**
 * 库级启停：与卡片内容分开存（导出/分享卡片不带别人的停用状态）。
 * 用独立的 HLC 比较，因此"停用 op 先到、卡片后到"也不会丢。
 */
export function applyCardLibrary(state: MaterializedState, op: Op): void {
  const payload = op.payload as CardLibraryPayload;
  if (typeof payload.card_id !== 'string' || payload.card_id === '') return;
  const existing = state.cardLibrary[payload.card_id];
  const newer =
    existing === undefined ||
    laterThanRecord(op, { updatedHlc: existing.hlc, opId: existing.opId });
  if (!newer) return;
  state.cardLibrary[payload.card_id] = {
    cardId: payload.card_id,
    enabled: payload.enabled !== false,
    hlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
}

/** 这张卡是否在库里启用（没记录 = 启用，与"缺省视为启用"一致）。 */
export function isCardLibraryEnabled(state: MaterializedState, cardId: string): boolean {
  return state.cardLibrary[cardId]?.enabled ?? true;
}

// ---------------------------------------------------------------- 卡片模型 op 的统一入口

/** 卡片模型那 9 类 op：由 `Materializer` 统一交给 `applyCardModelOp` 处理。 */
export function isCardModelOp(type: Op['type']): boolean {
  return (
    type === 'card.upsert' ||
    type === 'card.delete' ||
    type === 'card.library' ||
    type === 'session.setup' ||
    type === 'runtime.patch' ||
    type === 'pack.upsert' ||
    type === 'pack.delete' ||
    type === 'stash.upsert' ||
    type === 'stash.delete'
  );
}

export function applyCardModelOp(state: MaterializedState, op: Op): void {
  switch (op.type) {
    case 'card.upsert':
      applyCardUpsert(state, op);
      return;
    case 'card.delete':
      applyCardDelete(state, op);
      return;
    case 'card.library':
      applyCardLibrary(state, op);
      return;
    case 'session.setup':
      applySessionSetup(state, op);
      return;
    case 'runtime.patch':
      applyRuntimePatch(state, op);
      return;
    case 'pack.upsert':
      applyPackUpsert(state, op);
      return;
    case 'pack.delete':
      applyPackDelete(state, op);
      return;
    case 'stash.upsert':
      applyStashUpsert(state, op);
      return;
    case 'stash.delete':
      applyStashDelete(state, op);
      return;
    default:
      // 非卡片模型的 op 不该走到这里（isCardModelOp 已经筛过）；防御性忽略，绝不崩
      return;
  }
}

/** 会话开局配置（自由函数版本，避免 `Materializer` 类继续变长）。 */
export function setupOf(state: MaterializedState, sessionId: string): SetupRecord | undefined {
  return state.setups[sessionId];
}
