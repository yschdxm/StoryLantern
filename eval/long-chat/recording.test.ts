import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildLongConversation, createReplayClient, PROBES, scoreCitations, scoreProbes, type Recording } from './harness.ts';
import { buildPerfectSummaries, buildProbeRequest } from './probe-request.ts';

/**
 * 录制回放：**有录制就重放，分开算"答对率"与"引用正确率"；没有就明确 skip**。
 *
 * 关键点：回放请求由 \`probe-request.ts\` 构造 —— 与录制端**同一个函数**。
 * 录制的键是请求内容的哈希，两处各写一遍就会漂移（上一次给历史消息加编号时，
 * 这里当场报"回放缺席"——那是设计使然：宁可炸，也不许凭空生成答案）。
 */

const DIR = path.join(import.meta.dirname, 'recordings');

async function loadRecordings(): Promise<Array<{ file: string; recording: Recording }>> {
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const loaded: Array<{ file: string; recording: Recording }> = [];
  for (const file of files) {
    const raw = await readFile(path.join(DIR, file), 'utf8');
    loaded.push({ file, recording: JSON.parse(raw) as Recording });
  }
  return loaded;
}

test('录制回放：对已录制的评估集重放，分开算"答对率"与"引用正确率"（没有录制则 skip）', async (t) => {
  const recordings = await loadRecordings();
  if (recordings.length === 0) {
    console.log(
      '  [录制回放] recordings/ 里没有录制文件 —— 跳过。\n' +
        '    离线自检：node scripts/mock-openai.mjs 15198 & 然后\n' +
        '      node eval/long-chat/record.ts --base-url http://127.0.0.1:15198/v1 --model mock --out eval/long-chat/recordings/mock.json\n' +
        '    真实成绩：换成真实 provider 与模型，密钥放 STORYLANTERN_API_KEY。',
    );
    t.skip('没有录制文件：真实答对率需要真实 provider');
    return;
  }

  const history = buildLongConversation();
  const messages = history.map((message, index) => ({ id: `M${index + 1}`, role: message.role as 'user' | 'assistant' | 'system', content: message.content }));
  // 与录制端同一套输入：带上摘要注入（不然量的是"管线里没有记忆"的答对率）
  const summaries = await buildPerfectSummaries(messages);
  // 引用判分窗口：与装配一致（最近 N 条，含这一问）—— 用第一条探针的请求长度取，不猜
  const firstProbe = PROBES[0];
  const probeMessages = firstProbe === undefined ? [] : buildProbeRequest({ probe: firstProbe, history, summaries }).messages;
  const window = probeMessages.map((message, position) => ({ id: `w${position}`, content: message.content }));

  for (const { file, recording } of recordings) {
    const client = createReplayClient(recording);
    const answers = new Map<string, string>();
    for (const probe of PROBES) {
      const request = buildProbeRequest({ probe, history, summaries });
      const reply = await client.reply({ messages: request.messages, systemPrompt: request.systemPrompt }, {});
      answers.set(probe.id, reply.text);
    }
    const accuracy = scoreProbes(PROBES, answers);
    const citations = scoreCitations(PROBES, answers, window);
    console.log(
      `  [录制回放] ${file}｜${recording.producedBy}｜答对 ${accuracy.correct}/${accuracy.total}` +
        `（${(accuracy.rate * 100).toFixed(0)}%）｜引用正确 ${citations.correct}/${citations.total}` +
        `（不引用 ${citations.noCitation}·引错 ${citations.wrongCitation}）`,
    );

    // 确定性：同一份录制重放两次，结果必须完全一致
    const again = createReplayClient(recording);
    for (const probe of PROBES) {
      const request = buildProbeRequest({ probe, history, summaries });
      const reply = await again.reply({ messages: request.messages, systemPrompt: request.systemPrompt }, {});
      assert.equal(reply.text, answers.get(probe.id), `回放必须确定性（${probe.id}）`);
    }
  }
});
