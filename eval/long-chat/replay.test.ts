import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import { SETTING_KEYS } from '../../apps/app/src/data/types.ts';
import type { ChatCall } from '../../apps/app/src/data/chat-client.ts';
import {
  buildLongConversation,
  createPerfectReaderModel,
  createRecorder,
  createReplayClient,
  DEFAULT_LIMIT,
  PROBES,
  recordingKey,
  scoreProbes,
  TOTAL,
  type HistoryItem,
} from './harness.ts';

/**
 * 回放式评估：**离线、确定性、不需要网络与密钥**。
 *
 * 一次跑通四件事：① 用"完美读者"模型桩录制 5 条探针的回答；② 按答案键判分；
 * ③ 用同一份录制**回放**，结果必须逐字一致；④ 换一个请求去回放**必须报错**（回放缺席不许凭空造答案）。
 *
 * 这个数字的含义要说准：它是**上界** —— "假设模型是完美读者，光靠管线能答对多少"。
 * 它测的是**上下文有没有把事实喂到**，不是模型质量。真实模型只会更低。
 */

const systemPromptOf = (call: ChatCall): string => call.systemPrompt ?? '';

/** 把探针问题接在长对话后面，走**真实的**装配，得到一条真请求。 */
function callFor(history: readonly HistoryItem[], question: string, limit?: number): ChatCall {
  const settings: Record<string, string> = limit === undefined ? {} : { [SETTING_KEYS.historyLimit]: String(limit) };
  const request = buildChatRequest({
    settings,
    history: [...history, { role: 'user', content: question, status: 'done' }],
  });
  return { messages: request.messages, systemPrompt: request.systemPrompt };
}

test('回放式评估：默认窗口下（完美读者）只有窗口内事实可达，录制→判分→回放逐字一致', async () => {
  const history = buildLongConversation();
  const recorder = createRecorder(createPerfectReaderModel(PROBES), 'perfect-reader');

  const answers = new Map<string, string>();
  for (const probe of PROBES) {
    const result = await recorder.client.reply(callFor(history, probe.question), {});
    answers.set(probe.id, result.text);
  }

  const summary = scoreProbes(PROBES, answers);
  console.log(
    `  [回放评估] 答对 ${summary.correct}/${summary.total} = ${(summary.rate * 100).toFixed(0)}%` +
      `（录制 ${recorder.recording.entries.length} 条，producedBy=${recorder.recording.producedBy}）`,
  );

  // 默认窗口 40 条下，只有窗口内的事实进得了上下文 → 上界就是它们的条数（从数据算，不写死）
  const inWindow = PROBES.filter((probe) => probe.at > TOTAL - DEFAULT_LIMIT).length;
  assert.equal(summary.total, PROBES.length);
  assert.equal(summary.correct, inWindow, `默认窗口下（完美读者）应当恰好答对窗口内那 ${inWindow} 条`);
  assert.equal(recorder.recording.entries.length, PROBES.length, '每条探针都应留下一条录制');

  // 回放：同一份录制、同一批请求 → 逐字一致
  const replay = createReplayClient(recorder.recording);
  for (const probe of PROBES) {
    const replayed = await replay.reply(callFor(history, probe.question), {});
    assert.equal(replayed.text, answers.get(probe.id), `回放结果必须与录制逐字一致（${probe.id}）`);
  }

  // 录制本身要能落盘（JSON），将来录真实模型时直接提交这个文件
  const serialized = JSON.stringify(recorder.recording);
  assert.ok(serialized.length > 100);
  console.log(`  [回放评估] 录制体积 ${serialized.length} B，可 JSON 落盘`);
});

test('把历史上限开到 500：完美读者即可答对全部探针（说明瓶颈是窗口，不是评分器）', async () => {
  const history = buildLongConversation();
  const recorder = createRecorder(createPerfectReaderModel(PROBES), 'perfect-reader');
  const answers = new Map<string, string>();
  for (const probe of PROBES) {
    const result = await recorder.client.reply(callFor(history, probe.question, 500), {});
    answers.set(probe.id, result.text);
  }
  const summary = scoreProbes(PROBES, answers);
  console.log(`  [回放评估·上限 500] 答对 ${summary.correct}/${summary.total}`);
  assert.equal(summary.correct, PROBES.length);
});

test('回放缺席必须报错：换个请求去回放不得凭空生成答案', async () => {
  const history = buildLongConversation();
  const recorder = createRecorder(createPerfectReaderModel(PROBES), 'perfect-reader');
  await recorder.client.reply(callFor(history, PROBES[0]?.question ?? ''), {});

  const replay = createReplayClient(recorder.recording);
  // 少了一条历史 → 请求内容变了 → 键也变了 → 录制里没有 → 必须抛错
  const changed = callFor(history.slice(0, history.length - 1), PROBES[0]?.question ?? '');
  await assert.rejects(replay.reply(changed, {}), /回放缺席/);

  // 键确实是内容决定的（同一请求同一键，内容变则键变）
  assert.equal(recordingKey(callFor(history, '甲')), recordingKey(callFor(history, '甲')));
  assert.notEqual(recordingKey(callFor(history, '甲')), recordingKey(callFor(history, '乙')));
});
