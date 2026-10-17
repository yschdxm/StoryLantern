import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from './legacy-prompt.ts';
import { SETTING_KEYS } from '../../apps/app/src/data/types.ts';
import { buildLongConversation, PROBES } from './harness.ts';

/**
 * **真实模型**的「事实题正确率」评估（M4 判据之一：≥90%）。
 *
 * 为什么要单独一条：`probe.test.ts` 离线量的是"事实有没有进上下文"（完美读者上界），
 * 而判据要的是**真实模型答对多少**。之前文档里写的 100%（5/5）样本太小 ——
 * 5/5 的 95% 置信下界只有约 55%，撑不起"≥90%"。所以这里：
 *  1. 样本 30 条（`harness.ts` 的 FACTS）；
 *  2. 判分看**关键实体**（`probe.expect`）：真实模型会改写措辞，逐字比对会把"答对了但换了说法"判错；
 *     逐字（严格）结果一并打印，两种口径都摆在明面上；
 *  3. 给 **Wilson 95% 置信区间** —— 结论必须带区间，不许只报一个点估计。
 *
 * 没有密钥时**明确 skip**（不假跑）。运行方式（密钥只走环境变量，不要写进命令）：
 *   bash:       set -a; . ./.env.local; set +a; node --test eval/long-chat/probe-real.test.ts
 *   PowerShell: 见 DEVELOPMENT.md 的"评估"一节
 */

const KEY = process.env.DEEPSEEK_API_KEY ?? '';
const BASE = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
const MODEL = process.env.CHAT_MODEL ?? 'deepseek-chat';
const maybe = KEY === '' ? test.skip : test;
/** 全部 500 条都给模型看 —— 先量"上下文里全都有"时的上限，再谈摘要/检索能省多少。 */
const LIMIT = 500;

async function answer(systemPrompt: string, messages: readonly { role: string; content: string }[]): Promise<string> {
  const response = await fetch(`${BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 256,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content ?? '';
}

/** Wilson 95% 置信区间（n 小的时候比正态近似靠谱）。 */
function wilson(hits: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = hits / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

maybe(
  `真实模型事实题：${PROBES.length} 条探针，判分看关键实体（并报逐字严格口径与 Wilson 95% 区间）`,
  async () => {
    const history = buildLongConversation();
    const settings: Record<string, string> = { [SETTING_KEYS.historyLimit]: String(LIMIT) };
    let expectHits = 0;
    let strictHits = 0;
    let retried = 0;
    const rows: { id: string; ok: boolean; strict: boolean; answer: string }[] = [];

    for (const probe of PROBES) {
      const request = buildChatRequest({
        settings,
        history: [...history, { role: 'user', content: probe.question, status: 'done' as const }],
      });
      // 空回答**不算模型答错**：实测偶发返回空串（传输/服务侧抖动）。重试最多 2 次，并把重试次数报出来。
      let reply = '';
      let retries = 0;
      for (let attempt = 0; attempt < 3 && reply.trim() === ''; attempt += 1) {
        if (attempt > 0) retries += 1;
        reply = await answer(
          request.systemPrompt,
          request.messages.map((message) => ({ role: message.role, content: message.content })),
        );
      }
      const normalized = reply.replace(/\s+/g, '');
      const ok = probe.expect.every((needle) => normalized.includes(needle.replace(/\s+/g, '')));
      const strict = normalized.includes(probe.fact.replace(/[。，\s]/g, ''));
      if (ok) expectHits += 1;
      if (strict) strictHits += 1;
      if (retries > 0) retried += retries;
      rows.push({ id: probe.id, ok, strict, answer: reply.slice(0, 60) });
      console.log(
        `  ${probe.id} ${ok ? '✓' : '✗'}${strict ? '（逐字）' : ''}${retries > 0 ? `（重试 ${retries}）` : ''} 第${probe.at}条 ${probe.fact.slice(0, 18)}… → ${reply.slice(0, 40).replace(/\n/g, ' ')}`,
      );
    }

    const n = PROBES.length;
    const expected = expectHits / n;
    const strict = strictHits / n;
    const [low, high] = wilson(expectHits, n);
    console.log(`\n  样本 n=${n}（模型 ${MODEL}，temperature 0，上下文含全部 ${LIMIT} 条消息）`);
    console.log(`  关键实体口径：${expectHits}/${n} = ${(expected * 100).toFixed(1)}%，Wilson 95% 区间 [${(low * 100).toFixed(1)}%, ${(high * 100).toFixed(1)}%]`);
    console.log(`  逐字严格口径：${strictHits}/${n} = ${(strict * 100).toFixed(1)}%（只作参考：模型会改写措辞）`);
    if (retried > 0) console.log(`  空回答重试次数合计：${retried}（空串按传输抖动处理，不算模型答错）`);

    // 判据：≥90%。样本 30 意味着"点估计达标"才可能让下界也接近；不达标就如实红。
    assert.ok(
      expected >= 0.9,
      `事实题正确率 ${(expected * 100).toFixed(1)}% < 90%（n=${n}，Wilson 下界 ${(low * 100).toFixed(1)}%）；逐字口径 ${(strict * 100).toFixed(1)}%`,
    );
  },
);
