import type { Op } from './op.ts';
import type { HlcClock } from './hlc.ts';
import type { MaterializedState } from './state-types.ts';
import { summaryUpsert, type SummaryLevel, type SummaryUpsertPayload } from './summary-ops.ts';
import { planSummaries, type SummaryRecordLike, type SummaryMessage, type SummaryTarget } from './summary-plan.ts';

/**
 * 分层摘要的**执行器**：把计划器算出来的目标逐个生成文本、变成 op。
 *
 * 它接上了上一轮明确留下的缺口（"计划器只说该写什么，没有接生成"）：
 *  - **自底向上**：计划器给出的顺序就是 scene → arc → session，父层的输入用的是**本次刚生成的子摘要文本**，
 *    而不是磁盘上的旧文本 —— 否则一次编辑之后，arc 会拿着过期的 scene 文本去重算。
 *  - **生成是注入的**：真机上传真实模型客户端、评估里传回放客户端、测试里传桩。
 *    本模块自己不碰网络、不碰存储：它只返回**该写的 op**，由调用方决定何时落库（所以可测、可重放）。
 *  - **收敛**：把返回的 op 全部应用之后再跑一次，计划器会给空列表 → 不产生任何新 op（幂等闭环）。
 */

export interface SummarizeRequest {
  sessionId: string;
  level: SummaryLevel;
  /**
   * 这一层的输入文本：scene 是它覆盖的消息（`角色：内容` 形式）；
   * arc/session 是它覆盖的**下层摘要文本**（同一次运行里刚生成的优先）。
   */
  inputs: readonly string[];
  /** 覆盖范围，便于生成方在提示词里说明"这是第几条到第几条"。 */
  covers: readonly string[];
}

export interface SummaryRunnerOptions {
  deviceId: string;
  clock: HlcClock;
  /** 指纹函数（与计划器必须用同一个，否则永远收敛不了）。 */
  hash: (parts: readonly string[]) => Promise<string>;
  /** 生成摘要文本。真机=模型客户端，评估=回放客户端，测试=桩。 */
  summarize: (request: SummarizeRequest) => Promise<string>;
  /** 生成的来源标记，便于回溯（例如 'mock' / 'gpt-x' 这类配置名）。 */
  /**
   * 一次最多生成多少个单元（默认 24）。
   *
   * 为什么必须有：1 万条消息的会话按 20 条/scene 规划是 620 个单元 —— 620 次模型调用既不便宜也不快。
   * 计划器顺序稳定、已完成的单元指纹一致不会重做，所以分批是安全的。
   */
  limit?: number;
  modelId?: string;
  sceneSize?: number;
  arcSize?: number;
}

export interface SummaryRunInput {
  sessionId: string;
  /** 该会话的消息，按时间序。 */
  messages: readonly SummaryMessage[];
  /** 该会话已有的摘要（**含墓碑**；删除优先由计划器负责）。 */
  existing: readonly (SummaryRecordLike & { text: string })[];
  options: SummaryRunnerOptions;
}

export interface SummaryRunResult {
  /** 本次真正处理的目标（顺序 = 自底向上）。 */
  targets: SummaryTarget[];
  /** 还有多少单元这次没做（受 limit 限制）——界面据此告诉用户"再点一次继续"。 */
  remaining: number;
  /** 该写的 op（顺序与 targets 一致）。 */
  ops: Array<Op<SummaryUpsertPayload>>;
}

/** 消息给生成方看的形式：带角色前缀，读起来像对话。 */
function messageLine(message: SummaryMessage): string {
  const who = message.role === 'user' ? '旅人' : message.role === 'assistant' ? '星野' : message.role;
  return `${who}：${message.content}`;
}

export async function runSummaries(input: SummaryRunInput): Promise<SummaryRunResult> {
  const { sessionId, messages, existing, options } = input;
  const { hash, summarize, clock, deviceId } = options;

  const allTargets = await planSummaries({
    sessionId,
    messages,
    existing,
    hash,
    ...(options.sceneSize === undefined ? {} : { sceneSize: options.sceneSize }),
    ...(options.arcSize === undefined ? {} : { arcSize: options.arcSize }),
  });

  const limit = options.limit ?? 24;
  const targets = allTargets.slice(0, Math.max(0, limit));
  const remaining = allTargets.length - targets.length;

  const messageById = new Map(messages.map((message) => [message.id, message]));
  // 子摘要文本：先用磁盘上已有的，生成了新的就覆盖 —— 父层必须看到**本次**的文本
  const textById = new Map<string, string>();
  for (const record of existing) {
    if (record.deleted === undefined) textById.set(record.id, record.text);
  }

  const ops: Array<Op<SummaryUpsertPayload>> = [];
  for (const target of targets) {
    const inputs =
      target.level === 'scene'
        ? target.covers.map((id) => {
            const message = messageById.get(id);
            return message === undefined ? id : messageLine(message);
          })
        : target.covers.map((id) => textById.get(id) ?? `（缺少下层摘要 ${id}）`);

    const text = await summarize({ sessionId, level: target.level, inputs, covers: [...target.covers] });
    textById.set(target.summaryId, text);

    ops.push(
      summaryUpsert(
        { deviceId, clock },
        {
          summaryId: target.summaryId,
          sessionId: target.sessionId,
          level: target.level,
          covers: [...target.covers],
          contentHash: target.contentHash,
          text,
          createdBy: 'model',
          ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
        },
      ),
    );
  }

  return { targets, ops, remaining };
}

/** 便捷入口：直接给物化状态（调用方通常只有 state）。 */
export async function runSummariesFor(
  state: MaterializedState,
  input: Omit<SummaryRunInput, 'existing'> & { existing?: readonly (SummaryRecordLike & { text: string })[] },
): Promise<SummaryRunResult> {
  return runSummaries({
    ...input,
    existing: input.existing ?? Object.values(state.summaries).filter((record) => record.sessionId === input.sessionId),
  });
}
