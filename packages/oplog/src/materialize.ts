import { compareHlc, compareOpOrder, type Hlc } from './hlc.ts';
import type { MessageAuthor, Op } from './op.ts';

export interface RevisionRecord {
  revisionId: string;
  content: string;
  /** null 表示这是消息的首版；否则是它改写的基线版本。 */
  baseRevisionId: string | null;
  hlc: Hlc;
  opId: string;
  deviceId: string;
}

export interface CandidateRecord {
  candidateId: string;
  content: string;
  hlc: Hlc;
  opId: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  author: MessageAuthor;
  appendHlc: Hlc;
  appendOpId: string;
  revisions: RevisionRecord[];
  /** 当前正文版本。`explicit` 表示用户显式选过。 */
  activeRevision: { revisionId: string; hlc: Hlc; explicit: boolean };
  candidates: CandidateRecord[];
  selectedCandidate?: { candidateId: string; hlc: Hlc };
  deleted?: { hlc: Hlc };
}

export interface SessionRecord {
  id: string;
  title: string;
  titleHlc: Hlc;
  characterId?: string;
  forkedFrom?: string;
}

export interface MaterializedState {
  sessions: Record<string, SessionRecord>;
  messages: Record<string, MessageRecord>;
  settings: Record<string, { value: unknown; hlc: Hlc; opId: string }>;
}

export interface Snapshot {
  version: 1;
  state: MaterializedState;
  /** 已应用的 opId：投递是 at-least-once，因此幂等必须靠它。 */
  appliedOpIds: string[];
}

export interface ForkGroup {
  baseRevisionId: string | null;
  revisionIds: string[];
}

function emptyState(): MaterializedState {
  return { sessions: {}, messages: {}, settings: {} };
}

function cloneHlc(hlc: Hlc): Hlc {
  return { t: hlc.t, c: hlc.c };
}

function laterThan(a: Hlc, b: Hlc | undefined, tieA: string, tieB: string | undefined): boolean {
  if (!b || !tieB) return true;
  const byHlc = compareHlc(a, b);
  if (byHlc !== 0) return byHlc > 0;
  return tieA > tieB;
}

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

  /** 会话内的消息顺序：按 append 的 HLC 排序派生，因此与到达顺序无关。 */
  orderOf(sessionId: string): MessageRecord[] {
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

  /** 深拷贝快照，便于测试"两个副本收敛到相同状态"。 */
  static freeze(snapshot: Snapshot): string {
    return JSON.stringify({
      version: snapshot.version,
      sessions: Object.fromEntries(
        Object.entries(snapshot.state.sessions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, session]) => [id, { ...session }]),
      ),
      messages: Object.fromEntries(
        Object.entries(snapshot.state.messages)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, message]) => [
            id,
            {
              ...message,
              revisions: [...message.revisions].sort((a, b) => a.revisionId.localeCompare(b.revisionId)),
              candidates: [...message.candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
            },
          ]),
      ),
      settings: Object.fromEntries(
        Object.entries(snapshot.state.settings)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, value]),
      ),
      appliedOpIds: [...snapshot.appliedOpIds].sort(),
    });
  }

  #dispatch(op: Op): ApplyResult {
    switch (op.type) {
      case 'session.create':
        return this.#sessionCreate(op);
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
      default:
        // 未知 op 类型：向前兼容地忽略（未来版本写入的新 op 不应让旧客户端崩溃）。
        return 'applied';
    }
  }

  #sessionCreate(op: Op): ApplyResult {
    const payload = op.payload as { title: string; characterId?: string; forkedFrom?: string };
    const existing = this.#state.sessions[op.entity.id];
    if (!existing) {
      const record: SessionRecord = { id: op.entity.id, title: payload.title, titleHlc: cloneHlc(op.hlc) };
      if (payload.characterId !== undefined) record.characterId = payload.characterId;
      if (payload.forkedFrom !== undefined) record.forkedFrom = payload.forkedFrom;
      this.#state.sessions[op.entity.id] = record;
      return 'applied';
    }
    if (laterThan(op.hlc, existing.titleHlc, op.opId, undefined)) {
      existing.title = payload.title;
      existing.titleHlc = cloneHlc(op.hlc);
      if (payload.characterId !== undefined) existing.characterId = payload.characterId;
    }
    return 'applied';
  }

  #messageAppend(op: Op): ApplyResult {
    const payload = op.payload as { sessionId: string; messageId: string; author: MessageAuthor; content: string };
    const existing = this.#state.messages[payload.messageId];
    const revisionId = `${payload.messageId}:r0`;

    if (!existing) {
      const record: MessageRecord = {
        id: payload.messageId,
        sessionId: payload.sessionId,
        author: payload.author,
        appendHlc: cloneHlc(op.hlc),
        appendOpId: op.opId,
        revisions: [
          { revisionId, content: payload.content, baseRevisionId: null, hlc: cloneHlc(op.hlc), opId: op.opId, deviceId: op.deviceId },
        ],
        activeRevision: { revisionId, hlc: cloneHlc(op.hlc), explicit: false },
        candidates: [],
      };
      this.#state.messages[payload.messageId] = record;
      return 'applied';
    }

    // 同一个 messageId 被两个设备各写一次（只可能来自克隆的设备数据）：保留首版语义，补上缺的版本。
    if (!existing.revisions.some((revision) => revision.revisionId === revisionId)) {
      existing.revisions.push({
        revisionId,
        content: payload.content,
        baseRevisionId: null,
        hlc: cloneHlc(op.hlc),
        opId: op.opId,
        deviceId: op.deviceId,
      });
    }
    if (compareOpOrder({ hlc: op.hlc, opId: op.opId }, { hlc: existing.appendHlc, opId: existing.appendOpId }) < 0) {
      existing.appendHlc = cloneHlc(op.hlc);
      existing.appendOpId = op.opId;
    }
    return 'applied';
  }

  #messageEdit(op: Op): ApplyResult {
    const payload = op.payload as { messageId: string; revisionId: string; baseRevisionId: string; content: string };
    const message = this.#state.messages[payload.messageId];
    if (!message) return 'orphan';

    if (!message.revisions.some((revision) => revision.revisionId === payload.revisionId)) {
      message.revisions.push({
        revisionId: payload.revisionId,
        content: payload.content,
        baseRevisionId: payload.baseRevisionId,
        hlc: cloneHlc(op.hlc),
        opId: op.opId,
        deviceId: op.deviceId,
      });
    }

    const active = message.activeRevision;
    const newer = laterThan(op.hlc, active.hlc, op.opId, undefined);
    // 显式选择过的版本可以压过更早的编辑；但更新的编辑一定生效（用户刚改完就该看到）。
    if (active.explicit && !newer) return 'applied';
    if (newer) {
      message.activeRevision = { revisionId: payload.revisionId, hlc: cloneHlc(op.hlc), explicit: false };
    }
    return 'applied';
  }

  #revisionSelect(op: Op): ApplyResult {
    const payload = op.payload as { messageId: string; revisionId: string };
    const message = this.#state.messages[payload.messageId];
    if (!message) return 'orphan';
    if (!message.revisions.some((revision) => revision.revisionId === payload.revisionId)) return 'orphan';
    if (!laterThan(op.hlc, message.activeRevision.hlc, op.opId, undefined)) return 'applied';
    message.activeRevision = { revisionId: payload.revisionId, hlc: cloneHlc(op.hlc), explicit: true };
    return 'applied';
  }

  #candidateAppend(op: Op): ApplyResult {
    const payload = op.payload as { messageId: string; candidateId: string; content: string };
    const message = this.#state.messages[payload.messageId];
    if (!message) return 'orphan';
    if (message.candidates.some((candidate) => candidate.candidateId === payload.candidateId)) return 'applied';
    message.candidates.push({
      candidateId: payload.candidateId,
      content: payload.content,
      hlc: cloneHlc(op.hlc),
      opId: op.opId,
    });
    return 'applied';
  }

  #candidateSelect(op: Op): ApplyResult {
    const payload = op.payload as { messageId: string; candidateId: string };
    const message = this.#state.messages[payload.messageId];
    if (!message) return 'orphan';
    if (!message.candidates.some((candidate) => candidate.candidateId === payload.candidateId)) return 'orphan';
    const current = message.selectedCandidate;
    if (current && !laterThan(op.hlc, current.hlc, op.opId, undefined)) return 'applied';
    message.selectedCandidate = { candidateId: payload.candidateId, hlc: cloneHlc(op.hlc) };
    return 'applied';
  }

  #messageDelete(op: Op): ApplyResult {
    const payload = op.payload as { messageId: string };
    const message = this.#state.messages[payload.messageId];
    if (!message) return 'orphan';
    if (message.deleted && !laterThan(op.hlc, message.deleted.hlc, op.opId, undefined)) return 'applied';
    message.deleted = { hlc: cloneHlc(op.hlc) };
    return 'applied';
  }

  #settingSet(op: Op): ApplyResult {
    const payload = op.payload as { key: string; value: unknown };
    const existing = this.#state.settings[payload.key];
    if (existing && !laterThan(op.hlc, existing.hlc, op.opId, existing.opId)) return 'applied';
    this.#state.settings[payload.key] = { value: payload.value, hlc: cloneHlc(op.hlc), opId: op.opId };
    return 'applied';
  }
}
