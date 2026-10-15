import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../packages/oplog/src/index.ts';
import { SUMMARY_INSTRUCTION } from '../../apps/app/src/screens/use-summaries.ts';
import { buildLongConversation, FACTS } from './harness.ts';

/**
 * **真实摘要**测量：摘要那条提示（SUMMARY_INSTRUCTION）此前也只有单测（"计划器该写什么"），
 * 从没在真实模型上量过 —— 它到底能不能把窗口里的既定事实留住？
 *
 * 模型 = 官方 deepseek（temperature 0），地面真值 = harness 里埋在固定位置的事实，
 * 输入按产品**同一种格式**拼（`角色：内容`，见 SummarizeRequest.inputs 的注释）。
 * 照实说清差别：这里量的是**提示 + 输入格式**，请求拼接由本评估自己做（没有经过计划器那套接线）。
 *
 * 判分：把摘要切成句子，逐句与真值比（避免长文本把余弦稀释掉）；
 * 句子级最高余弦 ≥ 0.5 算"留住了"（0.5 这个门槛与文档里标定过的口径一致）。
 * 另外并排给严格口径（真值原文是否原样出现在摘要里）——真实模型会改写，它只作参考。
 *
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

async function summarizeReal(inputs: readonly string[]): Promise<string> {
  const response = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SUMMARY_INSTRUCTION },
        { role: 'user', content: inputs.join('\n') },
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

maybe('真实摘要：窗口里埋的事实有多少被摘要留住（官方 deepseek + 产品那条提示）', async () => {
  const all = buildLongConversation();
  let totalTruth = 0;
  let strictHits = 0;
  let survived = 0;

  for (const anchor of FACTS) {
    const window = all.slice(Math.max(0, anchor.at - WINDOW), anchor.at);
    const inputs = window.map((message) => `${message.role === 'user' ? '旅人' : '星野'}：${message.content}`);
    const started = Date.now();
    const summary = await summarizeReal(inputs);
    const elapsed = Date.now() - started;
    const truth = FACTS.filter((fact) => fact.at > anchor.at - WINDOW && fact.at <= anchor.at);
    totalTruth += truth.length;

    const sentences = summary
      .split(/[。；\n]/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const strictForWindow = truth.filter((fact) => summary.includes(fact.text)).length;
    strictHits += strictForWindow;

    let survivedForWindow = 0;
    const notes: string[] = [];
    if (MOARK_KEY !== '' && sentences.length > 0) {
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
      `  [真实摘要] 窗口末尾 m${anchor.at}（${elapsed} ms，${sentences.length} 句）：真值 ${truth.length} 条，` +
        `严格 ${strictForWindow}/${truth.length}，逐句语义 ${MOARK_KEY === '' ? '(无向量密钥，未量)' : `${survivedForWindow}/${truth.length}`}`,
    );
    for (const note of notes) console.log(`      · ${note}`);
    console.log(`      摘要前 120 字：${summary.replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  console.log(
    `  [真实摘要] 合计：真值实例 ${totalTruth}，严格 ${strictHits}/${totalTruth}，` +
      `逐句语义 ${MOARK_KEY === '' ? '(未量)' : `${survived}/${totalTruth}`}`,
  );
  assert.ok(totalTruth > 0);
});
