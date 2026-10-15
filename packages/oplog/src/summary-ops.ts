import { createOp, type Op, type StampOptions } from './op.ts';
import type { HlcClock } from './hlc.ts';

/**
 * 分层记忆（M4）的 op 构造器与 payload 类型。
 *
 * 层级是 PLAN §6 写的那一条：`message → scene → arc → session`。
 * 摘要**作为 op 落地**（不是旁路缓存）：这样它能同步、能重放、能被快照覆盖，
 * 也就不会出现"另一台设备算出来的摘要和本地不一致"这种状态分叉。
 *
 * 两级之间的连接靠 `covers`（直接下层的 id）与 `contentHash`（下层内容的指纹）：
 *  - 幂等：同样的覆盖范围 + 同样的指纹 → 不需要重算、不写新 op；
 *  - 失效：下层内容变了 → 指纹变了 → 上层摘要标 stale 并按需重算（见 summary-plan.ts）。
 */

/** 层级：一个 scene 覆盖若干条消息；一个 arc 覆盖若干 scene；session 覆盖若干 arc。 */
export type SummaryLevel = 'scene' | 'arc' | 'session';

export interface SummaryUpsertPayload {
  summaryId: string;
  sessionId: string;
  level: SummaryLevel;
  /** 直接下层的 id：scene → 消息 id；arc → 摘要 id；session → 摘要 id。**有序**（顺序参与指纹）。 */
  covers: string[];
  /**
   * 下层内容的指纹（十六进制）。
   *
   * 它是幂等与失效的唯一依据：指纹相同就不再生成，指纹不同就说明下层被改过。
   * 上层的指纹由"下层的 id + 下层的指纹"按序拼出来 → 改动会**逐层向上传播**。
   */
  contentHash: string;
  text: string;
  /** 谁写的：手写可信任，模型生成的应可审计（与记忆条目的 `createdBy` 同一套思路）。 */
  createdBy: 'user' | 'model';
  /** 模型生成的记下是哪份配置，便于回溯"这段摘要是谁写的"。 */
  modelId?: string;
}

export interface SummaryDeletePayload {
  summaryId: string;
}

export function summaryUpsert(
  base: { deviceId: string; clock: HlcClock },
  payload: SummaryUpsertPayload,
  stamp: StampOptions = {},
): Op<SummaryUpsertPayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'summary.upsert',
    entity: { type: 'summary', id: payload.summaryId },
    payload,
  });
}

export function summaryDelete(
  base: { deviceId: string; clock: HlcClock },
  payload: SummaryDeletePayload,
  stamp: StampOptions = {},
): Op<SummaryDeletePayload> {
  return createOp({
    ...base,
    ...stamp,
    type: 'summary.delete',
    entity: { type: 'summary', id: payload.summaryId },
    payload,
  });
}
