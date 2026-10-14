import type { Hlc } from './hlc.ts';
import type { MessageAuthor } from './op.ts';

/** 物化状态的记录类型。独立成文件，便于 protocol 层（快照/编解码）只依赖类型。 */

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

/**
 * 角色卡。字段用整体 LWW（`updatedHlc`）：这样"先收到更新、后收到创建"也能收敛，
 * 不需要把更新当成孤儿去等创建——角色卡本来就没有"必须先创建"的不变量。
 */
export interface CharacterRecord {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  updatedHlc: Hlc;
  opId: string;
  /**
   * 墓碑：删除也是一次带 HLC 的写入。
   * 删除与 upsert **共用同一条时间线**——否则乱序时"更旧的删除"会盖掉"更新的编辑"。
   */
  deleted?: { hlc: Hlc; opId: string };
}

export interface MaterializedState {
  characters: Record<string, CharacterRecord>;
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
