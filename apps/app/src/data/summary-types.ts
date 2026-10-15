import type { SummaryLevel } from '../../../../packages/oplog/src/index.ts';

/**
 * 分层摘要在**应用层**的类型（物化记录的镜像 + 仓储契约）。
 *
 * 为什么单独一个文件：`repository.ts` 已经很大，而这两组类型会被内存版与宿主版仓储同时引用；
 * 放这里两边都只依赖它，不会互相套娃。
 */

/** 界面要看的摘要记录：与 oplog 的 `SummaryRecord` 同形（字段名保持一致，避免两套词汇）。 */
export interface Summary {
  id: string;
  sessionId: string;
  level: SummaryLevel;
  /** 直接下层的 id（scene → 消息 id；arc/session → 摘要 id），有序。 */
  covers: string[];
  /** 下层内容的指纹：幂等与失效判据（见 oplog 的 summary-plan.ts）。 */
  contentHash: string;
  text: string;
  createdBy: 'user' | 'model';
  modelId?: string;
  /** 宿主版是墓碑；界面只需要知道它已经不在了。 */
  deleted?: boolean;
  updatedAt: number;
}

/** 要写入的一条摘要（执行器算出来的目标 + 生成的文本）。 */
export interface SummaryDraft {
  summaryId: string;
  sessionId: string;
  level: SummaryLevel;
  covers: string[];
  contentHash: string;
  text: string;
  modelId?: string;
}

export interface SummaryStore {
  /** 某个会话的全部活摘要（不传 = 所有会话）。 */
  list(sessionId?: string): Promise<Summary[]>;
  /** 批量写入（一次 appendAndApply，避免 N 条 op 打 N 次事务）。 */
  save(sessionId: string, drafts: readonly SummaryDraft[]): Promise<Summary[]>;
  /** 删除一条（墓碑）。返回是否真的删掉了。 */
  remove(id: string): Promise<boolean>;
}
