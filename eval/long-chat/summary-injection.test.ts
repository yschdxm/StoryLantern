import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock, runSummaries, toHex, utf8, nodeDigest, type SummarizeRequest } from '../../packages/oplog/src/index.ts';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import { SUMMARY_INJECT_LIMIT, type PromptSummary } from '../../apps/app/src/data/prompt-blocks.ts';
import { buildLongConversation, FACTS, TOTAL } from './harness.ts';

/**
 * 「检索接进上下文」这一步的**效果测量**（M4）。
 *
 * 早先（docs/M4-STATUS.md 第六节）量到的基线是：默认历史上限 40 条时，500 条对话里埋的 5 条事实
 * **只有 2 条**进得了上下文 —— 60% 到不了模型。这里量的是同一件事，但**把会话摘要也接上**之后：
 * 探针问题作为最后一条 user 消息 → 摘要按检索挑 3 条注入 → 事实是否因此变得可达。
 *
 * **说准这个方法**：摘要文本由"完美摘要器"桩生成（覆盖窗口里出现事实原文就照抄那一条），
 * 所以这里量的是**管线的可达性**，不是"模型能不能答对"。真实摘要文本取决于模型质量。
 */

const SCENE_SIZE = 20;
const ARC_SIZE = 5;
const SESSION = '会话甲';

const HASH = async (parts: readonly string[]): Promise<string> => toHex(await nodeDigest.sha256(utf8(parts.join('\n'))));

/** 完美摘要器：覆盖的材料里出现哪条事实，就把那条事实原文当摘要交出去。规则透明、写死在这里。 */
const perfectSummarize = async (request: SummarizeRequest): Promise<string> => {
  const hit = FACTS.find((fact) => request.inputs.some((line) => line.includes(fact.text)));
  return hit?.text ?? '（这一段没有需要长期记住的事实）';
};

const HISTORY = buildLongConversation();
const MESSAGES = HISTORY.map((message, index) => ({ id: `M${index + 1}`, role: message.role, content: message.content }));

/** 实际会发出去的内容（与 probe.test.ts 同一口径：不含 trace）。 */
function injectedText(request: ReturnType<typeof buildChatRequest>): string {
  return [
    request.systemPrompt,
    ...request.messages.map((message) => message.content),
    JSON.stringify(request.lore ?? []),
    JSON.stringify(request.memory ?? []),
  ].join('\n');
}

function countFacts(text: string): number {
  return FACTS.filter((fact) => text.includes(fact.text)).length;
}

async function buildSummaries(): Promise<PromptSummary[]> {
  const clock = new HlcClock();
  const { ops } = await runSummaries({
    sessionId: SESSION,
    messages: MESSAGES,
    existing: [],
    options: {
      deviceId: 'device-a',
      clock,
      hash: HASH,
      summarize: perfectSummarize,
      modelId: 'perfect-summarizer',
      sceneSize: SCENE_SIZE,
      arcSize: ARC_SIZE,
      limit: 10_000, // 这是评估：要全部单元，不受真机那 24 个上限影响
    },
  });
  return ops.map((op) => {
    const payload = op.payload as { summaryId: string; text: string; level: string; covers: string[] };
    return { id: payload.summaryId, text: payload.text, level: payload.level, covers: [...payload.covers] };
  });
}

test(`${TOTAL} 条长对话：接上摘要注入后，埋点事实的可达率应当显著高于基线`, async () => {
  const summaries = await buildSummaries();
  console.log(`  摘要：${summaries.length} 条（scene ${SCENE_SIZE} 条消息 / arc ${ARC_SIZE} 个 scene）`);

  let baseline = 0;
  let withSummaries = 0;
  const detail: string[] = [];

  for (const fact of FACTS) {
    // 探针问题接在最后，与真实对话一致（检索看到的"最近上下文"里就包含这个问题）
    // 问题取事实的前几个字——既像真人提问，又不照抄整句（照抄会让 includes 检查变成废话）
    const history = [...HISTORY, { role: 'user' as const, content: fact.text.slice(0, 6) + '那件事是什么？', status: 'done' as const }];

    const plain = buildChatRequest({ settings: {}, history });
    const injected = buildChatRequest({ settings: {}, history, summaries });

    // 两个口径必须分开：基线看"有没有在窗口消息里"；接摘要看"有没有经检索进到系统提示里"。
    // 不能拿整份请求去 includes —— 探针问题本身就在 messages 里，那样会把答案算成"本来就可达"。
    const baseHit = plain.messages.some((message) => message.content.includes(fact.text));
    const sumHit = injected.systemPrompt.includes(fact.text);
    if (baseHit) baseline += 1;
    if (sumHit) withSummaries += 1;
    const injectedCount = injected.trace.summaries.length;
    detail.push(
      `    ${sumHit ? '✓' : '✗'} 第 ${fact.at} 条：摘要注入 ${injectedCount} 条，事实${sumHit ? '可达' : '仍不可达'}${baseHit ? '（基线本来可达）' : ''}`,
    );
  }

  console.log(`  [摘要注入] 事实可达 基线 ${baseline}/${FACTS.length} → 接摘要 ${withSummaries}/${FACTS.length}（每次注入上限 ${SUMMARY_INJECT_LIMIT} 条）`);
  for (const line of detail) console.log(line);

  assert.equal(baseline, 2, '基线：默认窗口下只有 2 条可达（与 probe.test.ts 一致）');
  // 钉住今天的成绩：基线 2/5（那三条深埋在历史里、根本到不了模型），接上摘要注入后 5/5。
  // 将来如果有意改动检索/摘要策略，这条会红——那时要么是变好、要么是变坏，都得看一眼数字。
  assert.equal(withSummaries, FACTS.length, '接上摘要注入后，5 条事实都应当可达');
});
