import { createOp, type Op, type StampOptions } from './op.ts';
import type { HlcClock } from './hlc.ts';

/**
 * 世界书（lorebook）的 op 构造器与 payload 类型。
 *
 * 单独一个文件是因为 `op.ts` 已经接近行数上限，而且世界书这套字段会随
 * "lore 自动维护"继续长大——它值得自己一块地方。
 *
 * 书与条目分成两种 op：书级信息（名字、绑定角色）改动很少，
 * 而条目会被自动维护逐条增改；只能整本覆盖写的话，
 * 两个人同时改同一本书的不同条目就会互相覆盖。
 */

export interface LorebookUpsertPayload {
  lorebookId: string;
  name: string;
  description: string;
  /** 绑定到哪些角色；空表示全局（所有角色共用）。 */
  characterIds: string[];
  enabled: boolean;
}

export interface LorebookDeletePayload {
  lorebookId: string;
}

export interface LoreEntryUpsertPayload {
  lorebookId: string;
  entryId: string;
  /** 主关键词：命中任意一个即可（不分大小写时按小写比较）。 */
  keys: string[];
  /** 次级关键词：非空时要求**也**命中至少一个（SillyTavern 的 selective 语义）。 */
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  /** 插入顺序：越小越靠前。 */
  order: number;
  caseSensitive: boolean;
  /** 允许被其它条目的内容再次触发（递归扫描）。 */
  recursive: boolean;
  /** 只在最近 N 条消息里找关键词；0 表示用调用方给的默认深度。 */
  depth: number;
  /** 常量条目：不问关键词，只要书激活就注入。 */
  constant: boolean;
  /** 条目备注（SillyTavern 的 comment）。设定库导出的条目把 provenance 与审阅状态放这里。 */
  comment?: string;
}

export interface LoreEntryDeletePayload {
  lorebookId: string;
  entryId: string;
}

export function lorebookUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: LorebookUpsertPayload,
  stamp: StampOptions = {},
): Op<LorebookUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'lorebook.upsert',
    entity: { type: 'lorebook', id: payload.lorebookId },
    payload,
  });
}

export function lorebookDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: LorebookDeletePayload,
  stamp: StampOptions = {},
): Op<LorebookDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'lorebook.delete',
    entity: { type: 'lorebook', id: payload.lorebookId },
    payload,
  });
}

export function loreEntryUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: LoreEntryUpsertPayload,
  stamp: StampOptions = {},
): Op<LoreEntryUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'lore.entry.upsert',
    entity: { type: 'lore.entry', id: payload.entryId },
    payload,
  });
}

export function loreEntryDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: LoreEntryDeletePayload,
  stamp: StampOptions = {},
): Op<LoreEntryDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'lore.entry.delete',
    entity: { type: 'lore.entry', id: payload.entryId },
    payload,
  });
}
