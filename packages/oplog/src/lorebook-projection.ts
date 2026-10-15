import type { Op } from './op.ts';
import { cloneHlc, isNewerThanRecord, type ApplyResult } from './materialize-support.ts';
import type { LoreEntryRecord, LorebookRecord, MaterializedState } from './state-types.ts';

/**
 * 世界书的物化（纯函数）。
 *
 * 两级结构，两级都独立收敛：
 *  - **书**：名字、绑定角色、启用开关（整体覆盖 + LWW）；
 *  - **条目**：关键词、正文、优先级、递归/常量等（整体覆盖 + LWW）。
 * 条目挂在书的下面，因此书的删除天然把条目一起带走（不必逐条写 op）。
 */

interface BookUpsertPayload {
  name: string;
  description: string;
  characterIds: string[];
  enabled: boolean;
}

interface EntryUpsertPayload {
  lorebookId: string;
  entryId: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  order: number;
  caseSensitive: boolean;
  recursive: boolean;
  depth: number;
  constant: boolean;
  comment?: string;
}

export function applyLorebookUpsert(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as BookUpsertPayload;
  const id = op.entity.id;
  const existing = state.lorebooks[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.lorebooks[id] = {
    id,
    name: payload.name,
    description: payload.description,
    characterIds: [...payload.characterIds],
    enabled: payload.enabled,
    // 更新书级信息不该丢掉条目：条目有自己的时间线
    entries: existing?.entries ?? {},
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  return 'applied';
}

export function applyLorebookDelete(state: MaterializedState, op: Op): ApplyResult {
  const id = op.entity.id;
  const existing = state.lorebooks[id];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  state.lorebooks[id] = {
    id,
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    characterIds: existing?.characterIds ?? [],
    enabled: false,
    entries: existing?.entries ?? {},
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
    deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
  };
  return 'applied';
}

export function applyLoreEntryUpsert(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as EntryUpsertPayload;
  const book = state.lorebooks[payload.lorebookId];
  // 书还没到（乱序）：当成孤儿，等书到了再重放这条 op
  if (book === undefined || book.deleted !== undefined) return 'orphan';

  const existing = book.entries[payload.entryId];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  book.entries[payload.entryId] = {
    id: payload.entryId,
    keys: [...payload.keys],
    secondaryKeys: [...payload.secondaryKeys],
    content: payload.content,
    enabled: payload.enabled,
    order: payload.order,
    caseSensitive: payload.caseSensitive,
    recursive: payload.recursive,
    depth: payload.depth,
    constant: payload.constant,
    // 旧 op 没有这个字段：按空字符串读，不是"丢了"
    comment: payload.comment ?? '',
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
  };
  return 'applied';
}

export function applyLoreEntryDelete(state: MaterializedState, op: Op): ApplyResult {
  const payload = op.payload as { lorebookId: string; entryId: string };
  const book = state.lorebooks[payload.lorebookId];
  if (book === undefined || book.deleted !== undefined) return 'orphan';

  const existing = book.entries[payload.entryId];
  if (existing !== undefined && !isNewerThanRecord(op, existing)) return 'duplicate';

  book.entries[payload.entryId] = {
    id: payload.entryId,
    keys: existing?.keys ?? [],
    secondaryKeys: existing?.secondaryKeys ?? [],
    content: existing?.content ?? '',
    enabled: false,
    order: existing?.order ?? 100,
    caseSensitive: existing?.caseSensitive ?? false,
    recursive: existing?.recursive ?? true,
    depth: existing?.depth ?? 0,
    constant: existing?.constant ?? false,
    comment: existing?.comment ?? '',
    createdHlc: existing === undefined ? cloneHlc(op.hlc) : cloneHlc(existing.createdHlc),
    updatedHlc: cloneHlc(op.hlc),
    opId: op.opId,
    deleted: { hlc: cloneHlc(op.hlc), opId: op.opId },
  };
  return 'applied';
}

/** 界面用的世界书列表：按最后更新时间倒序，墓碑不出现。 */
export function listLorebooks(state: MaterializedState): LorebookRecord[] {
  return Object.values(state.lorebooks)
    .filter((book) => book.deleted === undefined)
    .sort((a, b) => {
      if (a.updatedHlc.t !== b.updatedHlc.t) return b.updatedHlc.t - a.updatedHlc.t;
      if (a.updatedHlc.c !== b.updatedHlc.c) return b.updatedHlc.c - a.updatedHlc.c;
      return b.opId.localeCompare(a.opId);
    });
}

/** 某本书里活着的条目，按 order 升序（同一 order 用 id 保证确定性）。 */
export function listLoreEntries(book: LorebookRecord): LoreEntryRecord[] {
  return Object.values(book.entries)
    .filter((entry) => entry.deleted === undefined)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
