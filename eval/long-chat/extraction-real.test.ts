import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, type EmbeddingPort } from '../../packages/oplog/src/index.ts';
import { FACT_INSTRUCTION, recomputeFacts } from '../../apps/app/src/data/fact-organize.ts';
import { buildLongConversation, FACTS, TOTAL } from './harness.ts';

/**
 * **真实提取**测量：把产品的设定抽取（`recomputeFacts`，用的是仓库里那条 FACT_INSTRUCTION）
 * 交给**官方 deepseek** 跑一遍，看"埋在最近窗口里的事实"能不能被抽出来。
 *
 * 为什么值得单独量：此前这条路径只有格式/越界/去重的单测（逻辑正确），但**提示本身从没在真实模型上量过** ——
 * 提示写得好不好，只有拿真模型跑、对照地面真值才知道。
 *
 * 地面真值来自 harness：`FACTS` 是埋进 500 条对话里的原文（位置固定、种子固定），
 * 窗口取最近 40 条（与应用的上下文窗口一致）→ 正好覆盖其中两条。
 *
 * 判分两条并排写（真实模型会改写措辞，光看字符串会误判）：
 *  - **严格**：抽出的文本里是否**原样包含**事实正文；
 *  - **语义**：用 8B 向量把每条真值匹配到最像的抽取项（最近邻 + 间隔 ≥ 0.25，与文档标定一致）。
 *
 * 没有 `DEEPSEEK_API_KEY` 时明确 skip（不许假跑）。
 */

const KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.CHAT_MODEL ?? 'deepseek-flash';
const MOARK_KEY = process.env.MOARK_API_KEY ?? '';
const MOARK_BASE = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const maybe = KEY === '' ? test.skip : test;
const WINDOW = 40;

/** 真实回复：官方 deepseek，temperature 0（可复跑）。 */
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
  const response = await fetch(`${MOARK_BASE.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MOARK_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  const parsed = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
  return (parsed.data ?? []).slice().sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

maybe('真实提取（deepseek 官方）：最近窗口里埋的事实抽出来了吗', async () => {
  const history = buildLongConversation().map((item, index) => ({ id: `m${index + 1}`, role: item.role, content: item.content }));
  const settings = {
    'model.profiles': JSON.stringify([
      {
        id: 'p-extract',
        name: 'deepseek 官方',
        baseUrl: BASE,
        model: MODEL,
        temperature: 0,
        maxTokens: 2048,
        tasks: ['extract'],
        enabled: true,
      },
    ]),
  };

  const started = Date.now();
  const result = await recomputeFacts({ settings, history, existing: [], reply: realReply, window: WINDOW });
  const elapsed = Date.now() - started;
  assert.ok(result.drafts.length > 0, '真实模型应当至少抽出一条（否则提示或解析有问题）');

  const extracted = result.drafts.map((draft) => ({
    text: `${draft.subject}｜${draft.predicate}｜${draft.object}｜${draft.text ?? ''}`,
    sourceMessageIds: draft.sourceMessageIds,
  }));
  const visible = FACTS.filter((fact) => fact.at > TOTAL - WINDOW);

  // 严格：原样包含事实正文
  const strictHits = visible.filter((fact) => extracted.some((item) => item.text.includes(fact.text)));
  // 语义：最近邻 + 间隔（与文档标定同规则）
  let semanticHits = 0;
  const details: string[] = [];
  if (MOARK_KEY !== '' && extracted.length > 0) {
    const vectors = await embed([...visible.map((fact) => fact.text), ...extracted.map((item) => item.text)]);
    const keys = vectors.slice(0, visible.length);
    const replies = vectors.slice(visible.length);
    visible.forEach((fact, index) => {
      const scored = replies
        .map((vector, replyIndex) => ({ replyIndex, score: cosineSimilarity(keys[index] ?? [], vector) }))
        .sort((left, right) => right.score - left.score);
      const best = scored[0];
      const second = scored[1];
      const margin = (best?.score ?? 0) - (second?.score ?? 0);
      const hit = (best?.score ?? 0) >= 0.5 && margin >= 0.25;
      if (hit) semanticHits += 1;
      details.push(`      · 「${fact.text}」→ 最近邻 ${best?.score.toFixed(3) ?? 'n/a'}，间隔 ${margin.toFixed(3)} ⇒ ${hit ? '命中' : '未命中'}`);
    });
  }

  console.log(`  [真实提取] deepseek=${MODEL}，窗口 ${WINDOW} 条，耗时 ${elapsed} ms`);
  console.log(`  [真实提取] 抽出 ${extracted.length} 条，丢弃 ${result.dropped} 条，去重 ${result.duplicated} 条`);
  // **来源契约**（真实模型输出上真正该盯的东西）：每条来源都必须落在窗口内真实存在的消息上
  const windowIds = new Set(history.slice(-WINDOW).map((message) => message.id));
  const bogus = extracted.filter((item) => item.sourceMessageIds.length === 0 || item.sourceMessageIds.some((id) => !windowIds.has(id)));
  const factualIds = new Set(extracted.flatMap((item) => item.sourceMessageIds));
  console.log(`  [真实提取] 来源：越界或空 ${bogus.length} 条；覆盖到的事实消息 ${[...visible].filter((fact) => factualIds.has(`m${fact.at}`)).length}/${visible.length}`);
  console.log(`  [真实提取] 窗口内真值 ${visible.length} 条：严格命中 ${strictHits.length}/${visible.length}，语义命中 ${semanticHits}/${visible.length}`);
  for (const line of details) console.log(line);
  console.log('  [真实提取] 抽出的条目（前 8 条）：');
  for (const item of extracted.slice(0, 8)) console.log(`      · ${item.text}（来源消息=${JSON.stringify(item.sourceMessageIds)}）`);

  assert.equal(bogus.length, 0, '任何一条来源都不许越界或为空（宁可少一条也不编来源）');
  for (const fact of visible) {
    assert.ok(factualIds.has(`m${fact.at}`), `埋点事实所在的消息 m${fact.at} 必须出现在某条抽取的来源里`);
  }
});
