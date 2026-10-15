import { cosineSimilarity } from '../../packages/oplog/src/retrieval-hybrid.ts';
import type { EmbeddingPort } from '../../packages/oplog/src/retrieval-hybrid.ts';
import type { Probe } from './harness.ts';

/**
 * **语义判分**：真实模型会改写，严格子串判分会把答对的判成错（实测过：deepseek-flash 把
 * 「铜铃是父亲留下来的遗物」答成「铜铃是父亲留下来的遗物，也就是它来自父亲…」，严格判 0 分）。
 *
 * 判据用**相对**的，不用绝对阈值：
 *
 *   这条回答的向量，**离它自己的答案键最近**（且不小于其他答案键），就算答对。
 *
 * 为什么不设"cos ≥ 0.8 算对"这种阈值：向量余弦没有绝对标尺（短句普遍偏高、长句偏低，
 * 不同模型尺度也不同），而"最像哪一条"是个稳定的相对判断。这样也不需要调参。
 *
 * 两个数字一起报：strict（子串）与 semantic（最近邻）。**分开报**是因为它们回答的是不同问题：
 * 前者是"有没有照抄"，后者是"有没有答到"。合成一个数字就看不出来是哪种错。
 */

/**
 * 间隔下限：`cosSelf - cosOtherMax >= MARGIN` 才算答对。
 *
 * **为什么最近邻本身不够**（实测被自己的判别性检查抓到）：假模型每次回同一句
 * 「风从北面来。铜铃响的时候，别回头……」—— 它和 P2 的答案键「铜铃是父亲留下来的遗物。」
 * 共享"铜铃"，cos 0.53，而与其他答案键只有 0.35，于是"最近邻是自己"**被蒙对了**。
 * 加上间隔要求后：真实模型实测间隔 0.33–0.53（5 条），假阳性间隔只有 0.18，0.25 这条线分得开。
 * 这是**小样本标定**，不是通用常数；将来语料变了要重新看一眼这几个数。
 */
export const SEMANTIC_MARGIN = 0.25;

export interface SemanticOutcome {
  id: string;
  /** 与自己的答案键的余弦。 */
  cosSelf: number;
  /** 与其他答案键里最像的那条的余弦（用于判断"最近邻是不是自己"）。 */
  cosOtherMax: number;
  /** 最近邻就是自己的答案键。 */
  nearestIsSelf: boolean;
  /** 与"最像的其他答案键"的间隔（cosSelf - cosOtherMax）。 */
  margin: number;
  /** 严格子串是否命中（两个口径都保留）。 */
  strict: boolean;
}

export interface SemanticSummary {
  total: number;
  /** 语义判分命中数（最近邻是自己，**并且**间隔达到 MARGIN）。 */
  correct: number;
  rate: number;
  /** 严格子串命中数。 */
  strictCorrect: number;
  outcomes: SemanticOutcome[];
}

/** 从录制里取回答（按问题文字配对，不靠数组下标 —— 下标配对踩过坑）。 */
export function answerOf(entries: readonly { question: string; chunks: readonly string[] }[], probe: Probe): string | undefined {
  const plain = (text: string): string => text.replace(/^\[\d+\]\s*/, '').trim();
  const hit = entries.find((entry) => plain(entry.question) === probe.question.trim());
  return hit === undefined ? undefined : hit.chunks.join('');
}

export async function scoreProbesSemantic(
  probes: readonly Probe[],
  answers: ReadonlyMap<string, string>,
  embedder: EmbeddingPort,
): Promise<SemanticSummary> {
  const texts = [...probes.map((probe) => probe.fact), ...probes.map((probe) => answers.get(probe.id) ?? '')];
  const vectors = await embedder.embed(texts);
  const keys = vectors.slice(0, probes.length);
  const replies = vectors.slice(probes.length);

  const outcomes: SemanticOutcome[] = probes.map((probe, index) => {
    const reply = replies[index];
    const self = keys[index];
    const cosSelf = reply === undefined || self === undefined ? 0 : cosineSimilarity(reply, self);
    let cosOtherMax = -1;
    keys.forEach((key, keyIndex) => {
      if (keyIndex === index || reply === undefined) return;
      cosOtherMax = Math.max(cosOtherMax, cosineSimilarity(reply, key));
    });
    const answer = answers.get(probe.id) ?? '';
    const margin = Number((cosSelf - cosOtherMax).toFixed(4));
    return {
      id: probe.id,
      cosSelf: Number(cosSelf.toFixed(4)),
      cosOtherMax: Number(cosOtherMax.toFixed(4)),
      nearestIsSelf: cosSelf >= cosOtherMax,
      margin,
      strict: answer.includes(probe.fact),
    };
  });

  const correct = outcomes.filter((outcome) => outcome.nearestIsSelf && outcome.margin >= SEMANTIC_MARGIN).length;
  return {
    total: outcomes.length,
    correct,
    rate: outcomes.length === 0 ? 0 : correct / outcomes.length,
    strictCorrect: outcomes.filter((outcome) => outcome.strict).length,
    outcomes,
  };
}

/** 打印一张两口径对照表（评估输出用）。 */
export function formatSemanticLine(label: string, summary: SemanticSummary): string {
  const rows = summary.outcomes
    .map((outcome) => `${outcome.id}:${outcome.nearestIsSelf && outcome.margin >= SEMANTIC_MARGIN ? '语义✓' : '语义✗'}/cos ${outcome.cosSelf} vs 其他 ${outcome.cosOtherMax}（间隔 ${outcome.margin}）`)
    .join('｜');
  return (
    `  [语义判分] ${label}｜严格 ${summary.strictCorrect}/${summary.total}` +
    `（${(summary.total === 0 ? 0 : (summary.strictCorrect / summary.total) * 100).toFixed(0)}%）` +
    `｜语义 ${summary.correct}/${summary.total}（${(summary.rate * 100).toFixed(0)}%）\n    ${rows}`
  );
}
