/**
 * 检索（M4 的第三块）：**零依赖的词法检索**，BM25 打分。
 *
 * PLAN §6 写的是混合检索（FTS5 BM25 + 向量），这里先把 BM25 这一半做出来：
 *  - 为什么先做它：它不需要模型、不需要 embedding、不需要宿主（FTS5 也没有），
 *    在浏览器与 Node 里行为完全一致，因此**今天就能用固定语料量召回**；
 *  - 为什么用**双字切片**（bigram）处理中文：中文不按空格分词，而"单字"区分度太低
 *    （"的"会命中一切）。双字切片是零依赖下最稳的做法：不需要词典，召回够用；
 *  - 向量那一半等有 embedding 来源（本地模型或 API）再说 —— **不假装已经做了**。
 *
 * 这个模块是纯函数：给它一批文档和一句查询，它给出排名。谁把文档喂进来（消息？摘要？世界书？）
 * 由调用方决定，检索本身不关心。
 */

export type RetrievalKind = 'message' | 'summary' | 'memory' | 'lore';

export interface RetrievalDoc {
  id: string;
  text: string;
  kind: RetrievalKind;
  /** 摘要之类"覆盖了哪些下层内容"的文档可以带上它，便于调用方回溯来源。 */
  covers?: readonly string[];
}

export interface ScoredDoc {
  id: string;
  kind: RetrievalKind;
  score: number;
  covers?: readonly string[];
}

export interface RetrieveOptions {
  /** 返回前多少个（默认 8）。 */
  limit?: number;
  /** BM25 参数：k1 控制词频饱和，b 控制长度归一。都是业界默认值，没有为我们的语料特意调过。 */
  k1?: number;
  b?: number;
  /** 只在这些 kind 里检索。 */
  kinds?: readonly RetrievalKind[];
}

/**
 * 切词：拉丁按词、CJK 按**双字**切片。
 *
 * 例：「她的真名是阿霜」→ 她的 / 的真 / 真名 / 名是 / 是阿 / 阿霜。
 * 标点与空白被丢掉；单字 CJK 串（如"灯"）单独保留一个字，否则会被切空。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // 先按"非字母数字非 CJK"切开，再对每一段分别处理
  for (const segment of lower.split(/[^\p{Script=Han}\p{L}\p{N}]+/u)) {
    if (segment === '') continue;
    const isCjk = /[\p{Script=Han}]/u.test(segment);
    if (!isCjk) {
      tokens.push(segment);
      continue;
    }
    // CJK：连续汉字取双字；同时把整段里的拉丁/数字也单独收进来
    const chars = [...segment];
    if (chars.length === 1) tokens.push(chars[0] ?? '');
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const pair = `${chars[index] ?? ''}${chars[index + 1] ?? ''}`;
      if (/[\p{Script=Han}]/u.test(pair) || pair.length === 2) tokens.push(pair);
    }
  }
  return tokens;
}

function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * BM25 检索。分数只用于**排序**，不是概率，也不该跨语料比较。
 * 空查询返回空数组（不做"随便给点东西"的兜底）。
 */
export function retrieve(query: string, docs: readonly RetrievalDoc[], options: RetrieveOptions = {}): ScoredDoc[] {
  const limit = options.limit ?? 8;
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const kinds = options.kinds;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0 || limit <= 0) return [];

  const pool = kinds === undefined ? docs : docs.filter((doc) => kinds.includes(doc.kind));
  if (pool.length === 0) return [];

  const docTokens = pool.map((doc) => tokenize(doc.text));
  const lengths = docTokens.map((tokens) => tokens.length);
  const avgdl = lengths.reduce((sum, value) => sum + value, 0) / lengths.length || 1;

  // 文档频率
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }

  const wanted = [...new Set(queryTokens)];
  const scored: ScoredDoc[] = [];
  for (let index = 0; index < pool.length; index += 1) {
    const doc = pool[index];
    if (doc === undefined) continue;
    const tf = termFrequencies(docTokens[index] ?? []);
    const dl = lengths[index] ?? 0;
    let score = 0;
    for (const token of wanted) {
      const frequency = tf.get(token) ?? 0;
      if (frequency === 0) continue;
      const docFrequency = df.get(token) ?? 0;
      const idf = Math.log(1 + (pool.length - docFrequency + 0.5) / (docFrequency + 0.5));
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * dl) / avgdl)));
    }
    if (score > 0) {
      scored.push({ id: doc.id, kind: doc.kind, score, ...(doc.covers === undefined ? {} : { covers: doc.covers }) });
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}
