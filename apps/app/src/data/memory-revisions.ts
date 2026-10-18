import type { Message, MessageRevision } from './types.ts';

/**
 * 内存仓储的正文版本历史（B15/B16）。
 *
 * 独立成模块有两个原因：`memory-repository.ts` 已贴着 400 行上限；
 * 而这段逻辑（版本列表 / 当前版本 / 超限不删）与仓储存储无关，单独测更直接。
 * op 仓储的同一语义由 `Materializer.revisionsOf` 从 op 日志投影出来。
 */
export interface RevisionHistory {
  /** 新消息的第一版；返回 active id。 */
  ensure(messageId: string, content: string): string;
  /** 追加一版；返回新 active id 与版本数；空正文返回 undefined（调用方报 DataError）。 */
  edit(messageId: string, content: string, nextId: () => string): { activeId: string; count: number } | undefined;
  /** 切到某版；返回该版内容（未知版本返回 undefined）。 */
  select(messageId: string, revisionId: string): string | undefined;
  list(messageId: string): MessageRevision[];
  remove(messageId: string): void;
}

export function createRevisionHistory(): RevisionHistory {
  const revisions = new Map<string, { id: string; content: string }[]>();
  const active = new Map<string, string>();
  return {
    ensure(messageId, content) {
      const id = `${messageId}:r0`;
      revisions.set(messageId, [{ id, content }]);
      active.set(messageId, id);
      return id;
    },
    edit(messageId, content, nextId) {
      if (content.trim() === '') return undefined;
      const list = revisions.get(messageId) ?? [];
      const activeId = `${messageId}:r${list.length}-${nextId()}`;
      list.push({ id: activeId, content });
      revisions.set(messageId, list);
      active.set(messageId, activeId);
      return { activeId, count: list.length };
    },
    select(messageId, revisionId) {
      const revision = (revisions.get(messageId) ?? []).find((item) => item.id === revisionId);
      if (revision === undefined) return undefined;
      active.set(messageId, revisionId);
      return revision.content;
    },
    list(messageId) {
      const current = active.get(messageId);
      return (revisions.get(messageId) ?? []).map((revision) => ({
        id: revision.id,
        content: revision.content,
        active: revision.id === current,
      }));
    },
    remove(messageId) {
      revisions.delete(messageId);
      active.delete(messageId);
    },
  };
}

/** 把历史操作的结果写回内存 `Message`（保持 list 视图的摘要字段最新）。 */
export function applyHistorySummary(message: Message, activeId: string, count: number): void {
  message.activeRevisionId = activeId;
  if (count > 1) message.revisionCount = count;
}
