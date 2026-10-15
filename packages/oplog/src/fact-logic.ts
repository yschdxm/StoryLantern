import type { FactRecord } from './state-types.ts';

/**
 * 设定库的**纯逻辑**：解析模型输出、判断冲突、导出世界书条目、把 provenance 变可读。
 *
 * 这里没有网络、没有存储、没有界面 —— 因此可以确定性地测，也能被"评估"直接调用。
 *
 * 关于冲突：**它是派生计算，不落库**。两台设备对同一批事实各算一次，结果必然一致；
 * 也不会因为写入顺序不同而分叉。判据是"同主语 + 同谓词、但宾语不同"（例如"铜铃｜来历｜父亲的遗物"
 * 与"铜铃｜来历｜守夜人的信物"）；已拒绝的提议不参与，免得噪音占满界面。
 */

export interface FactProposal {
  subject: string;
  predicate: string;
  object: string;
  /** 给人看的一句话；缺省时由三元组拼。 */
  text?: string;
  /** provenance：必须非空。 */
  sourceMessageIds: string[];
  confidence?: number;
}

export interface ParseFactsResult {
  proposals: FactProposal[];
  /** 被丢掉的条数（格式不对的）。界面要显示出来，而不是假装模型没给。 */
  dropped: number;
  /** 整体失败时的原因（例如根本不是 JSON）。 */
  error?: string;
}

/** 模型爱把 JSON 包在代码块里：先剥掉围栏再解析（与记忆整理同一套宽容策略）。 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/m.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  // 也可能是"前面说两句 + ```json ... ``` + 后面说两句"
  const inner = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(trimmed);
  return inner?.[1] === undefined ? trimmed : inner[1].trim();
}

function asProposal(value: unknown): FactProposal | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
  const predicate = typeof item.predicate === 'string' ? item.predicate.trim() : '';
  const object = typeof item.object === 'string' ? item.object.trim() : '';
  if (subject === '' || predicate === '' || object === '') return undefined;
  const ids = Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  if (ids.length === 0) return undefined;
  const text = typeof item.text === 'string' && item.text.trim() !== '' ? item.text.trim() : undefined;
  const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : undefined;
  return {
    subject,
    predicate,
    object,
    ...(text === undefined ? {} : { text }),
    sourceMessageIds: ids,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

/**
 * 解析模型给出的提议。**宽容但有据**：坏条目丢掉并计数，整体不是 JSON 才报 error。
 * 刻意不做"猜字段名"这类补救 —— 猜错的字段比丢一条更糟。
 */
export function parseFactProposals(raw: string): ParseFactsResult {
  const body = stripFences(raw);
  if (body === '') return { proposals: [], dropped: 0, error: '模型没有返回内容' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { proposals: [], dropped: 0, error: '模型返回的不是合法 JSON（可以要求它只输出 JSON 数组）' };
  }
  const items = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(items)) return { proposals: [], dropped: 0, error: 'JSON 顶层应当是数组（或 {facts: []}）' };

  const proposals: FactProposal[] = [];
  let dropped = 0;
  for (const item of items) {
    const proposal = asProposal(item);
    if (proposal === undefined) dropped += 1;
    else proposals.push(proposal);
  }
  return { proposals, dropped };
}

export interface FactConflict {
  subject: string;
  predicate: string;
  /** 冲突双方的事实 id 与宾语。 */
  a: { factId: string; object: string };
  b: { factId: string; object: string };
  reason: string;
}

/**
 * 冲突：同主语 + 同谓词、宾语不同。
 *
 * **成对报告**：一组里每两个"宾语不同"的事实各算一条（例如 f2 同时与 f1、f3 矛盾就是两条）。
 * 这样每条都指得出具体是哪两句话打架；要合并展示是界面的事，但信息不在这里丢掉。
 * 已拒绝的不参与；同一对不重复。
 */
export function conflictsOf(facts: readonly FactRecord[]): FactConflict[] {
  const alive = facts.filter((fact) => fact.deleted === undefined && fact.state !== 'rejected');
  const groups = new Map<string, FactRecord[]>();
  for (const fact of alive) {
    const key = `${fact.subject}\u0000${fact.predicate}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const conflicts: FactConflict[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const left = group[i];
        const right = group[j];
        if (left === undefined || right === undefined) continue;
        if (left.object === right.object) continue;
        conflicts.push({
          subject: left.subject,
          predicate: left.predicate,
          a: { factId: left.id, object: left.object },
          b: { factId: right.id, object: right.object },
          reason: `同一「${left.subject}｜${left.predicate}」出现了两个说法：「${left.object}」与「${right.object}」`,
        });
      }
    }
  }
  return conflicts.sort((left, right) => left.subject.localeCompare(right.subject) || left.predicate.localeCompare(right.predicate));
}

/** 世界书条目草稿：形状与 lore.entry.upsert 的 payload 对齐（写库由调用方做）。 */
export interface LoreEntryDraft {
  comment: string;
  content: string;
  keys: string[];
  secondaryKeys: string[];
  enabled: boolean;
}

export interface ExportFactsOptions {
  /** 只导出已采纳的（默认 true）。设 false 会把待定的也带上，便于人工过一遍。 */
  onlyAccepted?: boolean;
  /** 源消息 id → 可读标题（没有就不展开，只留 id）。 */
  titles?: ReadonlyMap<string, string> | undefined;
}

/** provenance 变成人能读的一行：**导出世界书时也带着**，这样条目本身可核对。 */
export function provenanceLine(fact: Pick<FactRecord, 'sourceMessageIds'>, titles?: ReadonlyMap<string, string>): string {
  const parts = fact.sourceMessageIds.map((id) => (titles?.get(id) === undefined ? id : `${titles.get(id)}（${id}）`));
  return `来源：${parts.join('、')}`;
}

export function factsToLoreEntries(facts: readonly FactRecord[], options: ExportFactsOptions = {}): LoreEntryDraft[] {
  const onlyAccepted = options.onlyAccepted ?? true;
  return facts
    .filter((fact) => fact.deleted === undefined && (!onlyAccepted || fact.state === 'accepted'))
    .map((fact) => ({
      // 注释里放 provenance 与状态：导出到世界书之后仍然能回溯"这条是从哪句话来的"
      comment: `${provenanceLine(fact, options.titles)}｜状态：${fact.state}｜置信：${fact.confidence ?? '—'}`,
      content: fact.text,
      // 关键词取主语与宾语：世界书扫描靠它们命中
      keys: [...new Set([fact.subject, fact.object].filter((key) => key !== ''))],
      secondaryKeys: [],
      enabled: true,
    }));
}
