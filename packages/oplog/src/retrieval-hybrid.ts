import { retrieve, tokenize, type RetrieveOptions, type RetrievalDoc, type ScoredDoc } from './retrieval.ts';
import type { RerankPort } from './rerank-openai.ts';

/**
 * 混合检索（M4 第三块的另一半）：**BM25 + 向量**，用 RRF 合并。
 *
 * 为什么用 RRF（Reciprocal Rank Fusion）而不是加权求和：两种检索的分数**不可比**
 * （BM25 是无界实数、余弦是 [-1,1]），加权求和要先归一化再调权重，而权重只能靠调参猜。
 * RRF 只看**名次**：score = Σ 1/(k + rank)，k 取 60 是文献里的常用值。它不需要调参，也不会
 * 因为某个检索器的分数尺度变化而失效 —— 这正是"零依赖、可解释"想要的。
 *
 * **回退规则（三条，写死在这里，结果里报告实际用了哪条）**：
 *  1. 没给 embedder → 纯词法（\`mode: 'lexical'\`）；
 *  2. embedder 报错 → 告警 + 纯词法（\`mode: 'lexical-fallback'\`），**绝不因为向量挂了就没有结果**；
 *  3. 两边都成 → RRF 合并（\`mode: 'hybrid'\`）。
 *
 * **本环境没有真实 embedding 来源**（没有本地模型、也没有 embedding API key），所以：
 *  - 生产路径**不注册** embedder，实际跑的就是词法那半（这一条在文档与界面上都要说清楚）；
 *  - 测试用的 \`createHashEmbeddingStub\` 是**桩**：它把文本哈希成向量，**不是语义检索**，
 *    只能用来验证"混合检索的管线与回退规则是对的"，**不能**用它证明召回变好（那需要真 embedding）。
 */

export interface EmbeddingPort {
  /** 来源标识（会显示在结果里，便于用户知道"现在用的是谁"）。 */
  readonly id: string;
  /** 把若干文本转成向量；维度自定，但同一个 port 必须一致。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export type RetrievalMode = 'lexical' | 'lexical-fallback' | 'hybrid';

export interface HybridRetrieveOptions extends RetrieveOptions {
  /** 向量来源；不给就纯词法。 */
  embedder?: EmbeddingPort | undefined;
  /** 已缓存的文档向量（键 = 文档 id）。给了就不重复算 —— 真实应用应当缓存。 */
  vectors?: ReadonlyMap<string, readonly number[]> | undefined;
  /** 向量那一路先取前几名送进 RRF（默认与 limit 相同）。 */
  vectorLimit?: number | undefined;
  /** RRF 的 k（默认 60）。 */
  rrfK?: number | undefined;
  /**
   * 融合后是否再重排。四种取值：
   *  - `'none'`（默认）：不重排；
   *  - `'lexical'`：纯词法重排（词项覆盖率 + 短语命中，零成本，偏字面）；
   *  - `'embedding'`：用 **embedding 模型的余弦**重排（复用已算好的向量，不额外花钱；
   *    注意它不是 rerank 模型 —— 双塔模型，比较粗）；
   *  - `'model'`：用 **rerank 模型**（交叉编码器）重排 —— 需要传 `reranker`；这是排序最准的那条，
   *    代价是额外一次网络调用（工程上先检索 20 条、再 rerank 出前 5）。
   * 开了重排但缺少必要输入（无 embedder/无 reranker/无向量）时，不静默降级，在 notes 里写清原因。
   */
  rerank?: 'none' | 'lexical' | 'embedding' | 'model' | undefined;
  /** 词法重排参数（只在 rerank: 'lexical' 时生效）。 */
  rerankOptions?: RerankOptions | undefined;
  /** 向量余弦重排参数（只在 rerank: 'embedding' 时生效）。 */
  embeddingRerankOptions?: EmbeddingRerankOptions | undefined;
  /** rerank 模型（只在 rerank: 'model' 时用得到）。 */
  reranker?: RerankPort | undefined;
  /** rerank 模型重排的候选数（默认 20：先粗排 20 条再精细排，和工程实践一致）。 */
  rerankCandidates?: number | undefined;
}

export interface HybridRetrieveResult {
  mode: RetrievalMode;
  /** 实际参与合并的检索器标识（词法固定为 'bm25'）。 */
  sources: string[];
  docs: ScoredDoc[];
  /** 回退或降级的原因（当前只有向量失败这一种）。 */
  notes: string[];
}

/** 余弦相似度。零向量返回 0（不返回 NaN —— NaN 会让排序变成随机）。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * RRF 合并：输入若干"有序的 id 列表"，输出合并后的名次。
 * 返回 Map（id → 融合分），调用方自己决定怎么变成 ScoredDoc。
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return scores;
}

/** 纯向量的近邻（暴力余弦；PLAN 说的"超预算再上 HNSW"，这里先给暴力版）。 */
export function vectorSearch(
  queryVector: readonly number[],
  docs: readonly RetrievalDoc[],
  vectors: ReadonlyMap<string, readonly number[]>,
  limit: number,
): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const doc of docs) {
    const vector = vectors.get(doc.id);
    if (vector === undefined) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score > 0) scored.push({ id: doc.id, score });
  }
  return scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit);
}

/**
 * **词法重排（rerank）**：在 RRF 融合之后用完全透明的信号再排一次。
 *
 * 信号只有两个，都能解释给人听：
 *  1. **词项覆盖率**：查询里的词有多少出现在这段文本里（0..1）；
 *  2. **完整短语命中**：整句查询原样出现在文本里 → 加固定奖励。
 *
 * 为什么默认**不启用**：RRF 已经融合了两路检索，再加重词法权重会偏向字面命中，
 * 对"换了说法"的提问可能变差。没有量过就不该默认打开——要打开请先跑
 * `eval/long-chat/retrieval.test.ts` 那组对比，把数字写进结论。
 */
export interface RerankOptions {
  /** 覆盖率权重（默认 0.5）：score * (1 + weight * coverage)。 */
  coverageWeight?: number;
  /** 完整短语命中的固定奖励（默认 1，与 RRF 分数同量级）。 */
  phraseBonus?: number;
}

export function rerankDocs(
  query: string,
  candidates: readonly ScoredDoc[],
  docs: readonly RetrievalDoc[],
  options: RerankOptions = {},
): ScoredDoc[] {
  const coverageWeight = options.coverageWeight ?? 0.5;
  const phraseBonus = options.phraseBonus ?? 1;
  const queryTerms = new Set(tokenize(query));
  const textById = new Map(docs.map((doc) => [doc.id, doc.text]));
  const phrase = query.trim();
  if (queryTerms.size === 0) return [...candidates];
  return candidates
    .map((candidate) => {
      const text = textById.get(candidate.id) ?? '';
      const docTerms = new Set(tokenize(text));
      let hit = 0;
      for (const term of queryTerms) if (docTerms.has(term)) hit += 1;
      const coverage = hit / queryTerms.size;
      const bonus = phrase !== '' && text.includes(phrase) ? phraseBonus : 0;
      return { ...candidate, score: candidate.score * (1 + coverageWeight * coverage) + bonus };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

/**
 * **向量重排（embedding rerank）**：有模型时走这条，而不是拿词法启发式凑数。
 *
 * 输入是已经算好的查询向量与候选向量（混合检索那边本来就为了向量那一路算过了，
 * 重排**不额外花一次 API 调用**）：
 *   - RRF 分数归一化到 [0,1]；
 *   - 余弦**负值截到 0**（正交 = "没有相似信号"，不该被映射成 0.5 —— 那样不相关的候选会凭空拿半分，
 *     实测会让"RRF 高但与查询正交"的候选压过真正同向的候选）；
 *   - score = (1 - weight) * rrfNorm + weight * cosClipped。
 *
 * 没有向量的候选：默认保留并只用 RRF 分数（`missing: 'rrf-only'`），并**统计个数**由调用方决定怎么提示；
 * 也可以选 `'drop'` 直接丢掉（少一条结果，但不会把没算过的当作相似）。
 */
export interface EmbeddingRerankOptions {
  /** 向量分的权重（默认 0.5）。 */
  weight?: number;
  /** 没有向量的候选：保留按 RRF 排序（默认）或丢掉。 */
  missing?: 'rrf-only' | 'drop';
}

export interface EmbeddingRerankResult {
  docs: ScoredDoc[];
  /** 没有向量的候选数（如实回报，便于判断模型覆盖是否完整）。 */
  missingVectors: number;
}

export function rerankByEmbedding(
  queryVector: readonly number[],
  candidates: readonly ScoredDoc[],
  vectors: ReadonlyMap<string, readonly number[]>,
  options: EmbeddingRerankOptions = {},
): EmbeddingRerankResult {
  const weight = Math.min(1, Math.max(0, options.weight ?? 0.5));
  const missingMode = options.missing ?? 'rrf-only';
  const maxRrf = candidates.reduce((max, candidate) => Math.max(max, candidate.score), 0);
  let missingVectors = 0;
  const scored: ScoredDoc[] = [];
  for (const candidate of candidates) {
    const vector = vectors.get(candidate.id);
    if (vector === undefined) {
      missingVectors += 1;
      if (missingMode === 'drop') continue;
      scored.push({ ...candidate, score: maxRrf === 0 ? 0 : candidate.score / maxRrf });
      continue;
    }
    const rrfNorm = maxRrf === 0 ? 0 : candidate.score / maxRrf;
    const cosNorm = Math.max(0, cosineSimilarity(queryVector, vector));
    scored.push({ ...candidate, score: (1 - weight) * rrfNorm + weight * cosNorm });
  }
  scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { docs: scored, missingVectors };
}

export async function retrieveHybrid(
  query: string,
  docs: readonly RetrievalDoc[],
  options: HybridRetrieveOptions = {},
): Promise<HybridRetrieveResult> {
  const limit = options.limit ?? 8;
  const lexical = retrieve(query, docs, options);
  const notes: string[] = [];
  const embedder = options.embedder;
  if (embedder === undefined) {
    return { mode: 'lexical', sources: ['bm25'], docs: lexical, notes };
  }
  if (query.trim() === '' || docs.length === 0) {
    return { mode: 'lexical', sources: ['bm25'], docs: lexical, notes };
  }

  let queryVector: readonly number[] | undefined;
  let vectors = options.vectors;
  try {
    // **只嵌入需要嵌入的东西**：调用方给了 vectors 缓存时，这里只算查询那一条。
    // 曾经这里无条件把"查询 + 全部文档"一起送去嵌入 —— 结果是每次查询都重算整个语料
    // （在 500 条语料上实测把一次查询拖到 100 秒以上）。缓存在手上就必须用上。
    const cacheHit = vectors !== undefined;
    const embedded = await embedder.embed(cacheHit ? [query] : [query, ...docs.map((doc) => doc.text)]);
    queryVector = embedded[0];
    if (vectors === undefined) {
      const built = new Map<string, readonly number[]>();
      docs.forEach((doc, index) => {
        const vector = embedded[index + 1];
        if (vector !== undefined) built.set(doc.id, vector);
      });
      vectors = built;
    }
  } catch (error) {
    // 回退规则 2：向量挂了照样给词法结果，并如实告警
    notes.push(
      `向量检索不可用（${embedder.id}）：${error instanceof Error ? error.message : String(error)} —— 本次只用词法检索`,
    );
    return { mode: 'lexical-fallback', sources: ['bm25'], docs: lexical, notes };
  }

  if (queryVector === undefined || vectors === undefined) {
    notes.push(`向量来源 ${embedder.id} 没有返回查询向量 —— 本次只用词法检索`);
    return { mode: 'lexical-fallback', sources: ['bm25'], docs: lexical, notes };
  }

  const vectorHits = vectorSearch(queryVector, docs, vectors, options.vectorLimit ?? limit);
  const fused = reciprocalRankFusion([lexical.map((item) => item.id), vectorHits.map((item) => item.id)], options.rrfK ?? 60);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const merged: ScoredDoc[] = [...fused.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([id, score]) => {
      const doc = byId.get(id);
      return {
        id,
        kind: doc?.kind ?? 'message',
        score,
        ...(doc?.covers === undefined ? {} : { covers: doc.covers }),
      };
    });

  const mode = options.rerank ?? 'none';
  if (mode === 'none') return { mode: 'hybrid', sources: ['bm25', embedder.id], docs: merged, notes };
  if (mode === 'lexical') {
    notes.push('已做词法重排（词项覆盖率 + 短语命中；默认关闭，需显式开启）');
    return { mode: 'hybrid', sources: ['bm25', embedder.id], docs: rerankDocs(query, merged, docs, options.rerankOptions), notes };
  }
  if (mode === 'model') {
    const reranker = options.reranker;
    if (reranker === undefined) {
      notes.push('要求用 rerank 模型重排，但没有可用的 reranker —— 本次保持融合后的排序');
      return { mode: 'hybrid', sources: ['bm25', embedder.id], docs: merged, notes };
    }
    // 工程实践：先取较宽的候选（默认 20 条）交给交叉编码器，再截到 limit
    const wide = Math.max(limit, options.rerankCandidates ?? 20);
    const fusedWide = [...fused.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, wide)
      .map(([id, score]) => {
        const doc = byId.get(id);
        return {
          id,
          kind: doc?.kind ?? 'message',
          score,
          ...(doc?.covers === undefined ? {} : { covers: doc.covers }),
        } satisfies ScoredDoc;
      });
    const texts = fusedWide.map((candidate) => byId.get(candidate.id)?.text ?? '');
    const hits = await reranker.rerank(query, texts, { topN: limit });
    const rerankedDocs: ScoredDoc[] = [];
    for (const hit of hits) {
      const candidate = fusedWide[hit.index];
      if (candidate !== undefined) rerankedDocs.push({ ...candidate, score: hit.score });
    }
    notes.push(`已用 rerank 模型重排（${reranker.id}；粗排 ${fusedWide.length} 条 → 精排前 ${rerankedDocs.length}）`);
    return { mode: 'hybrid', sources: ['bm25', embedder.id, reranker.id], docs: rerankedDocs, notes };
  }
  // 'embedding'：用 embedding 模型的余弦重排（复用混合检索已经算好的向量，不额外花 API 调用）
  const reranked = rerankByEmbedding(queryVector, merged, vectors, options.embeddingRerankOptions);
  notes.push(`已做 embedding 余弦重排（权重 ${(options.embeddingRerankOptions?.weight ?? 0.5).toFixed(2)}；复用已算好的向量；注意这不是 rerank 模型）`);
  if (reranked.missingVectors > 0) notes.push(`${reranked.missingVectors} 条候选没有向量，按 RRF 分数参与排序`);
  return { mode: 'hybrid', sources: ['bm25', embedder.id], docs: reranked.docs, notes };
}

/**
 * **测试桩**：把文本哈希成定长向量。**它不是语义检索** —— 相似文本不会因此靠得近，
 * 它只能用来验证"混合检索的管线、RRF 合并、回退规则"这些**结构**问题。
 * id 里带 stub 是故意的：它会出现在结果的 sources 里，谁用了都看得见。
 */
export function createHashEmbeddingStub(options: { dimensions?: number } = {}): EmbeddingPort {
  const dimensions = options.dimensions ?? 16;
  return {
    id: 'stub-hash-embedding',
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        for (let index = 0; index < text.length; index += 1) {
          const code = text.charCodeAt(index);
          const slot = (code * 31 + index * 17) % dimensions;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return norm === 0 ? vector : vector.map((value) => value / norm);
      });
    },
  };
}
