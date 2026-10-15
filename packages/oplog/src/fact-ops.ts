import { createOp, type Op, type StampOptions } from './op.ts';
import type { HlcClock } from './hlc.ts';

/**
 * 设定库（M4）的 op 构造器：从对话里抽出来的**事实/关系**。
 *
 * 与长期记忆的区别（这是两者都不能省的原因）：
 *  - 记忆是"这个人/这段关系要一直记得的事"（用户或模型整理出来的，粒度大、可读）；
 *  - 事实是"某句话确立了某个断言"（粒度小、**必须带 provenance 回链到源消息**），
 *    因此可以被核对、被冲突标记、被一键导出成世界书条目。
 *
 * 三条设计：
 *  1. **状态在 op 里**（\`state: proposed | accepted | rejected\`）：接受/拒绝是一次写入，
 *     跟着 op 日志同步与重放，不依赖任何界面的临时状态；
 *  2. **provenance 必须非空**：没有源消息的事实一律不采信（否则它就成了一段无法核对的断言）；
 *  3. **冲突不落库**：判断"同主语同谓词、不同宾语"是**派生计算**（见 fact-logic.ts 的 conflictsOf）。
 *     两台设备各自算出的结果必然一致，也不会因为写入顺序不同而分叉。
 */

/** 抽取来源：模型建议的、还是用户手写的。用户手写的直接是 accepted。 */
export type FactAuthor = 'user' | 'model';

/** 审阅状态：proposed 待定 / accepted 采纳 / rejected 拒绝（拒绝也是写入，不删除证据）。 */
export type FactState = 'proposed' | 'accepted' | 'rejected';

export interface FactUpsertPayload {
  factId: string;
  /** 绑定的角色；缺省 = 全局。 */
  characterId?: string;
  /** 断言的三元组。subject/predicate/object 都参与冲突判断。 */
  subject: string;
  predicate: string;
  object: string;
  /** 给人看的一句话（缺省时由三元组拼）。 */
  text?: string;
  /** provenance：**必须非空**，回链到源消息。 */
  sourceMessageIds: string[];
  /** 模型自评的把握（0-100），只用于排序与展示，不参与冲突判断。 */
  confidence?: number;
  state: FactState;
  createdBy: FactAuthor;
  modelId?: string;
}

export interface FactDeletePayload {
  factId: string;
}

export function factUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: FactUpsertPayload,
  stamp: StampOptions = {},
): Op<FactUpsertPayload> {
  if (payload.sourceMessageIds.length === 0) {
    // 在这里挡住比在物化阶段挡更好：错误发生在写入点，栈里能看见是谁写的
    throw new Error('事实必须带 provenance（sourceMessageIds 不能为空）：没有源消息的断言无法核对');
  }
  return createOp({
    ...base,
    ...stamp,
    type: 'fact.upsert',
    entity: { type: 'fact', id: payload.factId },
    payload,
  });
}

export function factDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: FactDeletePayload,
  stamp: StampOptions = {},
): Op<FactDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'fact.delete',
    entity: { type: 'fact', id: payload.factId },
    payload,
  });
}
