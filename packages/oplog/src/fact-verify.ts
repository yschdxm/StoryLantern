import { retrieve, type RetrievalDoc } from './retrieval.ts';
import type { FactLike } from './fact-logic.ts';

/**
 * provenance **自动核对**（M4）：光有"源消息 id"不够 —— 还要看看那条消息是不是真的支持这条事实。
 *
 * 做法是纯词法检索（零依赖 BM25，见 retrieval.ts），判据只有一条：
 *
 *   **把整个会话的消息都放进检索池，用事实本身的文字去查；如果排第一的那条正好是它引用的消息，
 *   这条 provenance 就算"已核对"。**
 *
 * 为什么是"排第一"而不是"分数够高"：分数没有绝对标尺（长文本天然占优），而"这条事实的出处就是它"
 * 是个**相对**判断。反过来，若排第一的是**另一条**消息，那这条事实的 provenance 就可疑 ——
 * 这正是"引用了但引用错"的情形，必须能被看见，而不是被一个阈值糊过去。
 *
 * 反例（也测了）：事实文本与所引消息毫无词面重合时会被判"未核对" —— 这是词法的固有局限，
 * 语义核对要 embedding，今天没有，不假装有。
 */

export interface ProvenanceMessage {
  id: string;
  content: string;
}

export interface ProvenanceCheck {
  /** 引用的消息是不是这条事实最可能的出处。 */
  verified: boolean;
  /** 检索给出的第一名（可能是别的消息）。 */
  topId?: string;
  topScore: number;
  /** 人话解释：为什么判成这个结果（界面照实显示）。 */
  reason: string;
}

export function verifyProvenance(
  fact: Pick<FactLike, 'id' | 'subject' | 'predicate' | 'object' | 'text' | 'sourceMessageIds'>,
  messages: readonly ProvenanceMessage[],
): ProvenanceCheck {
  const cited = new Set(fact.sourceMessageIds);
  if (fact.sourceMessageIds.length === 0) {
    return { verified: false, topScore: 0, reason: '没有来源消息' };
  }
  if (messages.length === 0) {
    return { verified: false, topScore: 0, reason: '拿不到消息内容，无法核对' };
  }
  const docs: RetrievalDoc[] = messages.map((message) => ({ id: message.id, text: message.content, kind: 'message' }));
  // 用「主语 + 宾语」查：谓词常常是"身份/来历"这类抽象词，参与检索反而引入噪声
  const query = `${fact.subject} ${fact.object}`;
  const ranked = retrieve(query, docs, { limit: 1 });
  const top = ranked[0];
  if (top === undefined) {
    return { verified: false, topScore: 0, reason: '在会话里找不到任何相关消息（可能这些消息已不在本地）' };
  }
  if (cited.has(top.id)) {
    return {
      verified: true,
      topId: top.id,
      topScore: top.score,
      reason: '引用的消息正是这条事实最可能的出处',
    };
  }
  return {
    verified: false,
    topId: top.id,
    topScore: top.score,
    reason: `这条事实最可能出自另一条消息（${top.id}），而不是它引用的那些`,
  };
}
