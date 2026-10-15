import { HlcClock, runSummaries, type SummarizeRequest, type SummaryRecordLike } from '../../../../packages/oplog/src/index.ts';
import { summaryHash } from './digest.ts';
import type { SummaryDraft } from './summary-types.ts';

/**
 * 分层摘要的**编排**（纯函数，不碰仓储、不碰网络）：
 * 拿会话消息 + 已有摘要 + 一个"生成一段文本"的函数，产出**该写哪些摘要草稿**。
 *
 * 为什么放在这里而不是 store 动作里：模型调用属于界面层（要挑候选配置、要报错给人看，
 * 与"记忆整理"同一个套路），而"算哪些该写、指纹是什么"是纯逻辑，独立出来才好测。
 *
 * 幂等由计划器保证：内容没变 → 返回空数组 → 调用方一条 op 都不写。
 */
export interface OrganizeSummariesInput {
  sessionId: string;
  /** 该会话的消息（按时间序）。 */
  messages: readonly { id: string; role: string; content: string }[];
  /** 该会话已有的摘要记录（**含墓碑**，删除优先由计划器负责）。 */
  existing: readonly (SummaryRecordLike & { text: string })[];
  /** 生成一段摘要文本（界面传入：真机上就是聊天客户端）。 */
  summarize: (request: SummarizeRequest) => Promise<string>;
  /** 模型配置名，便于回溯。 */
  modelId?: string;
  sceneSize?: number;
  arcSize?: number;
}

export interface OrganizeSummariesResult {
  drafts: SummaryDraft[];
  /** 受一次运行的上限限制，还有多少单元没做（界面据此提示"再点一次继续"）。 */
  remaining: number;
  /** 计划出来的目标数（= drafts 数；写出来是为了界面能说清"为什么一条都没写"）。 */
  planned: number;
}

export async function organizeSummaries(input: OrganizeSummariesInput): Promise<OrganizeSummariesResult> {
  // 设备 id / 时钟在这里只是 op 的戳，由调用方最终写库时决定；执行器需要它们才能造 op，
  // 而我们只取 payload（草稿），所以给一组占位值即可——真正的 HLC 由仓储写入时生成。
  const { ops, remaining } = await runSummaries({
    sessionId: input.sessionId,
    messages: input.messages,
    existing: input.existing,
    options: {
      deviceId: 'draft',
      // 只用来给 op 盖戳，而这些 op 的 payload 才是我们要的东西；真正的 HLC 由仓储写入时生成
      clock: new HlcClock({ now: () => Date.now() }),
      hash: summaryHash,
      summarize: input.summarize,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.sceneSize === undefined ? {} : { sceneSize: input.sceneSize }),
      ...(input.arcSize === undefined ? {} : { arcSize: input.arcSize }),
    },
  });

  const drafts: SummaryDraft[] = ops.map((op) => {
    const payload = op.payload as {
      summaryId: string;
      level: SummaryDraft['level'];
      covers: string[];
      contentHash: string;
      text: string;
      modelId?: string;
    };
    return {
      summaryId: payload.summaryId,
      sessionId: input.sessionId,
      level: payload.level,
      covers: [...payload.covers],
      contentHash: payload.contentHash,
      text: payload.text,
      ...(payload.modelId === undefined ? {} : { modelId: payload.modelId }),
    };
  });

  return { drafts, planned: drafts.length, remaining };
}
