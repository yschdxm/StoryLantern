import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../packages/oplog/src/index.ts';
import { recomputeFacts } from '../../apps/app/src/data/fact-organize.ts';
import { buildLongConversation, FACTS } from './harness.ts';

/**
 * **真实提取**测量：把产品的设定抽取（`recomputeFacts` + 仓库里的 `FACT_INSTRUCTION`）交给
 * **官方 deepseek** 跑一遍，看"埋在最近窗口里的事实"能不能被抽出来。
 *
 * 为什么要量：这条路径此前只有格式/越界/去重的单测（逻辑对），**提示本身从没在真实模型上量过**。
 *
 * 地面真值：harness 的 `FACTS`（埋在固定位置、种子固定的原文）。为了不只看最近那一两个埋点，
 * 这里把窗口**逐个滑到每个埋点**（窗口末尾 = 该埋点位置，仍取最近 40 条，与应用上下文窗口一致），
 * 于是 5 个埋点都能被量到 —— 其中 `TOTAL-35` 那条会同时出现在两个窗口里（它离 `TOTAL-2` 只有 33 条）。
 *
 * 判分两条并排写（真实模型会改写措辞，光看字符串会误判）：
 *  - **严格**：抽出的文本里**原样包含**事实正文；
 *  - **语义**：用 8B 向量做最近邻 + 间隔 ≥ 0.25（与文档标定一致）。
 * 另外量**精确率**：抽出来但与任何真值都不像（最近邻 < 0.5）的条目算噪声 —— 提示写坏了会体现在这里。
 *
 * 没有 `DEEPSEEK_API_KEY`（或没有 moark 密钥时只能报严格口径）时明确 skip/降级标注，不许假跑。
 */

const KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.CHAT_MODEL ?? 'deepseek-flash';
const MOARK_KEY = process.env.MOARK_API_KEY ?? '';
const MOARK_BASE = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const maybe = KEY === '' ? test.skip : test;

/**
 * **旧提示**（加"不要抽说话人"那条规则之前的原文）—— 评估里留着它，是为了能做**同等样本**的
 * 前后对比：用 `EXTRACTION_PROMPT=legacy` 跑同样次数，前后各 5 次，才谈得上比较。
 */
const LEGACY_INSTRUCTION = [
  '你是一个设定整理助手。请从下面带序号的对话里，抽出**已经确立**的事实（谁是谁、什么是什么、发生了什么）。',
  '只输出一个 JSON 数组，不要任何解释、不要代码块以外的文字。每一项形如：',
  '{"subject":"主语（人或物）","predicate":"谓语（关系或属性，如 身份/来历/地点）","object":"宾语（具体内容）",',
  '"text":"一句人话（可选）","sources":[1,3],"confidence":80}',
  '要求：sources 里是**对话序号**（方括号里的数字），必须真的支持这条事实；没有依据就不要写这一条。',
  '只整理、不发挥：不要推测，不要把设定写成小说。',
].join('\n');
const PROMPT_MODE = process.env.EXTRACTION_PROMPT === 'legacy' ? 'legacy' : 'new';
const INSTRUCTION_OVERRIDE = PROMPT_MODE === 'legacy' ? LEGACY_INSTRUCTION : undefined;
const WINDOW = 40;

async function realReply(_profileId: string | undefined, systemPrompt: string, userText: string): Promise<string> {
  const response = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content ?? '';
}

async function embed(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await fetch(`${MOARK_BASE.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MOARK_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  const parsed = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
  return (parsed.data ?? []).slice().sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

maybe('真实提取：把窗口滑到每个埋点，量召回与精确率（官方 deepseek）', async () => {
  const all = buildLongConversation().map((item, index) => ({ id: `m${index + 1}`, role: item.role, content: item.content }));
  const settings = {
    'model.profiles': JSON.stringify([
      { id: 'p-extract', name: 'deepseek 官方', baseUrl: BASE, model: MODEL, temperature: 0, maxTokens: 2048, tasks: ['extract'], enabled: true },
    ]),
  };

  let totalTruth = 0;
  let strictHits = 0;
  let semanticHits = 0;
  /** 更严的口径：还要求间隔 ≥ 0.25（"唯一最佳"）。抽取会把一句话拆成两条都对，故两个都报。 */
  let semanticStrictHits = 0;
  let totalDrafts = 0;
  let noise = 0;
  let bogusSources = 0;

  for (const anchor of FACTS) {
    const history = all.slice(0, anchor.at);
    const started = Date.now();
    // 也走**近似重复合并**（把草稿文本送真 moark 向量）——这样量的是产品改动后的真实行为
    const result = await recomputeFacts({
      settings,
      history,
      existing: [],
      reply: realReply,
      window: WINDOW,
      // EXTRACTION_MERGE=off 关掉近似合并 —— 这样能**隔离变量**：只看提示本身的效果
      ...(process.env.EXTRACTION_MERGE === 'off' ? {} : { embed: async (texts: readonly string[]) => embed(texts) }),
      ...(INSTRUCTION_OVERRIDE === undefined ? {} : { instruction: INSTRUCTION_OVERRIDE }),
    });
    const elapsed = Date.now() - started;
    const windowIds = new Set(history.slice(-WINDOW).map((message) => message.id));
    // 真值 = 既在窗口内、又不晚于窗口末尾（只看过的事实才谈得上"没抽出来"）
    const truth = FACTS.filter((fact) => fact.at > anchor.at - WINDOW && fact.at <= anchor.at);
    const drafts = result.drafts.map((draft) => ({
      text: `${draft.subject}｜${draft.predicate}｜${draft.object}｜${draft.text ?? ''}`,
      ids: draft.sourceMessageIds,
    }));
    totalDrafts += drafts.length;
    totalTruth += truth.length;

    const bad = drafts.filter((item) => item.ids.length === 0 || item.ids.some((id) => !windowIds.has(id)));
    bogusSources += bad.length;
    assert.equal(bad.length, 0, `窗口末尾 m${anchor.at}：来源不许越界或为空`);
    for (const fact of truth) {
      assert.ok(
        drafts.some((item) => item.ids.includes(`m${fact.at}`)),
        `窗口末尾 m${anchor.at}：埋点 m${fact.at} 必须出现在某条抽取的来源里`,
      );
    }

    const strictForWindow = truth.filter((fact) => drafts.some((item) => item.text.includes(fact.text)));
    strictHits += strictForWindow.length;

    let semanticForWindow = 0;
    let semanticStrictForWindow = 0;
    let noiseForWindow = 0;
    if (MOARK_KEY !== '' && drafts.length > 0) {
      const vectors = await embed([...truth.map((fact) => fact.text), ...drafts.map((item) => item.text)]);
      const keys = vectors.slice(0, truth.length);
      const replies = vectors.slice(truth.length);
      for (let index = 0; index < truth.length; index += 1) {
        const scored = replies
          .map((vector, replyIndex) => ({ replyIndex, score: cosineSimilarity(keys[index] ?? [], vector) }))
          .sort((left, right) => right.score - left.score);
        const margin = (scored[0]?.score ?? 0) - (scored[1]?.score ?? 0);
        if ((scored[0]?.score ?? 0) >= 0.5) semanticForWindow += 1;
        if ((scored[0]?.score ?? 0) >= 0.5 && margin >= 0.25) semanticStrictForWindow += 1;
      }
      // 精确率：每条抽取与"本窗口所有真值"的最高相似度 < 0.5 就当作噪声（抽了但没对应事实）
      for (const vector of replies) {
        const best = Math.max(0, ...keys.map((key) => cosineSimilarity(key, vector)));
        if (best < 0.5) noiseForWindow += 1;
      }
      semanticHits += semanticForWindow;
      semanticStrictHits += semanticStrictForWindow;
      noise += noiseForWindow;
    }

    // 阈值标定用：把本窗口草稿两两的余弦打出来（"同一句话被拆成两条"到底有多像，无关事实又有多不像）
    if (MOARK_KEY !== '' && drafts.length >= 2) {
      const pairVectors = await embed(drafts.map((item) => item.text));
      const pairs: string[] = [];
      for (let left = 0; left < drafts.length; left += 1) {
        for (let right = left + 1; right < drafts.length; right += 1) {
          const score = cosineSimilarity(pairVectors[left] ?? [], pairVectors[right] ?? []);
          pairs.push(`${score.toFixed(3)}(${left}|${right})`);
        }
      }
      console.log(`  [真实提取] 窗口末尾 m${anchor.at} 草稿两两余弦：${pairs.join(' ')}`);
    }
    console.log(
      `  [真实提取] 窗口末尾 m${anchor.at}（${elapsed} ms）：真值 ${truth.length} 条，抽出 ${drafts.length} 条，` +
        `合并掉 ${result.merged} 条，严格 ${strictForWindow.length}/${truth.length}，语义(≥0.5) ${MOARK_KEY === '' ? '(无向量密钥，未量)' : `${semanticForWindow}/${truth.length}`}，语义(且间隔≥0.25) ${MOARK_KEY === '' ? '(未量)' : `${semanticStrictForWindow}/${truth.length}`}，噪声 ${MOARK_KEY === '' ? '(未量)' : noiseForWindow}`,
    );
    for (const item of drafts) console.log(`      · ${item.text}（来源=${JSON.stringify(item.ids)}）`);
  }

  console.log(`  [真实提取] 提示模式=${PROMPT_MODE}`);
  console.log(`  [真实提取] 合计：真值实例 ${totalTruth}，严格 ${strictHits}/${totalTruth}，` +
    `语义(≥0.5) ${MOARK_KEY === '' ? '(未量)' : `${semanticHits}/${totalTruth}`}，语义(且间隔≥0.25) ${MOARK_KEY === '' ? '(未量)' : `${semanticStrictHits}/${totalTruth}`}，` +
    `抽出 ${totalDrafts} 条（合并后），噪声 ${MOARK_KEY === '' ? '(未量)' : noise}，越界来源 ${bogusSources}`);
  assert.ok(totalDrafts > 0, '真实模型应当在每个窗口都至少抽出一条');
});
