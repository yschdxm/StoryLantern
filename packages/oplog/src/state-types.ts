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
