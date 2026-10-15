import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../packages/oplog/src/index.ts';
import { recomputeSummaries } from '../../apps/app/src/data/summary-recompute.ts';
import { SUMMARY_INSTRUCTION } from '../../apps/app/src/screens/use-summaries.ts';
import { buildLongConversation, FACTS } from './harness.ts';

/**
 * **真实摘要**测量：走**产品真正那支**（`recomputeSummaries`：多模型路由 → 规划器 → 执行器），
 * 生成用**官方 deepseek**（temperature 0），地面真值 = harness 里埋在固定位置的事实。
 *
 * 与上一版（我自己拼请求）的区别：这一版把请求构造、单元规划、指纹、候选回退都交给产品代码，
 * 评估只提供"用某个配置生成一段文本"的回调 —— 也就是真机上聊天客户端扮演的那个角色。
 *
 * 判分：把生成的摘要文本拼起来切成句子，逐句与真值比（避开长文本稀释余弦），
 * 句子级最高余弦 ≥ 0.5 算"留住了"（与文档里标定过的口径一致）；严格口径并排给，只作参考。
 * 没有密钥时明确 skip（不许假跑）。
 */

const KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.CHAT_MODEL ?? 'deepseek-flash';
const MOARK_KEY = process.env.MOARK_API_KEY ?? '';
const MOARK_BASE = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const maybe = KEY === '' ? test.skip : test;
const WINDOW = 40;
/** 一个 scene 单元覆盖多少条消息（`organizeSummaries` 的默认值）。窗口比它还小就不该产摘要。 */
const SCENE_SIZE = 20;

/** 真实模型调用：带两次重试（评估自己也要有重试 —— 有一次外部请求偶发失败直接挂了）。 */
async function callDeepseek(systemPrompt: string, userText: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
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
      if (!response.ok) throw new Error(`deepseek HTTP ${response.status}: ${text.slice(0, 160)}`);
      const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
      return parsed.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

const SETTINGS = {
  'model.profiles': JSON.stringify([
    { id: 'p-summary', name: 'deepseek 官方', baseUrl: BASE, model: MODEL, temperature: 0, maxTokens: 2048, tasks: ['summary'], enabled: true },
  ]),
};

maybe('真实摘要（产品那支 recomputeSummaries）：窗口里埋的事实有多少被留住', async () => {
  const all = buildLongConversation();
  let totalTruth = 0;
  let strictHits = 0;
  let survived = 0;
  let totalUnits = 0;
  let totalPlanned = 0;
  let scoredTruth = 0;
  let subSceneWindows = 0;

  for (const anchor of FACTS) {
    const history = all
      .slice(Math.max(0, anchor.at - WINDOW), anchor.at)
      .map((message, index) => ({ id: `w${index + 1}`, role: message.role, content: message.content }));
    const started = Date.now();
    const result = await recomputeSummaries({
      sessionId: 'eval-session',
      settings: SETTINGS,
      history,
      existing: [],
      reply: async (_profileId, request) => callDeepseek(SUMMARY_INSTRUCTION, request.inputs.join('\n')),
    });
    const elapsed = Date.now() - started;
    totalUnits += result.units;
    totalPlanned += result.planned;

    // 窗口比一个 scene 还小时，规划器**按设计**不产摘要 —— 这不算召回失败，要单独标出来并断言。
    if (history.length < SCENE_SIZE) {
      subSceneWindows += 1;
      assert.equal(result.planned, 0, `窗口只有 ${history.length} 条（< sceneSize=${SCENE_SIZE}）时不该规划任何单元`);
      assert.equal(result.drafts.length, 0, '不该产出摘要');
      console.log(`  [真实摘要] 窗口末尾 m${anchor.at}：只有 ${history.length} 条（< 一个 scene ${SCENE_SIZE}）→ 规划器按设计不产摘要（不计入召回）`);
      continue;
    }
    assert.ok(result.planned > 0, '窗口不小于一个 scene 时应当规划出单元');

    const texts = result.drafts.map((draft) => draft.text).filter((text) => text.trim() !== '');
    const joined = texts.join('\n');
    const truth = FACTS.filter((fact) => fact.at > anchor.at - WINDOW && fact.at <= anchor.at);
    totalTruth += truth.length;
    scoredTruth += truth.length;

    const strictForWindow = truth.filter((fact) => joined.includes(fact.text)).length;
    strictHits += strictForWindow;

    let survivedForWindow = 0;
    const notes: string[] = [];
    if (MOARK_KEY !== '' && texts.length > 0) {
      const sentences = texts
        .join('\n')
        .split(/[。；\n]/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const vectors = await embed([...truth.map((fact) => fact.text), ...sentences]);
      const keys = vectors.slice(0, truth.length);
      const lines = vectors.slice(truth.length);
      truth.forEach((fact, index) => {
        let best = 0;
        for (const line of lines) best = Math.max(best, cosineSimilarity(keys[index] ?? [], line));
        const ok = best >= 0.5;
        if (ok) survivedForWindow += 1;
        notes.push(`「${fact.text}」最高句相似度 ${best.toFixed(3)} ⇒ ${ok ? '留住' : '丢了'}`);
      });
      survived += survivedForWindow;
    }

    console.log(
      `  [真实摘要] 窗口末尾 m${anchor.at}（${elapsed} ms）：计划 ${result.planned} 个单元、做了 ${result.units} 个、` +
        `产出 ${texts.length} 段摘要；真值 ${truth.length} 条，严格 ${strictForWindow}/${truth.length}，` +
        `逐句语义 ${MOARK_KEY === '' ? '(无向量密钥，未量)' : `${survivedForWindow}/${truth.length}`}`,
    );
    for (const note of notes) console.log(`      · ${note}`);
    console.log(`      摘要：${joined.replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  console.log(
    `  [真实摘要] 合计：真值实例 ${totalTruth}，严格 ${strictHits}/${totalTruth}，` +
      `逐句语义 ${MOARK_KEY === '' ? '(未量)' : `${survived}/${scoredTruth}`}（计划 ${totalPlanned} 单元、做了 ${totalUnits} 个；` +
      `另有 ${subSceneWindows} 个窗口小于一个 scene，按设计不产摘要、不计入）`,
  );
  assert.ok(totalTruth > 0);
});
