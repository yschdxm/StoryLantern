import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from './legacy-prompt.ts';
import type { ChatClient } from '../../apps/app/src/data/chat-client.ts';
import { buildLongConversation, PROBES, scoreCitations, scoreProbes, type Probe } from './harness.ts';

/**
 * 「引用正确」的评估测量。
 *
 * 两件事：
 *  1. **判分器能不能区分四种情况** —— 引对 / 引错 / 不引用 / 答错但引对；
 *  2. **在 500 条语料上量一次** —— 打印答对率与引用正确率。
 *
 * 桩是透明的、写死在这里的，所以它量的是"管线与判分器对不对"，**不是模型质量**。
 *
 * 一个必须踩对的地方（我第一版就踩错了）：编号窗口是**装配后**交给模型的那批消息，
 * 也就是 \`(历史 + 这一问).slice(-limit)\`，而不是 \`历史.slice(-limit)\` —— 差这一位，
 * 引用就会全指错。所以这里用装配结果来构造窗口，不自己另算一份。
 */

const HISTORY = buildLongConversation();

interface ProbeRun {
  probe: Probe;
  request: ReturnType<typeof buildChatRequest>;
  /** 与装配完全一致的编号窗口（含这一问）。 */
  window: { id: string; content: string }[];
}

function runOf(probe: Probe): ProbeRun {
  const request = buildChatRequest({
    settings: {},
    history: [...HISTORY, { role: 'user', content: probe.question, status: 'done' }],
    cite: true,
  });
  const limit = request.trace.historyLimit;
  // 历史项不一定带 id（渲染用的 PromptHistoryItem 就没有）；窗口必须有稳定身份，
  // 否则 checkCitations 解析出的 id 全是 undefined，supports 每次都命中第一条 —— 引用会被判成全错。
  const window = [...HISTORY, { content: probe.question }]
    .slice(-limit)
    .map((message, position) => ({
      id: `w${position}:${(message as { id?: string }).id ?? 'noid'}`,
      content: message.content,
    }));
  return { probe, request, window };
}

const RUNS = PROBES.map(runOf);

/** 事实是否在这次请求的可见内容里（系统提示 + 消息）。 */
function visibleFact(run: ProbeRun): boolean {
  const visible = [run.request.systemPrompt ?? '', ...run.request.messages.map((message) => message.content)].join('\n');
  return visible.includes(run.probe.fact);
}

function createCitingReader(cite: 'right' | 'wrong' | 'none'): ChatClient {
  return {
    available: true,
    async reply(request, handlers) {
      const run = RUNS.find((item) => request.messages[request.messages.length - 1]?.content?.includes(item.probe.question));
      const visible = [request.systemPrompt ?? '', ...request.messages.map((message) => message.content)].join('\n');
      const found = run !== undefined && visible.includes(run.probe.fact);
      let answer = found && run !== undefined ? run.probe.fact : '我不知道。';
      if (found && cite !== 'none') {
        if (cite === 'wrong') {
          // 引用最后一条（提问本身）：不可能支持答案
          answer += `（[${request.messages.length}]）`;
        } else {
          const position = request.messages.findIndex((message) => message.content.includes(run?.probe.fact ?? '\u0000'));
          answer += `（[${position + 1}]）`;
        }
      }
      for (const chunk of answer.length > 6 ? [answer.slice(0, 6), answer.slice(6)] : [answer]) {
        handlers.onDelta?.({ delta: chunk });
      }
      return { text: answer, aborted: false };
    },
    async probe() {
      return { ok: true, message: 'citing-reader 桩（不联网）' };
    },
  };
}

async function askAll(client: ChatClient): Promise<Map<string, string>> {
  const answers = new Map<string, string>();
  for (const run of RUNS) {
    const reply = await client.reply({ messages: run.request.messages, systemPrompt: run.request.systemPrompt }, {});
    answers.set(run.probe.id, reply.text);
  }
  return answers;
}

/** 判分窗口：各探针窗口长度一致，取第一份即可（用它的 id 集合去核对）。 */
function sharedWindow(): { id: string; content: string }[] {
  return RUNS[0]?.window ?? [];
}

test('引用判分能区分四种情况：引对 / 引错 / 不引用 / 答错但引对', async () => {
  const window = sharedWindow();
  const right = scoreCitations(PROBES, await askAll(createCitingReader('right')), window);
  const wrong = scoreCitations(PROBES, await askAll(createCitingReader('wrong')), window);
  const none = scoreCitations(PROBES, await askAll(createCitingReader('none')), window);

  // 答错但引对：答案说"我不知道"，引用仍指向事实所在的那条消息
  const mismatchAnswers = new Map<string, string>();
  for (const run of RUNS) {
    const position = run.request.messages.findIndex((message) => message.content.includes(run.probe.fact));
    // 事实不可见的那些不编引用（编了就是 [0]，解析器会正确地不当成引用）
    mismatchAnswers.set(run.probe.id, position >= 0 ? `我不知道。（[${position + 1}]）` : '我不知道。');
  }
  const mismatch = scoreCitations(PROBES, mismatchAnswers, window);

  console.log(
    `  [引用判分] 引对 ${right.correct}/${right.total} · 引错 ${wrong.wrongCitation}/${wrong.total} · ` +
      `不引用 ${none.noCitation}/${none.total} · 答错但引对 answerCorrect=${mismatch.outcomes.filter((o) => o.answerCorrect).length}/${mismatch.total}`,
  );

  // 桩只在事实可见时才引用，所以"引错"的条数上限是**可见条数**（其余是没引用）
  const visible = RUNS.filter(visibleFact).length;
  assert.ok(visible > 0, '至少有最近的埋点事实在窗口里');
  assert.equal(wrong.wrongCitation, visible, '引用错必须被抓住，不能算进正确');
  assert.equal(wrong.correct, 0);
  assert.equal(wrong.noCitation, PROBES.length - visible);
  assert.equal(none.noCitation, PROBES.length, '没引用要单独报，不能混成引用错');
  assert.equal(mismatch.correct, visible, '引用指对了位置，就算答案本身是错的');
  assert.equal(
    mismatch.outcomes.every((outcome) => !outcome.answerCorrect),
    true,
    '这一组的意义就在于：引用对 ≠ 答对，两个比率必须分开',
  );
  assert.match(wrong.outcomes[0]?.reason ?? '', /没有一条支持/);

  // 引对：只在**事实真的可见**的那几条上应当判成 correct（不可见时桩不会编引用）
  assert.equal(right.correct, visible, `可见 ${visible} 条，就应当有 ${visible} 条引用正确`);
  assert.equal(right.noCitation, PROBES.length - visible);
  assert.equal(right.wrongCitation, 0, '完美引用者不该引用错');
});

test('在 500 条语料上量一次：答对率与引用正确率各是多少（如实打印）', async () => {
  const answers = await askAll(createCitingReader('right'));
  const window = sharedWindow();
  const accuracy = scoreProbes(PROBES, answers);
  const citations = scoreCitations(PROBES, answers, window);
  console.log(
    `  [引用·500 条] 答对 ${accuracy.correct}/${accuracy.total}（${(accuracy.rate * 100).toFixed(0)}%）· ` +
      `引用正确 ${citations.correct}/${citations.total}（${(citations.rate * 100).toFixed(0)}%）· ` +
      `不引用 ${citations.noCitation} · 引错 ${citations.wrongCitation}`,
  );
  // 桩只在事实可见时才回答并引用，所以两个数字应当一致且都不为 0 —— 若为 0，说明窗口对不上
  assert.equal(accuracy.correct, citations.correct, '答对的那些，引用也应当对（因为桩是从可见内容里照抄并引用的）');
  assert.ok(citations.correct > 0, '至少应当有一两条（最近的埋点事实在窗口里）');
});
