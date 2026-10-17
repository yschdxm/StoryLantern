/**
 * 卡片模型的 op 定义（ADR-0011）：`card.*` / `session.setup` / `runtime.patch` / `pack.*` / `stash.*`。
 *
 * 为什么**一卡一条 op**而不是每类卡一套 op：
 *  - 四种卡片共享同一个基座（`meta`/`brief`/`visuals`/`refs`/`agent`/`compat`），存储层不需要知道差异；
 *  - 校验在 `packages/cards` 里按 `card_type` 分派，日志层只保证"文档完整、幂等、可收敛"；
 *  - 将来加 `event` / `faction` 卡（设计文档第二版）时，**不用再加 op 类型**。
 *
 * 冲突语义：卡片是**整文档 LWW**（与旧 `character.upsert` 一致）。两台设备同时改同一张卡，
 * HLC 大的整份胜出——这是有意的取舍：卡片是文档，字段级合并需要每类卡各自的语义，
 * 而现在没有证据表明它值得这份复杂度（真正需要细粒度合并的是消息，那已经有 revision）。
 *
 * `runtime.patch` 用的是**补丁序列**而不是 LWW：变量增量（好感 +5）被覆盖会丢数据。
 * 读取方按 HLC 全序重放补丁得到当前值；因此乱序到达也收敛（见 `runtime-derive.ts`）。
 */

import type { CardDocument, CompatStashEntry, RuntimePatchPayload, SessionSetup, WorldPackManifest } from '../../cards/src/index.ts';
import type { HlcClock } from './hlc.ts';
import { createOp, type Op, type StampOptions } from './op.ts';

/** 构造器共用的入参（deviceId + 时钟）。 */
export interface OpBase {
  deviceId: string;
  clock: HlcClock;
}

export interface CardUpsertPayload {
  /** 完整卡片文档（校验与 schema 版本由 `packages/cards` 负责）。 */
  card: CardDocument;
}

export interface CardDeletePayload {
  card_id: string;
}

/**
 * 卡片库级启停（退役/草稿）。与卡片内容分开存：
 * 导出/分享卡片时不该带走"我这台设备把它停用了"这种库状态。
 */
export interface CardLibraryPayload {
  card_id: string;
  enabled: boolean;
}

export interface SessionSetupPayload {
  session_id: string;
  setup: SessionSetup;
}

export interface PackUpsertPayload {
  pack: WorldPackManifest;
}

export interface PackDeletePayload {
  pack_id: string;
}

export interface StashUpsertPayload {
  entry: CompatStashEntry;
}

export interface StashDeletePayload {
  stash_id: string;
}

export function cardUpsert(base: OpBase, payload: CardUpsertPayload, stamp: StampOptions = {}): Op<CardUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'card.upsert',
    entity: { type: 'card', id: payload.card.meta.id },
    payload,
  });
}

export function cardDelete(base: OpBase, payload: CardDeletePayload, stamp: StampOptions = {}): Op<CardDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'card.delete',
    entity: { type: 'card', id: payload.card_id },
    payload,
  });
}

export function cardLibrary(base: OpBase, payload: CardLibraryPayload, stamp: StampOptions = {}): Op<CardLibraryPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'card.library',
    entity: { type: 'card', id: payload.card_id },
    payload,
  });
}

export function sessionSetup(base: OpBase, payload: SessionSetupPayload, stamp: StampOptions = {}): Op<SessionSetupPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'session.setup',
    entity: { type: 'session', id: payload.session_id },
    payload,
  });
}

export function runtimePatch(base: OpBase, payload: RuntimePatchPayload): Op<RuntimePatchPayload> {
  return createOp({
    ...base,
    type: 'runtime.patch',
    entity: { type: 'session', id: payload.session_id },
    payload,
  });
}

export function packUpsert(base: OpBase, payload: PackUpsertPayload, stamp: StampOptions = {}): Op<PackUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'pack.upsert',
    entity: { type: 'pack', id: payload.pack.id },
    payload,
  });
}

export function packDelete(base: OpBase, payload: PackDeletePayload, stamp: StampOptions = {}): Op<PackDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'pack.delete',
    entity: { type: 'pack', id: payload.pack_id },
    payload,
  });
}

export function stashUpsert(base: OpBase, payload: StashUpsertPayload, stamp: StampOptions = {}): Op<StashUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'stash.upsert',
    entity: { type: 'stash', id: payload.entry.id },
    payload,
  });
}

export function stashDelete(base: OpBase, payload: StashDeletePayload, stamp: StampOptions = {}): Op<StashDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'stash.delete',
    entity: { type: 'stash', id: payload.stash_id },
    payload,
  });
}
