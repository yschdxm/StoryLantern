import { ulid } from './bytes.ts';
import { HlcClock, type Hlc } from './hlc.ts';

export const OP_SCHEMA_VERSION = 1;

export type MessageAuthor = 'user' | 'character' | 'system' | 'narrator';

export type OpType =
  | 'character.upsert'
  | 'character.delete'
  | 'session.create'
  | 'session.delete'
  | 'message.append'
  | 'message.edit'
  | 'message.revision.select'
  | 'message.candidate.append'
  | 'message.candidate.select'
  | 'message.delete'
  | 'setting.set'
  | 'lorebook.upsert'
  | 'lorebook.delete'
  | 'lore.entry.upsert'
  | 'lore.entry.delete'
  | 'memory.upsert'
  | 'memory.delete'
  | 'summary.upsert'
  | 'summary.delete'
  | 'fact.upsert'
  | 'fact.delete'
  | 'log.checkpoint';

/** 角色卡字段：整体覆盖写入（LWW 由 op 的 HLC 决定）。id 放在 entity 里，不重复进 payload。 */
export interface CharacterUpsertPayload {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /**
   * 角色自带的系统提示（卡片里的 `system_prompt`）。
   * 留空就用设置里的全局提示——导入时不再把它丢掉。
   */
  systemPrompt?: string;
  /** 备选开场白（卡片里的 `alternate_greetings`）；第一条仍在 `firstMessage`。 */
  alternateGreetings?: string[];
}

export interface CharacterDeletePayload {
  characterId: string;
}

export interface SessionCreatePayload {
  title: string;
  characterId?: string;
  forkedFrom?: string;
}

export interface SessionDeletePayload {
  sessionId: string;
}

export interface MessageAppendPayload {
  sessionId: string;
  messageId: string;
  author: MessageAuthor;
  content: string;
  /** 生成失败时把错误文本也当成消息内容，并用这个状态标记出来（界面显示"失败"）。 */
  status?: 'done' | 'error';
}

export interface MessageEditPayload {
  messageId: string;
  revisionId: string;
  baseRevisionId: string;
  content: string;
  status?: 'done' | 'error';
}

export interface RevisionSelectPayload {
  messageId: string;
  revisionId: string;
}

export interface CandidateAppendPayload {
  messageId: string;
  candidateId: string;
  content: string;
}

export interface CandidateSelectPayload {
  messageId: string;
  candidateId: string;
}

export interface MessageDeletePayload {
  messageId: string;
}

export interface SettingSetPayload {
  key: string;
  value: unknown;
}

export interface Op<TPayload = unknown> {
  opId: string;
  deviceId: string;
  hlc: Hlc;
  entity: { type: string; id: string };
  type: OpType;
  payload: TPayload;
  schema: number;
}

export class OpCodecError extends Error {
  readonly index: number | undefined;

  constructor(message: string, index?: number) {
    super(index === undefined ? message : `第 ${index + 1} 条记录：${message}`);
    this.name = 'OpCodecError';
    this.index = index;
  }
}

function isHlc(value: unknown): value is Hlc {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.t === 'number' && Number.isFinite(record.t) && typeof record.c === 'number';
}

/** 严格校验：字段缺失或类型不符即抛错，绝不接受"看起来能用"的记录。 */
export function isOp(value: unknown): value is Op {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.opId !== 'string' || record.opId === '') return false;
  if (typeof record.deviceId !== 'string' || record.deviceId === '') return false;
  if (typeof record.type !== 'string') return false;
  if (typeof record.schema !== 'number') return false;
  if (!isHlc(record.hlc)) return false;
  const entity = record.entity;
  if (entity === null || typeof entity !== 'object') return false;
  const entityRecord = entity as Record<string, unknown>;
  if (typeof entityRecord.type !== 'string' || typeof entityRecord.id !== 'string') return false;
  if (record.payload === null || typeof record.payload !== 'object') return false;
  return true;
}

export function encodeOp(op: Op): string {
  return JSON.stringify(op);
}

export function decodeOp(line: string, index?: number): Op {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new OpCodecError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, index);
  }
  if (!isOp(parsed)) throw new OpCodecError('记录结构不合法（缺少 opId/deviceId/hlc/entity/payload）', index);
  if (parsed.schema > OP_SCHEMA_VERSION) {
    throw new OpCodecError(`op schema v${parsed.schema} 高于本实现支持的 v${OP_SCHEMA_VERSION}`, index);
  }
  return parsed;
}

/**
 * JSONL 编解码。任何一条记录损坏都会整体失败——部分接受会让"日志是唯一事实源"
 * 这件事变成谎言，因此宁可拒绝整段。
 */
export function encodeOps(ops: readonly Op[]): Uint8Array {
  const text = ops.map((op) => encodeOp(op)).join('\n');
  return new TextEncoder().encode(text);
}

export function decodeOps(text: string): Op[] {
  if (text.trim() === '') return [];
  const lines = text.split('\n');
  return lines.map((line, index) => decodeOp(line, index));
}

export interface CreateOpOptions<TPayload> {
  deviceId: string;
  clock: HlcClock;
  type: OpType;
  entity: { type: string; id: string };
  payload: TPayload;
  opId?: string;
  /** 显式时间戳：导入历史记录时要保留原始时间（此时不动本地时钟）。 */
  hlc?: Hlc;
}

export function createOp<TPayload>(options: CreateOpOptions<TPayload>): Op<TPayload> {
  return {
    opId: options.opId ?? ulid(),
    deviceId: options.deviceId,
    hlc: options.hlc ?? options.clock.tick(),
    entity: options.entity,
    type: options.type,
    payload: options.payload,
    schema: OP_SCHEMA_VERSION,
  };
}

/** 显式时间戳/opId：迁移与导入时用来"补写"过去发生的事。 */
export interface StampOptions {
  hlc?: Hlc;
  opId?: string;
}

// ---- 语义化构造器：让调用方不必手写 entity/type 组合 ----

export function characterUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: CharacterUpsertPayload & { characterId: string },
  stamp: StampOptions = {},
): Op<CharacterUpsertPayload> {
  const { characterId, ...rest } = payload;
  return createOp({
    ...base,
    ...stamp,
    type: 'character.upsert',
    entity: { type: 'character', id: characterId },
    payload: rest,
  });
}

export function characterDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: CharacterDeletePayload,
  stamp: StampOptions = {},
): Op<CharacterDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'character.delete',
    entity: { type: 'character', id: payload.characterId },
    payload,
  });
}

export function sessionCreate(
  base: { deviceId: string; clock: HlcClock },
  payload: SessionCreatePayload & { sessionId: string },
  stamp: StampOptions = {},
): Op<SessionCreatePayload> {
  const { sessionId, ...rest } = payload;
  return createOp({
    ...base,
    ...stamp,
    type: 'session.create',
    entity: { type: 'session', id: sessionId },
    payload: rest,
  });
}

export function sessionDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: SessionDeletePayload,
  stamp: StampOptions = {},
): Op<SessionDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'session.delete',
    entity: { type: 'session', id: payload.sessionId },
    payload,
  });
}

export function messageAppend(
  base: { deviceId: string; clock: HlcClock },
  payload: MessageAppendPayload,
  stamp: StampOptions = {},
): Op<MessageAppendPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'message.append',
    entity: { type: 'message', id: payload.messageId },
    payload,
  });
}

export function messageEdit(
  base: { deviceId: string; clock: HlcClock },
  payload: MessageEditPayload,
): Op<MessageEditPayload> {
  return createOp({ ...base, type: 'message.edit', entity: { type: 'message', id: payload.messageId }, payload });
}

export function revisionSelect(
  base: { deviceId: string; clock: HlcClock },
  payload: RevisionSelectPayload,
): Op<RevisionSelectPayload> {
  return createOp({
    ...base,
    type: 'message.revision.select',
    entity: { type: 'message', id: payload.messageId },
    payload,
  });
}

export function candidateAppend(
  base: { deviceId: string; clock: HlcClock },
  payload: CandidateAppendPayload,
): Op<CandidateAppendPayload> {
  return createOp({
    ...base,
    type: 'message.candidate.append',
    entity: { type: 'message', id: payload.messageId },
    payload,
  });
}

export function candidateSelect(
  base: { deviceId: string; clock: HlcClock },
  payload: CandidateSelectPayload,
): Op<CandidateSelectPayload> {
  return createOp({
    ...base,
    type: 'message.candidate.select',
    entity: { type: 'message', id: payload.messageId },
    payload,
  });
}

export function messageDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: MessageDeletePayload,
): Op<MessageDeletePayload> {
  return createOp({ ...base, type: 'message.delete', entity: { type: 'message', id: payload.messageId }, payload });
}

export function settingSet(
  base: { deviceId: string; clock: HlcClock },
  payload: SettingSetPayload,
  stamp: StampOptions = {},
): Op<SettingSetPayload> {
  return createOp({ ...base, ...stamp, type: 'setting.set', entity: { type: 'setting', id: payload.key }, payload });
}

// ---- 世界书 ----

// 世界书的 payload 类型与构造器放在 `lore-ops.ts`（字段多、还会长大），这里只做转发，
// 让调用方仍然可以只 import `op.ts`。
export type {
  LoreEntryDeletePayload,
  LoreEntryUpsertPayload,
  LorebookDeletePayload,
  LorebookUpsertPayload,
} from './lore-ops.ts';
export { loreEntryDelete, loreEntryUpsert, lorebookDelete, lorebookUpsert } from './lore-ops.ts';
