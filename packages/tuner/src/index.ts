import type { HlcClock } from '../../oplog/src/hlc.ts';
import { memoryDelete, memoryUpsert, type MemoryUpsertPayload } from '../../oplog/src/memory-ops.ts';
import { settingSet, type Op } from '../../oplog/src/op.ts';
import type { MaterializedState, MemoryRecord } from '../../oplog/src/state-types.ts';

/**
 * 调优助手（Agent 侧信道）的**纯逻辑**。
 *
 * ADR-0003 定的规矩：Agent 是**侧信道调优助手，不是创作者**。落到代码上就是三条硬约束：
 *
 *  1. **不带 op 的提案**。这里产出的 `TunerProposal` 里**只有数据**（要写什么、以及怎么撤回），
 *     一个 `Op` 都没有 —— 于是"未经批准不写入"不是靠自觉，而是**结构上不可能**：
 *     没有 base（deviceId + clock）就造不出 op，而 base 只在用户点"应用"时才传给 `applyProposal`。
 *  2. **撤销要能逐字节还原**。这条我按**内容级**理解并写成可断言的投影 `memoryContentProjection`：
 *     只比较内容字段（id/角色/文本/关键词/重要度/来源/作者），**排除** `createdHlc`/`updatedHlc`/`opId`
 *     —— 时间戳与因果时钟在"撤销"这个动作里**必然前进**（它们记录的是"什么时候发生的"），
 *     把它们算进去就等于要求"撤销不能留下发生过的事实"，与 op-log 的因果语义矛盾。
 *     这一点写在这里，是为了不让人误以为"逐字节"包含时钟。
 *  3. **不进生成热路径**。这个包不 import 任何装配/管线模块（架构测试另行断言）。
 *
 * 撤销依据存在 **op 日志里的设置项**（`tuner.undo.<提案 id>`）而不是内存：这样跨重启、跨设备都还在。
 */

export interface TunerBase {
  deviceId: string;
  clock: HlcClock;
}

/** 提案里的"要做什么"：只描述数据，绝不携带 op。 */
export interface MemoryMergeChange {
  upserts: MemoryUpsertPayload[];
  deletes: string[];
}

export interface TunerProposal {
  /** 由成员 id 派生：同一份数据重复分析得到**同一条**建议（不会越点越多）。 */
  id: string;
  kind: 'memory.merge';
  title: string;
  reason: string;
  evidence: string[];
  apply: MemoryMergeChange;
  inverse: MemoryMergeChange;
}

const DEFAULT_THRESHOLD = 0.6;
export const LEDGER_PREFIX = 'tuner.undo.';

/**
 * 记忆条目的**内容投影**：撤销"逐字节还原"的判据就是这个字符串相等。
 *
 * 排除三个元数据字段的原因见文件头：它们记录"何时发生"，撤销本身也会推进它们。
 */
export function memoryContentProjection(state: MaterializedState): string {
  const live = Object.values(state.memories)
    .filter((memory) => memory.deleted === undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((memory) => ({
      id: memory.id,
      characterId: memory.characterId ?? '',
      text: memory.text,
      keys: [...memory.keys].sort(),
      importance: memory.importance,
      sourceSessionId: memory.sourceSessionId ?? '',
      sourceMessageIds: [...memory.sourceMessageIds].sort(),
      createdBy: memory.createdBy,
    }));
  return JSON.stringify(live);
}

/** FNV-1a（与 join-link 同一个思路）：稳定、够短、用于"同一条建议只出现一次"。 */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 词的集合：中文按字切、拉丁按词切 —— 两种都不是"分词器"，但在近重复这件事上够用且可复现。 */
function tokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  return new Set([...latin, ...cjk]);
}

/** Jaccard 相似度：交集 / 并集。 */
export function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function toPayload(memory: MemoryRecord): MemoryUpsertPayload {
  return {
    memoryId: memory.id,
    ...(memory.characterId === undefined ? {} : { characterId: memory.characterId }),
    text: memory.text,
    keys: [...memory.keys],
    importance: memory.importance,
    ...(memory.sourceSessionId === undefined ? {} : { sourceSessionId: memory.sourceSessionId }),
    sourceMessageIds: [...memory.sourceMessageIds],
    createdBy: memory.createdBy,
  };
}

/** 合并出来的那条：id 由成员派生（稳定），内容取"最长的那条"+ 并集字段。 */
function mergedPayload(members: MemoryRecord[]): MemoryUpsertPayload {
  const sorted = [...members].sort((left, right) => left.id.localeCompare(right.id));
  const longest = sorted.reduce((best, current) => (current.text.length > best.text.length ? current : best));
  const keys = [...new Set(sorted.flatMap((memory) => memory.keys))].sort();
  const sourceMessageIds = [...new Set(sorted.flatMap((memory) => memory.sourceMessageIds))].sort();
  const importance = Math.max(...sorted.map((memory) => memory.importance));
  const characterId = sorted[0]?.characterId;
  // 绝不把用户手写降级成 agent 建议：只要有一条是用户写的，合并结果就算用户写的
  const createdBy = sorted.some((memory) => memory.createdBy === 'user') ? 'user' : 'agent';
  return {
    memoryId: `merged-${fnv(sorted.map((memory) => memory.id).join('|'))}`,
    ...(characterId === undefined ? {} : { characterId }),
    text: longest.text,
    keys,
    importance,
    ...(longest.sourceSessionId === undefined ? {} : { sourceSessionId: longest.sourceSessionId }),
    sourceMessageIds,
    createdBy,
  };
}

/**
 * 找近重复的长期记忆并给出合并建议。
 *
 * 只在**同一个角色作用域**内合并（`characterId` 相同才算一组）：跨角色合并会把设定串到一起，
 * 那种"建议"宁可不提。
 */
export function proposeMemoriesMerge(input: { state: MaterializedState; threshold?: number }): TunerProposal[] {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const live = Object.values(input.state.memories).filter((memory) => memory.deleted === undefined);
  const used = new Set<string>();
  const proposals: TunerProposal[] = [];

  for (const memory of [...live].sort((left, right) => left.id.localeCompare(right.id))) {
    if (used.has(memory.id)) continue;
    const group = live.filter((other) => {
      if (other.id === memory.id || used.has(other.id)) return false;
      if ((other.characterId ?? '') !== (memory.characterId ?? '')) return false;
      const score = similarity(memory.text, other.text);
      return score >= threshold;
    });
    if (group.length === 0) continue;

    const members = [memory, ...group];
    for (const member of members) used.add(member.id);
    const merged = mergedPayload(members);
    const scores = group.map((other) => similarity(memory.text, other.text).toFixed(2));
    proposals.push({
      id: fnv(members.map((member) => member.id).join('|')),
      kind: 'memory.merge',
      title: `合并 ${members.length} 条相近的长期记忆`,
      reason: '它们的文本高度重叠，分开注入会占掉两份预算，还容易让模型重复同一件事',
      evidence: [
        `成员：${members.map((member) => member.id).join('、')}`,
        `与首条的相似度：${scores.join('、')}（阈值 ${threshold}）`,
        `合并后保留最长文本（${merged.text.length} 字），关键词与来源取并集，重要度取最大`,
      ],
      apply: { upserts: [merged], deletes: members.map((member) => member.id) },
      // 撤销：把原条目按原内容写回，再把合并出来的那条删掉
      inverse: { upserts: members.map(toPayload), deletes: [merged.memoryId] },
    });
  }

  return proposals;
}

/**
 * 用户批准后**才**产出 op —— 这是整个模块里唯一会造 op 的地方，而它必须拿到 base。
 *
 * 同时把"怎么撤销"写进 op 日志（`tuner.undo.<提案 id>`）：撤销依据跟着事实源走，跨重启还在。
 */
export function applyProposal(proposal: TunerProposal, base: TunerBase): { ops: Op[]; ledgerKey: string } {
  const ledgerKey = `${LEDGER_PREFIX}${proposal.id}`;
  const ops: Op[] = [
    ...proposal.apply.upserts.map((payload) => memoryUpsert(base, payload)),
    ...proposal.apply.deletes.map((memoryId) => memoryDelete(base, { memoryId })),
    settingSet(base, { key: ledgerKey, value: JSON.stringify({ kind: proposal.kind, inverse: proposal.inverse }) }),
  ];
  return { ops, ledgerKey };
}

export interface TunerLedgerEntry {
  proposalId: string;
  kind: string;
  inverse: MemoryMergeChange;
}

/** 最近一次"还能撤销"的应用（值被清空表示已撤销）。 */
export function pendingUndo(state: MaterializedState): TunerLedgerEntry | undefined {
  const keys = Object.keys(state.settings)
    .filter((key) => key.startsWith(LEDGER_PREFIX))
    .sort();
  for (const key of keys.reverse()) {
    // 设置值在物化状态里是包着的（`{ value, hlc, opId }`）——LWW 用的就是那个 hlc
    const stored = state.settings[key];
    const raw = typeof stored?.value === 'string' ? stored.value : undefined;
    if (raw === undefined || raw === '') continue;
    try {
      const parsed = JSON.parse(raw) as { kind?: string; inverse?: MemoryMergeChange };
      if (parsed.inverse === undefined || typeof parsed.kind !== 'string') continue;
      return { proposalId: key.slice(LEDGER_PREFIX.length), kind: parsed.kind, inverse: parsed.inverse };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** 撤销：按记录的原内容写回、删掉合并项，并把账本条目标成已撤销。 */
export function undoOps(entry: TunerLedgerEntry, base: TunerBase): Op[] {
  return [
    ...entry.inverse.upserts.map((payload) => memoryUpsert(base, payload)),
    ...entry.inverse.deletes.map((memoryId) => memoryDelete(base, { memoryId })),
    settingSet(base, { key: `${LEDGER_PREFIX}${entry.proposalId}`, value: '' }),
  ];
}
