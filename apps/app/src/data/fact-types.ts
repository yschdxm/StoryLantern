import type { FactAuthor, FactState } from '../../../../packages/oplog/src/index.ts';

/**
 * 设定库在**应用层**的类型（物化记录的镜像 + 仓储契约）。
 *
 * 与摘要同理：`repository.ts` 已经很大，而这些类型要被内存版与宿主版仓储同时引用，
 * 放这里两边都只依赖它，不会互相套娃。
 */

/** 界面要看的记录：与 oplog 的 `FactRecord` 同形（字段名保持一致，避免两套词汇）。 */
export interface Fact {
  id: string;
  characterId?: string;
  subject: string;
  predicate: string;
  object: string;
  text: string;
  /** provenance：回链到源消息（永远非空，否则写不进来）。 */
  sourceMessageIds: string[];
  confidence?: number;
  state: FactState;
  createdBy: FactAuthor;
  modelId?: string;
  /** 宿主版是墓碑；界面只需要知道它已经不在了。 */
  deleted?: boolean;
  updatedAt: number;
}

/** 要写入的一条事实（抽取器或用户点出来的）。 */
export interface FactDraft {
  factId: string;
  characterId?: string;
  subject: string;
  predicate: string;
  object: string;
  text?: string;
  sourceMessageIds: string[];
  confidence?: number;
  state: FactState;
  createdBy: FactAuthor;
  modelId?: string;
}

export interface FactStore {
  /** 某个角色能看到的事实（含全局的）；不传 = 全部。 */
  list(characterId?: string): Promise<Fact[]>;
  /** 批量写入（一次 appendAndApply）。 */
  save(drafts: readonly FactDraft[]): Promise<Fact[]>;
  remove(id: string): Promise<boolean>;
}
