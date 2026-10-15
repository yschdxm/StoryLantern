import type { SummaryLevel } from './summary-ops.ts';

/**
 * 计划器只关心三件事：id、内容指纹、以及它是不是墓碑。
 * 放宽成最小形状，是为了让应用层的视图（不该带着 HLC / opId）也能直接传进来。
 */
export interface SummaryRecordLike {
  id: string;
  contentHash: string;
  deleted?: unknown;
}

/**
 * 分层摘要的**计划器**（M4 判据"内容哈希幂等 / 编辑旧消息后受影响摘要 100% 失效重算"的落点）。
 *
 * 它只做两件事，全是纯计算：
 *  1. 按 PLAN §6 的层级 `message → scene → arc → session` 算出"**应该存在**哪些摘要"以及每一层的指纹；
 *  2. 和已有的摘要比指纹，给出**要做什么**：`missing`（还没有）、`stale`（下层被改过）。
 *
 * 关键设计（都有理由，不是随手）：
 *  - **指纹逐层向上传播**：scene 的指纹来自它覆盖的消息（id|role|content）；arc 的指纹来自它覆盖的
 *    scene 的 **(id, 指纹)**；session 同理。于是改一条消息 → 它的 scene 变 stale → 该 scene 的新指纹
 *    会让上层 arc 也变 stale → 再上一层 session 也变 —— "受影响摘要 100% 失效"是**构造出来的**，
 *    不是靠运行时比对文本。
 *  - **只给"完整的"单元做摘要**：一个 scene 只有攒满 `sceneSize` 条消息才成单元（arc/session 同理），
 *    尾部不满的那一小段等它攒够。这样"同一个 id 对应的覆盖范围"永远不变，幂等才好判。
 *  - **幂等**：指纹相同的已存在摘要既不算 missing 也不算 stale → 调用方不会为此写任何新 op。
 *  - **删除优先**：已存在记录（含墓碑）里的 id 一律跳过。id 是 (会话, 层级, 覆盖范围) 的确定函数，
 *    所以"用户删掉的摘要"不会因为内容没变而被重新生成。
 *
 * 指纹函数由调用方注入（app 里用真实的 sha256 端口），因此本模块无副作用、可确定性测试。
 */

export interface SummaryMessage {
  id: string;
  role: string;
  content: string;
}

export interface SummaryPlanInput {
  sessionId: string;
  /** 该会话的消息，**按时间序**。 */
  messages: readonly SummaryMessage[];
  /** 该会话已有的摘要记录（**含墓碑**：删除要优先）。 */
  existing: readonly SummaryRecordLike[];
  /** 指纹函数：输入若干段文本，输出确定性的十六进制指纹。 */
  hash: (parts: readonly string[]) => Promise<string>;
  /** 一个 scene 覆盖多少条消息（默认 20）。 */
  sceneSize?: number;
  /** 一个 arc 覆盖多少个 scene（session 覆盖多少个 arc 用同一个值，默认 5）。 */
  arcSize?: number;
}

export interface SummaryTarget {
  summaryId: string;
  sessionId: string;
  level: SummaryLevel;
  covers: string[];
  contentHash: string;
  /** missing = 还没有；stale = 下层被改过，需要重算。 */
  reason: 'missing' | 'stale';
}

export const DEFAULT_SCENE_SIZE = 20;
export const DEFAULT_ARC_SIZE = 5;

/** 确定性 id：同一会话、同一层级、同一覆盖范围永远同一个 id。 */
export function summaryIdOf(sessionId: string, level: SummaryLevel, covers: readonly string[]): string {
  return `${sessionId}:${level}:${covers.join(',')}`;
}

/** 一条消息参与指纹的形式：id 也进去，这样"删一条 + 补一条"不会与原来撞上。 */
function messagePart(message: SummaryMessage): string {
  return `${message.id}|${message.role}|${message.content}`;
}

interface Unit {
  level: SummaryLevel;
  covers: string[];
  contentHash: string;
  summaryId: string;
}

/** 把消息/下层单元切成"完整的"窗口。 */
function windows<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start + size <= items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

export async function planSummaries(input: SummaryPlanInput): Promise<SummaryTarget[]> {
  const sceneSize = input.sceneSize ?? DEFAULT_SCENE_SIZE;
  const arcSize = input.arcSize ?? DEFAULT_ARC_SIZE;
  const { hash, sessionId } = input;

  const units: Unit[] = [];
  const byLevel: Record<SummaryLevel, Unit[]> = { scene: [], arc: [], session: [] };

  // scene：直接覆盖消息
  for (const slice of windows(input.messages, sceneSize)) {
    const contentHash = await hash(slice.map(messagePart));
    const covers = slice.map((message) => message.id);
    byLevel.scene.push({ level: 'scene', covers, contentHash, summaryId: summaryIdOf(sessionId, 'scene', covers) });
  }
  units.push(...byLevel.scene);

  // arc / session：覆盖下层单元，指纹来自下层 (id, 指纹)
  const levelOrder: SummaryLevel[] = ['arc', 'session'];
  for (const level of levelOrder) {
    const children = level === 'arc' ? byLevel.scene : byLevel.arc;
    for (const slice of windows(children, arcSize)) {
      const contentHash = await hash(slice.map((child) => `${child.summaryId}|${child.contentHash}`));
      const covers = slice.map((child) => child.summaryId);
      byLevel[level].push({ level, covers, contentHash, summaryId: summaryIdOf(sessionId, level, covers) });
    }
    units.push(...byLevel[level]);
  }

  // 与已有记录比对
  const existing = new Map(input.existing.map((record) => [record.id, record]));
  const targets: SummaryTarget[] = [];
  for (const unit of units) {
    const record = existing.get(unit.summaryId);
    // 删除优先：墓碑（或任何已存在记录）里已有这个 id，就不重新生成
    if (record !== undefined) {
      if (record.deleted !== undefined) continue;
      if (record.contentHash === unit.contentHash) continue; // 幂等：完全一致 → 什么都不用做
      targets.push({ ...unit, sessionId, reason: 'stale' });
      continue;
    }
    targets.push({ ...unit, sessionId, reason: 'missing' });
  }
  return targets;
}

/** 只要"失效重算"那部分（判据 2 的判据式调用）。 */
export async function staleSummaries(input: SummaryPlanInput): Promise<SummaryTarget[]> {
  return (await planSummaries(input)).filter((target) => target.reason === 'stale');
}
