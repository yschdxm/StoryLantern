import { messageAppend, messageDelete, messageEdit, ulid, type HlcClock, type Materializer, type Op } from '../../../../packages/oplog/src/index.ts';
import { authorOf, messageView } from './op-views.ts';
import { DataError, validateMessageRole, type MessageStore } from './repository.ts';
import type { MessageStatus } from './types.ts';

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

    append: (sessionId, role, content, status: MessageStatus = 'done', createdAt?: number) =>
      deps.withReady(async () => {
        // 与其它实现保持同样的校验（未知角色要报 invalid-argument，而不是写进日志）
        const safeRole = validateMessageRole(role);
        const id = ulid();
        await deps.appendAndApply([
          messageAppend(
            deps.base(),
            {
              sessionId,
              messageId: id,
              author: authorOf(safeRole),
              content,
              ...(status === 'error' ? { status: 'error' as const } : {}),
            },
            // 导入历史时保留原始时间；其余情况用本机时钟
            createdAt === undefined || createdAt <= 0 ? {} : { hlc: { t: createdAt, c: 0 } },
          ),
        ]);
        const view = messageView(deps.materializer(), id);
        if (view === undefined) throw new DataError('store-error', '写入后读不到该消息');
        return view;
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
            status: status === 'error' ? 'error' : 'done',
          }),
        ]);
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
