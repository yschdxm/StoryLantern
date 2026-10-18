import {
  candidateAppend,
  candidateSelect,
  messageAppend,
  messageDelete,
  messageEdit,
  ulid,
  type HlcClock,
  type Materializer,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import { authorOf, messageView } from './op-views.ts';
import { DataError, validateMessageRole, type MessageStore } from './repository.ts';
import type { MessageMeta, MessageStatus } from './types.ts';

/** app 的 `streaming` 只存在于内存预览，落库只写 done/error/stopped。 */
function payloadStatus(status: MessageStatus): 'error' | 'stopped' | undefined {
  if (status === 'error') return 'error';
  if (status === 'stopped') return 'stopped';
  return undefined;
}

/**
 * 消息的 op 仓储（从 `op-repository.ts` 拆出，与世界书/记忆两块同构）。
 *
 * 两条不变量在这里体现得最直接：
 *  - **先落盘再改内存**（`appendAndApply`）；
 *  - 消息顺序**按 append 的 HLC 派生**（`orderOf`），因此与到达顺序无关。
 */
export interface MessageStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

/**
 * 宿主对**每次** ops.append 有条数上限：`apps/shell/src-tauri/src/wire_ops.rs` 的
 * `MAX_OPS_PER_APPEND = 5000`，超了宿主会直接拒绝（真机上导入 1 万条时就是这么被挡下的）。
 * 这里留出余量按 4000 分片，用纯函数切好，便于单测。
 */
export const APPEND_CHUNK = 4000;

/** 把要写的 op 切成每片 ≤size 的若干片（纯函数）。 */
export function chunkOps<T>(items: readonly T[], size: number = APPEND_CHUNK): T[][] {
  if (size <= 0) throw new Error('分片大小必须为正数');
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

export function createMessageStore(deps: MessageStoreDeps): MessageStore {
  return {
    list: (sessionId) =>
      deps.withReady(async () => {
        const session = deps.materializer().state.sessions[sessionId];
        if (session === undefined || session.deleted !== undefined) return [];
        return deps
          .materializer()
          .orderOf(sessionId)
          .map((record) => messageView(deps.materializer(), record.id))
          .filter((message): message is NonNullable<typeof message> => message !== undefined);
      }),

    append: (sessionId, role, content, status: MessageStatus = 'done', createdAt?: number, meta?: MessageMeta) =>
      deps.withReady(async () => {
        // 与其它实现保持同样的校验（未知角色要报 invalid-argument，而不是写进日志）
        const safeRole = validateMessageRole(role);
        const id = ulid();
        const statusField = payloadStatus(status);
        await deps.appendAndApply([
          messageAppend(
            deps.base(),
            {
              sessionId,
              messageId: id,
              author: authorOf(safeRole),
              content,
              ...(statusField === undefined ? {} : { status: statusField }),
              ...(meta === undefined ? {} : { meta }),
            },
            // 导入历史时保留原始时间；其余情况用本机时钟
            createdAt === undefined || createdAt <= 0 ? {} : { hlc: { t: createdAt, c: 0 } },
          ),
        ]);
        const view = messageView(deps.materializer(), id);
        if (view === undefined) throw new DataError('store-error', '写入后读不到该消息');
        return view;
      }),

    appendMany: (sessionId, entries) =>
      deps.withReady(async () => {
        const ops: Op[] = [];
        for (const entry of entries) {
          const safeRole = validateMessageRole(entry.role);
          const id = ulid();
          const content = entry.content;
          const statusField = payloadStatus(entry.status ?? 'done');
          ops.push(
            messageAppend(
              deps.base(),
              {
                sessionId,
                messageId: id,
                author: authorOf(safeRole),
                content,
                ...(statusField === undefined ? {} : { status: statusField }),
                ...(entry.meta === undefined ? {} : { meta: entry.meta }),
              },
              entry.createdAt === undefined || entry.createdAt <= 0 ? {} : { hlc: { t: entry.createdAt, c: 0 } },
            ),
          );
          // 候选：跳过空串、与正文相同、以及同一条里重复的（与 appendCandidates 的规则一致）
          const seen = new Set<string>();
          const activeText = content.trim();
          for (const candidate of entry.candidates ?? []) {
            const clean = candidate.trim();
            if (clean === '' || clean === activeText || seen.has(clean)) continue;
            seen.add(clean);
            ops.push(candidateAppend(deps.base(), { messageId: id, candidateId: ulid(), content: clean }));
          }
        }
        if (ops.length === 0) return 0;
        // 分片写入：宿主的单次上限是 5000 条，超了会被整批拒绝（真机踩到过）。
        // 分片仍然远少于"每条一次"，1 万条 = 3 次写入而不是 1 万次。
        for (const slice of chunkOps(ops)) await deps.appendAndApply(slice);
        return entries.length;
      }),

    update: (id, content, status: MessageStatus = 'done') =>
      deps.withReady(async () => {
        const record = deps.materializer().state.messages[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await deps.appendAndApply([
          messageEdit(deps.base(), {
            messageId: id,
            revisionId: `${id}:r${record.revisions.length}`,
            baseRevisionId: record.activeRevision.revisionId,
            content,
            status: payloadStatus(status) ?? 'done',
          }),
        ]);
        return true;
      }),

    /**
     * 追加候选回复：每条候选一个 op（`message.candidate.append`）。
     *
     * 跳过空串、与正文相同、以及已存在的候选——因此导入重放不会堆出重复候选。
     */
    appendCandidates: (id, contents) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.messages[id];
        if (record === undefined || record.deleted !== undefined) return 0;
        const existing = new Set(record.candidates.map((candidate) => candidate.content.trim()));
        // 正文（当前 revision）本身也是一种内容：swipes 里常常把当前这条也带了一份
        const active = record.revisions.find((revision) => revision.revisionId === record.activeRevision.revisionId);
        const activeText = (active?.content ?? '').trim();
        const ops: Op[] = [];
        for (const content of contents) {
          const clean = content.trim();
          if (clean === '' || clean === activeText || existing.has(clean)) continue;
          existing.add(clean);
          ops.push(candidateAppend(deps.base(), { messageId: id, candidateId: ulid(), content: clean }));
        }
        if (ops.length === 0) return 0;
        await deps.appendAndApply(ops);
        return ops.length;
      }),

    selectCandidate: (id, candidateId) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.messages[id];
        if (record === undefined || record.deleted !== undefined) return false;
        if (!record.candidates.some((candidate) => candidate.candidateId === candidateId)) return false;
        await deps.appendAndApply([candidateSelect(deps.base(), { messageId: id, candidateId })]);
        return true;
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.messages[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await deps.appendAndApply([messageDelete(deps.base(), { messageId: id })]);
        return true;
      }),
  };
}
