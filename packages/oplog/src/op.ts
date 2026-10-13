import { ulid } from './bytes.ts';
import { HlcClock, type Hlc } from './hlc.ts';

export const OP_SCHEMA_VERSION = 1;

export type MessageAuthor = 'user' | 'character' | 'system' | 'narrator';

export type OpType =
  | 'session.create'
  | 'message.append'
  | 'message.edit'
  | 'message.revision.select'
  | 'message.candidate.append'
  | 'message.candidate.select'
  | 'message.delete'
  | 'setting.set';

export interface SessionCreatePayload {
  title: string;
  characterId?: string;
  forkedFrom?: string;
}

export interface MessageAppendPayload {
  sessionId: string;
  messageId: string;
  author: MessageAuthor;
  content: string;
}

export interface MessageEditPayload {
  messageId: string;
  revisionId: string;
  baseRevisionId: string;
  content: string;
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

export interface Op<TPayload = Record<string, unknown>> {
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
}

export function createOp<TPayload>(options: CreateOpOptions<TPayload>): Op<TPayload> {
  return {
    opId: options.opId ?? ulid(),
    deviceId: options.deviceId,
    hlc: options.clock.tick(),
    entity: options.entity,
    type: options.type,
    payload: options.payload,
    schema: OP_SCHEMA_VERSION,
  };
}

// ---- 语义化构造器：让调用方不必手写 entity/type 组合 ----

export function sessionCreate(
  base: { deviceId: string; clock: HlcClock },
  payload: SessionCreatePayload & { sessionId: string },
): Op<SessionCreatePayload> {
  const { sessionId, ...rest } = payload;
  return createOp({ ...base, type: 'session.create', entity: { type: 'session', id: sessionId }, payload: rest });
}

export function messageAppend(
  base: { deviceId: string; clock: HlcClock },
  payload: MessageAppendPayload,
): Op<MessageAppendPayload> {
  return createOp({
    ...base,
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
): Op<SettingSetPayload> {
  return createOp({ ...base, type: 'setting.set', entity: { type: 'setting', id: payload.key }, payload });
}
