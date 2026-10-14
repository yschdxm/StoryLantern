import { compareOpOrder, type Hlc } from './hlc.ts';
import { freezeSnapshot } from './freeze.ts';
import { applyCharacterDelete, applyCharacterUpsert, listCharacters } from './character-projection.ts';
import { applySessionDelete, applySessionUpsert, liveSessions } from './session-projection.ts';
import {
  applyCandidateAppend,
  applyCandidateSelect,
  applyMessageAppend,
  applyMessageDelete,
  applyMessageEdit,
  applyRevisionSelect,
  applySettingSet,
} from './message-projection.ts';
import { cloneHlc, emptyState, laterThan } from './materialize-support.ts';
import {
  applyLoreEntryDelete,
  applyLoreEntryUpsert,
  applyLorebookDelete,
  applyLorebookUpsert,
  listLorebooks,
} from './lorebook-projection.ts';
import { applyMemoryDelete, applyMemoryUpsert, listMemories, memoriesFor } from './memory-projection.ts';
import type { MessageAuthor, Op } from './op.ts';
import type { SessionSnapshot } from './snapshot.ts';
import type {
  CandidateRecord,
  CharacterRecord,
  ForkGroup,
  LorebookRecord,
  MaterializedState,
  MemoryRecord,
  MessageRecord,
  RevisionRecord,
  SessionRecord,
  Snapshot,
} from './state-types.ts';

export type {
  CandidateRecord,
  CharacterRecord,
  ForkGroup,
  LoreEntryRecord,
  LorebookRecord,
  MaterializedState,
  MemoryRecord,
  MessageRecord,
  RevisionRecord,
  SessionRecord,
  Snapshot,
} from './state-types.ts';

type ApplyResult = 'applied' | 'duplicate' | 'orphan';

/**
 * 物化器：把 op 重放成可查询的状态。
 *
 * 两条不变量：
 *  1. **幂等**：同一个 opId 应用多次结果不变（投递是 at-least-once）。
 *  2. **收敛**：同一批 op 无论以什么顺序送达，最终状态一致——所有
 *     "谁赢"的判断都用 HLC 比较，`order` 这类顺序信息在读取时按 HLC 排序派生，
 *     而不是按到达顺序累加。
 */
export class Materializer {
  #state: MaterializedState = emptyState();
  #applied = new Set<string>();
  #orphans: Op[] = [];

  constructor(snapshot?: Snapshot) {
    if (snapshot) {
      this.#state = snapshot.state;
      this.#applied = new Set(snapshot.appliedOpIds);
    }
  }

  get state(): MaterializedState {
    return this.#state;
  }

  get appliedCount(): number {
    return this.#applied.size;
  }

  get orphanCount(): number {
    return this.#orphans.length;
  }

  apply(op: Op): ApplyResult {
    if (this.#applied.has(op.opId)) return 'duplicate';

    const result = this.#dispatch(op);
    if (result === 'orphan') {
      this.#orphans.push(op);
      return 'orphan';
    }
    this.#applied.add(op.opId);
    return 'applied';
  }

  /** 按 HLC 全序重放，并清空孤儿队列（先到的编辑等被 append 补上后即可落地）。 */
  applyAll(ops: readonly Op[]): { applied: number; duplicates: number; orphans: number } {
    const sorted = [...ops].sort(compareOpOrder);
    let applied = 0;
    let duplicates = 0;
    for (const op of sorted) {
      const result = this.apply(op);
      if (result === 'applied') applied += 1;
      else if (result === 'duplicate') duplicates += 1;
    }

    // 最多两轮：孤儿里的编辑可能依赖另一个孤儿里的 append。
    for (let round = 0; round < 2 && this.#orphans.length > 0; round += 1) {
      const pending = [...this.#orphans].sort(compareOpOrder);
      this.#orphans = [];
      for (const op of pending) {
        const result = this.#dispatch(op);
        if (result === 'applied') {
          this.#applied.add(op.opId);
        } else if (result === 'orphan') {
          this.#orphans.push(op);
        } else {
          this.#applied.add(op.opId);
        }
      }
    }

    return { applied, duplicates, orphans: this.#orphans.length };
  }

  /** 角色列表：按最后更新时间倒序（界面列表的顺序），墓碑不出现在结果里。 */
  characters(): CharacterRecord[] {
    return listCharacters(this.#state);
  }

  /** 未被删除的会话（顺序由上层按"最近活跃"决定）。 */
  sessions(): SessionRecord[] {
    return liveSessions(this.#state);
  }

  /** 世界书列表（墓碑不出现）。 */
  lorebooks(): LorebookRecord[] {
    return listLorebooks(this.#state);
  }

  /** 某本世界书（被删掉的返回 undefined）。 */
  lorebook(id: string): LorebookRecord | undefined {
    const book = this.#state.lorebooks[id];
    return book === undefined || book.deleted !== undefined ? undefined : book;
  }

  /**
   * 与某个角色相关的世界书：绑定了它的 + 全局的（`characterIds` 为空）。
   * 扫描时只看这一批，避免无关的书参与关键词匹配。
   */
  lorebooksFor(characterId: string | undefined): LorebookRecord[] {
    return this.lorebooks().filter(
      (book) => book.enabled && (book.characterIds.length === 0 || (characterId !== undefined && book.characterIds.includes(characterId))),
    );
  }

  /** 长期记忆列表（墓碑不出现）。 */
  memories(): MemoryRecord[] {
    return listMemories(this.#state);
  }

  /** 与某个角色相关的记忆：绑定了它的 + 全局的。 */
  memoriesFor(characterId: string | undefined): MemoryRecord[] {
    return memoriesFor(this.#state, characterId);
  }

  /** 会话内的消息顺序：按 append 的 HLC 排序派生，因此与到达顺序无关。 */  orderOf(sessionId: string): MessageRecord[] {
    return Object.values(this.#state.messages)
      .filter((message) => message.sessionId === sessionId && message.deleted === undefined)
      .sort((a, b) => compareOpOrder(
        { hlc: a.appendHlc, opId: a.appendOpId },
        { hlc: b.appendHlc, opId: b.appendOpId },
      ));
  }

  /** 消息的显示正文：优先选中的候选（swipe），否则当前正文版本。 */
  textOf(messageId: string): string | undefined {
    const message = this.#state.messages[messageId];
    if (!message || message.deleted) return undefined;
    if (message.selectedCandidate) {
      const candidate = message.candidates.find((item) => item.candidateId === message.selectedCandidate?.candidateId);
      if (candidate) return candidate.content;
    }
    return message.revisions.find((item) => item.revisionId === message.activeRevision.revisionId)?.content;
  }


  /** 消息的生成状态（界面显示"失败"用）。 */
  statusOf(messageId: string): 'done' | 'error' {
    return this.#state.messages[messageId]?.status ?? 'done';
  }

  /**
   * 分叉检测：同一个基线版本有多个子版本，说明两台设备基于同一版本各改了一次。
   * 这是纯粹的结构判定（按 baseRevisionId 分组），因此与送达顺序无关，
   * 也不会静默丢掉任何一版。
   */
  forksOf(messageId: string): ForkGroup[] {
    const message = this.#state.messages[messageId];
    if (!message) return [];
    const groups = new Map<string, string[]>();
    for (const revision of message.revisions) {
      const key = revision.baseRevisionId ?? '';
      const list = groups.get(key);
      if (list) list.push(revision.revisionId);
      else groups.set(key, [revision.revisionId]);
    }
    return [...groups.entries()]
      .filter(([, revisionIds]) => revisionIds.length > 1)
      .map(([key, revisionIds]) => ({ baseRevisionId: key === '' ? null : key, revisionIds: revisionIds.sort() }));
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      state: this.#state,
      appliedOpIds: [...this.#applied].sort(),
    };
  }

  /**
   * 导出某个会话的快照（换机/首次同步用）。
   * `watermarks` 由调用方给出：它知道"该会话已并入各设备的第几号段"。
   */
  exportSessionSnapshot(input: {
    deviceId: string;
    blindSessionId: string;
    sessionId: string;
    watermarks: Record<string, number>;
    now?: number;
  }): SessionSnapshot {
    const messages = Object.values(this.#state.messages).filter((message) => message.sessionId === input.sessionId);
    const appliedOpIds: string[] = [];
    for (const message of messages) {
      appliedOpIds.push(message.appendOpId);
      for (const revision of message.revisions) appliedOpIds.push(revision.opId);
      for (const candidate of message.candidates) appliedOpIds.push(candidate.opId);
    }

    const session = this.#state.sessions[input.sessionId];
    return {
      v: 1,
      deviceId: input.deviceId,
      blindSessionId: input.blindSessionId,
      createdAt: input.now ?? Date.now(),
      watermarks: { ...input.watermarks },
      appliedOpIds,
      ...(session === undefined ? {} : { session }),
      messages,
    };
  }

  /**
   * 恢复快照：**只补本地缺失的消息**，已存在的一律保留本地版本。
   * 这条"本地优先"规则很重要：快照可能比本地旧，宁可少补也不能覆盖已有的编辑。
   */
  restoreSessionSnapshot(snapshot: SessionSnapshot): { restoredMessages: number; skippedExisting: number } {
    let restoredMessages = 0;
    let skippedExisting = 0;

    if (snapshot.session && !this.#state.sessions[snapshot.session.id]) {
      this.#state.sessions[snapshot.session.id] = snapshot.session;
    }

    for (const message of snapshot.messages) {
      if (this.#state.messages[message.id]) {
        skippedExisting += 1;
        continue;
      }
      this.#state.messages[message.id] = message;
      restoredMessages += 1;
    }

    // 把快照覆盖的 op 标记为已应用：尾巴段落里若重复出现这些 op，会被幂等去重。
    for (const opId of snapshot.appliedOpIds) this.#applied.add(opId);

    return { restoredMessages, skippedExisting };
  }

  /** 规范化序列化（先排序），便于断言"两个副本是否收敛"。实现见 `freeze.ts`。 */
  static freeze(snapshot: Snapshot): string {
    return freezeSnapshot(snapshot);
  }

  #dispatch(op: Op): ApplyResult {
    switch (op.type) {
      case 'character.upsert':
        return this.#characterUpsert(op);
      case 'character.delete':
        return this.#characterDelete(op);
      case 'session.create':
        return this.#sessionCreate(op);
      case 'session.delete':
        return this.#sessionDelete(op);
      case 'message.append':
        return this.#messageAppend(op);
      case 'message.edit':
        return this.#messageEdit(op);
      case 'message.revision.select':
        return this.#revisionSelect(op);
      case 'message.candidate.append':
        return this.#candidateAppend(op);
      case 'message.candidate.select':
        return this.#candidateSelect(op);
      case 'message.delete':
        return this.#messageDelete(op);
      case 'setting.set':
        return this.#settingSet(op);
      case 'lorebook.upsert':
        return applyLorebookUpsert(this.#state, op);
      case 'lorebook.delete':
        return applyLorebookDelete(this.#state, op);
      case 'lore.entry.upsert':
        return applyLoreEntryUpsert(this.#state, op);
      case 'lore.entry.delete':
        return applyLoreEntryDelete(this.#state, op);
      case 'memory.upsert':
        return applyMemoryUpsert(this.#state, op);
      case 'memory.delete':
        return applyMemoryDelete(this.#state, op);
      default:
        // 未知 op 类型：向前兼容地忽略（未来版本写入的新 op 不应让旧客户端崩溃）。
        return 'applied';
    }
  }

  /**
   * 角色卡：整体覆盖 + LWW，删除是共用时间线的墓碑。语义在 `character-projection.ts` 里，这里只转发。
   */
  #characterUpsert(op: Op): ApplyResult {
    applyCharacterUpsert(this.#state, op);
    return 'applied';
  }

  #characterDelete(op: Op): ApplyResult {
    applyCharacterDelete(this.#state, op);
    return 'applied';
  }

  #sessionCreate(op: Op): ApplyResult {
    applySessionUpsert(this.#state, op);
    return 'applied';
  }

  #sessionDelete(op: Op): ApplyResult {
    applySessionDelete(this.#state, op);
    return 'applied';
  }

  /** 消息与设置的语义在 `message-projection.ts` 里，这里只转发（保持门禁 400 行以内）。 */
  #messageAppend(op: Op): ApplyResult {
    return applyMessageAppend(this.#state, op);
  }

  #messageEdit(op: Op): ApplyResult {
    return applyMessageEdit(this.#state, op);
  }

  #revisionSelect(op: Op): ApplyResult {
    return applyRevisionSelect(this.#state, op);
  }

  #candidateAppend(op: Op): ApplyResult {
    return applyCandidateAppend(this.#state, op);
  }

  #candidateSelect(op: Op): ApplyResult {
    return applyCandidateSelect(this.#state, op);
  }

  #messageDelete(op: Op): ApplyResult {
    return applyMessageDelete(this.#state, op);
  }

  #settingSet(op: Op): ApplyResult {
    return applySettingSet(this.#state, op);
  }
}
