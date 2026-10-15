import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import { buildLongConversation, createReplayClient, PROBES, scoreProbes, type Recording } from './harness.ts';

/**
 * 录制回放：**有录制就重放并算分，没有就明确 skip**。
 *
 * 为什么要有这个测试：M4 那条判据（事实题正确率）在**没有真实 provider** 的环境里只能空着。
 * 空着不能藏在"没跑"里 —— 所以这里的行为是：
 *  - \`eval/long-chat/recordings/*.json\` 有文件（用 record.ts 录的）→ 逐条重放、算正确率、断言回放是确定性的；
 *  - 一个都没有 → **skip**，并在测试名里说明"需要先跑 record.ts，且真实成绩需要真实 key"。
 * 这样"有没有真实数据"在测试报告里一眼可见，而不是悄悄绿着。
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

test('录制回放：对已录制的评估集重放并算分（没有录制则 skip，并说明需要真实 key）', async (t) => {
  const recordings = await loadRecordings();
  if (recordings.length === 0) {
    console.log(
      '  [录制回放] eval/long-chat/recordings/ 里没有录制文件 —— 跳过。\n' +
        '    离线自检：node scripts/mock-openai.mjs 15198 & 然后\n' +
        '      node eval/long-chat/record.ts --base-url http://127.0.0.1:15198/v1 --model mock --out eval/long-chat/recordings/mock.json\n' +
        '    真实成绩：把 --base-url/--model 换成真实 provider，并把密钥放进 STORYLANTERN_API_KEY。',
    );
    t.skip('没有录制文件：真实答对率需要真实 provider（见上面的命令）');
    return;
  }

  const history = buildLongConversation();
  /** 与 record.ts 一致：探针问题接在长对话之后、走真实装配 —— 键才可能与录制对上。 */
  const callFor = (question: string) => {
    const request = buildChatRequest({ settings: {}, history: [...history, { role: 'user', content: question, status: 'done' }] });
    return { messages: request.messages, systemPrompt: request.systemPrompt };
  };

  for (const { file, recording } of recordings) {
    const client = createReplayClient(recording);
    const answers = new Map<string, string>();
    for (const probe of PROBES) {
      const reply = await client.reply(callFor(probe.question), {});
      answers.set(probe.id, reply.text);
    }
    const summary = scoreProbes(PROBES, answers);
    console.log(`  [录制回放] ${file}：${recording.producedBy} → 命中 ${summary.total === 0 ? 0 : summary.correct}/${summary.total}`);

    // 确定性：同一份录制重放两次，结果必须完全一致
    const client2 = createReplayClient(recording);
    for (const probe of PROBES) {
      const again = await client2.reply(callFor(probe.question), {});
      assert.equal(again.text, answers.get(probe.id), `回放必须确定性（${probe.id}）`);
    }
  }
});
